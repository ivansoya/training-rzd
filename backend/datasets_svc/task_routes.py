"""Таски: пул кадров, который размечают и по частям отдают в проект.

Жизнь таски: на очереди → в работе → готово → изменение → … → закрыто.
На «готово» размеченные кадры получают `dataset_id` и становятся данными
проекта. «Изменение» кадры обратно НЕ выдёргивает — они правятся на месте,
иначе экспорт стал бы невоспроизводимым. «Закрыто» убирает черновое:
неразмеченные кадры и исходное видео.

`task_id` у кадра ставится при загрузке и не снимается никогда: таска — это
происхождение кадра, датасет — его текущая принадлежность.
"""
import os
import shutil
import tempfile
import threading
import uuid

from flask import Blueprint, jsonify, request, send_file
from sqlalchemy import case, func, select

from common import config, jobs
from common.auth import current_user, has_role, project_by_code, role_in
from common.db import SessionLocal
from common.models import (
    Annotation,
    Dataset,
    Image,
    LabelClass,
    Project,
    ProjectMember,
    Task,
    TaskEvent,
    TaskVideo,
    User,
)
from common.storage import translit_slug
from datasets_svc import video as videolib

bp = Blueprint("tasks", __name__)

IMAGE_EXTS = config.IMAGE_EXTENSIONS
# Переходы, которые вообще имеют смысл. Всё остальное — ошибка в интерфейсе.
ALLOWED = {
    "queued": {"in_progress", "closed"},
    "in_progress": {"done", "queued", "closed"},
    "done": {"updating", "closed"},
    "updating": {"done", "closed"},
    "closed": set(),
}
STATUS_LABELS = {
    "queued": "на очереди",
    "in_progress": "в работе",
    "done": "готово",
    "updating": "изменение",
    "closed": "закрыто",
}
# Бокс тоньше этого — промах мышью, а не объект.
MIN_BOX_PX = 2.0
# Нетронутое вперёд, отложенное в конец — к нему возвращаются, когда основное
# сделано. Забракованное в самом хвосте: из работы выпало, но видно до закрытия.
QUEUE_ORDER = case(
    (Image.task_status == "new", 0),
    (Image.task_status.in_(("annotated", "empty")), 1),
    (Image.task_status == "skipped", 2),
    else_=3,
)
# Кадры, которые уходят в датасет на «Готово»: размеченные и фоновые. Пустой
# лейбл-файл — штатный пример для YOLO, а не отсутствие работы.
ACCEPTABLE = ("annotated", "empty")


def _clamp_box(box, width, height):
    """Загоняет бокс внутрь кадра.

    Вылезший за край бокс при экспорте в YOLO даёт координату вне [0,1] —
    ровно ту, которую мы отбраковываем на импорте. Чинить это на экспорте
    поздно: там уже не видно, что человек имел в виду.
    """
    try:
        x = float(box.get("x", 0))
        y = float(box.get("y", 0))
        w = float(box.get("w", 0))
        h = float(box.get("h", 0))
    except (TypeError, ValueError):
        return None
    # Отрицательные размеры — это протяжка справа налево; нормализуем.
    if w < 0:
        x, w = x + w, -w
    if h < 0:
        y, h = y + h, -h
    x2 = min(x + w, float(width))
    y2 = min(y + h, float(height))
    x = max(0.0, min(x, float(width)))
    y = max(0.0, min(y, float(height)))
    w = x2 - x
    h = y2 - y
    if w < MIN_BOX_PX or h < MIN_BOX_PX:
        return None
    return {"x": round(x, 2), "y": round(y, 2),
            "w": round(w, 2), "h": round(h, 2)}


# --------------------------------------------------------------------------- #
# Общее
# --------------------------------------------------------------------------- #
def _uuid_or_none(raw):
    try:
        return uuid.UUID(str(raw))
    except (ValueError, TypeError, AttributeError):
        return None


def _resolve_project(code, needed="viewer"):
    db = SessionLocal()
    user = current_user(db)
    if user is None:
        db.close()
        return None, None, None, (jsonify({"error": "Не выполнен вход."}), 401)
    project = project_by_code(db, code)
    if project is None:
        db.close()
        return None, None, None, (jsonify({"error": "Проект не найден."}), 404)
    role = role_in(db, user, project)
    if not has_role(role, needed):
        db.close()
        return None, None, None, (jsonify({"error": "Недостаточно прав в проекте."}), 403)
    return db, project, user, None


