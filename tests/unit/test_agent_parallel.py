"""Очередь копий: реальные транзакции PostgreSQL, без моделей и видеокарты.

PARALLEL_TEST_DATABASE_URL задаётся только для отдельной тестовой базы.
"""
import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from common import agent_parallel as ap
from common.db import Base
from common.models import AgentRun, AugGraph, AugGraphVersion, Image, Project, ProjectMember, Task, TaskVideo, User, VideoScout


def test_память_не_складывает_щели_разных_карт():
    cards = [{"cap_mb": 12000, "free_mb": 5900}, {"cap_mb": 12000, "free_mb": 5900}]
    assert ap.capacity([6000], cards, 10) == 0
    assert ap.capacity([3000, 3000], cards, 10) == 1


def test_контекст_каждой_копии_и_потолок_работ():
    cards = [{"cap_mb": 12000, "free_mb": 11000}]
    assert ap.capacity([5500], cards, 20) == 2
    assert ap.capacity([5501], cards, 20) == 1
    assert ap.capacity([1000], cards, 3) == 3
    assert ap.capacity([1000], cards, 20, limit=8) == 8


@pytest.fixture(scope="module")
def sessions():
    url = os.environ.get("PARALLEL_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Нужна отдельная PostgreSQL: PARALLEL_TEST_DATABASE_URL")
    engine = create_engine(url)
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, expire_on_commit=False)
    engine.dispose()


@pytest.fixture
def setup(sessions):
    with sessions() as db:
        key = uuid.uuid4().hex
        user = User(email=f"{key}@test.invalid", login=key, display_name="Тест", password_hash="test")
        project = Project(name="test-parallel", code=key[:20])
        db.add_all([user, project]); db.commit()
        db.add(ProjectMember(project_id=project.id, user_id=user.id, role="admin")); db.commit()
        task = Task(project_id=project.id, name="test-parallel", status="in_progress", created_by=user.id)
        graph = AugGraph(name=key, kind="agent", owner_id=user.id)
        db.add_all([task, graph]); db.commit()
        doc = {"v": 1, "nodes": [{"id": "frame", "type": "frame", "params": {}},
            {"id": "text", "type": "text", "params": {"model": "s", "prompts": [{"on": True, "agent": "человек", "prompt": "person"}]}},
            {"id": "out", "type": "output", "params": {}}], "edges": [
                {"from": "frame", "out": "out", "to": "text", "in": "in"},
                {"from": "text", "out": "out", "to": "out", "in": "in"}]}
        version = AugGraphVersion(graph_id=graph.id, version=1, digest=key, doc=doc)
        db.add(version); db.commit()
        graph.head_version_id = version.id
        videos = [TaskVideo(task_id=task.id, file_name=f"{i}.mp4", file_path="unused", mode="annotate", frame_count=100)
                  for i in range(5)]
        db.add_all(videos); db.commit()
        yield dict(user=user.id, project=project.id, task=task.id, graph=graph.id, version=version.id,
                   videos=[str(v.id) for v in videos])
        db.delete(project); db.commit()
        db.delete(graph); db.delete(user); db.commit()


def group(db, setup, count=2, mode="scout"):
    run = AgentRun(project_id=setup["project"], task_id=setup["task"], graph_id=setup["graph"],
        version_id=setup["version"], created_by=setup["user"],
        params={"mode": mode, "step": 25, "videos": setup["videos"], "sources": ["files"], "mapping": {}})
    work = ap.items(db, run)
    ap.create(db, run, work, count); db.commit()
    return run, ap.children(db, run.id)


def test_одновременно_выдаются_разные_целые_ролики(sessions, setup):
    with sessions() as db:
        parent, copies = group(db, setup, 3)
        ids = [r.id for r in copies]
    def take(run_id):
        with sessions() as db:
            return ap.take(db, db.get(AgentRun, run_id))
    with ThreadPoolExecutor(max_workers=3) as pool:
        got = list(pool.map(take, ids))
    assert len({w["videos"][0] for w in got}) == 3
    assert all(len(w["videos"]) == 1 for w in got)
    with sessions() as db:
        assert len(db.get(AgentRun, parent.id).params["pending"]) == 2
        assert take(ids[0]) == got[0]  # восстановление после перезапуска


