"""Состояние разметки для доски и обзора; видеокадр считается один раз.

Снимок на возврате к разметке хранится служебным событием, без миграции.
Сравниваем содержимое, а не число сохранений: отмена правки убирает изменение.
"""
import hashlib
import json

from sqlalchemy import func, select

from common import task_frames, video_tracks
from common.models import Annotation, Image, TaskEvent, TaskVideo

BASELINE = "progress_baseline"


def _digest(status, annotations):
    shapes = sorted(json.dumps([a["class_id"], a["ann_type"], a["geometry"], bool(a.get("pending"))],
                               sort_keys=True, default=str, separators=(",", ":")) for a in annotations)
    return hashlib.blake2b(json.dumps([status, shapes]).encode(), digest_size=16).hexdigest()


def snapshot(db, task, fingerprints=True):
    frames = {}
    annotated = db.execute(select(func.count(Image.id)).where(
        Image.task_id == task.id, ~task_frames.video_frame(), task_frames.reviewed())).scalar_one()
    if fingerprints:
        images = db.execute(select(Image.id, Image.task_status).where(
            Image.task_id == task.id, ~task_frames.video_frame())).all()
        by_image = {}
        for row in db.execute(select(Annotation.image_id, Annotation.class_id, Annotation.ann_type,
                                     Annotation.geometry, Annotation.pending)
                              .join(Image, Image.id == Annotation.image_id)
                              .where(Image.task_id == task.id, ~task_frames.video_frame())):
            by_image.setdefault(row.image_id, []).append(dict(row._mapping))
        for image in images:
            shapes = by_image.get(image.id, [])
            if shapes or image.task_status in ("annotated", "empty", "deleted"):
                frames[f"i:{image.id}"] = _digest(image.task_status, shapes)

    videos = db.execute(select(TaskVideo).where(TaskVideo.task_id == task.id, TaskVideo.mode == "annotate")).scalars()
    for video in videos:
        tracks, singles = task_frames.video_payload(db, video, shapes=fingerprints)
        plan = video_tracks.plan(tracks, singles, (video.frame_count or 1) - 1)
        for frame, shapes in plan.items():
            if fingerprints:
                frames[f"v:{video.id}:{frame}"] = _digest("annotated", shapes)
            if not any(a.get("pending") for a in shapes):
                annotated += 1
        for frame in video_tracks.empty_frames(tracks, singles, video.empty_frames):
            if fingerprints:
                frames[f"v:{video.id}:{frame}"] = _digest("empty", [])
            annotated += 1
    return frames, annotated


def remember(db, task, user):
    frames, _ = snapshot(db, task)
    db.add(TaskEvent(task_id=task.id, user_id=user.id, kind=BASELINE, payload={"frames": frames}))


def summary(db, task):
    baseline = None
    if task.status == "updating":
        baseline = db.execute(select(TaskEvent).where(TaskEvent.task_id == task.id, TaskEvent.kind == BASELINE)
                              .order_by(TaskEvent.created_at.desc(), TaskEvent.id.desc()).limit(1)).scalar_one_or_none()
    frames, annotated = snapshot(db, task, fingerprints=baseline is not None)
    changed = None
    if baseline is not None:
        before = baseline.payload["frames"]
        changed = sum(before.get(key) != frames.get(key) for key in before.keys() | frames.keys())
    return {"annotated": annotated, "changed": changed}