def _resolve_task(task_id, needed="viewer"):
    """(db, task, project, user, role, error). Права считаются по проекту."""
    db = SessionLocal()
    user = current_user(db)
    if user is None:
        db.close()
        return (None,) * 5 + ((jsonify({"error": "Не выполнен вход."}), 401),)
    tid = _uuid_or_none(task_id)
    task = db.get(Task, tid) if tid else None
    if task is None:
        db.close()
        return (None,) * 5 + ((jsonify({"error": "Таска не найдена."}), 404),)
    project = db.get(Project, task.project_id)
    role = role_in(db, user, project)
    if not has_role(role, needed):
        db.close()
        return (None,) * 5 + ((jsonify({"error": "Недостаточно прав в проекте."}), 403),)
    return db, task, project, user, role, None


def _may_work(task, user, role):
    """Админ может всё; исполнитель — всё в своей таске, кроме переназначения."""
    return role == "admin" or task.assignee_id == user.id


def _log(db, task, user, kind, **payload):
    db.add(TaskEvent(
        task_id=task.id,
        user_id=user.id if user else None,
        kind=kind,
        payload=payload or None,
    ))


def _counts(db, task_id):
    rows = dict(db.execute(
        select(Image.task_status, func.count(Image.id))
        .where(Image.task_id == task_id)
        .group_by(Image.task_status)
    ).all())
    accepted = db.execute(
        select(func.count(Image.id)).where(
            Image.task_id == task_id, Image.dataset_id.isnot(None)
        )
    ).scalar_one()
    deleted = rows.get("deleted", 0)
    # Забракованные не в общем числе: иначе прогресс не дойдёт до конца никогда.
    return {
        "total": sum(rows.values()) - deleted,
        "new": rows.get("new", 0),
        "skipped": rows.get("skipped", 0),
        "annotated": rows.get("annotated", 0),
        "empty": rows.get("empty", 0),
        "deleted": deleted,
        "accepted": accepted,
    }


def _task_json(db, task, with_counts=True):
    assignee = db.get(User, task.assignee_id) if task.assignee_id else None
    dataset = db.get(Dataset, task.target_dataset_id) if task.target_dataset_id else None
    data = {
        "id": str(task.id),
        "name": task.name,
        "status": task.status,
        "status_label": STATUS_LABELS.get(task.status, task.status),
        "assignee": (
            {"id": str(assignee.id), "display_name": assignee.display_name}
            if assignee else None
        ),
        "target_dataset": (
            {"id": str(dataset.id), "name": dataset.name} if dataset
            else ({"id": None, "name": task.target_dataset_name}
                  if task.target_dataset_name else None)
        ),
        "created_at": task.created_at.isoformat(),
    }
    if with_counts:
        data["counts"] = _counts(db, task.id)
    return data


# --------------------------------------------------------------------------- #
# Список и создание
# --------------------------------------------------------------------------- #
@bp.get("/api/projects/<code>/tasks")
def list_tasks(code):
    db, project, user, err = _resolve_project(code)
    if err:
        return err
    try:
        tasks = db.execute(
            select(Task).where(Task.project_id == project.id)
            .order_by(Task.created_at.desc())
        ).scalars().all()
        return jsonify({
            "tasks": [_task_json(db, t) for t in tasks],
            "can_create": has_role(role_in(db, user, project), "editor"),
            "is_admin": role_in(db, user, project) == "admin",
        })
    finally:
        db.close()


@bp.post("/api/projects/<code>/tasks")
def create_task(code):
    db, project, user, err = _resolve_project(code, "editor")
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Укажите название таски."}), 400

        role = role_in(db, user, project)
        assignee_id = user.id
        raw = data.get("assignee_id")
        if raw:
            # Обычный участник назначает только себя; выбирать исполнителя
            # из команды может администратор.
            if role != "admin" and str(raw) != str(user.id):
                return jsonify({"error": "Назначать других может администратор."}), 403
            target = _uuid_or_none(raw)
            member = db.execute(
                select(ProjectMember).where(
                    ProjectMember.project_id == project.id,
                    ProjectMember.user_id == target,
                )
            ).scalar_one_or_none()
            if member is None:
                return jsonify({"error": "Исполнитель не состоит в проекте."}), 400
            assignee_id = target

        dataset_id = _uuid_or_none(data.get("target_dataset_id"))
        dataset_name = (data.get("target_dataset_name") or "").strip() or None
        if dataset_id is not None:
            ds = db.get(Dataset, dataset_id)
            if ds is None or ds.project_id != project.id:
                return jsonify({"error": "Датасет не найден в проекте."}), 400
        elif not dataset_name:
            # Не спрашиваем дважды: пустое поле означает «датасет с именем таски».
            dataset_name = name

        task = Task(
            project_id=project.id,
            name=name,
            assignee_id=assignee_id,
            target_dataset_id=dataset_id,
            target_dataset_name=None if dataset_id else dataset_name,
            created_by=user.id,
        )
        db.add(task)
        db.flush()
        assignee = db.get(User, assignee_id)
        _log(db, task, user, "created",
             assignee=assignee.display_name if assignee else None)
        db.commit()
        return jsonify(_task_json(db, task)), 201
    finally:
        db.close()


