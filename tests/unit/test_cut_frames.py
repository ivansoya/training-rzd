"""Фильтры галереи нарезки на отдельной PostgreSQL, с настоящими правами и тагами."""
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import pytest

url = os.environ.get("TEST_CUT_FRAMES_DATABASE_URL")
if not url:
    pytest.skip("Нужна отдельная TEST_CUT_FRAMES_DATABASE_URL", allow_module_level=True)
assert os.environ.get("DATABASE_URL") == url

from flask import Flask
from common import config
from common.auth import hash_token
from common.db import Base, SessionLocal, engine
from common.models import Annotation, AuthSession, Image, ImageTag, LabelClass, Project, ProjectMember, Tag, Task, TaskQuestion, TaskVideo, User, VideoAnnotation
from datasets_svc.task_routes import bp
from datasets_svc.question_routes import bp as questions_bp


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
    app = Flask(__name__); app.register_blueprint(bp); app.register_blueprint(questions_bp)
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
    all_frames = get(scene, review="all").get_json()["images"]
    assert [r["file_name"] for r in all_frames] == ["done.jpg", "empty.jpg", "new.jpg", "pending.jpg", "skipped.jpg"]


def test_agent_empty_is_pending_and_human_edit_is_personal(scene):
    db, client, task, _cut, images, *_ = scene
    image = images["new"]
    path = f"/api/images/{image.id}/task-status"
    question = client.post(f"/api/tasks/{task.id}/questions", json={
        "image_id": str(image.id), "text": "Проверьте, есть ли объект на кадре.", "by_agent": True,
    })
    assert question.status_code == 201, question.text
    row = get(scene, image=str(image.id)).json["images"][0]
    assert row["agent_question"] and row["task_status"] == "new"
    assert client.patch(path, json={"status": "empty", "propose_empty": True}).status_code == 200
    pending = get(scene, status="agent").get_json()["images"]
    row = next(r for r in pending if r["id"] == str(image.id))
    assert row["agent_empty"] and row["task_status"] == "new"
    assert not row["human_edited"] and row["my_edited_at"] is None
    confirmed = client.patch(path, json={"status": "empty", "review_empty": True})
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json["my_edited_at"] and not confirmed.json["agent_empty"]
    assert client.patch(path, json={"status": "empty", "review_empty": True}).status_code == 409
    unchanged = client.put(f"/api/images/{image.id}/annotations", json={"boxes": [], "rev": confirmed.json["rev"]})
    assert unchanged.status_code == 200 and unchanged.json["my_edited_at"] is None

    key = uuid.uuid4().hex
    peer = User(email=f"{key}@test.invalid", login=key, display_name="Коллега", password_hash="test")
    db.add(peer); db.flush()
    db.add_all([ProjectMember(project_id=task.project_id, user_id=peer.id, role="admin"),
                AuthSession(user_id=peer.id, token_hash=hash_token(key), expires_at=datetime.now(timezone.utc) + timedelta(days=1))])
    db.commit()
    second = client.application.test_client()
    second.set_cookie("session", key)
    result = second.get(f"/api/tasks/{task.id}/images", query_string={"image": str(image.id)}).json["images"][0]
    assert result["human_edited"] and result["my_edited_at"] is None
    mine = get(scene, image=str(image.id)).json["images"][0]
    assert mine["my_edited_at"] == confirmed.json["my_edited_at"]
    db.delete(peer); db.commit()


def test_editor_index_agrees_with_filtered_details(scene):
    _db, _client, _task, _cut, images, tag, *_ = scene
    params = {"review": "new", "tags": str(tag.id)}
    response = get(scene, editor_index=1, **params)
    assert response.status_code == 200
    rows = response.json["index"]
    detailed = get(scene, **params).json["images"]
    assert [row[0] for row in rows] == [frame["id"] for frame in detailed]
    pending = next(row for row in rows if row[0] == str(images["pending"].id))
    assert pending[1:11] == ["pending.jpg", "annotated", False, True, False, False, None, 1, [0], [str(tag.id)]]


