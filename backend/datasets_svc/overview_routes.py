"""Сводка проекта для экрана «Обзор».

Новых таблиц нет: всё выводится из уже записанного — даты появления кадров и
разметок, события тасок, эпохи обучений. Ряды за неделю приблизительны в одном
месте: забракованный кадр уходит из датасета без отметки времени, поэтому
прошлые дни его ещё считают.
"""
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify
from sqlalchemy import func, select

from common.models import (
    Annotation,
    Image,
    LabelClass,
    Task,
    TaskEvent,
    TrainEpoch,
    TrainRun,
    User,
)
from datasets_svc.project_routes import _resolve

bp = Blueprint("overview", __name__)

DAYS = 7
MAP50 = "metrics/mAP50(B)"
MAP95 = "metrics/mAP50-95(B)"
ACTIVITY = 12


def _day_ends(now: datetime) -> list[datetime]:
    """Концы последних семи суток; последний — «сейчас»."""
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return [today - timedelta(days=DAYS - 1 - i) + timedelta(days=1) for i in range(DAYS - 1)] + [now]


def _cumulative(total: int, stamps: list[tuple[datetime, int]], ends: list[datetime]) -> list[int]:
    """Сколько было на конец каждого дня: текущее минус пришедшее позже."""
    return [total - sum(n for at, n in stamps if at > end) for end in ends]