@bp.get("/api/tasks/<task_id>")
def get_task(task_id):
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        data = _task_json(db, task)
        data["project"] = {"code": project.code, "name": project.name}
        data["can_work"] = _may_work(task, user, role)
        data["is_admin"] = role == "admin"
        videos = db.execute(
            select(TaskVideo).where(TaskVideo.task_id == task.id)
            .order_by(TaskVideo.created_at)
        ).scalars().all()
        # Сколько кадров дал каждый ролик и сколько загружено файлами.
        per_video = dict(db.execute(
            select(Image.source_video_id, func.count(Image.id))
            .where(Image.task_id == task.id, Image.source_video_id.isnot(None),
                   Image.task_status != "deleted")
            .group_by(Image.source_video_id)
        ).all())
        data["videos"] = [
            {
                "id": str(v.id),
                "file_name": v.file_name,
                "duration_ms": v.duration_ms,
                "fps": v.fps,
                "width": v.width,
                "height": v.height,
                "size_bytes": v.size_bytes,
                "segments": v.segments or [],
                "frames": per_video.get(v.id, 0),
            }
            for v in videos
        ]
        data["from_files"] = db.execute(
            select(func.count(Image.id)).where(
                Image.task_id == task.id, Image.source_video_id.is_(None),
                Image.task_status != "deleted",
            )
        ).scalar_one()

        # Чем именно размечено: по одному числу «86 разметок» перекос не виден.
        rows = db.execute(
            select(LabelClass.class_index, LabelClass.name, LabelClass.color,
                   func.count(Annotation.id))
            .join(Annotation, Annotation.class_id == LabelClass.id)
            .join(Image, Image.id == Annotation.image_id)
            .where(Image.task_id == task.id, Image.task_status != "deleted")
            .group_by(LabelClass.id)
            .order_by(func.count(Annotation.id).desc())
        ).all()
        data["classes"] = [
            {"class_index": i, "name": n, "color": c, "annotations": k}
            for i, n, c, k in rows
        ]
        return jsonify(data)
    finally:
        db.close()


@bp.patch("/api/tasks/<task_id>")
def update_task(task_id):
    db, task, project, user, role, err = _resolve_task(task_id, "editor")
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        if "assignee_id" in data:
            if role != "admin":
                return jsonify({"error": "Переназначать может администратор."}), 403
            target = _uuid_or_none(data["assignee_id"])
            if target is not None:
                member = db.execute(
                    select(ProjectMember).where(
                        ProjectMember.project_id == project.id,
                        ProjectMember.user_id == target,
                    )
                ).scalar_one_or_none()
                if member is None:
                    return jsonify({"error": "Исполнитель не состоит в проекте."}), 400
            task.assignee_id = target
            who = db.get(User, target) if target else None
            _log(db, task, user, "assigned",
                 assignee=who.display_name if who else None)
        if "name" in data:
            if not _may_work(task, user, role):
                return jsonify({"error": "Это не ваша таска."}), 403
            name = (data.get("name") or "").strip()
            if not name:
                return jsonify({"error": "Название не может быть пустым."}), 400
            task.name = name
        db.commit()
        return jsonify(_task_json(db, task))
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Состояния
# --------------------------------------------------------------------------- #
def _target_dataset(db, task, user):
    """Датасет, куда уходят принятые кадры; создаётся при первом «готово»."""
    if task.target_dataset_id:
        return db.get(Dataset, task.target_dataset_id)
    base = translit_slug(task.target_dataset_name or task.name) or "dataset"
    taken = set(db.execute(
        select(Dataset.identifier).where(Dataset.project_id == task.project_id)
    ).scalars())
    identifier = base
    n = 2
    while identifier in taken:
        identifier = f"{base}_{n}"
        n += 1
    ds = Dataset(
        project_id=task.project_id,
        name=task.target_dataset_name or task.name,
        identifier=identifier,
        created_by=user.id if user else None,
    )
    db.add(ds)
    db.flush()
    task.target_dataset_id = ds.id
    return ds


