"""Агент на ролике: разведка и разметка каждого N-го кадра — на настоящих весах.

Решения владельца (24.09.2026). Проверяется не «ручка отвечает», а «агент
видит»: ролик собран из кадров «РСМ-2000 · тест», про которые ручная разметка
говорит, где человек есть, а где нет. Агент — как у владельца: две «Сети» на
одних весах РСМ-2000 (одна ищет только человека, вторая всё остальное),
«Объединение» и «Уточнение SAM».

Ролик — пять блоков по две секунды при 5 к/с, по кадру РСМ-2000 на блок:
«человек, пусто, человек, пусто, пусто» — пусто в смысле «человека нет».
Разведка обязана найти человека ровно в блоках с человеком; разметка —
поставить рамки на каждый N-й кадр, кроме кадра, где уже поработал человек,
дать полигоны от SAM и рамки обеих сетей; закрытие разметки — отдать кадры
агента на проверку (`new`), а тронутые человеком — размеченными.

Нужен стенд с картой и дев-учётка `tester` с весами РСМ-2000 на полке:
контейнер тестов тома не видит, и чужие веса ему взять неоткуда. Нет весов
или копии проекта — тест пропускается и говорит почему.
"""
import io
import os
import time

import pytest
import requests

from conftest import BASE_URL, tag, wait_job

LOGIN = os.environ.get("TEST_AGENT_LOGIN", "tester")
PASSWORD = os.environ.get("TEST_AGENT_PASSWORD", "123456")
SOURCE_PROJECT = "РСМ-2000 · тест"
PERSON = "Человек"
FPS = 5
BLOCK = 10                      # кадров на блок — две секунды
PLAN = [True, False, True, False, False]   # есть ли человек в блоке
STEP = 5                        # агент смотрит раз в секунду
HUMAN_FRAME = 10                # здесь «работал человек» — агент обязан пропустить


def _person_blocks():
    return [range(i * BLOCK, (i + 1) * BLOCK) for i, p in enumerate(PLAN) if p]


def _empty_blocks():
    return [range(i * BLOCK, (i + 1) * BLOCK) for i, p in enumerate(PLAN) if not p]


@pytest.fixture(scope="module")
def owner():
    s = requests.Session()
    res = s.post(f"{BASE_URL}/api/auth/login", json={"identity": LOGIN, "password": PASSWORD})
    if res.status_code != 200:
        pytest.skip(f"Нет дев-учётки {LOGIN}: {res.status_code}")
    return s


@pytest.fixture(scope="module")
def weights(owner):
    shelf = owner.get(f"{BASE_URL}/api/agents/weights").json()["weights"]
    found = next((w for w in shelf if "РСМ-2000" in w["name"] and PERSON in w["names"]), None)
    if found is None:
        pytest.skip("На полке нет весов РСМ-2000 с классом «Человек»")
    return found


@pytest.fixture(scope="module")
def clip(owner, db, tmp_path_factory):
    """Ролик из кадров копии РСМ-2000: человек по ручной разметке — или нет."""
    import av
    from PIL import Image

    with db.cursor() as cur:
        cur.execute("""
            select i.id, bool_or(c.name = %s) from images i
            join projects p on p.id = i.project_id
            join annotations a on a.image_id = i.id join classes c on c.id = a.class_id
            where p.name = %s group by i.id, i.file_name order by i.file_name""",
                    (PERSON, SOURCE_PROJECT))
        rows = cur.fetchall()
    with_person = [r[0] for r in rows if r[1]]
    without = [r[0] for r in rows if not r[1]]
    if len(with_person) < 2 or len(without) < 3:
        pytest.skip(f"Нет проекта «{SOURCE_PROJECT}» с размеченными кадрами")
    picks = iter(with_person[:2]), iter(without[:3])
    frames = []
    for has in PLAN:
        image_id = next(picks[0] if has else picks[1])
        res = owner.get(f"{BASE_URL}/api/images/{image_id}/file")
        assert res.status_code == 200, res.text
        frames.append(Image.open(io.BytesIO(res.content)).convert("RGB"))

    path = tmp_path_factory.mktemp("agent") / "rsm-agent.mp4"
    width, height = frames[0].size
    container = av.open(str(path), mode="w", format="mp4")
    stream = container.add_stream("mpeg4", rate=FPS)
    stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
    stream.bit_rate = 8_000_000
    for picture in frames:
        for _ in range(BLOCK):
            container.mux(stream.encode(av.VideoFrame.from_image(picture)))
    container.mux(stream.encode())
    container.close()
    return path


