"""Пакетное отклонение на изолированной PostgreSQL, без загрузки кадров в редактор."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

url = os.environ.get("TEST_AGENT_REJECT_DATABASE_URL")
if not url:
    pytest.skip("Нужна отдельная TEST_AGENT_REJECT_DATABASE_URL", allow_module_level=True)
assert os.environ.get("DATABASE_URL") == url

from flask import Flask
from sqlalchemy import select
from common.auth import hash_token
from common.db import Base, SessionLocal, engine
from common.models import (AgentRun, AugGraph, AugGraphVersion, AuthSession, LabelClass, Project,
                           ProjectMember, Task, TaskVideo, User, VideoAnnotation, VideoTrack)
from common.web import register_json_errors
from datasets_svc.video_routes import bp


@pytest.fixture(scope="session", autouse=True)
def schema():
    Base.metadata.create_all(engine)


@pytest.fixture
def scene():
    db = SessionLocal()
    token = uuid.uuid4().hex
    user = User(email=f"{token}@example.test", login=token, password_hash="test", display_name="Тест")
    project = Project(name="Тест", code=token[:20])
    db.add_all([user, project]); db.flush()
    member = ProjectMember(project_id=project.id, user_id=user.id, role="admin")
    db.add_all([member, AuthSession(user_id=user.id, token_hash=hash_token(token),
                                    expires_at=datetime.now(timezone.utc) + timedelta(days=1))])
    task = Task(project_id=project.id, name="Тест", status="in_progress")
    cls = LabelClass(project_id=project.id, class_index=0, name="Объект", color="#e5484d")
    db.add_all([task, cls]); db.flush()
    video = TaskVideo(task_id=task.id, file_name="range.mp4", file_path="range.mp4", mode="annotate", frame_count=30, fps=10)
    db.add(video); db.flush()
    graphs, versions = [], []
    for name in ["Первый", "Второй"]:
        graph = AugGraph(owner_id=user.id, kind="agent", name=name)
        db.add(graph); db.flush(); graphs.append(graph)
        for n in [1, 2]:
            v = AugGraphVersion(graph_id=graph.id, version=n, digest=str(n), doc={})
            db.add(v); db.flush(); versions.append(v)
    track = VideoTrack(video_id=video.id, class_id=cls.id, start_frame=6)
    db.add(track); db.flush()
    rows = []
    def add(frame, version=None, source="model", pending=True, track_id=None):
        row = VideoAnnotation(video_id=video.id, class_id=cls.id, frame_no=frame, track_id=track_id,
                              ann_type="bbox", geometry={"x": 1, "y": 2, "w": 30, "h": 40},
                              agent_version_id=version, source=source, pending=pending)
        db.add(row); db.flush(); rows.append(row)
        return row.id
    for frame in [4, 5, 7, 10, 11]:
        add(frame, versions[0].id)
    second_version = add(6, versions[1].id)
    other_agent = add(7, versions[2].id)
    unknown = add(8)
    protected = [add(6, versions[0].id, pending=False), add(6, source="human", pending=False),
                 add(6, versions[0].id, source="human"), add(6, versions[0].id, track_id=track.id)]
    db.commit()
    app = Flask(__name__); register_json_errors(app); app.register_blueprint(bp)
    client = app.test_client(); client.set_cookie("session", token)
    yield {"db": db, "client": client, "task": task, "video": video, "member": member,
           "agent": graphs[0], "versions": versions, "protected": protected,
           "other": other_agent, "unknown": unknown, "second_version": second_version,
           "ids": {r.id for r in rows}, "path": f"/api/tasks/{task.id}/videos/{video.id}/agent-reject"}
    db.close()


def remaining(s):
    s["db"].expire_all()
    return set(s["db"].execute(select(VideoAnnotation.id).where(VideoAnnotation.video_id == s["video"].id)).scalars())


def test_preview_then_inclusive_delete_preserves_reviewed_human_tracks_and_neighbors(scene):
    s = scene
    data = {"from_frame": 5, "to_frame": 10, "agent_id": str(s["agent"].id)}
    preview = s["client"].post(s["path"], json={**data, "dry": True})
    assert preview.status_code == 200, preview.text
    assert (preview.json["boxes"], preview.json["frames"]) == (4, 4)
    assert len(preview.json["agents"]) == 3
    assert remaining(s) == s["ids"]
    result = s["client"].post(s["path"], json=data)
    assert result.status_code == 200, result.text
    assert (result.json["boxes"], result.json["frames"]) == (4, 4)
    left = remaining(s)
    assert len(left) == len(s["ids"]) - 4
    assert set(s["protected"] + [s["other"], s["unknown"]]) <= left
    assert s["second_version"] not in left
    assert s["client"].post(s["path"], json=data).json["boxes"] == 0


@pytest.mark.parametrize("last, boxes, frames", [(7, 2, 1), (8, 3, 2)])
def test_all_agents_and_single_frame_include_unknown(scene, last, boxes, frames):
    s = scene
    response = s["client"].post(s["path"], json={"from_frame": 7, "to_frame": last})
    assert response.status_code == 200
    assert (response.json["boxes"], response.json["frames"]) == (boxes, frames)
    assert s["other"] not in remaining(s)
    assert (s["unknown"] in remaining(s)) == (last == 7)


def test_unknown_agent_filter(scene):
    s = scene
    response = s["client"].post(s["path"], json={"from_frame": 0, "to_frame": 29, "agent_id": "unknown"})
    assert response.status_code == 200 and response.json["boxes"] == 1
    assert remaining(s) == s["ids"] - {s["unknown"]}


@pytest.mark.parametrize("bad", [{"from_frame": -1}, {"to_frame": 30}, {"from_frame": 12, "to_frame": 10},
                                  {"from_frame": True}, {"from_frame": 1.5}, {"agent_id": "bad"}, {"dry": "false"}])
def test_invalid_request_cannot_delete(scene, bad):
    s = scene
    response = s["client"].post(s["path"], json={"from_frame": 5, "to_frame": 10, **bad})
    assert response.status_code == 400, response.text
    assert remaining(s) == s["ids"]


@pytest.mark.parametrize("restriction", ["viewer", "closed", "cut", "agent_running", "foreign_task"])
def test_restrictions_cannot_delete(scene, restriction):
    s = scene; db = s["db"]; path = s["path"]
    if restriction == "viewer": s["member"].role = "viewer"
    elif restriction == "closed": s["task"].status = "closed"
    elif restriction == "cut": s["video"].mode = "cut"
    elif restriction == "foreign_task": path = path.replace(str(s["task"].id), str(uuid.uuid4()))
    else:
        db.add(AgentRun(task_id=s["task"].id, project_id=s["task"].project_id,
                        created_by=s["agent"].owner_id, graph_id=s["agent"].id,
                        version_id=s["versions"][0].id, status="running", params={}))
    db.commit()
    response = s["client"].post(path, json={"from_frame": 5, "to_frame": 10})
    assert response.status_code in (403, 404, 409), response.text
    assert remaining(s) == s["ids"]