@bp.post("/api/tasks/<task_id>/status")
def set_status(task_id):
    db, task, project, user, role, err = _resolve_task(task_id, "editor")
    if err:
        return err
    try:
        if not _may_work(task, user, role):
            return jsonify({"error": "Это не ваша таска."}), 403
        target = (request.get_json(silent=True) or {}).get("status")
        if target not in ALLOWED:
            return jsonify({"error": "Неизвестное состояние."}), 400
        if target not in ALLOWED[task.status]:
            return jsonify({
                "error": f"Из «{STATUS_LABELS[task.status]}» нельзя перейти "
                         f"в «{STATUS_LABELS[target]}»."
            }), 409

        result = {}
        if target == "done":
            result = _accept(db, task, user)
        elif target == "closed":
            result = _close(db, task, user)
        else:
            _log(db, task, user, "status", status=target)

        task.status = target
        db.commit()
        payload = _task_json(db, task)
        payload.update(result)
        return jsonify(payload)
    finally:
        db.close()


def _accept(db, task, user):
    """Размеченные и фоновые кадры уходят в датасет; остальные ждут."""
    pending = db.execute(
        select(Image).where(
            Image.task_id == task.id,
            Image.task_status.in_(ACCEPTABLE),
            Image.dataset_id.is_(None),
        )
    ).scalars().all()
    if not pending:
        _log(db, task, user, "done", accepted=0)
        return {"accepted": 0}
    dataset = _target_dataset(db, task, user)
    for img in pending:
        img.dataset_id = dataset.id
    _log(db, task, user, "accepted", accepted=len(pending), dataset=dataset.name)
    return {"accepted": len(pending), "dataset": dataset.name}


def _drop_files(base, image_id):
    """Три размера кадра на томе. Отсутствие файла — не ошибка."""
    for sub in ("images", "thumbs", "preview"):
        try:
            os.remove(os.path.join(base, sub, f"{image_id}.jpg"))
        except OSError:
            pass


def _close(db, task, user):
    """Убираем черновое: неразмеченные кадры и исходники видео."""
    drafts = db.execute(
        select(Image).where(Image.task_id == task.id, Image.dataset_id.is_(None))
    ).scalars().all()
    base = config.image_base_dir(task.project_id, task.id)
    removed = 0
    for img in drafts:
        _drop_files(base, img.id)
        db.delete(img)
        removed += 1

    videos = db.execute(
        select(TaskVideo).where(TaskVideo.task_id == task.id)
    ).scalars().all()
    for v in videos:
        try:
            os.remove(os.path.join(config.DATA_DIR, v.file_path))
        except OSError:
            pass
        db.delete(v)
    _log(db, task, user, "closed", removed_images=removed, removed_videos=len(videos))
    return {"removed_images": removed, "removed_videos": len(videos)}


# --------------------------------------------------------------------------- #
# Кадры таски
# --------------------------------------------------------------------------- #
def _strip_path(task, video_id):
    return os.path.join(
        config.task_video_dir(task.project_id, task.id), f"{video_id}_strip.jpg"
    )


@bp.get("/api/tasks/<task_id>/videos/<video_id>/strip")
def video_strip(task_id, video_id):
    """Кинолента под таймлайн: одна широкая картинка на весь ролик."""
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        vid = _uuid_or_none(video_id)
        row = db.get(TaskVideo, vid) if vid else None
        if row is None or row.task_id != task.id:
            return jsonify({"error": "Видео не найдено."}), 404
        path = _strip_path(task, row.id)
        if not os.path.exists(path):
            videolib.make_strip(
                os.path.join(config.DATA_DIR, row.file_path), path, row.duration_ms
            )
        if not os.path.exists(path):
            return jsonify({"error": "Лента недоступна."}), 404
        resp = send_file(path, mimetype="image/jpeg", conditional=True)
        resp.headers["Cache-Control"] = "private, max-age=31536000, immutable"
        return resp
    finally:
        db.close()


@bp.get("/api/tasks/<task_id>/videos/<video_id>/file")
def video_file(task_id, video_id):
    """Сам ролик — для плеера, с поддержкой перемотки."""
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        vid = _uuid_or_none(video_id)
        row = db.get(TaskVideo, vid) if vid else None
        if row is None or row.task_id != task.id:
            return jsonify({"error": "Видео не найдено."}), 404
        path = os.path.join(config.DATA_DIR, row.file_path)
        if not os.path.exists(path):
            return jsonify({"error": "Файл не найден."}), 404
        return send_file(path, conditional=True)
    finally:
        db.close()


