"""Доска: текущие кадры видео, изменения/удаления и возврат к исходному виду."""
from sqlalchemy import select

from test_cut_frames import scene, schema  # noqa: F401
from common.models import Annotation, Image, LabelClass, TaskEvent, TaskVideo, VideoAnnotation, VideoTrack
from datasets_svc import task_progress


def video_scene(scene):
    db, client, task, cut, images, *_ = scene
    video = db.execute(select(TaskVideo).where(TaskVideo.task_id == task.id, TaskVideo.mode == "annotate")).scalar_one()
    cls = db.execute(select(LabelClass).where(LabelClass.project_id == task.project_id)).scalar_one()
    video.frame_count = 20
    video.empty_frames = [9]
    track = VideoTrack(video_id=video.id, class_id=cls.id, start_frame=0, end_frame=4, export_step=2)
    db.add(track); db.flush()
    box = {"x": 1, "y": 2, "w": 10, "h": 10}
    rows = [VideoAnnotation(video_id=video.id, track_id=track.id, frame_no=0, class_id=cls.id, geometry=box),
            VideoAnnotation(video_id=video.id, frame_no=6, class_id=cls.id, geometry=box),
            VideoAnnotation(video_id=video.id, frame_no=7, class_id=cls.id, geometry=box, pending=True)]
    db.add_all(rows)
    # Уже материализованный кадр видео не должен считаться второй раз.
    images["video-annotation"].task_status = "annotated"
    db.commit()
    return db, client, task, video, rows, images


def test_current_video_frames_include_tracks_and_background_not_pending_or_materialized_twice(scene):
    db, client, task, video, rows, images = video_scene(scene)
    response = client.get(f"/api/tasks/{task.id}/summary")
    assert response.status_code == 200, response.text
    # 2 изображения + 3 кадра трека + одиночный + фон; pending не готов.
    assert response.get_json()["progress"] == {"annotated": 7, "changed": None}


def test_changes_compare_content_count_deleted_once_and_undo_to_zero(scene):
    db, client, task, video, rows, images = video_scene(scene)
    task.status = "done"; db.commit()
    response = client.post(f"/api/tasks/{task.id}/status", json={"status": "updating"})
    assert response.status_code == 200, response.text
    db.expire_all()
    assert task_progress.summary(db, task) == {"annotated": 7, "changed": 0}
    original = dict(rows[1].geometry)
    rows[1].geometry = {**original, "x": 30}
    images["done"].task_status = "deleted"
    db.commit()
    assert task_progress.summary(db, task) == {"annotated": 6, "changed": 2}
    rows[1].geometry = {**original, "x": 40}; db.commit()
    assert task_progress.summary(db, task)["changed"] == 2
    rows[1].geometry = original
    images["done"].task_status = "annotated"
    db.commit()
    assert task_progress.summary(db, task) == {"annotated": 7, "changed": 0}
    # Удаление последней рамки и принятие pending — два разных изменённых кадра.
    db.delete(rows[1]); rows[2].pending = False; db.commit()
    assert task_progress.summary(db, task) == {"annotated": 7, "changed": 2}
    events = client.get(f"/api/tasks/{task.id}/events").get_json()["events"]
    assert not any(e["kind"] == task_progress.BASELINE for e in events)
    # Новый цикл не сравнивается с прошлым.
    user = db.get(TaskEvent, db.execute(select(TaskEvent.id).where(TaskEvent.task_id == task.id,
                  TaskEvent.kind == task_progress.BASELINE)).scalar_one()).user
    task_progress.remember(db, task, user); db.commit()
    assert task_progress.summary(db, task)["changed"] == 0
    # Один ключ трека меняет три выгружаемых кадра, а не одну строку БД.
    rows[0].geometry = {**rows[0].geometry, "x": 90}
    video.empty_frames = [9, 10, 10]
    db.commit()
    assert task_progress.summary(db, task) == {"annotated": 8, "changed": 4}


def test_legacy_updating_does_not_invent_historical_changes(scene):
    db, client, task, *_ = scene
    task.status = "updating"; db.commit()
    assert task_progress.summary(db, task) == {"annotated": 2, "changed": None}