def test_cut_frames_follow_video_names_then_time_in_gallery_and_editor(scene):
    db, _client, task, cut, *_ = scene
    cut.file_name = "camera_a_2026-10-24_08-00-00.mp4"
    duplicate = TaskVideo(task_id=task.id, file_name=cut.file_name, file_path="unused", mode="cut",
                          created_at=cut.created_at + timedelta(seconds=1))
    later = TaskVideo(task_id=task.id, file_name="camera_a_2026-10-24_09-00-00.mp4", file_path="unused", mode="cut")
    other = TaskVideo(task_id=task.id, file_name="camera_b_2026-10-24_07-00-00.mp4", file_path="unused", mode="cut")
    db.add_all([other, later, duplicate]); db.flush()

    def frame(video, suffix, time_ms, number=None):
        return Image(task_id=task.id, project_id=task.project_id, source_video_id=video.id,
                     file_name=f"{video.file_name[:-4]}_{suffix}.jpg", file_path="unused",
                     source_time_ms=time_ms, source_frame_no=number)

    first = frame(cut, "00003s", 3000)
    second = frame(cut, "00-10.000", 10000, 250)
    same_time = frame(cut, "00-09.999", 10000, 251)
    duplicate_first = frame(duplicate, "00-01.000", 1000, 25)
    later_first = frame(later, "00-00.000", 0, 0)
    other_first = frame(other, "00-00.000", 0, 0)
    expected = [first, second, same_time, duplicate_first, later_first, other_first]
    db.add_all(reversed(expected)); db.commit()
    ids = [str(row.id) for row in expected]

    index = get(scene, editor_index=1).json
    assert index["video_order"]
    assert [row[0] for row in index["index"] if row[0] in ids] == ids
    assert [row["id"] for row in get(scene, review="all").json["images"] if row["id"] in ids] == ids
    assert [row["id"] for row in get(scene, source="", order="name").json["images"] if row["id"] in ids] == ids
    assert [row["id"] for row in get(scene, source=str(cut.id), limit=3).json["images"]] == ids[:3]
    assert not get(scene, source="files", editor_index=1).json["video_order"]


def test_editor_window_is_capped_and_scoped_to_task(scene):
    _db, _client, _task, _cut, images, *_ = scene
    ids = [str(images[name].id) for name in ("pending", "file", "other-task")]
    result = get(scene, source="", editor_ids=",".join(ids), limit=100).json
    assert {row["id"] for row in result["images"]} == set(ids[:2])
    assert "counts" not in result
    assert next(row for row in result["images"] if row["id"] == ids[0])["boxes"][0]["pending"]
    assert get(scene, editor_ids=",".join([ids[0]] * 101)).status_code == 400


def test_editor_name_order_keeps_discarded_frames_in_place(scene):
    db, _client, _task, _cut, images, *_ = scene
    before = [r["id"] for r in get(scene, order="name").get_json()["images"]]
    assert len(before) == 6
    images["empty"].task_status = "deleted"
    db.commit()
    after = [r["id"] for r in get(scene, order="name").get_json()["images"]]
    assert after == before


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



