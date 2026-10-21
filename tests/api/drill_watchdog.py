"""Учения сторожа: работа, замёрзшая как 21.10.2026 на voran, снимается, и система поднимается сама.

Не тест общего прогона (имя без `test_`): процессы морозит `tests/bench/watchdog_drill.sh` с хоста по
меткам «DRILL STOP …», пороги — `tests/bench/drill.compose.yml`. SIGSTOP — как взаимная блокировка:
процесс жив, хода нет. Проверяется не «ручка ответила», а итог: прогон дошёл, рамок столько же, сколько
у прогона без сбоя, повисшее снято, следующее работает.
"""
import time

import pytest

import agent_data
import sample
from conftest import BASE_URL, clip_url, drop_project, tag, wait_clip, wait_job
from test_agent_video import BLOCK, FPS, STEP, owner, setup, weights  # noqa: F401 — фикстуры
from test_project_data import archive

LONG = 150  # блоков: 1500 кадров, агенту при шаге 5 — 300, на карте минута-две
REF = {}    # рамки агента по кадрам у прогона без сбоя
DOC = {"v": 1, "nodes": [
    {"id": "frame", "type": "frame", "params": {}},
    {"id": "text", "type": "text", "params": {"model": "s", "prompts": [{"prompt": "person", "agent": "person", "on": True}]}},
    {"id": "out", "type": "output", "params": {}}],
    "edges": [{"from": "frame", "out": "out", "to": "text", "in": "in"},
              {"from": "text", "out": "out", "to": "out", "in": "in"}]}


def drill(*words):
    print("\nDRILL", *words, flush=True)  # с новой строки: pytest дописывает «.» к текущей
    time.sleep(3)  # скрипт с хоста читает журнал раз в секунду


@pytest.fixture(scope="module")
def clip(tmp_path_factory):
    """Длинный ролик: прогон должен ещё идти, когда его заморозят."""
    import av

    pics = [agent_data.place("bus.jpg")[0], agent_data.place("zidane.jpg")[0], agent_data.blank(0)]
    path = tmp_path_factory.mktemp("drill") / "drill-agent.mp4"
    container = av.open(str(path), mode="w", format="mp4")
    stream = container.add_stream("mpeg4", rate=FPS)
    stream.width, stream.height = pics[0].size
    stream.pix_fmt, stream.bit_rate = "yuv420p", 1_000_000
    for i in range(LONG):
        frame = av.VideoFrame.from_image(pics[i % len(pics)])
        for _ in range(BLOCK):
            container.mux(stream.encode(frame))
    container.mux(stream.encode())
    container.close()
    return path


def _row(db, run_id):
    with db.cursor() as cur:
        cur.execute("select status::text, processed, total, stats, error from agent_runs where id = %s", (run_id,))
        status, processed, total, stats, error = cur.fetchone()
    return {"status": status, "processed": processed or 0, "total": total, "stats": stats or {}, "error": error}


def _until(fn, timeout, what):
    end = time.time() + timeout
    while time.time() < end:
        got = fn()
        if got:
            return got
        time.sleep(0.5)
    raise AssertionError(f"не дождались: {what}")


def _start(owner, setup):
    task_id = setup["task"]["id"]
    ctx = _until(lambda: (c := owner.get(f"{BASE_URL}/api/agents/tasks/{task_id}").json())
                 and all(v["frames"] for v in c["videos"]) and c, 600, "ролики посчитаны")
    agent = next(a for a in ctx["agents"] if a["id"] == setup["graph"]["id"])
    version = agent["versions"][0]
    by_name = {c["name"]: c["id"] for c in ctx["classes"]}
    res = owner.post(f"{BASE_URL}/api/agents/tasks/{task_id}/runs", json={
        "graph_id": agent["id"], "version_id": version["id"], "sources": [], "step": STEP, "mode": "annotate",
        "videos": [setup["videos"]["annotate"]["id"]],
        "mapping": {c["id"]: by_name.get(c["name"]) for c in version["classes"]}})
    assert res.status_code == 202, res.text
    return res.json()["id"]


def _end(db, run_id):
    return _until(lambda: (r := _row(db, run_id))["status"] in ("done", "error", "stopped") and r, 900, "конец прогона")


def _boxes(db, setup):
    with db.cursor() as cur:
        cur.execute("""select frame_no, count(*) from video_annotations where video_id = %s and track_id is null
                       and agent_version_id is not null group by frame_no""", (setup["videos"]["annotate"]["id"],))
        return dict(cur.fetchall())


def _running(db, run_id, at_least):
    return _until(lambda: (r := _row(db, run_id))["status"] == "running" and r["processed"] >= at_least and r,
                  600, f"прогон идёт, кадров ≥ {at_least}")


def test_эталон_без_сбоя(owner, setup, db):
    run_id = _start(owner, setup)
    assert _end(db, run_id)["status"] == "done"
    REF.update(_boxes(db, setup))
    assert REF, "агент ничего не нашёл — сравнивать не с чем"


def test_прогон_замёрз_снят_и_продолжен_с_места(owner, setup, db):
    run_id = _start(owner, setup)
    _running(db, run_id, 20)
    drill("STOP training-worker", f"agent-{run_id[:8]}")
    run = _end(db, run_id)
    assert run["status"] == "done", run
    assert run["stats"].get("retries") == 1, run["stats"]
    assert run["processed"] == run["total"]
    # Уборка по полному плану: рамки, написанные до сбоя, на месте; лишних нет.
    assert _boxes(db, setup) == REF


