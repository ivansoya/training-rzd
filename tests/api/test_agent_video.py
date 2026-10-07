"""Агент на ролике: разведка и разметка каждого N-го кадра — на настоящих весах.

Решения владельца (24.09.2026). Проверяется не «ручка отвечает», а «агент
видит»: ролик собран из снимков с людьми и кадров, где людей нет точно
(`agent_data`). Агент — как у владельца: две «Сети» на одних весах (одна ищет
только человека, вторая всё остальное), «Объединение» и «Уточнение SAM».
Веса — COCO `yolo11n.pt` с тома, кладутся на полку свежего владельца.

Ролик — пять блоков по две секунды при 5 к/с, по снимку на блок:
«человек, пусто, человек, пусто, пусто» — пусто в смысле «человека нет».
Разведка обязана найти человека ровно в блоках с человеком; разметка —
поставить рамки на каждый N-й кадр, кроме кадра, где уже поработал человек,
дать полигоны от SAM и рамки обеих сетей; закрытие разметки — отдать кадры
агента на проверку (`new`), а тронутые человеком — размеченными.

Нужен стенд с картой; данные тест заводит сам.
"""
import time
import uuid

import pytest

import agent_data
from agent_data import PERSON
from conftest import BASE_URL, drop_project, tag, wait_job

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
def owner(db):
    return agent_data.session(db)


@pytest.fixture(scope="module")
def weights(owner):
    row = agent_data.shelf_weights(owner)
    assert PERSON in row["names"], row["names"]
    yield row
    owner.delete(f"{BASE_URL}/api/agents/weights/{row['id']}")


@pytest.fixture(scope="module")
def clip(tmp_path_factory):
    """Ролик: блоки со снимками людей и блоки, где людей нет точно."""
    import av

    people = iter(["bus.jpg", "zidane.jpg"])
    frames = [agent_data.place(next(people))[0] if has else agent_data.blank(i)
              for i, has in enumerate(PLAN)]

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

    net = lambda keep: {"weights": weights["id"], "conf": 0.25, "imgsz": 1280,
                        "classes": [{"agent": n, "on": keep(n)} for n in weights["names"]]}
    doc = {"v": 1, "nodes": [
        {"id": "frame", "type": "frame", "params": {}},
        {"id": "person", "type": "net", "params": net(lambda n: n == PERSON)},
        {"id": "rest", "type": "net", "params": net(lambda n: n != PERSON)},
        {"id": "merge", "type": "merge", "params": {"inputs": 2}},
        {"id": "nms", "type": "nms", "params": {"iou": 0.6}},
        {"id": "sam", "type": "sam", "params": {}},
        {"id": "out", "type": "output", "params": {}}],
        "edges": [{"from": "frame", "out": "out", "to": "person", "in": "in"},
                  {"from": "frame", "out": "out", "to": "rest", "in": "in"},
                  {"from": "person", "out": "out", "to": "merge", "in": "i0"},
                  {"from": "rest", "out": "out", "to": "merge", "in": "i1"},
                  {"from": "merge", "out": "out", "to": "nms", "in": "in"},
                  {"from": "nms", "out": "out", "to": "sam", "in": "in"},
                  {"from": "sam", "out": "out", "to": "out", "in": "in"}]}
    graph = owner.post(f"{BASE_URL}/api/aug/graphs", json={"name": tag(), "kind": "agent"}).json()
    res = owner.post(f"{BASE_URL}/api/aug/graphs/{graph['id']}/versions", json={"doc": doc})
    assert res.status_code in (200, 201), res.text
    try:
        yield {"task": task, "videos": videos, "graph": graph, "code": code}
    finally:
        # Сперва проект: агента с рамками в проектах удалить нельзя — подписи
        # «агент X v1» обезличились бы. Проект уходит каскадом с рамками.
        drop_project(db, code)
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
        "mapping": {c["id"]: by_name.get(c["name"]) for c in version["classes"]}, **body})
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
    # Вторая сеть тоже работала: на снимках кроме людей автобус и галстук.
    assert set(annotate["segments"]) - {PERSON}, annotate["segments"]