def _save_upload(db, task, user, file, base):
    from PIL import Image as PilImage

    image = Image(
        project_id=task.project_id,
        dataset_id=None,          # пока кадр в таске, он ничей
        task_id=task.id,
        task_status="new",
        file_name=file.filename,
        file_path="",
        split="other",
        created_by=user.id,
    )
    db.add(image)
    db.flush()

    for sub in ("images", "thumbs", "preview"):
        os.makedirs(os.path.join(base, sub), exist_ok=True)
    dest = os.path.join(base, "images", f"{image.id}.jpg")
    try:
        with PilImage.open(file.stream) as img:
            rgb = img.convert("RGB")
            rgb.save(dest, "JPEG", quality=88)
            thumb = rgb.copy()
            thumb.thumbnail(
                (config.THUMB_MAX_SIDE, config.THUMB_MAX_SIDE), PilImage.LANCZOS
            )
            thumb.save(os.path.join(base, "thumbs", f"{image.id}.jpg"),
                       "JPEG", quality=config.THUMB_QUALITY)
            image.width, image.height = rgb.size
    except Exception:  # noqa: BLE001
        db.delete(image)
        return None
    image.file_path = os.path.relpath(dest, config.DATA_DIR)
    image.size_bytes = os.path.getsize(dest)
    return image


@bp.post("/api/tasks/<task_id>/images")
def upload_images(task_id):
    db, task, project, user, role, err = _resolve_task(task_id, "editor")
    if err:
        return err
    try:
        if not _may_work(task, user, role):
            return jsonify({"error": "Это не ваша таска."}), 403
        if task.status == "closed":
            return jsonify({"error": "Таска закрыта — загружать в неё нечего."}), 409
        files = request.files.getlist("files")
        if not files:
            return jsonify({"error": "Файлы не переданы."}), 400

        base = config.image_base_dir(task.project_id, task.id)
        added, skipped = 0, 0
        for file in files:
            ext = os.path.splitext(file.filename or "")[1].lower()
            if ext not in IMAGE_EXTS:
                skipped += 1
                continue
            if _save_upload(db, task, user, file, base) is None:
                skipped += 1
            else:
                added += 1
        _log(db, task, user, "images_added", added=added, skipped=skipped)
        db.commit()
        return jsonify({"added": added, "skipped": skipped,
                        "counts": _counts(db, task.id)}), 201
    finally:
        db.close()


@bp.post("/api/tasks/<task_id>/videos")
def upload_video(task_id):
    """Кладём исходник и отдаём его параметры — резать будем отдельным шагом."""
    db, task, project, user, role, err = _resolve_task(task_id, "editor")
    if err:
        return err
    try:
        if not _may_work(task, user, role):
            return jsonify({"error": "Это не ваша таска."}), 403
        file = request.files.get("file")
        if not file or not file.filename:
            return jsonify({"error": "Файл не передан."}), 400
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in config.VIDEO_EXTENSIONS:
            return jsonify({"error": "Такой формат видео не поддерживается."}), 400

        vid = uuid.uuid4()
        vdir = config.task_video_dir(task.project_id, task.id)
        os.makedirs(vdir, exist_ok=True)
        path = os.path.join(vdir, f"{vid}{ext}")
        file.save(path)
        try:
            meta = videolib.probe(path)
        except videolib.VideoError as exc:
            os.remove(path)
            return jsonify({"error": str(exc)}), 400

        row = TaskVideo(
            id=vid, task_id=task.id, file_name=file.filename,
            file_path=os.path.relpath(path, config.DATA_DIR),
            size_bytes=os.path.getsize(path), segments=[],
            created_by=user.id, **meta,
        )
        db.add(row)
        # Кинолента под таймлайн — сразу, пока файл горячий.
        videolib.make_strip(path, _strip_path(task, vid), meta.get("duration_ms"))
        _log(db, task, user, "video_added", file=file.filename,
             duration_ms=meta.get("duration_ms"))
        db.commit()
        return jsonify({
            "id": str(vid), "file_name": row.file_name,
            "size_bytes": row.size_bytes, **meta,
        }), 201
    finally:
        db.close()


def _plan_diff(db, row, segments):
    """Что случится, если применить план к уже нарезанным кадрам.

    Момент считается покрытым, если кадр с таким временем есть в любом
    состоянии, включая забракованный: план не воскрешает то, что разметчик
    выбросил осознанно. Принятое в датасет план не удаляет — это уже данные
    проекта, а не таски.
    """
    moments = videolib.plan(segments, row.duration_ms)
    want = set(moments)
    rows = db.execute(
        select(
            Image.id,
            Image.source_time_ms,
            Image.task_status,
            Image.dataset_id,
            func.count(Annotation.id),
        )
        .outerjoin(Annotation, Annotation.image_id == Image.id)
        .where(Image.source_video_id == row.id)
        .group_by(Image.id)
    ).all()

    covered = {ms for _, ms, _, _, _ in rows if ms is not None}
    drop, doomed, annotated, kept = [], [], [], 0
    for image_id, ms, status, dataset_id, boxes in rows:
        if ms is None or ms in want or status == "deleted":
            continue
        if dataset_id is not None:
            kept += 1
            continue
        drop.append(image_id)
        doomed.append(ms)
        if boxes:
            annotated.append({"ms": ms, "boxes": boxes})
    annotated.sort(key=lambda x: x["ms"])
    return {
        "moments": moments,
        "add": [m for m in moments if m not in covered],
        "drop": drop,
        "doomed": sorted(doomed),
        "annotated": annotated,
        "kept_accepted": kept,
        "existing": sorted(covered),
    }