def test_ошибка_одной_копии_не_мешает_другим_и_повтор_сохраняет_назначение(sessions, setup):
    with sessions() as db:
        parent, (failed, other) = group(db, setup)
        held = ap.take(db, failed)
        failed.status, failed.error = "error", "test failure"
        db.commit()
        seen = []
        while item := ap.take(db, other):
            seen.extend(item["videos"])
            ap.complete(db, other)
        other.status = "done"; db.commit(); ap.sync(db, parent.id)
        assert parent.status == "error"
        assert held["videos"][0] not in seen and len(seen) == 4
        ap.resume(failed); ap.resume(parent); db.commit()
        assert ap.take(db, failed) == held
        ap.complete(db, failed)
        failed.status = "done"; db.commit(); ap.sync(db, parent.id)
        assert parent.status == "done" and parent.processed == parent.total == 20


def test_пачки_кадров_не_пересекаются_и_не_берут_работу_человека(sessions, setup):
    with sessions() as db:
        db.add_all([Image(project_id=setup["project"], task_id=setup["task"], file_name=f"{i:04}.jpg",
                         file_path="unused", task_status="annotated" if i == 0 else "new") for i in range(126)])
        db.commit()
        parent, copies = group(db, setup, 3, "frames")
        batches = [ap.take(db, r)["images"] for r in copies]
        assert list(map(len, batches)) == [60, 60, 5]
        assert len(set(i for b in batches for i in b)) == 125
        assert parent.total == 125


def test_вторая_группа_не_может_перезаписать_активную(sessions, setup):
    with sessions() as db:
        parent, copies = group(db, setup)
        assert len(copies) == 2
        with pytest.raises(IntegrityError):
            group(db, setup)
        db.rollback()
        assert db.get(AgentRun, parent.id).status == "queued"


def test_остановка_не_теряет_очередь_и_завершённую_работу(sessions, setup):
    with sessions() as db:
        parent, copies = group(db, setup)
        ap.take(db, copies[0]); ap.complete(db, copies[0])
        held = ap.take(db, copies[1])
        parent.cancel_requested = True
        for child in copies:
            ap.stop(db, child)
        db.commit(); ap.sync(db, parent.id)
        assert parent.status == "stopped" and parent.processed == 4
        assert len(parent.params["pending"]) == 3
        for child in copies:
            ap.resume(child)
        ap.resume(parent); db.commit()
        assert ap.take(db, copies[1]) == held
        assert len(parent.stats["completed_videos"]) == 1


def test_настоящий_цикл_раннера_берёт_следующую_пачку_без_повторной_загрузки(sessions, setup, monkeypatch):
    from training_svc import agent_runner as runner
    with sessions() as db:
        db.add_all([Image(project_id=setup["project"], task_id=setup["task"], file_name=f"{i:03}.jpg",
                         file_path="unused") for i in range(121)])
        db.commit()
        parent, copies = group(db, setup, 1, "frames")
        copy = copies[0]; copy.status = "running"; db.commit()
        loads, visited = [], []
        class Work:
            def __init__(self, *args): loads.append(True)
            def frame(self, image_id, *_args):
                visited.append(image_id)
                _args[-1](image_id, [])
            def flush(self): pass
        monkeypatch.setattr(runner, "_Work", Work)
        monkeypatch.setattr(runner, "_device", lambda *_args: "cpu")
        monkeypatch.setattr(runner, "_free", lambda: None)
        monkeypatch.setattr(runner.gpu, "beat", lambda *_args: None)
        monkeypatch.setattr(runner.gpu, "release", lambda *_args, **_kw: None)
        ctx = {"doc": {"nodes": []}, "mode": "frames", "info": {}, "want": 0, "weights": {},
               "owner": setup["user"], "unit_index": {}, "first": None, "cpu": True, "lease_id": None,
               "order": [], "units": [], "sequential": False, "sig": None}
        runner.run_held(db, copy.id, ctx)
        assert copy.status == parent.status == "done", copy.error
        assert len(loads) == 1 and len(visited) == len(set(visited)) == 121
        assert parent.processed == parent.total == 121


