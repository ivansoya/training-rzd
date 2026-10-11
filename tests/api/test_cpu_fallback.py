"""Окно «на карте не запустится» (решения владельца 11.10.2026).

Обучение и прогон агента, которым карта мала или выключена, при запуске получают 409 с причиной
(и обучение — с подсказкой, что влезет), а с согласием (`device: cpu`) считают на процессоре.
Процессор берёт одну задачу разом. Карта ужимается запасом до CAP МБ под задачи — ни обучение,
ни YOLOE на неё не влезают; после модуля запас возвращается.
"""
import io
import time

import pytest

import agent_data
from conftest import BASE_URL, drop_project, tag, wait_job
from test_project_data import archive

CAP = 100
PERSON = "person"


@pytest.fixture(scope="module")
def owner(db):
    return agent_data.session(db)


@pytest.fixture(scope="module")
def card(db):
    with db.cursor() as cur:
        cur.execute("""select id, total_mb, reserved_mb, sam2_reserve_mb from gpu_devices
                       where enabled and seen_at > now() - interval '5 min' order by device_index limit 1""")
        row = cur.fetchone()
        if row is None:
            pytest.skip("На стенде нет живой карты")
        real, total, reserved, sam2 = row
        cur.execute("update gpu_devices set reserved_mb = %s where id = %s", (total - sam2 - CAP, real))
    try:
        yield str(real)
    finally:
        with db.cursor() as cur:
            cur.execute("update gpu_devices set reserved_mb = %s, enabled = true where id = %s", (reserved, real))


@pytest.fixture(scope="module")
def project(owner, db):
    code = owner.post(f"{BASE_URL}/api/projects", json={"name": tag()}).json()["code"]
    res = owner.post(f"{BASE_URL}/api/projects/{code}/classes", json={"name": PERSON})
    assert res.status_code in (200, 201), res.text
    try:
        yield code
    finally:
        drop_project(db, code)


def _doc():
    return {"v": 1, "nodes": [
        {"id": "frame", "type": "frame", "params": {}},
        {"id": "text", "type": "text", "params": {"model": "s", "prompts": [{"prompt": "person", "agent": PERSON, "on": True}]}},
        {"id": "nms", "type": "nms", "params": {"iou": 0.6}},
        {"id": "out", "type": "output", "params": {}}],
        "edges": [{"from": "frame", "out": "out", "to": "text", "in": "in"},
                  {"from": "text", "out": "out", "to": "nms", "in": "in"},
                  {"from": "nms", "out": "out", "to": "out", "in": "in"}]}


@pytest.fixture(scope="module")
def agent(owner):
    graph = owner.post(f"{BASE_URL}/api/aug/graphs", json={"name": tag(), "kind": "agent"}).json()
    res = owner.post(f"{BASE_URL}/api/aug/graphs/{graph['id']}/versions", json={"doc": _doc()})
    assert res.status_code in (200, 201), res.text
    try:
        yield graph
    finally:
        owner.delete(f"{BASE_URL}/api/aug/graphs/{graph['id']}")


def _task(owner, code, frames=2):
    task = owner.post(f"{BASE_URL}/api/projects/{code}/tasks", json={"name": tag()}).json()
    owner.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "in_progress"})
    for i in range(frames):
        picture, _ = agent_data.place("bus.jpg" if i % 2 == 0 else "zidane.jpg")
        buf = io.BytesIO()
        picture.save(buf, "JPEG", quality=90)
        res = owner.post(f"{BASE_URL}/api/tasks/{task['id']}/images",
                         files={"files": (f"p{i}.jpg", buf.getvalue(), "image/jpeg")})
        assert res.status_code in (200, 201), res.text
    return task


def _agent_body(owner, task, graph, **extra):
    ctx = owner.get(f"{BASE_URL}/api/agents/tasks/{task['id']}").json()
    version = next(a for a in ctx["agents"] if a["id"] == graph["id"])["versions"][0]
    person = next(c["id"] for c in ctx["classes"] if c["name"] == PERSON)
    return {"graph_id": graph["id"], "version_id": version["id"], "mode": "frames", "sources": ["files"],
            "videos": [], "step": 25, "gap": 2, "mapping": {PERSON: person}, **extra}


def _wait_agent(owner, task, run_id, timeout=600):
    end = time.time() + timeout
    while time.time() < end:
        run = next(r for r in owner.get(f"{BASE_URL}/api/agents/tasks/{task['id']}").json()["runs"] if r["id"] == run_id)
        if run["status"] not in ("queued", "waiting_gpu", "running"):
            return run
        time.sleep(1)
    raise AssertionError("прогон агента не кончился")