@bp.get("/api/projects/<code>/overview")
def overview(code):
    db, project, err = _resolve(code)
    if err:
        return err
    try:
        now = datetime.now(timezone.utc)
        ends = _day_ends(now)
        week_ago = now - timedelta(days=DAYS)
        in_project = (Image.project_id == project.id) & Image.dataset_id.isnot(None)

        # --- кадры: пришли архивом (без таски) или приняты из таски ---
        total = db.scalar(select(func.count()).select_from(Image).where(in_project)) or 0
        img_hour = func.date_trunc("hour", Image.created_at)
        imported = db.execute(
            select(img_hour, func.count())
            .where(in_project, Image.task_id.is_(None), Image.created_at > week_ago)
            .group_by(img_hour)
        ).all()
        accepted = db.execute(
            select(TaskEvent.created_at, TaskEvent.payload)
            .join(Task, Task.id == TaskEvent.task_id)
            .where(Task.project_id == project.id, TaskEvent.kind == "accepted",
                   TaskEvent.created_at > week_ago)
        ).all()
        frame_stamps = [(at, n) for at, n in imported] + [
            (at, int((p or {}).get("accepted") or 0)) for at, p in accepted
        ]
        frames_week = sum(n for at, n in frame_stamps if at > week_ago)

        # --- разметка: кадр размечен с первой рамки; «пусто» — осознанный фон ---
        first_box = (
            select(Annotation.image_id, func.min(Annotation.created_at).label("at"))
            .join(Image, Image.id == Annotation.image_id)
            .where(in_project)
            .group_by(Annotation.image_id)
            .subquery()
        )
        annotated = db.scalar(select(func.count()).select_from(first_box)) or 0
        recent_first = db.execute(
            select(first_box.c.at).where(first_box.c.at > week_ago)
        ).scalars().all()
        empty = db.scalar(
            select(func.count()).select_from(Image).where(
                in_project, Image.task_status == "empty",
                ~Image.id.in_(select(Annotation.image_id)),
            )
        ) or 0

        boxes = db.scalar(
            select(func.count()).select_from(Annotation)
            .join(Image, Image.id == Annotation.image_id).where(in_project)
        ) or 0
        box_hour = func.date_trunc("hour", Annotation.created_at)
        recent_boxes = db.execute(
            select(box_hour, func.count())
            .join(Image, Image.id == Annotation.image_id)
            .where(in_project, Annotation.created_at > week_ago)
            .group_by(box_hour)
        ).all()

        frames_series = _cumulative(total, frame_stamps, ends)
        annotated_series = _cumulative(annotated, [(at, 1) for at in recent_first], ends)
        done_share = [
            round((a + empty) / f, 4) if f else 0 for a, f in zip(annotated_series, frames_series)
        ]

        # --- баланс классов по сплитам ---
        by_split = db.execute(
            select(Annotation.class_id, Image.split, func.count())
            .join(Image, Image.id == Annotation.image_id)
            .where(in_project)
            .group_by(Annotation.class_id, Image.split)
        ).all()
        split_of: dict = {}
        for cid, split, n in by_split:
            row = split_of.setdefault(cid, {"train": 0, "val": 0, "other": 0})
            row["train" if split == "train" else "val" if split == "val" else "other"] += n
        classes = db.execute(
            select(LabelClass).where(LabelClass.project_id == project.id)
            .order_by(LabelClass.class_index)
        ).scalars().all()
        class_rows = [
            {"id": str(c.id), "index": c.class_index, "name": c.name, "color": c.color,
             **split_of.get(c.id, {"train": 0, "val": 0, "other": 0})}
            for c in classes
        ]

        # --- обучение: последний прогон с рядом метрик и лучший результат ---
        runs = db.execute(
            select(TrainRun).where(TrainRun.project_id == project.id)
            .order_by(TrainRun.created_at.desc())
        ).scalars().all()
        epochs = db.execute(
            select(TrainEpoch.run_id, TrainEpoch.epoch, TrainEpoch.metrics)
            .where(TrainEpoch.run_id.in_([r.id for r in runs]))
            .order_by(TrainEpoch.run_id, TrainEpoch.epoch)
        ).all() if runs else []
        series: dict = {}
        for run_id, epoch, metrics in epochs:
            series.setdefault(run_id, []).append((epoch, metrics or {}))

        best = None
        for r in runs:
            for epoch, m in series.get(r.id, []):
                v = m.get(MAP50)
                if isinstance(v, (int, float)) and (best is None or v > best["map50"]):
                    best = {"run_id": str(r.id), "name": r.name, "epoch": epoch, "map50": v}
        best_series = []
        if best:
            per_epoch = series.get(next(r.id for r in runs if str(r.id) == best["run_id"]), [])
            best_series = [m.get(MAP50) for _, m in per_epoch if isinstance(m.get(MAP50), (int, float))]

        latest = None
        if runs:
            r = runs[0]
            rows = series.get(r.id, [])
            latest = {
                "id": str(r.id), "name": r.name, "model": r.base_model,
                "imgsz": (r.params or {}).get("imgsz"), "status": r.status,
                "epoch": r.current_epoch, "epochs": r.epochs,
                "map50": [m.get(MAP50) for _, m in rows],
                "map95": [m.get(MAP95) for _, m in rows],
            }

        # --- лента: события тасок и обучения вперемешку, свежие сверху ---
        events = db.execute(
            select(TaskEvent, Task.name, Task.id, User.display_name)
            .join(Task, Task.id == TaskEvent.task_id)
            .outerjoin(User, User.id == TaskEvent.user_id)
            .where(Task.project_id == project.id)
            .order_by(TaskEvent.created_at.desc())
            .limit(ACTIVITY)
        ).all()
        activity = [
            {"at": e.created_at.isoformat(), "kind": e.kind, "payload": e.payload or {},
             "user": who, "task": {"id": str(tid), "name": tname}}
            for e, tname, tid, who in events
        ]
        authors = {
            u.id: u.display_name for u in db.execute(
                select(User).where(User.id.in_([r.created_by for r in runs[:ACTIVITY] if r.created_by]))
            ).scalars()
        } if runs else {}
        for r in runs[:ACTIVITY]:
            activity.append({
                "at": r.created_at.isoformat(), "kind": "run_created", "payload": {"name": r.name},
                "user": authors.get(r.created_by), "run": {"id": str(r.id), "name": r.name},
            })
            if r.finished_at:
                activity.append({
                    "at": r.finished_at.isoformat(), "kind": "run_finished",
                    "payload": {"name": r.name, "status": r.status},
                    "user": None, "run": {"id": str(r.id), "name": r.name},
                })
        activity.sort(key=lambda a: a["at"], reverse=True)
        activity = activity[:ACTIVITY]

        return jsonify({
            "updated_at": activity[0]["at"] if activity else None,
            "frames": {"total": total, "week": frames_week, "series": frames_series},
            "annotated": {"count": annotated, "empty": empty, "share": done_share},
            "boxes": {"total": boxes,
                      "series": _cumulative(boxes, [(at, n) for at, n in recent_boxes], ends)},
            "classes": {"declared": len(classes),
                        "used": sum(1 for c in class_rows if c["train"] + c["val"] + c["other"]),
                        "rows": class_rows},
            "best": best and {**best, "series": best_series},
            "latest_run": latest,
            "activity": activity,
        })
    finally:
        db.close()
