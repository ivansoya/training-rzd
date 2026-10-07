"""Образцы для «Сети по тексту»: агент находит человека по образцам из разметки.

Решения владельца (25.09.2026): набор собирается из ручных рамок класса в
датасетах проекта, лежит на полке неизменяемым; «убрать», «переставить» и
«добрать» дают новый набор. YOLOE берёт средний вектор образцов, SAM 3 —
коллаж из первых вырезок. Ролик и проверка — как у `test_agent_text`.
Источник образцов — свой проект со снимками людей и ручными рамками
(`agent_data.source_project`).

Нужен стенд с картой; нет SAM 3 на томе — его проверка пропускается.
"""
import time

import pytest

import agent_data
from conftest import BASE_URL, drop_project, tag
from test_agent_text import setup  # noqa: F401 — фикстура
from test_agent_video import (  # noqa: F401 — фикстуры
    PERSON, STEP, _agent_singles, _empty_blocks, _person_blocks, clip, owner,
)

@pytest.fixture(scope="module")
def source(owner, db):
    code = agent_data.source_project(owner, db)
    got = owner.get(f"{BASE_URL}/api/agents/examples/sources", params={"project": code})
    assert got.status_code == 200, got.text
    yield got.json()
    drop_project(db, code)


@pytest.fixture(scope="module")
def people(owner, source):
    """Набор «Человек», 16 образцов — общий для проверок ниже."""
    cls = next(c for c in source["classes"] if c["name"] == PERSON)
    res = owner.post(f"{BASE_URL}/api/agents/examples", json={
        "project": source["project"]["code"], "class_id": cls["id"], "n": 16, "collage": 6, "ctx": 2.5})
    assert res.status_code == 201, res.text
    return res.json()["set"]


def _doc(model, set_id):
    return {"v": 1, "nodes": [
        {"id": "frame", "type": "frame", "params": {}},
        {"id": "text", "type": "text", "params": {"model": model, "prompts": [
            {"kind": "examples", "set": set_id, "agent": PERSON, "on": True, "conf": 0.1 if model != "sam3" else 0.4}]}},
        {"id": "nms", "type": "nms", "params": {"iou": 0.6}},
        {"id": "out", "type": "output", "params": {}}],
        "edges": [{"from": "frame", "out": "out", "to": "text", "in": "in"},
                  {"from": "text", "out": "out", "to": "nms", "in": "in"},
                  {"from": "nms", "out": "out", "to": "out", "in": "in"}]}


def _agent(owner, setup, model, set_id):
    graph = owner.post(f"{BASE_URL}/api/aug/graphs", json={"name": tag(), "kind": "agent"}).json()
    setup["graphs"][f"examples-{model}"] = graph
    res = owner.post(f"{BASE_URL}/api/aug/graphs/{graph['id']}/versions", json={"doc": _doc(model, set_id)})
    assert res.status_code in (200, 201), res.text
    return graph


def _run(owner, setup, graph, **body):
    url = f"{BASE_URL}/api/agents/tasks/{setup['task']['id']}"
    deadline = time.time() + 300
    while time.time() < deadline:
        ctx = owner.get(url).json()
        if all(v["frames"] for v in ctx["videos"]):
            break
        time.sleep(1)
    agent = next(a for a in ctx["agents"] if a["id"] == graph["id"])
    version = agent["versions"][0]
    assert [c["name"] for c in version["classes"]] == [PERSON]
    person = next(c["id"] for c in ctx["classes"] if c["name"] == PERSON)
    res = owner.post(f"{url}/runs", json={
        "graph_id": agent["id"], "version_id": version["id"], "sources": [], "step": STEP,
        "mapping": {PERSON: person}, "videos": [setup["video"]["id"]], **body})
    assert res.status_code == 202, res.text
    run_id = res.json()["id"]
    deadline = time.time() + 600
    while time.time() < deadline:
        run = next(r for r in owner.get(url).json()["runs"] if r["id"] == run_id)
        if run["status"] not in ("queued", "waiting_gpu", "running"):
            assert run["status"] == "done", run
            return run
        time.sleep(1)
    raise AssertionError("Прогон агента не кончился за 10 минут")


def test_источники_считают_годные_рамки(source):
    cls = next(c for c in source["classes"] if c["name"] == PERSON)
    usable = sum(d["usable"] for d in cls["datasets"].values())
    assert usable > 16 and {d["id"] for d in source["datasets"]} >= set(cls["datasets"])


def test_набор_с_разных_кадров_и_вырезки(owner, people):
    assert people["status"] == "ready" and len(people["items"]) == 16
    # сперва по одной рамке с кадра: людей на снимках больше, чем 16 кадров
    assert people["frames"] == 16
    uid = people["items"][0]["uid"]
    crop = owner.get(f"{BASE_URL}/api/agents/examples/{people['id']}/crops/{uid}")
    assert crop.status_code == 200 and crop.headers["Content-Type"] == "image/jpeg" and len(crop.content) > 1000


