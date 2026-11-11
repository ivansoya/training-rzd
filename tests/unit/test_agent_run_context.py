"""Таги выбора роликов: реальная ручка на отдельной тестовой PostgreSQL, без моделей."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

url = os.environ.get("TEST_AGENT_CONTEXT_DATABASE_URL")
if not url:
    pytest.skip("Нужна отдельная TEST_AGENT_CONTEXT_DATABASE_URL", allow_module_level=True)
assert os.environ.get("DATABASE_URL") == url

from flask import Flask
from common.auth import hash_token
from common.db import Base, SessionLocal, engine
from common.models import AuthSession, Project, ProjectMember, Tag, Task, TaskVideo, User, VideoTag
from training_svc.agents import bp


@pytest.fixture(scope="module")
def scene():
    Base.metadata.create_all(engine)
    db = SessionLocal()
    token = uuid.uuid4().hex
    user = User(email=f"{token}@example.test", login=token, password_hash="test", display_name="Тест")
    own = Project(name="Свои", code=token[:20])
    foreign = Project(name="Чужие", code=token[12:])
    db.add_all([user, own, foreign]); db.flush()
    db.add_all([ProjectMember(project_id=own.id, user_id=user.id, role="admin"),
                AuthSession(user_id=user.id, token_hash=hash_token(token),
                            expires_at=datetime.now(timezone.utc) + timedelta(days=1))])
    task = Task(project_id=own.id, name="Тест", status="in_progress")
    other_task = Task(project_id=foreign.id, name="Чужая", status="in_progress")
    near = Tag(project_id=own.id, name="Ближняя камера")
    station = Tag(project_id=own.id, name="Станция")
    private = Tag(project_id=foreign.id, name="Чужой таг")
    db.add_all([task, other_task, near, station, private]); db.flush()
    cut = TaskVideo(task_id=task.id, file_name="cut.mp4", file_path="cut.mp4", mode="cut", duration_ms=1000, fps=25)
    annotate = TaskVideo(task_id=task.id, file_name="annotate.mp4", file_path="annotate.mp4", mode="annotate", frame_count=30)
    other = TaskVideo(task_id=other_task.id, file_name="private.mp4", file_path="private.mp4", mode="cut")
    db.add_all([cut, annotate, other]); db.flush()
    db.add_all([VideoTag(video_id=cut.id, tag_id=near.id), VideoTag(video_id=other.id, tag_id=private.id)])
    db.commit()
    app = Flask(__name__); app.register_blueprint(bp)
    client = app.test_client(); client.set_cookie("session", token)
    yield client, task, other_task, cut, annotate, near, station
    db.close()


def test_context_includes_project_tags_and_video_links(scene):
    client, task, _, cut, annotate, near, station = scene
    response = client.get(f"/api/agents/tasks/{task.id}")
    assert response.status_code == 200, response.text
    assert response.json["tags"] == [{"id": str(t.id), "name": t.name} for t in (near, station)]
    rows = {v["id"]: v for v in response.json["videos"]}
    assert set(rows) == {str(cut.id), str(annotate.id)}
    assert rows[str(cut.id)]["tag_ids"] == [str(near.id)]
    assert rows[str(annotate.id)]["tag_ids"] == []
    assert rows[str(cut.id)]["frames"] == 25
    assert rows[str(annotate.id)]["frames"] == 30


def test_foreign_context_is_not_accessible(scene):
    client, _, foreign, *_ = scene
    assert client.get(f"/api/agents/tasks/{foreign.id}").status_code == 403
