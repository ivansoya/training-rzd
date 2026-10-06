"""Экран «Мои агенты» и редактор агента (редизайн 2026-10-06).

Список отдаёт у агента запуски в тасках, поставленные рамки и последний запуск — разведка
рамок не ставит и в счёт не идёт. «Превью на 6 кадрах» — один запрос: «Выход» агента на
нескольких случайных кадрах проекта, модели прогреваются один раз.
"""
import json
import uuid

import pytest

import agent_data
from conftest import BASE_URL, drop_project, tag

PERSON = agent_data.PERSON
DOC = {"v": 1, "nodes": [
    {"id": "frame", "type": "frame", "params": {}},
    {"id": "text", "type": "text", "params": {"model": "s", "prompts": [{"prompt": "person", "agent": PERSON, "on": True}]}},
    {"id": "out", "type": "output", "params": {}}],
    "edges": [{"from": "frame", "out": "out", "to": "text", "in": "in"},
              {"from": "text", "out": "out", "to": "out", "in": "in"}]}


@pytest.fixture(scope="module")
def owner(db):
    return agent_data.session(db)


@pytest.fixture(scope="module")
def agent(owner):
    graph = owner.post(f"{BASE_URL}/api/aug/graphs", json={"name": tag(), "kind": "agent"}).json()
    res = owner.post(f"{BASE_URL}/api/aug/graphs/{graph['id']}/versions", json={"doc": DOC})
    assert res.status_code in (200, 201), res.text
    yield graph
    owner.delete(f"{BASE_URL}/api/aug/graphs/{graph['id']}")


def _row(owner, graph_id):
    rows = owner.get(f"{BASE_URL}/api/aug/graphs", params={"kind": "agent"}).json()["graphs"]
    return next(g for g in rows if g["id"] == graph_id)


def test_список_агентов_считает_запуски_и_рамки(owner, agent, db):
    fresh = _row(owner, agent["id"])
    assert (fresh["runs"], fresh["boxes"], fresh["last_run_at"]) == (0, 0, None)
    assert [c["name"] for c in fresh["stats"]["classes"]] == [PERSON]

    project = owner.post(f"{BASE_URL}/api/projects", json={"name": tag()}).json()
    task = owner.post(f"{BASE_URL}/api/projects/{project['code']}/tasks", json={"name": tag()}).json()
    try:
        with db.cursor() as cur:
            for mode, boxes in (("frames", 7), ("annotate", 5), ("scout", 40)):
                cur.execute(
                    """insert into agent_runs (id, project_id, task_id, graph_id, params, status, stats)
                       select %s, p.id, %s, %s, %s, 'done', %s from projects p where p.code = %s""",
                    (str(uuid.uuid4()), task["id"], agent["id"], json.dumps({"mode": mode}),
                     json.dumps({"boxes": boxes, "frames": 3}), project["code"]))
        got = _row(owner, agent["id"])
        assert got["runs"] == 3
        assert got["boxes"] == 12, "находки разведки не рамки"
        assert got["last_run_at"]
    finally:
        drop_project(db, project["code"])


def test_превью_на_нескольких_кадрах_одним_запросом(owner, agent, db):
    code = agent_data.source_project(owner, db, frames=3)
    try:
        res = owner.post(f"{BASE_URL}/api/agents/preview/frames",
                         json={"graph_id": agent["id"], "doc": DOC, "project": code, "count": 6})
        assert res.status_code == 200, res.text
        body = res.json()
        # Кадров в проекте три — больше и не придёт.
        assert len(body["frames"]) == 3
        assert len({f["image"]["id"] for f in body["frames"]}) == 3
        for f in body["frames"]:
            assert f["human"], "ручная разметка кадра нужна для сравнения"
            assert any(d["cls"] == PERSON for d in f["out"]), f
        assert body["device"] in ("cuda", "cpu") and body["ms"] >= 0
    finally:
        drop_project(db, code)


def test_пакет_кадров_чужого_агента_не_считается(owner, agent, db):
    stranger = agent_data.session(db)
    res = stranger.post(f"{BASE_URL}/api/agents/preview/frames",
                        json={"graph_id": agent["id"], "doc": DOC, "project": "нет", "count": 6})
    assert res.status_code == 404