@pytest.fixture
def client(sessions, setup, monkeypatch):
    from flask import Flask
    from training_svc import agents
    app = Flask(__name__)
    app.register_blueprint(agents.bp)
    def me():
        db = sessions()
        return db, db.get(User, setup["user"]), None
    monkeypatch.setattr(agents, "_me", me)
    cards = [{"id": "test", "index": 0, "name": "Test GPU", "cap_mb": 24000, "free_mb": 24000}]
    monkeypatch.setattr(agents.gpu, "cards", lambda _db: cards)
    return app.test_client(), cards


def body(setup, **kwargs):
    return {"graph_id": str(setup["graph"]), "version_id": str(setup["version"]), "mode": "scout",
            "sources": [], "videos": setup["videos"], "step": 25, "parallel": True, **kwargs}


def test_api_автомаксимум_пересчитывается_при_запуске_и_контекст_возвращает_группу(client, setup):
    http, cards = client
    url = f"/api/agents/tasks/{setup['task']}"
    plan = http.post(url + "/parallel-capacity", json=body(setup)).get_json()
    assert plan["max_count"] > 2, plan
    cards[0]["free_mb"] = plan["per_copy_mb"] * 2
    response = http.post(url + "/runs", json=body(setup, copies="auto"))
    assert response.status_code == 202, response.get_json()
    run = response.get_json()
    assert run["parallel"]["count"] == 2
    context = http.get(url).get_json()
    assert len(context["runs"]) == 1
    assert len(context["runs"][0]["parallel"]["copies"]) == 2
    child_id = run["parallel"]["copies"][0]["id"]
    changed = http.post(f"/api/agents/runs/{child_id}/stop").get_json()
    assert changed["id"] == run["id"] and changed["status"] in ap.ACTIVE
    assert changed["parallel"]["copies"][0]["status"] == "stopped"
    changed = http.post(f"/api/agents/runs/{child_id}/resume").get_json()
    assert changed["id"] == run["id"] and changed["parallel"]["count"] == 2
    assert http.post(url + "/runs", json=body(setup, copies=1)).status_code == 409
    stopped = http.post(f"/api/agents/runs/{run['id']}/stop").get_json()
    assert stopped["status"] == "stopped" and all(c["status"] == "stopped" for c in stopped["parallel"]["copies"])
    resumed = http.post(f"/api/agents/runs/{run['id']}/resume").get_json()
    assert resumed["parallel"]["count"] == 2
    assert all(c["status"] in ap.ACTIVE for c in resumed["parallel"]["copies"])


def test_api_повтор_старой_копии_не_конфликтует_с_новым_прогоном(client, setup):
    http, _cards = client
    url = f"/api/agents/tasks/{setup['task']}/runs"
    old = http.post(url, json=body(setup, copies=2)).get_json()
    http.post(f"/api/agents/runs/{old['id']}/stop")
    new = http.post(url, json=body(setup, copies=2)).get_json()
    assert old["id"] != new["id"]
    child_id = old["parallel"]["copies"][0]["id"]
    response = http.post(f"/api/agents/runs/{child_id}/resume")
    assert response.status_code == 409


@pytest.mark.parametrize("copies,expected", [(0, 400), (1.5, 400), ("2", 400), (True, 400), (100, 409)])
def test_api_проверяет_ручное_количество(client, setup, copies, expected):
    http, _cards = client
    response = http.post(f"/api/agents/tasks/{setup['task']}/runs", json=body(setup, copies=copies))
    assert response.status_code == expected, response.get_json()


def test_api_закрывает_чужие_ролики_и_права_на_запуск(client, sessions, setup):
    http, _cards = client
    url = f"/api/agents/tasks/{setup['task']}"
    plan = http.post(url + "/parallel-capacity", json=body(setup, videos=[str(uuid.uuid4())])).get_json()
    assert plan["max_count"] == plan["work_count"] == 0
    with sessions() as db:
        member = db.execute(select(ProjectMember).where(ProjectMember.project_id == setup["project"])).scalar_one()
        member.role = "viewer"; db.commit()
    assert http.post(url + "/runs", json=body(setup, copies=1)).status_code == 403