def test_статистика_разведки_и_nms_без_дублей(owner, setup, db):
    """Идёт после разведки выше: окно статистики сходится с тем, что лежит в
    базе, а узел NMS в воркере не пропустил ни одной пары одного класса."""
    video = setup["videos"]["annotate"]
    res = owner.get(f"{BASE_URL}/api/agents/tasks/{setup['task']['id']}/scouts/{video['id']}")
    assert res.status_code == 200, res.text
    stats = res.json()
    assert stats["file_name"] == "rsm-agent.mp4" and stats["version"] == 1
    assert stats["checked"] == list(range(0, stats["last_frame"] + 1, STEP))
    assert stats["boxes"] == sum(stats["per_frame"]) == sum(c["boxes"] for c in stats["classes"])
    assert {c["name"] for c in stats["classes"]} == set(stats["segments"])
    for c in stats["classes"]:
        assert sum(c["counts"]) == c["boxes"] and sum(c["conf"]["hist"]) == c["boxes"]

    with db.cursor() as cur:
        cur.execute("select frames from video_scouts where video_id = %s", (video["id"],))
        frames = cur.fetchone()[0]

    def iou(a, b):
        ix = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
        iy = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
        union = a[2] * a[3] + b[2] * b[3] - ix * iy
        return ix * iy / union if union else 0

    pairs = [(f, a[0]) for f, dets in frames.items() for i, a in enumerate(dets) for b in dets[i + 1:]
             if a[0] == b[0] and iou(a[2:], b[2:]) >= 0.6]
    assert not pairs, pairs[:5]

    missing = owner.get(f"{BASE_URL}/api/agents/tasks/{setup['task']['id']}/scouts/{uuid.uuid4()}")
    assert missing.status_code == 404


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


def test_агент_на_кадре_из_редактора(owner, setup, db):
    """G в редакторе ролика: рамки встают на проверку, повторный вызов заменяет
    непроверенное, а подтверждённое не дублирует (решение 2026-10-07)."""
    task, video = setup["task"], setup["videos"]["annotate"]
    url = f"{BASE_URL}/api/agents/tasks/{task['id']}/apply"
    frame = 2   # блок с человеком, мимо плана каждого N-го кадра
    body = {"graph_id": setup["graph"]["id"],
            "version_id": _context(owner, setup)["agents"][0]["versions"][0]["id"],
            "video_id": video["id"], "frame_no": frame}
    res = owner.post(url, json=body)
    assert res.status_code == 200, res.text
    assert res.json()["put"] > 0
    with db.cursor() as cur:
        cur.execute("select id, pending from video_annotations where video_id = %s and frame_no = %s",
                    (video["id"], frame))
        first = cur.fetchall()
    assert first and all(p for _, p in first), first

    # Повторный вызов — «перепрогнать»: прежнее непроверенное заменяется, а не копится
    again = owner.post(url, json=body).json()
    with db.cursor() as cur:
        cur.execute("select id from video_annotations where video_id = %s and frame_no = %s", (video["id"], frame))
        second = {r[0] for r in cur.fetchall()}
    assert len(second) == again["put"] and second.isdisjoint({r[0] for r in first})

    # Подтвердили кадр — агент те же объекты больше не предлагает
    singles = owner.get(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/annotations").json()["singles"]
    wire = [{**s["shape"], "id": s["id"], "class_index": s["class_index"], "pending": False}
            for s in singles if s["frame_no"] == frame]
    res = owner.put(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frames/{frame}/boxes",
                    json={"boxes": wire})
    assert res.status_code == 200 and res.json()["pending"] == 0, res.text
    third = owner.post(url, json=body).json()
    assert third["put"] == 0, third

    # Изображение таски: ответ несёт разметку кадра, рамки — на проверке
    images = owner.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"]
    if images:
        got = owner.post(url, json={**{k: body[k] for k in ("graph_id", "version_id")},
                                    "image_id": images[0]["id"]}).json()
        assert all(b["pending"] for b in got["boxes"] if b["source"] == "model")


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