@bp.post("/api/tasks/<task_id>/videos/<video_id>/estimate")
def estimate_cut(task_id, video_id):
    """Итог плана и его разница с таской — считаем до запуска, а не после."""
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        vid = _uuid_or_none(video_id)
        row = db.get(TaskVideo, vid) if vid else None
        if row is None or row.task_id != task.id:
            return jsonify({"error": "Видео не найдено."}), 404
        segments = (request.get_json(silent=True) or {}).get("segments") or []
        est = videolib.estimate(segments, row.duration_ms, row.width, row.height)
        if est.get("error"):
            return jsonify(est)
        diff = _plan_diff(db, row, segments)
        est.update(
            add=len(diff["add"]),
            remove=len(diff["drop"]),
            remove_annotated=diff["annotated"],
            kept_accepted=diff["kept_accepted"],
            existing=diff["existing"],
            doomed=diff["doomed"],
        )
        return jsonify(est)
    finally:
        db.close()


def _run_cut_job(job_id, task_id, video_id, segments, user_id):
    db = SessionLocal()
    try:
        task = db.get(Task, task_id)
        row = db.get(TaskVideo, video_id)
        path = os.path.join(config.DATA_DIR, row.file_path)
        diff = _plan_diff(db, row, segments)
        moments = diff["add"]
        base = config.image_base_dir(task.project_id, task.id)

        # Сначала лишнее: кадра нет в плане — значит его не должно было быть.
        # Удаление настоящее, иначе момент остался бы «покрытым» и вернуть
        # участок в план уже не вышло бы.
        for image_id in diff["drop"]:
            image = db.get(Image, image_id)
            if image is None:
                continue
            _drop_files(base, image.id)
            db.delete(image)
        db.commit()

        jobs.update(job_id, total=len(moments), message="Режу кадры", phase="cut")
        created = []

        def on_frame(index, time_ms, img):
            image = Image(
                project_id=task.project_id,
                dataset_id=None,
                task_id=task.id,
                task_status="new",
                # Время до миллисекунд: при шаге меньше секунды имена вида
                # «..._00003s» столкнулись бы, а по ним потом экспортировать.
                file_name=(
                    f"{os.path.splitext(row.file_name)[0]}"
                    f"_{time_ms // 60000:02d}-{time_ms // 1000 % 60:02d}"
                    f".{time_ms % 1000:03d}.jpg"
                ),
                file_path="",
                split="other",
                source_video_id=row.id,
                source_time_ms=time_ms,
                created_by=user_id,
            )
            db.add(image)
            db.flush()
            full, size, nbytes = videolib.save_frame(img, base, image.id)
            image.file_path = os.path.relpath(full, config.DATA_DIR)
            image.width, image.height = size
            image.size_bytes = nbytes
            created.append(image.id)
            if len(created) % 25 == 0:
                db.commit()

        videolib.extract(path, moments, base, on_frame,
                         progress=lambda d, t: jobs.update(job_id, processed=d))

        # План, а не история: он и есть то, что должно быть нарезано, поэтому
        # перезаписывается целиком и при следующем открытии показывается как есть.
        row.segments = [
            {
                "start_ms": int(s.get("start_ms", 0)),
                "end_ms": int(s.get("end_ms", 0)),
                "step_ms": int(s.get("step_ms", 1000)),
            }
            for s in segments
        ]

        user = db.get(User, user_id) if user_id else None
        _log(db, task, user, "video_cut", frames=len(created), file=row.file_name,
             segments=len(segments), removed=len(diff["drop"]))
        db.commit()
        jobs.update(job_id, status="done", processed=len(created),
                    result={"frames": len(created), "removed": len(diff["drop"])})
    except videolib.VideoError as exc:
        db.rollback()
        jobs.update(job_id, status="error", error=str(exc))
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        jobs.update(job_id, status="error", error=str(exc))
    finally:
        db.close()