def test_разведка_после_сбоя_досчитывает_свой_ролик_без_дублирования_счётчиков(sessions, setup, monkeypatch):
    from training_svc import agent_runner as runner
    visits, loaded = [], []
    fail = [True]
    class Work:
        def __init__(self, *args): loaded.append(True)
        def frame(self, frame_no, *_args):
            visits.append(frame_no)
            if fail[0] and len(visits) == 3:
                fail[0] = False
                raise RuntimeError("test interrupted scout")
            _args[-1](frame_no, [{"cls": "человек", "conf": 0.9, "box": [1, 2, 3, 4]}])
        def flush(self): pass
    monkeypatch.setattr(runner, "_Work", Work)
    monkeypatch.setattr(runner, "_device", lambda *_args: "cpu")
    monkeypatch.setattr(runner, "_free", lambda: None)
    monkeypatch.setattr(runner.gpu, "beat", lambda *_args: None)
    monkeypatch.setattr(runner.gpu, "release", lambda *_args, **_kw: None)
    monkeypatch.setattr(runner.video_frames, "extract_frames", lambda _path, wanted, on_frame, **_kw:
                        [on_frame(f, 0, None) for f in wanted])
    ctx = {"doc": {"nodes": []}, "mode": "scout", "info": {}, "want": 0, "weights": {},
           "owner": setup["user"], "unit_index": {}, "first": None, "cpu": True, "lease_id": None,
           "order": [], "units": [], "sequential": False, "sig": None}
    with sessions() as db:
        parent, (copy,) = group(db, setup, 1)
        copy.status = "running"; db.commit()
        runner.run_held(db, copy.id, ctx)
        assert copy.status == "error" and copy.processed == 2
        original = copy.params["assignment"]
        ap.resume(parent); ap.resume(copy); copy.status = "running"; db.commit()
        assert copy.params["assignment"] == original
        runner.run_held(db, copy.id, ctx)
        assert copy.status == parent.status == "done", copy.error
        scouts = db.execute(select(VideoScout).where(VideoScout.run_id == copy.id)).scalars().all()
        assert len(scouts) == 5 and all(len(s.frames) == 4 for s in scouts)
        assert copy.stats["frames"] == parent.stats["frames"] == parent.processed == 20
        assert len(loaded) == 2  # один раз на попытку, все пять роликов на тёплой модели


def test_уборка_восстанавливает_итог_группы_после_сбоя_между_двумя_коммитами(sessions, setup):
    from training_svc import agent_runner as runner
    with sessions() as db:
        parent, copies = group(db, setup)
        while ap.take(db, copies[0]):
            ap.complete(db, copies[0])
        for copy in copies:
            copy.status = "done"
        db.commit()  # процесс исчез до sync
        assert parent.status in ap.ACTIVE
        runner.reap_orphans(db, "test")
        assert parent.status == "done"


def test_миграция_сохраняет_историю_и_восстанавливает_индекс(sessions, setup):
    import importlib.util
    from pathlib import Path
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import inspect
    path = Path(__file__).parents[2] / "backend/auth_svc/migrations/versions/f0a1b2c3d4e5_parallel_agents.py"
    spec = importlib.util.spec_from_file_location("parallel_migration", path)
    migration = importlib.util.module_from_spec(spec); spec.loader.exec_module(migration)
    with sessions() as db:
        parent, copies = group(db, setup)
        while ap.take(db, copies[0]):
            ap.complete(db, copies[0])
        for copy in copies:
            copy.status = "done"
        db.commit(); ap.sync(db, parent.id)
        ids = {r.id for r in [parent, *copies]}
    with sessions().bind.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            migration.downgrade()
            assert "parent_id" not in {c["name"] for c in inspect(conn).get_columns("agent_runs")}
            migration.upgrade()
            assert {"parent_id", "is_group"} <= {c["name"] for c in inspect(conn).get_columns("agent_runs")}
            index = next(i for i in inspect(conn).get_indexes("agent_runs") if i["name"] == "uq_agent_run_active")
            assert index["unique"] and "parent_id IS NULL" in str(index["dialect_options"]["postgresql_where"])
            assert set(conn.execute(select(AgentRun.id).where(AgentRun.id.in_(ids))).scalars()) == ids
