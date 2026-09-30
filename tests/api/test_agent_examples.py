"""Образцы для «Сети по тексту»: агент находит человека по образцам из разметки.

Решения владельца (25.09.2026): набор собирается из ручных рамок класса в
датасетах проекта, лежит на полке неизменяемым; «убрать», «переставить» и
«добрать» дают новый набор. YOLOE берёт средний вектор образцов, SAM 3 —
коллаж из первых вырезок. Ролик и проверка — как у `test_agent_text`:
кадры «РСМ-2000 · тест» блоками «человек, пусто, человек, пусто, пусто».

Нужны стенд с картой и копия РСМ-2000; нет SAM 3 на томе — его проверка
пропускается.
"""
import time

import pytest

from conftest import BASE_URL, tag
from test_agent_text import setup  # noqa: F401 — фикстура
from test_agent_video import (  # noqa: F401 — фикстуры
    PERSON, STEP, _agent_singles, _empty_blocks, _person_blocks, clip, owner,
)

SOURCE = "РСМ-2000 · тест"


@pytest.fixture(scope="module")
def source(owner, db):
    with db.cursor() as cur:
        cur.execute("select code from projects where name = %s", (SOURCE,))
        row = cur.fetchone()
    if row is None:
        pytest.skip(f"Нет проекта «{SOURCE}»")
    got = owner.get(f"{BASE_URL}/api/agents/examples/sources", params={"project": row[0]})
    assert got.status_code == 200, got.text
    return got.json()


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
    assert version["classes"] == [PERSON]
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
    # сперва по одной рамке с кадра: людей на РСМ больше, чем 16 кадров
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


def test_превью_по_образцам(owner, setup, db, people):
    graph = setup["graphs"].get("examples-l") or _agent(owner, setup, "l", people["id"])
    with db.cursor() as cur:
        cur.execute("""select i.id, p.code from images i join projects p on p.id = i.project_id
                       join annotations a on a.image_id = i.id join classes c on c.id = a.class_id
                       where p.name = %s group by i.id, i.file_name, p.code
                       having bool_or(c.name = %s) order by i.file_name limit 1""", (SOURCE, PERSON))
        image_id, code = cur.fetchone()
    res = owner.post(f"{BASE_URL}/api/agents/preview", json={
        "graph_id": graph["id"], "doc": _doc("l", people["id"]), "project": code,
        "image_id": str(image_id), "step": "same"})
    assert res.status_code == 200, res.text
    assert any(d["cls"] == PERSON for d in res.json()["nodes"]["text"]["out"])
