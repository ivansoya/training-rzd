"""Фильтры галереи нарезки на отдельной PostgreSQL, с настоящими правами и тагами."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

url = os.environ.get("TEST_CUT_FRAMES_DATABASE_URL")
if not url:
    pytest.skip("Нужна отдельная TEST_CUT_FRAMES_DATABASE_URL", allow_module_level=True)
assert os.environ.get("DATABASE_URL") == url

from flask import Flask
from common.auth import hash_token
from common.db import Base, SessionLocal, engine
from common.models import Annotation, AuthSession, Image, ImageTag, LabelClass, Project, ProjectMember, Tag, Task, TaskVideo, User
from datasets_svc.task_routes import bp


@pytest.fixture(scope="module", autouse=True)
def schema():
    Base.metadata.create_all(engine)


@pytest.fixture
def scene():
    db = SessionLocal(); key = uuid.uuid4().hex
    user = User(email=f"{key}@test.invalid", login=key, display_name="Тест", password_hash="test")
    project = Project(name="test-cut-frames", code=key[:20])
    foreign = Project(name="test-other", code=uuid.uuid4().hex[:20])
    db.add_all([user, project, foreign]); db.flush()
    db.add_all([ProjectMember(project_id=project.id, user_id=user.id, role="admin"),
                AuthSession(user_id=user.id, token_hash=hash_token(key), expires_at=datetime.now(timezone.utc) + timedelta(days=1))])
    task = Task(project_id=project.id, name="test-cut-frames", status="in_progress")
    other = Task(project_id=project.id, name="test-other", status="in_progress")
    cls = LabelClass(project_id=project.id, name="Человек", class_index=0, color="#46a758")
    a, b = [Tag(project_id=project.id, name=name) for name in ("Камера", "Станция")]
    alien = Tag(project_id=foreign.id, name="Чужой")
    db.add_all([task, other, cls, a, b, alien]); db.flush()
    cut = TaskVideo(task_id=task.id, file_name="cut.mp4", file_path="unused", mode="cut")
    annotate = TaskVideo(task_id=task.id, file_name="annotate.mp4", file_path="unused", mode="annotate")
    other_video = TaskVideo(task_id=other.id, file_name="other.mp4", file_path="unused", mode="cut")
    db.add_all([cut, annotate, other_video]); db.flush()
    images = {}
    for name, status in [("new", "new"), ("skipped", "skipped"), ("done", "annotated"), ("empty", "empty"), ("pending", "annotated"), ("deleted", "deleted")]:
        image = Image(task_id=task.id, project_id=project.id, source_video_id=cut.id,
                      file_name=name + ".jpg", file_path="unused", width=640, height=480, task_status=status)
        db.add(image); db.flush(); images[name] = image
        db.add(ImageTag(image_id=image.id, tag_id=b.id if name in ("skipped", "empty") else a.id))
    db.add(Annotation(image_id=images["pending"].id, class_id=cls.id, ann_type="bbox", geometry={"x": 1, "y": 1, "w": 10, "h": 10}, source="model", pending=True))
    for name, task_id, video_id in [("video-annotation", task.id, annotate.id), ("file", task.id, None), ("other-task", other.id, other_video.id)]:
        image = Image(task_id=task_id, project_id=project.id, source_video_id=video_id, file_name=name + ".jpg", file_path="unused")
        db.add(image); db.flush(); images[name] = image
        db.add(ImageTag(image_id=image.id, tag_id=a.id))
    db.commit()
    app = Flask(__name__); app.register_blueprint(bp)
    client = app.test_client(); client.set_cookie("session", key)
    yield db, client, task, cut, images, a, b, alien
    db.delete(project); db.delete(foreign); db.commit(); db.delete(user); db.commit(); db.close()


def get(scene, **query):
    _db, client, task, *_rest = scene
    return client.get(f"/api/tasks/{task.id}/images", query_string={"source": "videos", **query})


def test_review_не_считает_модель_подтверждённой_и_исключает_брак_и_другие_источники(scene):
    fresh = get(scene, review="new").get_json()
    ready = get(scene, review="done").get_json()
    assert {r["file_name"] for r in fresh["images"]} == {"new.jpg", "skipped.jpg", "pending.jpg"}
    assert {r["file_name"] for r in ready["images"]} == {"done.jpg", "empty.jpg"}
    assert fresh["matched"] == 3 and ready["matched"] == 2
    assert next(r for r in fresh["images"] if r["file_name"] == "pending.jpg")["boxes"][0]["pending"]


def test_таги_объединяются_по_или_и_пересекаются_с_состоянием(scene):
    _db, _client, _task, cut, _images, a, b, alien = scene
    assert get(scene, review="new", tags=str(a.id)).get_json()["matched"] == 2
    assert get(scene, review="done", tags=str(a.id)).get_json()["matched"] == 1
    assert get(scene, review="new", tags=f"{a.id},{b.id}", source=str(cut.id)).get_json()["matched"] == 3
    assert get(scene, review="new", tags=str(alien.id)).get_json()["matched"] == 0
    assert get(scene, review="new", tags="not-a-tag").get_json()["matched"] == 0


def test_счётчики_подтверждённых_по_ролику_учитывают_ожидающую_модель(scene):
    _db, client, task, cut, *_rest = scene
    response = client.get(f"/api/tasks/{task.id}/counts")
    assert response.status_code == 200, response.text
    counts = response.get_json()["by_source"][str(cut.id)]
    assert counts["annotated"] == 2 and counts["empty"] == 1
    assert counts["reviewed"] == 2 and counts["agent"] == 1


def test_страницы_с_одинаковыми_именами_не_дублируются_и_matched_не_размер_страницы(scene):
    db, _client, task, cut, *_rest = scene
    db.add_all([Image(project_id=task.project_id, task_id=task.id, source_video_id=cut.id, file_name="same.jpg", file_path="unused") for _ in range(35)])
    db.commit()
    first = get(scene, review="new", limit=24).get_json()
    second = get(scene, review="new", limit=24, offset=24).get_json()
    assert first["matched"] == second["matched"] == 38
    ids = [r["id"] for r in first["images"] + second["images"]]
    assert len(ids) == len(set(ids)) == 38


def test_общая_галерея_возвращает_по_50_со_счётчиками_всей_выборки(scene):
    db, _client, task, cut, _images, a, _b, _alien = scene
    extra = [Image(project_id=task.project_id, task_id=task.id, source_video_id=cut.id,
                   file_name=f"bulk-{i:03}.jpg", file_path="unused") for i in range(102)]
    db.add_all(extra); db.flush()
    db.add_all([ImageTag(image_id=image.id, tag_id=a.id) for image in extra]); db.commit()
    pages = [get(scene, review="all", limit=50, offset=offset).get_json() for offset in (0, 50, 100)]
    assert [len(p["images"]) for p in pages] == [50, 50, 7]
    assert all(p["matched"] == 107 and p["review_counts"] == {"new": 105, "done": 2} for p in pages)
    ids = [image["id"] for p in pages for image in p["images"]]
    assert len(ids) == len(set(ids)) == 107
    tagged = get(scene, review="done", tags=str(a.id), limit=50).get_json()
    assert tagged["matched"] == 1 and tagged["review_counts"] == {"new": 104, "done": 1}
    assert get(scene, review="all", offset=150, limit=50).get_json()["images"] == []


@pytest.mark.parametrize("query", [{"review": "bad"}, {"limit": "bad"}, {"offset": "bad"}, {"source": "bad"}])
def test_невалидные_фильтры_отклоняются(scene, query):
    assert get(scene, **query).status_code == 400


def test_без_прав_нет_доступа_к_кадрам(scene):
    _db, client, task, *_rest = scene
    client.delete_cookie("session")
    assert client.get(f"/api/tasks/{task.id}/images", query_string={"source": "videos", "review": "new"}).status_code == 401
