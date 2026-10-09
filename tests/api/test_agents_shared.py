"""Агенты по проекту и права на оборудование (решения 09.10.2026).

Агент личный, подключается к проекту ссылкой: участники видят его на чтение и
запускают, правит только владелец; отключает владелец или admin. Копия — уже
свой агент. Вердикт «влезет ли» считается одной функцией для редактора и
запуска. Права на оборудование — два уровня, выдаёт «Управление».
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


def _login_of(db, session):
    me = session.get(f"{BASE_URL}/api/auth/me").json()
    return (me.get("user") or me)["login"]


def _join(db, session, code, role):
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO project_members (id, project_id, user_id, role, created_at)"
            " SELECT gen_random_uuid(), p.id, u.id, %s::project_role, now() FROM projects p, users u"
            " WHERE p.code = %s AND u.login = %s", (role, code, _login_of(db, session)))


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


@pytest.fixture
def shared(owner, agent, db):
    """Проект владельца с подключённым агентом и двумя участниками: editor и viewer."""
    project = owner.post(f"{BASE_URL}/api/projects", json={"name": tag()}).json()
    code = project["code"]
    editor, viewer = agent_data.session(db), agent_data.session(db)
    _join(db, editor, code, "editor")
    _join(db, viewer, code, "viewer")
    yield code, editor, viewer
    drop_project(db, code)


def test_чужой_агент_виден_только_через_общий_проект(owner, agent, shared):
    code, editor, viewer = shared
    assert viewer.get(f"{BASE_URL}/api/aug/graphs/{agent['id']}").status_code == 404
    res = owner.post(f"{BASE_URL}/api/projects/{code}/agents", json={"graph_id": agent["id"]})
    assert res.status_code == 201, res.text
    got = viewer.get(f"{BASE_URL}/api/aug/graphs/{agent['id']}")
    assert got.status_code == 200, got.text
    assert got.json()["mine"] is False
    # Править чужого нельзя — только копия.
    res = viewer.post(f"{BASE_URL}/api/aug/graphs/{agent['id']}/versions", json={"doc": DOC})
    assert res.status_code == 403


def test_подключает_только_владелец_отключает_владелец_или_admin(owner, agent, shared):
    code, editor, _viewer = shared
    res = editor.post(f"{BASE_URL}/api/projects/{code}/agents", json={"graph_id": agent["id"]})
    assert res.status_code == 404, "чужого агента подключить нельзя"
    owner.post(f"{BASE_URL}/api/projects/{code}/agents", json={"graph_id": agent["id"]})
    assert editor.delete(f"{BASE_URL}/api/projects/{code}/agents/{agent['id']}").status_code == 403
    # Адрес аугментаций агента не отключает — даже не ошибкой, а мимо.
    editor.delete(f"{BASE_URL}/api/projects/{code}/aug/{agent['id']}")
    listed = owner.get(f"{BASE_URL}/api/projects/{code}/agents").json()["agents"]
    assert [a["id"] for a in listed] == [agent["id"]]
    assert owner.delete(f"{BASE_URL}/api/projects/{code}/agents/{agent['id']}").status_code == 200
    assert owner.get(f"{BASE_URL}/api/projects/{code}/agents").json()["agents"] == []


def test_страница_агентов_проекта_с_вердиктом(owner, agent, shared):
    code, _editor, viewer = shared
    owner.post(f"{BASE_URL}/api/projects/{code}/agents", json={"graph_id": agent["id"]})
    body = viewer.get(f"{BASE_URL}/api/projects/{code}/agents").json()
    [row] = body["agents"]
    assert row["mine"] is False and row["owner_here"] is True
    assert row["verdict"]["state"] in ("fits", "wait", "sequential", "never")
    assert row["total_mb"] > 0 and row["version"] == 1
    assert "cards" in body and body["can_link"] is False and body["can_copy"] is False
    assert row["classes"] >= 1 and row["heaviest"]["mb"] > 0
    assert row["runs"] == 0 and row["last_status"] is None


def test_окно_запуска_делит_на_группы(owner, agent, shared, db):
    code, editor, _viewer = shared
    owner.post(f"{BASE_URL}/api/projects/{code}/agents", json={"graph_id": agent["id"]})
    task = owner.post(f"{BASE_URL}/api/projects/{code}/tasks", json={"name": tag()}).json()
    mine = editor.post(f"{BASE_URL}/api/aug/graphs", json={"name": tag(), "kind": "agent"}).json()
    editor.post(f"{BASE_URL}/api/aug/graphs/{mine['id']}/versions", json={"doc": DOC})
    try:
        body = editor.get(f"{BASE_URL}/api/agents/tasks/{task['id']}").json()
        groups = {a["id"]: a["group"] for a in body["agents"]}
        assert groups[agent["id"]] == "project" and groups[mine["id"]] == "mine"
        assert all("verdict" in a for a in body["agents"])
        assert "cards" in body["resources"]
    finally:
        editor.delete(f"{BASE_URL}/api/aug/graphs/{mine['id']}")


def test_копия_становится_своим_агентом(owner, agent, shared):
    code, editor, viewer = shared
    owner.post(f"{BASE_URL}/api/projects/{code}/agents", json={"graph_id": agent["id"]})
    assert viewer.post(f"{BASE_URL}/api/aug/graphs/{agent['id']}/copy").status_code == 403
    res = editor.post(f"{BASE_URL}/api/aug/graphs/{agent['id']}/copy")
    assert res.status_code == 201, res.text
    copy = res.json()
    try:
        assert copy["id"] != agent["id"] and copy["version"] == 1
        got = editor.get(f"{BASE_URL}/api/aug/graphs/{copy['id']}").json()
        assert got["mine"] is True
    finally:
        editor.delete(f"{BASE_URL}/api/aug/graphs/{copy['id']}")


def test_журнал_прогонов_с_картой_и_памятью(owner, agent, shared, db):
    code, _editor, viewer = shared
    task = owner.post(f"{BASE_URL}/api/projects/{code}/tasks", json={"name": tag()}).json()
    run_id = str(uuid.uuid4())
    with db.cursor() as cur:
        cur.execute(
            """insert into agent_runs (id, project_id, task_id, graph_id, params, status, stats, processed, total)
               select %s, p.id, %s, %s, %s, 'done', %s, 10, 10 from projects p where p.code = %s""",
            (run_id, task["id"], agent["id"], json.dumps({"mode": "frames", "mapping": {PERSON: None}}),
             json.dumps({"boxes": 4, "frames": 3, "res": {"card": "RTX 5070 Ti", "want_mb": 7300,
                                                            "sequential": True, "words": {"text": 2}}}),
             code))
    body = viewer.get(f"{BASE_URL}/api/projects/{code}/agent-runs").json()
    [row] = body["runs"]
    assert row["id"] == run_id and row["card"] == "RTX 5070 Ti" and row["want_mb"] == 7300
    assert row["sequential"] is True and row["task"]["name"] == task["name"]
    assert body["facets"]["agents"][0]["id"] == agent["id"]
    assert body["totals"] == {"all": 1, "running": 0, "waiting": 0}
    gone = viewer.get(f"{BASE_URL}/api/projects/{code}/agent-runs", params={"status": "error"}).json()
    assert gone["runs"] == [] and gone["totals"]["all"] == 0


def test_оценка_памяти_по_черновику(owner, agent):
    res = owner.post(f"{BASE_URL}/api/agents/estimate", json={"graph_id": agent["id"], "doc": DOC})
    assert res.status_code == 200, res.text
    body = res.json()
    assert [u["kind"] for u in body["units"]] == ["yoloe"]
    assert body["verdict"]["state"] in ("fits", "wait", "sequential", "never")
    assert body["nodes"]["text"] == body["units"][0]["mb"]


def test_права_на_оборудование(db):
    boss, other = agent_data.session(db), agent_data.session(db)
    assert boss.get(f"{BASE_URL}/api/gpu/access").status_code == 403
    state = other.get(f"{BASE_URL}/api/gpu").json()
    assert state["staff"] is False and "cards" in state, "сводка карт — всем"
    with db.cursor() as cur:
        cur.execute("UPDATE users SET hardware = 'manage' WHERE login = %s", (_login_of(db, boss),))
    found = boss.get(f"{BASE_URL}/api/gpu/access", params={"q": _login_of(db, other)}).json()["found"]
    [row] = found
    res = boss.put(f"{BASE_URL}/api/gpu/access/{row['id']}", json={"level": "view"})
    assert res.status_code == 200 and res.json()["level"] == "view"
    seen = other.get(f"{BASE_URL}/api/gpu").json()
    assert seen["staff"] is True and seen["manage"] is False
    assert other.put(f"{BASE_URL}/api/gpu/access/{row['id']}", json={"level": "manage"}).status_code == 403
    me = boss.get(f"{BASE_URL}/api/gpu/access").json()["granted"]
    boss_id = next(u["id"] for u in me if u["level"] == "manage" and u["login"] == _login_of(db, boss))
    assert boss.put(f"{BASE_URL}/api/gpu/access/{boss_id}", json={"level": None}).status_code == 409