def test_второе_зависание_ошибка_с_роликом_и_кадром(owner, setup, db):
    run_id = _start(owner, setup)
    first = _running(db, run_id, 20)["processed"]
    drill("STOP training-worker", f"agent-{run_id[:8]}")
    _until(lambda: _row(db, run_id)["stats"].get("retries") == 1, 300, "повтор")
    _running(db, run_id, first + 10)
    drill("STOP training-worker", f"agent-{run_id[:8]}")
    run = _end(db, run_id)
    assert run["status"] == "error", run
    assert "Повтор с места остановки тоже не дошёл: ролик «rsm-agent.mp4», после кадра" in run["error"], run["error"]


def test_родитель_замёрз_контейнер_поднят_прогон_продолжен(owner, setup, db):
    run_id = _start(owner, setup)
    _running(db, run_id, 20)
    # Как 21.10: замёрз весь воркер. Healthcheck убивает родителя, restart поднимает, прогон — с курсора.
    drill("STOP training-worker", "parent")
    drill("STOP training-worker", f"agent-{run_id[:8]}")
    run = _end(db, run_id)
    assert run["status"] == "done", run
    assert run["stats"].get("retries") == 1, run["stats"]
    assert _boxes(db, setup) == REF


@pytest.fixture(scope="module")
def preview(owner, db):
    code = agent_data.source_project(owner, db, frames=3)
    graph = owner.post(f"{BASE_URL}/api/aug/graphs", json={"name": tag(), "kind": "agent"}).json()
    owner.post(f"{BASE_URL}/api/aug/graphs/{graph['id']}/versions", json={"doc": DOC})
    yield lambda: owner.post(f"{BASE_URL}/api/agents/preview/frames",
                             json={"graph_id": graph["id"], "doc": DOC, "project": code, "count": 1})
    drop_project(db, code)
    owner.delete(f"{BASE_URL}/api/aug/graphs/{graph['id']}")


def test_тёплый_процесс_замёрз_запрос_ошибкой_следующий_работает(preview):
    assert (res := preview()).status_code == 200, res.text
    drill("STOP training-worker", "warm")
    started = time.time()
    res = preview()
    assert res.status_code == 422 and "Превью зависло" in res.json()["error"], res.text
    assert time.time() - started < 120, "снят позже веба — человек увидел бы 504"
    assert (res := preview()).status_code == 200, res.text


def test_полуавтомат_замёрз_процесс_снят_сессия_заново(owner, setup):
    open_ = lambda: owner.post(f"{BASE_URL}/api/auto/sessions",  # noqa: E731
                               json={"model": "sam2", "project": setup["code"]}).json()["session_id"]
    video = setup["videos"]["annotate"]
    ref = {"video_id": video["id"], "frame_no": 0}
    assert owner.get(clip_url(setup["task"]["id"], video["id"]) + "/frame", params={"n": 0}).status_code == 200
    warm = lambda sid: owner.post(f"{BASE_URL}/api/auto/sessions/{sid}/warm", json=ref)  # noqa: E731
    sid = open_()
    assert warm(sid).status_code == 200
    drill("STOP autolabel", "sam2")
    started = time.time()
    res = warm(sid)
    assert res.status_code == 503 and "перезапускается" in res.json()["error"], res.text
    assert time.time() - started < 60
    assert warm(sid).status_code == 404  # сессию забыли — клиент откроет заново
    assert warm(open_()).status_code == 200


def test_видеоворкер_замёрз_контейнер_поднят_ролик_готов(owner, setup):
    drill("STOP video-worker", "parent")
    with open(sample.ensure(), "rb") as fh:
        res = owner.post(f"{BASE_URL}/api/tasks/{setup['task']['id']}/videos",
                         files={"file": ("drill-after.mp4", fh, "video/mp4")}, data={"mode": "annotate"})
    assert res.status_code in (200, 201), res.text
    wait_clip(owner, setup["task"]["id"], res.json()["id"], timeout=600)


def test_обучение_замёрзло_снято_и_продолжено_с_last_pt(owner, db):
    code = owner.post(f"{BASE_URL}/api/projects", json={"name": tag()}).json()["code"]
    url = lambda tail="": f"{BASE_URL}/api/projects/{code}{tail}"  # noqa: E731
    try:
        res = owner.post(url("/import"), files={"file": ("test-data.zip", archive(), "application/zip")})
        assert wait_job(owner, res.json()["job_id"])["status"] == "done"
        res = owner.post(url("/import/commit"), json={"dataset_name": "Учения", "classes": [
            {"class_index": 0, "name": "вагон"}, {"class_index": 1, "name": "опора"}]})
        dataset = wait_job(owner, res.json()["job_id"])["result"]["dataset_id"]
        classes = [c["id"] for c in owner.get(url("/classes")).json()["classes"]]
        sid = owner.post(url("/trainsets"), json={"datasets": [dataset], "classes": classes, "split_mode": "random",
                                                  "val_ratio": 0.5, "seed": 1, "name": "Учения"}).json()["id"]
        _until(lambda: owner.get(url(f"/trainsets/{sid}")).json()["status"] not in ("queued", "building"), 180, "набор")
        res = owner.post(url("/runs"), json={"set_id": sid, "model": "yolo11n",
                                             "params": {"epochs": 300, "imgsz": 320, "batch": 2}})
        assert res.status_code == 202, res.text
        rid = res.json()["id"]

        def row():
            with db.cursor() as cur:
                cur.execute("select status::text, current_epoch, pid, params, error from train_runs where id = %s",
                            (rid,))
                return cur.fetchone()

        _, _, pid, _, _ = _until(lambda: (r := row())[0] == "running" and (r[1] or 0) >= 3 and r, 600, "эпоха 3")
        drill("STOP training-worker", f"pid:{pid}")
        status, _, _, params, error = _until(lambda: (r := row())[0] in ("done", "error", "stopped") and r, 900,
                                             "конец обучения")
        assert status == "done", error
        assert params.get("auto_resumes") == 1, params
    finally:
        drop_project(db, code)