@bp.post("/api/tasks/<task_id>/videos/<video_id>/cut")
def cut_video(task_id, video_id):
    db, task, project, user, role, err = _resolve_task(task_id, "editor")
    if err:
        return err
    try:
        if not _may_work(task, user, role):
            return jsonify({"error": "Это не ваша таска."}), 403
        vid = _uuid_or_none(video_id)
        row = db.get(TaskVideo, vid) if vid else None
        if row is None or row.task_id != task.id:
            return jsonify({"error": "Видео не найдено."}), 404
        segments = (request.get_json(silent=True) or {}).get("segments") or []
        try:
            diff = _plan_diff(db, row, segments)
        except videolib.VideoError as exc:
            return jsonify({"error": str(exc)}), 400
        # Пустой план законен — это «убрать всё нарезанное». Отказываем только
        # когда применение вообще ничего не изменит.
        if not diff["add"] and not diff["drop"]:
            return jsonify({"error": "Плану нечего менять."}), 400

        job_id = jobs.create("video-cut", total=len(diff["add"]), message="Подготовка")
        threading.Thread(
            target=_run_cut_job,
            args=(job_id, task.id, row.id, segments, user.id),
            daemon=True,
        ).start()
        return jsonify({"job_id": job_id}), 202
    finally:
        db.close()


