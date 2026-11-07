"""Очистка кадра ролика на отдельной тестовой PostgreSQL."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

url = os.environ.get("TEST_VIDEO_CLEAR_DATABASE_URL")
if not url:
    pytest.skip("Для проверки нужна отдельная TEST_VIDEO_CLEAR_DATABASE_URL", allow_module_level=True)
assert os.environ.get("DATABASE_URL") == url

from flask import Flask
from sqlalchemy import select

from common.auth import hash_token
from common.db import Base, SessionLocal, engine
from common.models import AuthSession, LabelClass, Project, ProjectMember, Task, TaskVideo, User, VideoAnnotation, VideoTrack
from common.video_tracks import state_at
from datasets_svc.video_routes import bp


@pytest.fixture(scope="session", autouse=True)
def schema():
    Base.metadata.create_all(engine)


@pytest.fixture
def scene():
    db = SessionLocal()
    suffix = uuid.uuid4().hex
    user = User(email=f"{suffix}@example.test", login=suffix, password_hash="test", display_name="Тест")
    project = Project(name="Тест", code=suffix[:20])
    db.add_all([user, project]); db.flush()
    db.add_all([ProjectMember(project_id=project.id, user_id=user.id, role="admin"),
                AuthSession(user_id=user.id, token_hash=hash_token(suffix),
                            expires_at=datetime.now(timezone.utc) + timedelta(days=1))])
    task = Task(project_id=project.id, name="Тест", status="in_progress")
    cls = LabelClass(project_id=project.id, class_index=0, name="Вагон", color="#e5484d")
    db.add_all([task, cls]); db.flush()
    video = TaskVideo(task_id=task.id, file_name="test.mp4", file_path="test.mp4", mode="annotate",
                      width=640, height=480, frame_count=30, fps=10)
    db.add(video); db.flush()
    track = VideoTrack(video_id=video.id, class_id=cls.id, start_frame=0)
    db.add(track); db.flush()
    for frame, x in [(0, 10.111), (29, 80.777)]:
        db.add(VideoAnnotation(video_id=video.id, track_id=track.id, class_id=cls.id,
                               frame_no=frame, ann_type="bbox", geometry={"x": x, "y": 20, "w": 30, "h": 40}))
    db.commit()
    app = Flask(__name__); app.register_blueprint(bp)
    client = app.test_client(); client.set_cookie("session", suffix)
    yield db, client, task, video, track, cls
    db.close()


def snapshot(db, track):
    db.expire_all()
    t = db.get(VideoTrack, track.id)
    rows = db.execute(select(VideoAnnotation).where(VideoAnnotation.track_id == t.id)
                      .order_by(VideoAnnotation.frame_no)).scalars().all()
    return {"id": str(t.id), "start_frame": t.start_frame, "end_frame": t.end_frame,
            "interpolate": t.interpolate, "hidden_ranges": t.hidden_ranges or [],
            "keys": [{"frame_no": k.frame_no, "geometry": k.geometry} for k in rows]}


@pytest.mark.parametrize("frame", [0, 7, 29])
def test_clear_removes_singles_only_here_and_preserves_track_neighbors(scene, frame):
    db, client, task, video, track, cls = scene
    for at in (frame, (frame + 2) % 30):
        db.add(VideoAnnotation(video_id=video.id, track_id=None, class_id=cls.id, frame_no=at,
                               ann_type="bbox", geometry={"x": 10, "y": 20, "w": 30, "h": 40}))
    db.commit()
    before = snapshot(db, track)
    positions = [state_at(before, before["keys"], i) for i in range(30)]
    path = f"/api/tasks/{task.id}/videos/{video.id}/frames/{frame}/boxes"
    response = client.put(path, json={"boxes": [], "clear_tracks": True, "track_versions": [before]})
    assert response.status_code == 200, response.text
    after = snapshot(db, track)
    assert state_at(after, after["keys"], frame)["hidden"]
    for i in range(30):
        if i != frame:
            assert state_at(after, after["keys"], i) == positions[i]
    singles = db.execute(select(VideoAnnotation.frame_no).where(VideoAnnotation.video_id == video.id,
                                                               VideoAnnotation.track_id.is_(None))).scalars().all()
    assert singles == [(frame + 2) % 30]
    marked = db.execute(select(VideoAnnotation).where(VideoAnnotation.track_id == track.id,
                                                      VideoAnnotation.frame_no == frame)).scalar_one()
    assert marked.attributes["cleared_frame"] is True
    assert frame not in (db.get(TaskVideo, video.id).empty_frames or [])


def test_clear_rejects_changed_tracks_without_deleting_singles(scene):
    db, client, task, video, track, cls = scene
    db.add(VideoAnnotation(video_id=video.id, track_id=None, class_id=cls.id, frame_no=7,
                           ann_type="bbox", geometry={"x": 10, "y": 20, "w": 30, "h": 40}))
    db.commit()
    old = snapshot(db, track)
    t = db.get(VideoTrack, track.id); t.interpolate = False; db.commit()
    response = client.put(f"/api/tasks/{task.id}/videos/{video.id}/frames/7/boxes",
                          json={"boxes": [], "clear_tracks": True, "track_versions": [old]})
    assert response.status_code == 409
    db.expire_all()
    assert db.execute(select(VideoAnnotation).where(VideoAnnotation.video_id == video.id,
                                                    VideoAnnotation.track_id.is_(None))).scalar_one()
    assert snapshot(db, track)["hidden_ranges"] == []


def test_clear_rejects_stale_single_revision(scene):
    db, client, task, video, track, cls = scene
    db.add(VideoAnnotation(video_id=video.id, track_id=None, class_id=cls.id, frame_no=7,
                           ann_type="bbox", geometry={"x": 10, "y": 20, "w": 30, "h": 40}))
    db.commit()
    before = snapshot(db, track)
    response = client.put(f"/api/tasks/{task.id}/videos/{video.id}/frames/7/boxes",
                          json={"boxes": [], "rev": "stale", "clear_tracks": True, "track_versions": [before]})
    assert response.status_code == 409 and response.json["code"] == "stale"
    assert snapshot(db, track)["hidden_ranges"] == []
    assert db.execute(select(VideoAnnotation).where(VideoAnnotation.video_id == video.id,
                                                    VideoAnnotation.track_id.is_(None))).scalar_one()


def test_clear_already_hidden_track_preserves_its_existing_range(scene):
    db, client, task, video, track, _ = scene
    db.get(VideoTrack, track.id).hidden_ranges = [[4, 12]]
    db.commit()
    before = snapshot(db, track)
    response = client.put(f"/api/tasks/{task.id}/videos/{video.id}/frames/7/boxes",
                          json={"boxes": [], "clear_tracks": True, "track_versions": [before]})
    assert response.status_code == 200
    after = snapshot(db, track)
    assert after["hidden_ranges"] == [[4, 12]]
    for i in range(30):
        assert state_at(after, after["keys"], i) == state_at(before, before["keys"], i)
    marked = db.execute(select(VideoAnnotation).where(VideoAnnotation.track_id == track.id,
                                                      VideoAnnotation.frame_no == 7)).scalar_one()
    assert marked.attributes["cleared_frame"] is True