def test_transfer_cut_moves_video_frames_questions_and_files(scene):
    db, client, task, cut, images, tag, *_ = scene
    task.status = "queued"
    task.target_dataset_name = "Общий датасет"
    held = TaskQuestion(task_id=task.id, image_id=images["done"].id, place="done.jpg")
    db.add(held)
    db.commit()
    other = db.query(TaskVideo).filter_by(task_id=task.id, mode="annotate").one()
    path = f"/api/tasks/{task.id}/cut-transfer"
    payload = {"name": "Часть перегона", "video_ids": [str(cut.id)]}
    assert client.post(path, json={**payload, "video_ids": [str(other.id)]}).status_code == 409
    moved = [row for row in images.values() if row.source_video_id == cut.id]
    with (TemporaryDirectory() as tmp, patch.object(config, "DATA_DIR", tmp),
          patch.object(config, "PROJECTS_DIR", str(Path(tmp) / "projects"))):
        source = Path(config.image_base_dir(task.project_id, task.id))
        for row in moved:
            full = source / "images" / f"{row.id}.jpg"
            thumb = source / "thumbs" / full.name
            full.parent.mkdir(parents=True, exist_ok=True)
            thumb.parent.mkdir(parents=True, exist_ok=True)
            full.write_bytes(b"frame")
            thumb.write_bytes(b"thumb")
            row.file_path = str(full.relative_to(tmp))
        db.commit()
        full.unlink()
        assert client.post(path, json=payload).status_code == 500
        db.expire_all()
        assert task.target_dataset_id is None and cut.task_id == task.id
        assert thumb.read_bytes() == b"thumb"
        full.write_bytes(b"frame")
        response = client.post(path, json=payload)
        assert response.status_code == 201, response.text
        child_id = uuid.UUID(response.json["task_id"])
        db.expire_all()
        child = db.get(Task, child_id)
        assert child.name == payload["name"] and child.status == "queued"
        assert child.target_dataset_id == task.target_dataset_id is not None
        assert cut.task_id == child.id and other.task_id == task.id
        assert held.task_id == child.id and held.image_id == images["done"].id
        for row in moved:
            assert row.task_id == child.id and row.source_video_id == cut.id
            assert (Path(tmp) / row.file_path).read_bytes() == b"frame"
            assert not (source / "images" / f"{row.id}.jpg").exists()
        assert images["done"].file_name == "done.jpg"
        assert db.query(ImageTag).filter_by(image_id=images["done"].id, tag_id=tag.id).count() == 1
        assert client.post(path, json=payload).status_code == 409


@pytest.mark.parametrize("status", ["in_progress", "updating"])
def test_done_keeps_unresolved_frames_and_cannot_close(scene, status):
    db, client, task, _cut, images, *_ = scene
    task.status = status
    db.delete(db.query(TaskVideo).filter_by(task_id=task.id, mode="annotate").one())
    db.commit()
    path = f"/api/tasks/{task.id}"
    closed = client.post(f"{path}/status", json={"status": "closed"})
    assert closed.status_code == 409 and closed.json["code"] == "remaining_frames"
    assert closed.json["remaining"]["skipped"] == closed.json["remaining"]["review"] == 1
    for key in ("done", "skipped"):
        db.add(TaskQuestion(task_id=task.id, image_id=images[key].id, place=f"{key}.jpg"))
    db.commit()
    response = client.post(f"{path}/status", json={"status": "done"})
    assert response.status_code == 200 and response.json["accepted"] == 1, response.text
    db.expire_all()
    assert task.status == "done" and images["empty"].dataset_id is not None
    assert all(images[key].dataset_id is None for key in ("done", "skipped", "pending"))
    remaining = client.get(f"{path}/counts").json["remaining"]
    assert remaining == response.json["remaining"] == {"total": 3, "not_exported": 3, "questions": 2, "skipped": 1, "review": 1}
    assert client.post(f"{path}/status", json={"status": "closed"}).status_code == 409
    db.expire_all()
    assert task.status == "done" and images["skipped"].task_status == "skipped"



def test_done_counts_pending_video_annotation_on_existing_image(scene):
    db, client, task, _cut, images, *_ = scene
    task.status = "done"
    image = images["video-annotation"]
    image.source_frame_no = 7
    images["skipped"].task_status = "new"
    annotation = db.query(Annotation).filter_by(image_id=images["pending"].id).one()
    annotation.pending = False
    db.add(VideoAnnotation(video_id=image.source_video_id, frame_no=7, class_id=annotation.class_id,
                           ann_type="bbox", geometry=annotation.geometry, source="model", pending=True))
    db.commit()
    path = f"/api/tasks/{task.id}"
    assert client.get(f"{path}/counts").json["remaining"]["review"] == 1
    response = client.post(f"{path}/status", json={"status": "closed"})
    assert response.status_code == 409 and response.json["code"] == "remaining_frames"
    assert response.json["remaining"]["total"] == 1