@bp.get("/api/tasks/<task_id>/images")
def task_images(task_id):
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        status = request.args.get("status")
        limit = min(int(request.args.get("limit", 60)), 200)
        offset = int(request.args.get("offset", 0))
        q = select(Image).where(Image.task_id == task.id)
        if status:
            q = q.where(Image.task_status == status)
        matched = db.execute(
            select(func.count()).select_from(q.subquery())
        ).scalar_one()
        images = db.execute(
            q.order_by(QUEUE_ORDER, Image.file_name).limit(limit).offset(offset)
        ).scalars().all()

        ids = [i.id for i in images]
        by_image = {i: [] for i in ids}
        if ids:
            for ann, idx, name, color in db.execute(
                select(Annotation, LabelClass.class_index, LabelClass.name,
                       LabelClass.color)
                .join(LabelClass, LabelClass.id == Annotation.class_id)
                .where(Annotation.image_id.in_(ids))
            ).all():
                g = ann.geometry or {}
                by_image[ann.image_id].append({
                    "id": str(ann.id),
                    "x": g.get("x", 0), "y": g.get("y", 0),
                    "w": g.get("w", 0), "h": g.get("h", 0),
                    "class_index": idx, "name": name, "color": color,
                    "source": ann.source,
                })
        return jsonify({
            "matched": matched,
            "counts": _counts(db, task.id),
            "images": [
                {
                    "id": str(img.id),
                    "file_name": img.file_name,
                    "width": img.width,
                    "height": img.height,
                    "size_bytes": img.size_bytes,
                    "task_status": img.task_status,
                    "accepted": img.dataset_id is not None,
                    "source_video_id": (
                        str(img.source_video_id) if img.source_video_id else None
                    ),
                    "source_time_ms": img.source_time_ms,
                    "annotations": len(by_image[img.id]),
                    "boxes": by_image[img.id],
                }
                for img in images
            ],
        })
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Разметка
# --------------------------------------------------------------------------- #
@bp.put("/api/images/<image_id>/annotations")
def save_annotations(image_id):
    """Разметка кадра заменяется целиком.

    Так автосохранение остаётся простым и атомарным: на кадре редко бывает
    больше полусотни боксов, а частичные обновления потребовали бы следить
    за идентификаторами на клиенте и разбираться с гонками.
    """
    db = SessionLocal()
    try:
        user = current_user(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        iid = _uuid_or_none(image_id)
        image = db.get(Image, iid) if iid else None
        if image is None:
            return jsonify({"error": "Изображение не найдено."}), 404
        project = db.get(Project, image.project_id)
        role = role_in(db, user, project)
        if not has_role(role, "editor"):
            return jsonify({"error": "Недостаточно прав в проекте."}), 403
        if image.task_id:
            task = db.get(Task, image.task_id)
            if task.status == "closed":
                return jsonify({"error": "Таска закрыта, разметка заморожена."}), 409
            if not _may_work(task, user, role):
                return jsonify({"error": "Это не ваша таска."}), 403

        data = request.get_json(silent=True) or {}
        by_index = {
            c.class_index: c
            for c in db.execute(
                select(LabelClass).where(LabelClass.project_id == project.id)
            ).scalars()
        }
        width = image.width or 0
        height = image.height or 0

        fresh = []
        clamped = 0
        for raw in data.get("boxes") or []:
            cls = by_index.get(raw.get("class_index"))
            if cls is None:
                continue
            geometry = _clamp_box(raw, width, height)
            if geometry is None:
                continue
            if (round(float(raw.get("w", 0)), 2) != geometry["w"]
                    or round(float(raw.get("x", 0)), 2) != geometry["x"]):
                clamped += 1
            fresh.append((cls.id, geometry, raw.get("source") or "human"))

        db.execute(
            Annotation.__table__.delete().where(Annotation.image_id == image.id)
        )
        for class_id, geometry, source in fresh:
            db.add(Annotation(
                image_id=image.id,
                class_id=class_id,
                ann_type="bbox",
                geometry=geometry,
                area=round(geometry["w"] * geometry["h"], 2),
                source=source,
                created_by=user.id,
            ))

        # Статус кадра идёт за содержимым: появились боксы — размечен, стёрли
        # все — снова нетронутый, если его не откладывали осознанно. У
        # забракованного статус не трогаем, иначе он оживёт сам собой.
        if image.task_id and image.task_status != "deleted":
            if fresh:
                image.task_status = "annotated"
            elif image.task_status == "annotated":
                image.task_status = "new"
        db.commit()
        return jsonify({"saved": len(fresh), "clamped": clamped,
                        "task_status": image.task_status})
    finally:
        db.close()


@bp.patch("/api/images/<image_id>/task-status")
def set_image_status(image_id):
    """Приговор кадру: отложить, объявить фоновым, забраковать или вернуть.

    «deleted» снимает `dataset_id`: забракованный кадр перестаёт быть данными
    проекта сразу, а файлы за ним уберёт `_close` — он и так чистит всё, у чего
    нет датасета. Возврат `dataset_id` не восстанавливает: кадр заново поедет
    в датасет на следующем «Готово».
    """
    db = SessionLocal()
    try:
        user = current_user(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        iid = _uuid_or_none(image_id)
        image = db.get(Image, iid) if iid else None
        if image is None or image.task_id is None:
            return jsonify({"error": "Кадр не найден в таске."}), 404
        project = db.get(Project, image.project_id)
        role = role_in(db, user, project)
        task = db.get(Task, image.task_id)
        if not has_role(role, "editor") or not _may_work(task, user, role):
            return jsonify({"error": "Недостаточно прав."}), 403
        if task.status == "closed":
            return jsonify({"error": "Таска закрыта, кадры заморожены."}), 409
        status = (request.get_json(silent=True) or {}).get("status")
        if status not in ("new", "skipped", "annotated", "empty", "deleted"):
            return jsonify({"error": "Неизвестное состояние кадра."}), 400

        was = image.task_status
        if status == "deleted":
            image.dataset_id = None
            _log(db, task, user, "image_deleted", file=image.file_name)
        elif was == "deleted":
            _log(db, task, user, "image_restored", file=image.file_name)
        image.task_status = status
        db.commit()
        return jsonify({"task_status": status, "counts": _counts(db, task.id)})
    finally:
        db.close()


@bp.delete("/api/images/<image_id>")
def delete_image(image_id):
    """Удаление кадра.

    В живой таске оно мягкое: кадр помечается «deleted» и остаётся виден
    разметчику, пока таску не закроют, — передумать можно одним нажатием.
    У кадра вне таски (из архива, из датасета) отменять некому и нечем, поэтому
    там удаление окончательное, вместе с файлами.
    """
    db = SessionLocal()
    try:
        user = current_user(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        iid = _uuid_or_none(image_id)
        image = db.get(Image, iid) if iid else None
        if image is None:
            return jsonify({"error": "Изображение не найдено."}), 404
        project = db.get(Project, image.project_id)
        role = role_in(db, user, project)
        if not has_role(role, "editor"):
            return jsonify({"error": "Недостаточно прав в проекте."}), 403
        task = db.get(Task, image.task_id) if image.task_id else None
        if task is not None and not _may_work(task, user, role):
            return jsonify({"error": "Это не ваша таска."}), 403

        if task is not None and task.status != "closed":
            image.task_status = "deleted"
            image.dataset_id = None
            _log(db, task, user, "image_deleted", file=image.file_name)
            db.commit()
            return jsonify({"ok": True, "soft": True,
                            "counts": _counts(db, task.id)})

        _drop_files(config.image_base_dir(image.project_id, image.task_id), image.id)
        db.delete(image)
        db.commit()
        return jsonify({"ok": True, "soft": False})
    finally:
        db.close()


@bp.get("/api/tasks/<task_id>/events")
def task_events(task_id):
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        rows = db.execute(
            select(TaskEvent).where(TaskEvent.task_id == task.id)
            .order_by(TaskEvent.created_at.desc()).limit(200)
        ).scalars().all()
        return jsonify({"events": [
            {
                "id": str(e.id),
                "kind": e.kind,
                "payload": e.payload or {},
                "created_at": e.created_at.isoformat(),
                "user": e.user.display_name if e.user else None,
            }
            for e in rows
        ]})
    finally:
        db.close()