def test_обучение_больше_карты_учится_на_процессоре(owner, project, card):
    url = lambda tail="": f"{BASE_URL}/api/projects/{project}{tail}"  # noqa: E731
    res = owner.post(url("/import"), files={"file": ("test-data.zip", archive(), "application/zip")})
    assert wait_job(owner, res.json()["job_id"])["status"] == "done"
    res = owner.post(url("/import/commit"), json={"dataset_name": "Первый", "classes": [
        {"class_index": 0, "name": "вагон"}, {"class_index": 1, "name": "опора"}]})
    dataset = wait_job(owner, res.json()["job_id"])["result"]["dataset_id"]
    classes = [c["id"] for c in owner.get(url("/classes")).json()["classes"]]
    sid = owner.post(url("/trainsets"), json={"datasets": [dataset], "classes": classes, "split_mode": "random",
                                              "val_ratio": 0.5, "seed": 1, "name": "ЦП"}).json()["id"]
    for _ in range(180):
        if owner.get(url(f"/trainsets/{sid}")).json()["status"] not in ("queued", "building"):
            break
        time.sleep(1)

    body = {"set_id": sid, "model": "yolo11n", "params": {"epochs": 1, "imgsz": 640, "batch": 16}}
    res = owner.post(url("/runs"), json=body)
    assert res.status_code == 409 and res.json()["code"] == "gpu_never", res.text
    # Под задачи 100 МБ: даже батч 1 на 640 не влезает — подсказка про вход.
    fit = res.json()["fit"]
    assert fit and fit["batch"] == 1 and fit["imgsz"] < 640, fit

    res = owner.post(url("/runs"), json={**body, "params": {"epochs": 1, "imgsz": 64, "batch": 2}, "device": "cpu"})
    assert res.status_code == 202, res.text
    rid = res.json()["id"]
    for _ in range(600):
        run = owner.get(url(f"/runs/{rid}")).json()
        if run["status"] in ("done", "error", "stopped"):
            break
        time.sleep(1)
    assert run["device"] == "cpu", run["device"]
    if run["status"] == "error" and "неожиданно" in (run["error"] or ""):
        # Стенд на Ryzen 9700X под WSL2: torch 2.7.1 на процессоре падает нативно (double free) на любом
        # обратном проходе, даже на голой свёртке; на voran тот же образ учится (замер 11.10.2026).
        pytest.xfail("torch на процессоре этой машины падает нативно — обучение на процессоре проверять на voran")
    assert run["status"] == "done", run


def test_агент_больше_карты_размечает_на_процессоре_по_одному(owner, project, agent, card, db):
    first, second = _task(owner, project), _task(owner, project)
    res = owner.post(f"{BASE_URL}/api/agents/tasks/{first['id']}/runs", json=_agent_body(owner, first, agent))
    assert res.status_code == 409 and res.json()["code"] == "gpu_never", res.text

    runs = [owner.post(f"{BASE_URL}/api/agents/tasks/{t['id']}/runs",
                       json=_agent_body(owner, t, agent, device="cpu")) for t in (first, second)]
    assert all(r.status_code == 202 for r in runs), [r.text for r in runs]
    done = [_wait_agent(owner, t, r.json()["id"]) for t, r in zip((first, second), runs)]
    for run in done:
        assert run["status"] == "done" and run["cpu"] and run["processed"] == 2, run
    with db.cursor() as cur:
        cur.execute("""select granted_at, released_at from gpu_leases where on_cpu and status = 'released'
                       and ref_id = any(%s::uuid[]) order by granted_at""", ([r.json()["id"] for r in runs],))
        held = cur.fetchall()
    # Процессор — одна задача разом: второй получил его, когда первый отпустил.
    assert len(held) == 2 and held[1][0] >= held[0][1], held


def test_карты_выключены_тоже_предлагается_процессор(owner, project, agent, card, db):
    task = _task(owner, project, frames=1)
    with db.cursor() as cur:
        cur.execute("update gpu_devices set enabled = false where id = %s", (card,))
    try:
        res = owner.post(f"{BASE_URL}/api/agents/tasks/{task['id']}/runs", json=_agent_body(owner, task, agent))
        assert res.status_code == 409 and res.json()["code"] == "gpu_off", res.text
    finally:
        with db.cursor() as cur:
            cur.execute("update gpu_devices set enabled = true where id = %s", (card,))