def test_убрать_переставить_добрать_дают_новый_набор(owner, people):
    uids = [it["uid"] for it in people["items"]]
    order = list(reversed(uids[1:]))
    res = owner.post(f"{BASE_URL}/api/agents/examples/{people['id']}/derive", json={"order": order, "collage": 3})
    assert res.status_code == 201, res.text
    child = res.json()["set"]
    assert child["id"] != people["id"] and child["parent_id"] == people["id"]
    assert [it["uid"] for it in child["items"]] == order and child["params"]["collage"] == 3
    res = owner.post(f"{BASE_URL}/api/agents/examples/{child['id']}/derive", json={"add": 4})
    assert res.status_code == 201, res.text
    grown = res.json()["set"]
    got = [it["uid"] for it in grown["items"]]
    # старые — на своих местах, новые — в конце и не повторяют ни одного взятого
    assert got[:15] == order and len(got) == 19 and not set(got[15:]) & set(uids)
    listed = owner.get(f"{BASE_URL}/api/agents/examples", params={"ids": f"{people['id']},{grown['id']}"}).json()
    assert {s["id"] for s in listed["sets"]} == {people["id"], grown["id"]}


def _boxes(owner, source):
    cls = next(c for c in source["classes"] if c["name"] == PERSON)
    got = owner.get(f"{BASE_URL}/api/agents/examples/boxes",
                    params={"project": source["project"]["code"], "class_id": cls["id"]})
    assert got.status_code == 200, got.text
    return cls, got.json()


def test_рамки_класса_для_окна_выбора(owner, source):
    _, got = _boxes(owner, source)
    boxes = got["boxes"]
    assert len(boxes) > 16 and got["frames"] == len({b["image_id"] for b in boxes})
    assert 1 <= got["objects"] <= len(boxes) and {"uid", "image_id", "box", "group", "frame"} <= set(boxes[0])
    b = boxes[0]
    crop = owner.get(f"{BASE_URL}/api/agents/examples/boxes/crop",
                     params={"image": b["image_id"], "box": ",".join(str(v) for v in b["box"])})
    assert crop.status_code == 200 and crop.headers["Content-Type"] == "image/jpeg", crop.text
    assert owner.get(f"{BASE_URL}/api/agents/examples/boxes/crop",
                     params={"image": b["image_id"], "box": "1,2"}).status_code == 400
    assert owner.get(f"{BASE_URL}/api/agents/examples/boxes/crop",
                     params={"image": "00000000-0000-0000-0000-000000000000", "box": "1,2,3,4"}).status_code == 404


def test_коллаж_как_видит_sam3(owner, source, people):
    _, got = _boxes(owner, source)
    boxes = got["boxes"][:13]
    items = [{"image_id": b["image_id"], "box": b["box"]} for b in boxes]
    frame = people["items"][0]["image_id"]
    url = f"{BASE_URL}/api/agents/examples/collage"
    res = owner.post(url, json={"image_id": frame, "items": items, "side": 1008, "pass": 0})
    assert res.status_code == 200 and res.headers["Content-Type"] == "image/jpeg", res.text
    # 13 образцов — минимум два прохода (по 12 на широком кадре, по 6 на высоком)
    assert int(res.headers["X-Passes"]) >= 2
    import cv2
    import numpy as np
    pic = cv2.imdecode(np.frombuffer(res.content, np.uint8), cv2.IMREAD_COLOR)
    assert pic.shape[:2] == (1008, 1008)
    small = owner.post(url, json={"image_id": frame, "items": items[:2], "side": 644, "tile": 640})
    assert small.status_code == 200 and small.headers["X-Passes"] == "1"
    assert owner.post(url, json={"image_id": frame, "items": items, "side": 900}).status_code == 400
    assert owner.post(url, json={"image_id": frame, "items": []}).status_code == 400
    assert owner.post(url, json={"image_id": "00000000-0000-0000-0000-000000000000", "items": items[:1]}).status_code == 404