@pytest.fixture(scope="module")
def setup(owner, weights, clip, db):
    """Проект, классы по именам весов, таска, два ролика и агент владельца."""
    project = owner.post(f"{BASE_URL}/api/projects", json={"name": tag()}).json()
    code = project["code"]
    for name in weights["names"]:
        res = owner.post(f"{BASE_URL}/api/projects/{code}/classes", json={"name": name})
        assert res.status_code in (200, 201), res.text
    task = owner.post(f"{BASE_URL}/api/projects/{code}/tasks", json={"name": tag()}).json()
    owner.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "in_progress"})

    videos = {}
    for mode in ("cut", "annotate"):
        with open(clip, "rb") as fh:
            res = owner.post(f"{BASE_URL}/api/tasks/{task['id']}/videos",
                             files={"file": ("rsm-agent.mp4", fh, "video/mp4")}, data={"mode": mode})
        assert res.status_code in (200, 201), res.text
        videos[mode] = res.json()

    net = lambda keep: {"weights": weights["id"], "conf": 0.25, "iou": 0.6, "imgsz": 1280,
                        "classes": [{"agent": n, "on": keep(n)} for n in weights["names"]]}
    doc = {"v": 1, "nodes": [
        {"id": "frame", "type": "frame", "params": {}},
        {"id": "person", "type": "net", "params": net(lambda n: n == PERSON)},
        {"id": "rest", "type": "net", "params": net(lambda n: n != PERSON)},
        {"id": "merge", "type": "merge", "params": {"inputs": 2}},
        {"id": "sam", "type": "sam", "params": {}},
        {"id": "out", "type": "output", "params": {}}],
        "edges": [{"from": "frame", "out": "out", "to": "person", "in": "in"},
                  {"from": "frame", "out": "out", "to": "rest", "in": "in"},
                  {"from": "person", "out": "out", "to": "merge", "in": "i0"},
                  {"from": "rest", "out": "out", "to": "merge", "in": "i1"},
                  {"from": "merge", "out": "out", "to": "sam", "in": "in"},
                  {"from": "sam", "out": "out", "to": "out", "in": "in"}]}
    graph = owner.post(f"{BASE_URL}/api/aug/graphs", json={"name": tag(), "kind": "agent"}).json()
    res = owner.post(f"{BASE_URL}/api/aug/graphs/{graph['id']}/versions", json={"doc": doc})
    assert res.status_code in (200, 201), res.text
    try:
        yield {"task": task, "videos": videos, "graph": graph, "code": code}
    finally:
        # Сперва проект: агента с рамками в проектах удалить нельзя — подписи
        # «агент X v1» обезличились бы. Проект уходит каскадом с рамками.
        with db.cursor() as cur:
            cur.execute("DELETE FROM projects WHERE code = %s", (code,))
        res = owner.delete(f"{BASE_URL}/api/aug/graphs/{graph['id']}")
        assert res.status_code == 200, res.text


def _context(owner, setup):
    return owner.get(f"{BASE_URL}/api/agents/tasks/{setup['task']['id']}").json()


def _run(owner, setup, **body):
    """Запустить прогон и дождаться конца. Ролики сперва должны посчитаться."""
    deadline = time.time() + 300
    while time.time() < deadline:
        ctx = _context(owner, setup)
        if all(v["frames"] for v in ctx["videos"]):
            break
        time.sleep(1)
    agent = next(a for a in ctx["agents"] if a["id"] == setup["graph"]["id"])
    version = agent["versions"][0]
    by_name = {c["name"]: c["id"] for c in ctx["classes"]}
    res = owner.post(f"{BASE_URL}/api/agents/tasks/{setup['task']['id']}/runs", json={
        "graph_id": agent["id"], "version_id": version["id"], "sources": [], "step": STEP,
        "mapping": {n: by_name.get(n) for n in version["classes"]}, **body})
    assert res.status_code == 202, res.text
    run_id = res.json()["id"]
    deadline = time.time() + 600
    while time.time() < deadline:
        run = next(r for r in _context(owner, setup)["runs"] if r["id"] == run_id)
        if run["status"] not in ("queued", "waiting_gpu", "running"):
            assert run["status"] == "done", run
            return run
        time.sleep(1)
    raise AssertionError("Прогон агента не кончился за 10 минут")


def _agent_singles(db, video_id):
    with db.cursor() as cur:
        cur.execute("""select v.id, v.frame_no, c.name, v.ann_type, v.source, v.agent_version_id
                       from video_annotations v join classes c on c.id = v.class_id
                       where v.video_id = %s and v.track_id is null order by v.frame_no""", (video_id,))
        return cur.fetchall()


