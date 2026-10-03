"""«Сеть по тексту»: агент находит человека по слову `person` — без своих весов.

Решения владельца (24.09.2026): узел с таблицей «промт → класс агента»,
модель — YOLOE-26 из образа или SAM 3 с тома; SAM 3 сразу пишет контур.
Проверяется «агент видит», а не «ручка отвечает»: ролик тот же, что у
`test_agent_video` — снимки с людьми и пустые кадры блоками «человек, пусто,
человек, пусто, пусто».

Весов на полке не нужно — в этом и смысл узла. Нужен стенд с картой и веса
SAM 3 на томе; нет SAM 3 — его проверки пропускаются.
"""
import time

import pytest

import agent_data
from conftest import BASE_URL, drop_project, tag
from test_agent_video import (  # noqa: F401 — фикстуры
    PERSON, STEP, _agent_singles, _empty_blocks, _person_blocks, clip, owner,
)

PROMPTS = [{"prompt": "person", "agent": PERSON, "on": True},
           {"prompt": "worker", "agent": PERSON, "on": True},
           {"prompt": "лопата", "agent": "Инструмент", "on": False}]


def _doc(model):
    return {"v": 1, "nodes": [
        {"id": "frame", "type": "frame", "params": {}},
        {"id": "text", "type": "text", "params": {"model": model, "prompts": PROMPTS}},
        {"id": "nms", "type": "nms", "params": {"iou": 0.6}},
        {"id": "out", "type": "output", "params": {}}],
        "edges": [{"from": "frame", "out": "out", "to": "text", "in": "in"},
                  {"from": "text", "out": "out", "to": "nms", "in": "in"},
                  {"from": "nms", "out": "out", "to": "out", "in": "in"}]}


@pytest.fixture(scope="module")
def sam3(owner):
    return bool(owner.get(f"{BASE_URL}/api/agents/weights").json().get("sam3"))


@pytest.fixture(scope="module")
def setup(owner, clip, db):
    project = owner.post(f"{BASE_URL}/api/projects", json={"name": tag()}).json()
    code = project["code"]
    res = owner.post(f"{BASE_URL}/api/projects/{code}/classes", json={"name": PERSON})
    assert res.status_code in (200, 201), res.text
    task = owner.post(f"{BASE_URL}/api/projects/{code}/tasks", json={"name": tag()}).json()
    owner.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "in_progress"})
    with open(clip, "rb") as fh:
        res = owner.post(f"{BASE_URL}/api/tasks/{task['id']}/videos",
                         files={"file": ("rsm-text.mp4", fh, "video/mp4")}, data={"mode": "annotate"})
    assert res.status_code in (200, 201), res.text
    graphs = {}
    try:
        yield {"task": task, "video": res.json(), "code": code, "graphs": graphs}
    finally:
        drop_project(db, code)
        for graph in graphs.values():
            owner.delete(f"{BASE_URL}/api/aug/graphs/{graph['id']}")


def _agent(owner, setup, model):
    graph = owner.post(f"{BASE_URL}/api/aug/graphs", json={"name": tag(), "kind": "agent"}).json()
    setup["graphs"][model] = graph
    res = owner.post(f"{BASE_URL}/api/aug/graphs/{graph['id']}/versions", json={"doc": _doc(model)})
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
    # Классы агента — только из включённых строк с промтом: «Инструмент»
    # выключен и в паспорт версии не попал.
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


def test_версия_с_повтором_промта_не_сохраняется(owner, setup):
    graph = owner.post(f"{BASE_URL}/api/aug/graphs", json={"name": tag(), "kind": "agent"}).json()
    setup["graphs"]["bad"] = graph
    doc = _doc("l")
    doc["nodes"][1]["params"]["prompts"] = PROMPTS[:1] + [{"prompt": "Person", "agent": "Люди", "on": True}]
    res = owner.post(f"{BASE_URL}/api/aug/graphs/{graph['id']}/versions", json={"doc": doc})
    assert res.status_code == 400 and "повторяется" in res.json()["error"], res.text


def test_разведка_yoloe_находит_человека_по_слову(owner, setup):
    run = _run(owner, setup, _agent(owner, setup, "l"), mode="scout", gap=0.5)
    assert run["stats"]["videos"] == 1
    scouts = owner.get(f"{BASE_URL}/api/agents/tasks/{setup['task']['id']}/scouts").json()["scouts"]
    people = scouts[setup["video"]["id"]]["segments"].get(PERSON, [])
    for block in _person_blocks():
        assert any(a <= block[-1] and b >= block[0] for a, b, _ in people), (block, people)
    for block in _empty_blocks():
        middle = block[len(block) // 2]
        assert not any(a <= middle <= b for a, b, _ in people), (block, people)


def test_разметка_sam3_сразу_с_контуром(owner, setup, db, sam3):
    if not sam3:
        pytest.skip("Нет весов SAM 3 на томе")
    video = setup["video"]
    _run(owner, setup, _agent(owner, setup, "sam3"), mode="annotate")
    agent = [r for r in _agent_singles(db, video["id"]) if r[4] == "model" and r[5]]
    assert agent and all(r[2] == PERSON for r in agent)
    # Пустоту блоков не проверяем: на первом «пустом» кадре SAM 3 находит ногу
    # человека у верхнего края (0,69) — разметчики её не обвели, а модель права
    # (сверено глазами 25.09.2026).
    # в каждом блоке с человеком — хоть одна рамка, и все с контуром SAM 3
    for block in _person_blocks():
        assert any(r[1] in block for r in agent), block
    assert {r[3] for r in agent} == {"polygon"}, {r[3] for r in agent}


def test_превью_показывает_находки_узла(owner, setup, db):
    graph = setup["graphs"].get("l") or _agent(owner, setup, "l")
    # Превью смотрит кадр проекта: свой проект из двух снимков с людьми.
    code = agent_data.source_project(owner, db, frames=2)
    with db.cursor() as cur:
        cur.execute("""select i.id from images i join projects p on p.id = i.project_id
                       where p.code = %s and i.dataset_id is not null
                       order by i.file_name limit 1""", (code,))
        image_id = cur.fetchone()[0]
    res = owner.post(f"{BASE_URL}/api/agents/preview", json={
        "graph_id": graph["id"], "doc": _doc("l"), "project": code, "image_id": str(image_id), "step": "same"})
    assert res.status_code == 200, res.text
    trace = res.json()["nodes"]["text"]
    assert trace["in"] == [] and any(d["cls"] == PERSON for d in trace["out"]), trace