def test_набор_вручную_в_заданном_порядке(owner, source, people):
    cls, got = _boxes(owner, source)
    taken = {it["uid"] for it in people["items"]}
    fresh = [b for b in got["boxes"] if b["uid"] not in taken][:2]
    picked = [fresh[1], fresh[0]]
    res = owner.post(f"{BASE_URL}/api/agents/examples", json={
        "project": source["project"]["code"], "class_id": cls["id"],
        "items": [{"image_id": b["image_id"], "box": b["box"]} for b in picked]})
    assert res.status_code == 201, res.text
    assert [it["uid"] for it in res.json()["set"]["items"]] == [b["uid"] for b in picked]
    # от набора-основы: его образцы не пересчитываются, порядок — заданный
    keep = people["items"][:3]
    items = [{"image_id": it["image_id"], "box": it["box"]} for it in [keep[2], keep[0]]] + \
            [{"image_id": fresh[0]["image_id"], "box": fresh[0]["box"]}, {"image_id": keep[1]["image_id"], "box": keep[1]["box"]}]
    res = owner.post(f"{BASE_URL}/api/agents/examples", json={
        "project": source["project"]["code"], "class_id": cls["id"], "items": items, "from": people["id"]})
    assert res.status_code == 201, res.text
    made = res.json()["set"]
    assert made["parent_id"] == people["id"]
    assert [it["uid"] for it in made["items"]] == [keep[2]["uid"], keep[0]["uid"], fresh[0]["uid"], keep[1]["uid"]]
    # случайный добор ручного набора не повторяет ручной список, а добирает
    res = owner.post(f"{BASE_URL}/api/agents/examples/{made['id']}/derive", json={"add": 2})
    assert res.status_code == 201, res.text
    grown = [it["uid"] for it in res.json()["set"]["items"]]
    assert grown[:4] == [it["uid"] for it in made["items"]] and len(grown) == 6


def test_набор_вручную_отказ_на_чужую_рамку(owner, source):
    cls, got = _boxes(owner, source)
    b = got["boxes"][0]
    res = owner.post(f"{BASE_URL}/api/agents/examples", json={
        "project": source["project"]["code"], "class_id": cls["id"],
        "items": [{"image_id": b["image_id"], "box": [1, 1, 30, 30]}]})
    assert res.status_code == 422 and "больше нет в ручной разметке" in res.json()["error"], res.text
    res = owner.post(f"{BASE_URL}/api/agents/examples", json={
        "project": source["project"]["code"], "class_id": cls["id"], "items": [{"image_id": "x"}]})
    assert res.status_code == 400, res.text


def test_версия_с_чужим_набором_не_сохраняется(owner, setup):
    graph = owner.post(f"{BASE_URL}/api/aug/graphs", json={"name": tag(), "kind": "agent"}).json()
    setup["graphs"]["examples-bad"] = graph
    res = owner.post(f"{BASE_URL}/api/aug/graphs/{graph['id']}/versions",
                     json={"doc": _doc("l", "00000000-0000-0000-0000-000000000000")})
    assert res.status_code == 400 and "нет на вашей полке" in res.json()["error"], res.text


def test_разведка_yoloe_по_образцам_находит_человека(owner, setup, people):
    _run(owner, setup, _agent(owner, setup, "l", people["id"]), mode="scout", gap=0.5)
    scouts = owner.get(f"{BASE_URL}/api/agents/tasks/{setup['task']['id']}/scouts").json()["scouts"]
    found = scouts[setup["video"]["id"]]["segments"].get(PERSON, [])
    for block in _person_blocks():
        assert any(a <= block[-1] and b >= block[0] for a, b, _ in found), (block, found)
    for block in _empty_blocks():
        middle = block[len(block) // 2]
        assert not any(a <= middle <= b for a, b, _ in found), (block, found)


def test_разметка_sam3_по_образцам_коллажем(owner, setup, db, people):
    if not owner.get(f"{BASE_URL}/api/agents/weights").json().get("sam3"):
        pytest.skip("Нет весов SAM 3 на томе")
    _run(owner, setup, _agent(owner, setup, "sam3", people["id"]), mode="annotate")
    agent = [r for r in _agent_singles(db, setup["video"]["id"]) if r[4] == "model" and r[5]]
    assert agent and all(r[2] == PERSON for r in agent)
    for block in _person_blocks():
        assert any(r[1] in block for r in agent), block
    assert {r[3] for r in agent} == {"polygon"}


def test_превью_по_образцам(owner, setup, db, source, people):
    graph = setup["graphs"].get("examples-l") or _agent(owner, setup, "l", people["id"])
    code = source["project"]["code"]
    with db.cursor() as cur:
        cur.execute("""select i.id from images i join projects p on p.id = i.project_id
                       where p.code = %s and i.dataset_id is not null
                       order by i.file_name limit 1""", (code,))
        image_id = cur.fetchone()[0]
    res = owner.post(f"{BASE_URL}/api/agents/preview", json={
        "graph_id": graph["id"], "doc": _doc("l", people["id"]), "project": code,
        "image_id": str(image_id), "step": "same"})
    assert res.status_code == 200, res.text
    assert any(d["cls"] == PERSON for d in res.json()["nodes"]["text"]["out"])