def test_разведка_находит_человека_там_где_он_есть(owner, setup):
    run = _run(owner, setup, mode="scout", videos=[v["id"] for v in setup["videos"].values()], gap=0.5)
    assert run["stats"]["videos"] == 2

    scouts = owner.get(f"{BASE_URL}/api/agents/tasks/{setup['task']['id']}/scouts").json()["scouts"]
    cut, annotate = scouts[setup["videos"]["cut"]["id"]], scouts[setup["videos"]["annotate"]["id"]]
    # Один файл, один декодер — у обоих режимов обязана выйти одна разведка.
    assert cut["segments"] == annotate["segments"]

    people = annotate["segments"].get(PERSON, [])
    for block in _person_blocks():
        assert any(a <= block[-1] and b >= block[0] for a, b, _ in people), (block, people)
    for block in _empty_blocks():
        # Участок, начавшийся в блоке с человеком, заходит в соседний на
        # полшага — это край, а не находка. Середина пустого блока — чиста.
        middle = block[len(block) // 2]
        assert not any(a <= middle <= b for a, b, _ in people), (block, people)
    # Вторая сеть тоже работала: в роликах РСМ-2000 кроме людей есть предметы.
    assert set(annotate["segments"]) - {PERSON}, annotate["segments"]


def test_разметка_ролика_каждый_n_й_кадр_кроме_работы_человека(owner, setup, db):
    task, video = setup["task"], setup["videos"]["annotate"]
    classes = {c["name"]: c for c in owner.get(
        f"{BASE_URL}/api/projects/{setup['code']}/classes").json()["classes"]}
    res = owner.put(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frames/{HUMAN_FRAME}/boxes",
        json={"boxes": [{"class_index": classes[PERSON]["class_index"], "x": 10, "y": 10, "w": 80, "h": 160}]})
    assert res.status_code == 200, res.text

    _run(owner, setup, mode="annotate", videos=[video["id"]])
    rows = _agent_singles(db, video["id"])
    agent = [r for r in rows if r[4] == "model" and r[5]]
    frames = {r[1] for r in agent}
    assert frames <= set(range(0, len(PLAN) * BLOCK, STEP)) - {HUMAN_FRAME}, frames
    assert HUMAN_FRAME not in frames
    # На кадре человека — только его рамка.
    assert [(r[2], r[4]) for r in rows if r[1] == HUMAN_FRAME] == [(PERSON, "human")]
    # Обе сети: человек в блоках с человеком, предметы — от второй сети.
    person_frames = {r[1] for r in agent if r[2] == PERSON}
    assert all(any(f in b for b in _person_blocks()) for f in person_frames), person_frames
    assert person_frames, "сеть «человек» не поставила ни одной рамки"
    assert {r[2] for r in agent} - {PERSON}, "сеть «всё остальное» не поставила ни одной рамки"
    assert any(r[3] == "polygon" for r in agent), "SAM не дал ни одного полигона"

    # Повторный прогон заменяет рамки агента и не трогает рамку человека.
    before = {r[0] for r in agent}
    _run(owner, setup, mode="annotate", videos=[video["id"]])
    again = _agent_singles(db, video["id"])
    assert {r[0] for r in again if r[4] == "model" and r[5]}.isdisjoint(before)
    assert [(r[2], r[4]) for r in again if r[1] == HUMAN_FRAME] == [(PERSON, "human")]


def test_закрытие_отдаёт_кадры_агента_на_проверку(owner, setup, db):
    task, video = setup["task"], setup["videos"]["annotate"]
    rows = [r for r in _agent_singles(db, video["id"]) if r[4] == "model" and r[5]]
    assert rows, "разметка ролика не дала рамок — закрывать нечего"
    # Человек поправил одну рамку агента: этот кадр теперь его.
    touched = rows[0][1]
    body = owner.get(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/annotations").json()
    here = [s for s in body["singles"] if s["frame_no"] == touched]
    wire = [{**s["shape"], "id": s["id"], "class_index": s["class_index"]} for s in here]
    # Сдвиг на 3 px. У контура геометрия — его точки, а не x: сдвигаем их.
    if wire[0].get("parts"):
        wire[0]["parts"] = [[[x + 3, y] for x, y in ring] for ring in wire[0]["parts"]]
    wire[0]["x"] = wire[0]["x"] + 3
    res = owner.put(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frames/{touched}/boxes",
                    json={"boxes": wire})
    assert res.status_code == 200, res.text
    after = {r[0]: r for r in _agent_singles(db, video["id"])}
    assert after[wire[0]["id"]][4] == "human" and after[wire[0]["id"]][5], "правка не сделала рамку человеческой"
    if len(wire) > 1:
        assert after[wire[1]["id"]][4] == "model", "нетронутая рамка агента потеряла авторство"

    res = owner.post(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/close-annotation", json={})
    assert res.status_code == 202, res.text
    job = wait_job(owner, res.json()["job_id"], timeout=300)
    assert job["status"] == "done", job.get("error")

    with db.cursor() as cur:
        cur.execute("""select i.source_frame_no, i.task_status,
                              bool_or(a.agent_version_id is not null and a.source = 'model')
                       from images i join annotations a on a.image_id = i.id
                       where i.source_video_id = %s group by i.id""", (video["id"],))
        made = {f: (status, agent) for f, status, agent in cur.fetchall()}
    assert made[HUMAN_FRAME][0] == "annotated"
    assert made[touched][0] == "annotated"
    pending = {f for f, (status, agent) in made.items() if status == "new"}
    assert pending, "ни один кадр агента не ушёл на проверку"
    assert all(made[f][1] for f in pending), "на проверку ушёл кадр без рамки агента"
