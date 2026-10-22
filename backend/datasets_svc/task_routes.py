"""Таски: пул кадров, который размечают и по частям отдают в проект.

Жизнь таски: на очереди → в работе → готово → изменение → … → закрыто.
На «готово» размеченные кадры получают `dataset_id` и становятся данными
проекта. «Изменение» кадры обратно НЕ выдёргивает — они правятся на месте,
иначе экспорт стал бы невоспроизводимым. «Закрыто» убирает черновое:
неразмеченные кадры и исходное видео.

`task_id` у кадра ставится при загрузке и не снимается никогда: таска — это
происхождение кадра, датасет — его текущая принадлежность.
"""
import json
import os
import shutil
import tempfile
import threading
import uuid

from flask import Blueprint, jsonify, request, send_file
from sqlalchemy import case, func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import aliased

from common import attribution, config, images, jobs, live, tags, task_frames, task_rights
from common.auth import current_user, has_role, project_by_code, role_in
from common.db import SessionLocal
from common.models import (
    AgentRun,
    Annotation,
    Dataset,
    Image,
    LabelClass,
    Project,
    ProjectMember,
    Task,
    TaskAssignee,
    TaskEvent,
    TaskVideo,
    User,
    VideoAnnotation,
    VideoTrack,
)
from common.storage import translit_slug
from common.web import InputError, json_body, public_error
from datasets_svc import copies, materialize
from common import shapes
from datasets_svc import video as videolib
from datasets_svc import video_chunks as chunklib
from datasets_svc import upload, video_busy, video_index
from common.video_frames import FrameClock
from common import video_tracks as tracklib
from datasets_svc import video_queue as queue

bp = Blueprint("tasks", __name__)

IMAGE_EXTS = config.IMAGE_EXTENSIONS
ALLOWED = task_rights.MOVES
STATUS_LABELS = {
    "queued": "на очереди",
    "in_progress": "в работе",
    "done": "готово",
    "updating": "изменение",
    "closed": "закрыто",
}
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

# Подрезка бокса и разбор фигуры переехали в `shapes`: разметка на проводе
# теперь бывает двух видов, и держать её разбор в четырёх файлах порознь
# значило бы развести их при первой правке. Имена оставлены прежними —
# `video_routes` берёт подрезку отсюда.
MIN_BOX_PX = shapes.MIN_BOX_PX
_clamp_box = shapes.clamp_box


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


# Столбцы имён таски и датасета — String(255). Длиннее база не примет, и без
# проверки здесь человек получал HTTP 500 вместо объяснения.
NAME_MAX = 255


NOT_WORKER = "Исполнителем может быть редактор или администратор, зритель размечать не может."


def _team_from(db, project, raw):
    """Состав исполнителей из запроса: ({user_id}, None) или (None, ответ-ошибка)."""
    if not isinstance(raw, list):
        return None, (jsonify({"error": "assignees: ожидается список людей."}), 400)
    ids = {_uuid_or_none(r) for r in raw}
    if None in ids:
        return None, (jsonify({"error": "Исполнитель не состоит в проекте."}), 400)
    roles = dict(db.execute(select(ProjectMember.user_id, ProjectMember.role).where(
        ProjectMember.project_id == project.id, ProjectMember.user_id.in_(ids))).all()) if ids else {}
    if ids - roles.keys():
        return None, (jsonify({"error": "Исполнитель не состоит в проекте."}), 400)
    if not all(has_role(r, "editor") for r in roles.values()):
        return None, (jsonify({"error": NOT_WORKER}), 400)
    return ids, None


def _team(task):
    return {u.id for u in task.assignees}


def _can(task, user, role, what="edit"):
    """edit — работа над кадрами, fill — источники, tag — таги кадра (см. `task_rights`)."""
    team = _team(task)
    if what == "fill":
        return task_rights.can_fill(task.status, role, user.id, team, task.created_by)
    if what == "tag":
        return task_rights.can_tag_frame(task.status, role, user.id, team)
    return task_rights.can_edit(task.status, role, user.id, team)


# Не то состояние — 409 с кодом: редактор по нему пишет, почему правка не легла.
STATE_REFUSAL = {
    "queued": "Таска на очереди — сначала возьмите её в работу.",
    "done": "Таска сдана — верните её к разметке, чтобы править.",
    "closed": "Таска закрыта, разметка заморожена.",
}


def _refusal(task, user, role, what="edit"):
    """None, если можно; иначе ответ: 403 — не ваша таска, 409 — не то состояние или идёт сдача."""
    handing = _handing(task)
    if handing:
        return handing
    if _can(task, user, role, what):
        return None
    if task.status in task_rights.WORK or (what == "fill" and task.status == "queued"):
        return jsonify({"error": "Это не ваша таска.", "code": "not_yours"}), 403
    return jsonify({"error": STATE_REFUSAL[task.status], "code": f"task_{task.status}"}), 409


def _handing(task):
    """409, пока таска сдаётся: кадры роликов достаются фоном, и правка ушла бы мимо сдачи."""
    busy = video_busy.current(video_busy.task_key(task.id))
    if busy is None:
        return None
    return jsonify({"error": "Таска сдаётся — дождитесь конца.", "code": "task_handover",
                    "job_id": busy["job_id"]}), 409


def _rights(task, user, role):
    return task_rights.rights(task.status, role, user.id, _team(task), task.created_by)


def _ping_frame(db, image, user):
    """Правка кадра: таске-происхождению — как прежде, кадру датасета — своё событие:
    его открытый «Фокус» в датасете подтянет правку соседа."""
    _ping(db, image.task_id, image.project_id, user, i=str(image.id))
    if image.dataset_id is not None:
        live.notify(db, "frame", image.id, image.project_id, u=str(user.id))


def _ping(db, task_id, project_id, user, **what):
    """Живое событие таски: кто-то правил. Сосед перечитывает свой кадр, страница — числа.
    i — кадр, v и f — ролик и номер кадра в нём, s — новое состояние или состав."""
    if task_id:
        live.notify(db, "task", task_id, project_id, u=str(user.id), **what)


def _log(db, task, user, kind, **payload):
    db.add(TaskEvent(
        task_id=task.id,
        user_id=user.id if user else None,
        kind=kind,
        payload=payload or None,
    ))


def _states(db, task_id, which):
    """Кадры таски по состояниям. Забракованные не в общем числе: иначе прогресс не дойдёт до конца никогда."""
    rows = dict(db.execute(
        select(Image.task_status, func.count(Image.id))
        .where(Image.task_id == task_id, which)
        .group_by(Image.task_status)
    ).all())
    deleted = rows.get("deleted", 0)
    return {
        # Часть «new»: кадры с рамками агента, которые ещё никто не принял.
        "agent": db.execute(
            select(func.count(Image.id)).where(Image.task_id == task_id, which, task_frames.agent_pending())
        ).scalar_one(),
        "total": sum(rows.values()) - deleted,
        "new": rows.get("new", 0),
        "skipped": rows.get("skipped", 0),
        "annotated": rows.get("annotated", 0),
        "empty": rows.get("empty", 0),
        "deleted": deleted,
    }


def _counts(db, task_id):
    """Счётчики вкладки «Кадры». Кадры размечаемых роликов в них не входят: в таске они
    правятся только в ролике (решение 14.10.2026); их состояния — отдельно в `video`:
    сданная таска на доске показывает все свои изображения, а не одну вкладку."""
    video = task_frames.video_frame()
    accepted, video_accepted = db.execute(
        select(func.count(Image.id).filter(~video), func.count(Image.id).filter(video))
        .where(Image.task_id == task_id, Image.dataset_id.isnot(None))
    ).one()
    # Решённые копии кадров датасета: лягут на исходники, а не уйдут в датасет таски
    copies_decided = db.execute(
        select(func.count(Image.id)).where(
            Image.task_id == task_id, Image.origin_image_id.isnot(None),
            Image.task_status.in_(("annotated", "empty")))
    ).scalar_one()
    return {
        **_states(db, task_id, ~video),
        "accepted": accepted,
        "copies_decided": copies_decided,
        "video_accepted": video_accepted,
        "video": _states(db, task_id, video),
    }


# События, которыми таска переходит из состояния в состояние
STATUS_EVENTS = ("status", "accepted", "done", "closed")


def _status_at(db, task):
    at = db.execute(
        select(func.max(TaskEvent.created_at)).where(
            TaskEvent.task_id == task.id, TaskEvent.kind.in_(STATUS_EVENTS))
    ).scalar_one()
    return (at or task.created_at).isoformat()


def _board_extra(db, task):
    """Сводка для карточки доски: откуда кадры и как идёт разметка роликов — треки, рамки и проверка
    агента по кадрам (решения 14.10.2026). Когда трогали — в лёгком списке: по нему доска сортирует,
    и карточки не прыгают."""
    videos = db.execute(
        select(TaskVideo.id, TaskVideo.mode, TaskVideo.segments, TaskVideo.agent_frames)
        .where(TaskVideo.task_id == task.id)
    ).all()
    files, copied = db.execute(
        select(func.count(Image.id).filter(Image.origin_image_id.is_(None)),
               func.count(Image.id).filter(Image.origin_image_id.isnot(None))).where(
            Image.task_id == task.id, Image.source_video_id.is_(None),
            Image.task_status != "deleted")
    ).one()
    # Ролики на разметку и кадры, где в них ставил рамки агент
    seen = {v.id: set(v.agent_frames or []) for v in videos if v.mode == "annotate"}
    tracks = boxes = done = left = 0
    if seen:
        A = VideoAnnotation
        single = (A.video_id.in_(list(seen)), A.track_id.is_(None))
        tracks = db.execute(select(func.count(VideoTrack.id)).where(VideoTrack.video_id.in_(list(seen)))).scalar_one()
        boxes = db.execute(select(func.count(A.id)).where(*single, A.pending.is_(False))).scalar_one()
        waiting = {}
        for vid, f in db.execute(select(A.video_id, A.frame_no).where(*single, A.pending.is_(True)).distinct()):
            waiting.setdefault(vid, set()).add(f)
        left = sum(len(fs) for fs in waiting.values())
        # Проверено — кадры, где агент ставил рамки и ничего не ждёт: и принятые, и где всё отклонили
        done = sum(len(fs - waiting.get(vid, set())) for vid, fs in seen.items())
    return {
        "sources": {
            "files": files,
            "dataset": copied,
            "cut": sum(1 for v in videos if v.mode == "cut"),
            "uncut": sum(1 for v in videos if v.mode == "cut" and not v.segments),
            "annotate": len(seen),
        },
        "videos": {"tracks": tracks, "boxes": boxes, "agent_done": done, "agent_left": left},
        "handover": (video_busy.current(video_busy.task_key(task.id)) or {}).get("job_id"),
    }


def _people(users):
    return sorted(({"id": str(u.id), "display_name": u.display_name} for u in users),
                  key=lambda p: p["display_name"].lower())


def _names(users):
    return [p["display_name"] for p in _people(users)]


def _task_json(db, task, user, role, with_counts=True):
    author = db.get(User, task.created_by) if task.created_by else None
    dataset = db.get(Dataset, task.target_dataset_id) if task.target_dataset_id else None
    data = {
        "id": str(task.id),
        "name": task.name,
        "status": task.status,
        "status_label": STATUS_LABELS.get(task.status, task.status),
        "assignees": _people(task.assignees),
        "rights": _rights(task, user, role),
        "target_dataset": (
            {"id": str(dataset.id), "name": dataset.name} if dataset
            else ({"id": None, "name": task.target_dataset_name}
                  if task.target_dataset_name else None)
        ),
        "created_at": task.created_at.isoformat(),
        "created_by": author.display_name if author else None,
        "status_at": _status_at(db, task),
        "handover": (video_busy.current(video_busy.task_key(task.id)) or {}).get("job_id"),
    }
    if with_counts:
        data["counts"] = _counts(db, task.id)
    return data


# --------------------------------------------------------------------------- #
# Список и создание
# --------------------------------------------------------------------------- #
def _light_list(db, tasks, user, role):
    """Карточки без счётчиков, пакетом: люди, датасеты и смены состояний — по запросу на всех.
    Счётчики доска спрашивает потом по одной таске (`/summary`)."""
    ids = [t.id for t in tasks]
    teams = {t.id: set() for t in tasks}
    if ids:
        for tid, uid in db.execute(select(TaskAssignee.task_id, TaskAssignee.user_id)
                                   .where(TaskAssignee.task_id.in_(ids))):
            teams[tid].add(uid)
    people = (set().union(*teams.values()) | {t.created_by for t in tasks}) - {None}
    # display_name — свойство, не колонка: людей читаем целиком
    names = {u.id: u.display_name for u in db.execute(select(User).where(User.id.in_(people))).scalars()} if people else {}
    sets = {t.target_dataset_id for t in tasks} - {None}
    datasets = dict(db.execute(select(Dataset.id, Dataset.name).where(Dataset.id.in_(sets))).all()) if sets else {}
    moved, touched, boxed = {}, {}, {}
    if ids:
        moved = dict(db.execute(
            select(TaskEvent.task_id, func.max(TaskEvent.created_at))
            .where(TaskEvent.task_id.in_(ids), TaskEvent.kind.in_(STATUS_EVENTS))
            .group_by(TaskEvent.task_id)
        ).all())
        touched = dict(db.execute(
            select(TaskEvent.task_id, func.max(TaskEvent.created_at))
            .where(TaskEvent.task_id.in_(ids)).group_by(TaskEvent.task_id)
        ).all())
        boxed = dict(db.execute(
            select(Image.task_id, func.max(Annotation.created_at))
            .join(Image, Image.id == Annotation.image_id)
            .where(Image.task_id.in_(ids)).group_by(Image.task_id)
        ).all())
    out = []
    for t in tasks:
        last_box = boxed.get(t.id)
        last = max(d for d in (last_box, touched.get(t.id), t.created_at) if d is not None)
        out.append({
            "id": str(t.id),
            "name": t.name,
            "status": t.status,
            "status_label": STATUS_LABELS.get(t.status, t.status),
            "assignees": sorted(({"id": str(u), "display_name": names[u]} for u in teams[t.id] if u in names),
                                key=lambda p: p["display_name"].lower()),
            "target_dataset": (
                {"id": str(t.target_dataset_id), "name": datasets[t.target_dataset_id]} if t.target_dataset_id in datasets
                else ({"id": None, "name": t.target_dataset_name} if t.target_dataset_name else None)
            ),
            "created_at": t.created_at.isoformat(),
            "created_by": names.get(t.created_by),
            "status_at": (moved.get(t.id) or t.created_at).isoformat(),
            "last_box_at": last_box.isoformat() if last_box else None,
            "last_at": last.isoformat(),
            # Куда карточку можно перетащить по доске — те же переходы, что у кнопок таски.
            "moves": sorted(task_rights.moves(t.status, role, user.id, teams[t.id])),
            # Можно ли пополнять — «В таску ▾» в датасете предлагает только такие
            "fill": task_rights.can_fill(t.status, role, user.id, teams[t.id], t.created_by),
        })
    return out


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
        role = role_in(db, user, project)
        return jsonify({
            "tasks": _light_list(db, tasks, user, role),
            "can_create": has_role(role, "editor"),
            "is_admin": role == "admin",
        })
    finally:
        db.close()


@bp.get("/api/tasks/<task_id>/summary")
def task_summary(task_id):
    """Счётчики карточки доски одной таски: кадры по состояниям, источники, ждущие закрытия."""
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        return jsonify({"id": str(task.id), "counts": _counts(db, task.id), **_board_extra(db, task)})
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
        if len(name) > NAME_MAX:
            return jsonify({"error": f"Название длиннее {NAME_MAX} знаков."}), 400

        role = role_in(db, user, project)
        # Без поля — автор; пустой список — ничья таска, её возьмёт любой редактор.
        team, err = _team_from(db, project, data.get("assignees", [str(user.id)]))
        if err:
            return err
        if role != "admin" and team - {user.id}:
            return jsonify({"error": "Назначать других может администратор."}), 403

        dataset_id = _uuid_or_none(data.get("target_dataset_id"))
        dataset_name = (data.get("target_dataset_name") or "").strip() or None
        if dataset_id is not None:
            ds = db.get(Dataset, dataset_id)
            if ds is None or ds.project_id != project.id:
                return jsonify({"error": "Датасет не найден в проекте."}), 400
        elif not dataset_name:
            # Не спрашиваем дважды: пустое поле означает «датасет с именем таски».
            dataset_name = name
        elif len(dataset_name) > NAME_MAX:
            return jsonify({"error": f"Имя датасета длиннее {NAME_MAX} знаков."}), 400

        task = Task(
            project_id=project.id,
            name=name,
            target_dataset_id=dataset_id,
            target_dataset_name=None if dataset_id else dataset_name,
            created_by=user.id,
        )
        task.assignees = [db.get(User, uid) for uid in team]
        db.add(task)
        db.flush()
        _log(db, task, user, "created", assignees=_names(task.assignees))
        # Таска из датасета: копии кладутся той же транзакцией — пустой таски не останется
        taken, made = None, []
        if data.get("image_ids"):
            taken, made = copies.take(db, task, user, data["image_ids"])
            if taken["added"]:
                _log(db, task, user, "from_dataset", added=taken["added"])
        try:
            db.commit()
        except Exception:
            copies.drop_files(task.project_id, task.id, made)
            raise
        out = _task_json(db, task, user, role)
        if taken:
            out["taken"] = taken
        return jsonify(out), 201
    finally:
        db.close()


@bp.post("/api/projects/<code>/images/take")
def dataset_take_preview(code):
    """Окно «В таску»: сколько кадров уйдёт копиями, из каких датасетов и сколько пропустим."""
    db, project, user, err = _resolve_project(code, "editor")
    if err:
        return err
    try:
        return jsonify(copies.preview(db, project.id, json_body().get("image_ids")))
    finally:
        db.close()


@bp.post("/api/tasks/<task_id>/from-dataset")
def take_from_dataset(task_id):
    """Пополнить таску копиями кадров датасета. Права — как на загрузку файлов."""
    db, task, project, user, role, err = _resolve_task(task_id, "editor")
    if err:
        return err
    try:
        denied = _refusal(task, user, role, "fill")
        if denied:
            return denied
        taken, made = copies.take(db, task, user, json_body().get("image_ids"))
        if taken["added"]:
            _log(db, task, user, "from_dataset", added=taken["added"])
        try:
            db.commit()
        except Exception:
            copies.drop_files(task.project_id, task.id, made)
            raise
        _ping(db, task.id, task.project_id, user)
        return jsonify(taken)
    finally:
        db.close()


@bp.get("/api/tasks/<task_id>")
def get_task(task_id):
    """Лёгкая часть страницы таски: шапка, паспорт без чисел, ролики с готовностью, таги.
    Счётчики — `/counts`, сводка каждого ролика на разметку — `/videos/<id>/pending`:
    страница спрашивает их по очереди, и тяжёлый ролик не держит остальное."""
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        data = _task_json(db, task, user, role, with_counts=False)
        data["project"] = {"code": project.code, "name": project.name}
        data["is_admin"] = role == "admin"
        videos = db.execute(
            select(TaskVideo).where(TaskVideo.task_id == task.id)
            .order_by(TaskVideo.created_at)
        ).scalars().all()
        # Сколько кадров дал каждый ролик и сколько из них в датасете.
        per_video = {vid: (n, a) for vid, n, a in db.execute(
            select(Image.source_video_id, func.count(Image.id),
                   func.count(Image.id).filter(Image.dataset_id.isnot(None)))
            .where(Image.task_id == task.id, Image.source_video_id.isnot(None),
                   Image.task_status != "deleted")
            .group_by(Image.source_video_id)
        ).all()}
        # Сколько объектов ведётся на каждом размечаемом ролике: в списке
        # источников у нарезки счётчик кадров, а у разметки — счётчик треков.
        per_video_tracks = dict(db.execute(
            select(VideoTrack.video_id, func.count(VideoTrack.id))
            .join(TaskVideo, TaskVideo.id == VideoTrack.video_id)
            .where(TaskVideo.task_id == task.id)
            .group_by(VideoTrack.video_id)
        ).all())
        video_tags = tags.of(db, "video", [v.id for v in videos])
        data["videos"] = [
            {
                "id": str(v.id),
                "tag_ids": [str(t) for t in video_tags.get(v.id, [])],
                "prepare": _prepare_state(db, v),
                "file_name": v.file_name,
                "duration_ms": v.duration_ms,
                "fps": v.fps,
                "width": v.width,
                "height": v.height,
                "size_bytes": v.size_bytes,
                "mode": v.mode,
                "frame_count": v.frame_count,
                "segments": v.segments or [],
                "frames": per_video.get(v.id, (0, 0))[0],
                "accepted": per_video.get(v.id, (0, 0))[1],
                "tracks": per_video_tracks.get(v.id, 0),
                "created_at": v.created_at.isoformat(),
            }
            for v in videos
        ]
        # Какие блоки есть на странице: кадров у источника (с бракованными) и когда пришёл
        # первый. Числа по состояниям — в `/counts`; блоки встают сразу и не прыгают потом.
        key = task_frames.source_key()
        data["sources"] = {
            source: {
                "total": total, "frames": frames, "first_at": first.isoformat() if first else None,
            }
            for source, total, frames, first in db.execute(
                select(key, func.count(Image.id),
                       func.count(Image.id).filter(Image.task_status != "deleted"), func.min(Image.created_at))
                .where(Image.task_id == task.id, ~task_frames.video_frame())
                .group_by(key)
            ).all()
        }
        # Копии кадров датасета: из каких датасетов исходники — строки карточки «Из датасета»
        if "dataset" in data["sources"]:
            origin = aliased(Image)
            data["sources"]["dataset"]["datasets"] = [
                {"id": str(ds_id), "name": name, "n": n}
                for ds_id, name, n in db.execute(
                    select(Dataset.id, Dataset.name, func.count(Image.id))
                    .join(origin, origin.id == Image.origin_image_id)
                    .join(Dataset, Dataset.id == origin.dataset_id)
                    .where(Image.task_id == task.id, Image.task_status != "deleted")
                    .group_by(Dataset.id, Dataset.name).order_by(func.count(Image.id).desc())
                ).all()
            ]
        # Справочник тагов едет вместе с таской: его спрашивают три места на
        # этой же странице — карточка ролика, карточка загрузки и редактор.
        data["tags"] = [tags.view(t) for t in tags.project_tags(db, project.id)]
        return jsonify(data)
    finally:
        db.close()


@bp.get("/api/tasks/<task_id>/counts")
def task_counts(task_id):
    """Счётчики страницы таски: паспорт, блоки кадров по источникам, классы."""
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        data = {"counts": _counts(db, task.id)}
        data["from_files"] = db.execute(
            select(func.count(Image.id)).where(
                Image.task_id == task.id, task_frames.source_clause(task.id, "files"),
                Image.task_status != "deleted",
            )
        ).scalar_one()

        # Разбивка по источникам считается здесь, а не на клиенте: клиент
        # видит лишь первую страницу кадров, и его счётчики врали бы тем
        # сильнее, чем больше таска.
        src = task_frames.source_key()
        rows = db.execute(
            select(src, Image.task_status, func.count(Image.id))
            .where(Image.task_id == task.id, ~task_frames.video_frame())
            .group_by(src, Image.task_status)
        ).all()
        buckets = {}
        for key, status, count in rows:
            bucket = buckets.setdefault(key, {
                "new": 0, "annotated": 0, "empty": 0, "skipped": 0, "deleted": 0,
            })
            bucket[status] = bucket.get(status, 0) + count
        accepted = db.execute(
            select(src, func.count(Image.id))
            .where(Image.task_id == task.id, Image.dataset_id.isnot(None), ~task_frames.video_frame())
            .group_by(src)
        ).all()
        for key, count in accepted:
            buckets.setdefault(key, {})["accepted"] = count
        agent_rows = db.execute(
            select(src, func.count(Image.id))
            .where(Image.task_id == task.id, task_frames.agent_pending(), ~task_frames.video_frame())
            .group_by(src)
        ).all()
        for key, count in agent_rows:
            buckets.setdefault(key, {})["agent"] = count
        data["by_source"] = buckets

        # Чем именно размечено: по одному числу «86 разметок» перекос не виден.
        rows = db.execute(
            select(LabelClass.class_index, LabelClass.name, LabelClass.color,
                   func.count(Annotation.id))
            .join(Annotation, Annotation.class_id == LabelClass.id)
            .join(Image, Image.id == Annotation.image_id)
            .where(Image.task_id == task.id, Image.task_status != "deleted", ~task_frames.video_frame())
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


@bp.get("/api/tasks/<task_id>/videos/<video_id>/pending")
def video_pending(task_id, video_id):
    """Что уйдёт из ролика при сдаче; null — ничего (или таска уже сдана).
    Работа по ролику до сдачи не кадры и невидима в счётчиках — без сводки прогресс врал бы."""
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        video = db.get(TaskVideo, _uuid_or_none(video_id))
        if video is None or video.task_id != task.id:
            return jsonify({"error": "Ролик не найден в таске."}), 404
        open_ = video.mode == "annotate" and task.status in materialize.WORKING
        row = materialize.pending_row(db, video, materialize.class_look(db, task.project_id)) if open_ else None
        return jsonify({"pending": row})
    finally:
        db.close()


@bp.patch("/api/tasks/<task_id>")
def update_task(task_id):
    db, task, project, user, role, err = _resolve_task(task_id, "editor")
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        moved = False
        if "assignees" in data:
            if role != "admin":
                return jsonify({"error": "Переназначать может администратор."}), 403
            if task.status == "closed":
                return jsonify({"error": STATE_REFUSAL["closed"], "code": "task_closed"}), 409
            team, err = _team_from(db, project, data["assignees"])
            if err:
                return err
            was = {u.id: u for u in task.assignees}
            if team != was.keys():
                task.assignees = [was.get(uid) or db.get(User, uid) for uid in team]
                _log(db, task, user, "assignees",
                     added=_names(u for u in task.assignees if u.id not in was),
                     removed=_names(u for uid, u in was.items() if uid not in team))
                moved = True
        if "name" in data:
            denied = _refusal(task, user, role, "fill")
            if denied:
                return denied
            name = (data.get("name") or "").strip()
            if not name:
                return jsonify({"error": "Название не может быть пустым."}), 400
            if len(name) > NAME_MAX:
                return jsonify({"error": f"Название длиннее {NAME_MAX} знаков."}), 400
            task.name = name
        db.commit()
        if moved:
            # Снятый исполнитель уходит в просмотр сразу, а не на первом отказе.
            _ping(db, task.id, task.project_id, user, s=task.status)
        return jsonify(_task_json(db, task, user, role))
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Состояния
# --------------------------------------------------------------------------- #
def _target_dataset(db, task, user):
    """Датасет, куда уходят принятые кадры; создаётся при первом «готово»."""
    if task.target_dataset_id:
        return db.get(Dataset, task.target_dataset_id)
    # Замок на проект: две таски, принятые разом, иначе выбрали бы один identifier.
    db.execute(select(Project.id).where(Project.id == task.project_id).with_for_update())
    rows = db.execute(
        select(Dataset.identifier, Dataset.name).where(Dataset.project_id == task.project_id)
    ).all()
    taken = {r.identifier for r in rows}
    names = {r.name for r in rows}
    base = translit_slug(task.target_dataset_name or task.name) or "dataset"
    identifier = base
    n = 2
    while identifier in taken:
        identifier = f"{base}_{n}"
        n += 1
    # Одноимённые таски давали одноимённые датасеты — в списках их не различить.
    title = task.target_dataset_name or task.name
    name, n = title, 2
    while name in names:
        name = f"{title} ({n})"
        n += 1
    ds = Dataset(
        project_id=task.project_id,
        name=name,
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
        # Таска под замком: два «Готово» разом создавали два датасета или падали 500.
        task = db.execute(
            select(Task).where(Task.id == task.id).with_for_update()
            .execution_options(populate_existing=True)
        ).scalar_one()
        target = json_body().get("status")
        if target not in ALLOWED:
            return jsonify({"error": "Неизвестное состояние."}), 400
        if target not in ALLOWED[task.status]:
            return jsonify({
                "error": f"Из «{STATUS_LABELS[task.status]}» нельзя перейти "
                         f"в «{STATUS_LABELS[target]}»."
            }), 409
        team = _team(task)
        if target not in task_rights.moves(task.status, role, user.id, team):
            if target == "closed":
                return jsonify({"error": "Закрыть таску может администратор."}), 403
            if task.status == "queued":
                return jsonify({"error": "Таску назначили другим — взять её могут они."}), 403
            return jsonify({"error": "Это не ваша таска."}), 403
        # На «Готово» ничего не должно меняться; на очереди нарезка не мешает — там готовят материал.
        blocked = _handing(task) \
            or (_agent_running(db, task) if target in ("done", "queued") else None) \
            or (_video_busy(db, task) if target == "done" else None) \
            or (_close_blockers(db, task) if target == "closed" else None)
        if blocked:
            return blocked
        # Кадры роликов рождаются сдачей: «Готово» и «Закрыто» из работы идут фоном.
        if target in ("done", "closed") and task.status != "done":
            videos = materialize.annotate_videos(db, task)
            if videos:
                return _start_handover(db, task, project, user, target, videos)

        result, dropped = {}, []
        if target == "done":
            result = _accept(db, task, user)
        elif target == "closed":
            result = _close(db, task, user)
        elif task_rights.joins_on_take(task.status, target, team):
            task.assignees.append(user)
            _log(db, task, user, "status", status=target, joined=user.display_name)
        else:
            if task.status == "done":
                # Обратно к разметке: черновые кадры роликов уходят, их рамки и так в ролике.
                dropped = materialize.drop_drafts(db, task)
            _log(db, task, user, "status", status=target)

        task.status = target
        db.commit()
        _drop_after_commit(db)
        materialize.drop_frame_files(task.project_id, task.id, dropped)
        _ping(db, task.id, task.project_id, user, s=target)
        payload = _task_json(db, task, user, role)
        payload.update(result)
        return jsonify(payload)
    finally:
        db.close()


def _start_handover(db, task, project, user, target, videos):
    """«Готово»/«Закрыто» таски с роликами: кадры достаются фоном, состояние — только после успеха.
    Объект, у которого план не считается, кадров не даст — отказ до начала, с его именем."""
    by_class = materialize.class_look(db, task.project_id)
    total = 0
    for video in videos:
        row = materialize.pending_row(db, video, by_class)
        if row and row.get("error"):
            bad = next((o for o in row["objects"] if o["error"]), None)
            what = (f"объект «{bad['class_name'] or 'без класса'}» с кадра {bad['start']}: {bad['error']}"
                    if bad else row["error"])
            return jsonify({"error": f"Ролик «{video.file_name}», {what}", "code": "video_plan",
                            "video_id": str(video.id)}), 409
        total += row["frames"] if row else 0

    key = video_busy.task_key(task.id)
    slot = video_busy.take(key, "handover")
    if slot is None:
        return _handing(task)
    taken = []
    for video in videos:
        if video_busy.take(video.id, "handover") is None:
            for vid in [key, *taken]:
                video_busy.release(vid)
            return video_busy.refusal(video.id)
        taken.append(video.id)
    slot["job_id"] = jobs.create("task-handover", total=total, message="Достаю кадры роликов",
                                 project_id=project.id, owner=user.id)
    threading.Thread(target=_run_handover, args=(slot["job_id"], task.id, target, user.id, taken),
                     daemon=True).start()
    # notify коммитит: замок строки таски отпущен, сдача в потоке берёт его сама
    _ping(db, task.id, task.project_id, user, s="handover")
    return jsonify({"job_id": slot["job_id"], "frames": total}), 202


HANDOVER_SUMS = ("created", "updated", "removed", "kept_edited", "waiting", "unchecked", "boxes", "empty")


def _run_handover(job_id, task_id, target, user_id, video_ids):
    """Сдача одной транзакцией: кадры роликов, приёмка, новое состояние. Упала — не записано ничего,
    таска остаётся в работе."""
    db = SessionLocal()
    made, project_id = [], None
    try:
        task = db.execute(select(Task).where(Task.id == task_id).with_for_update()).scalar_one()
        project_id = task.project_id
        user = db.get(User, user_id)
        sums, dropped, base = dict.fromkeys(HANDOVER_SUMS, 0), [], 0
        for video in materialize.annotate_videos(db, task):
            got = materialize.hand_over(db, task, video, user_id,
                                        progress=lambda n, b=base: jobs.update(job_id, processed=b + n))
            made += got["image_ids"]
            dropped += got["dropped_ids"]
            base += got["planned"]
            for k in HANDOVER_SUMS:
                sums[k] += got[k]
        _log(db, task, user, "videos_handed", **sums)
        result = _accept(db, task, user) if target == "done" else _close(db, task, user)
        task.status = target
        db.commit()
        made = []
        _drop_after_commit(db)
        materialize.drop_frame_files(project_id, task_id, dropped)
        jobs.update(job_id, status="done", processed=base, result={**result, **sums})
        _ping(db, task_id, project_id, user, s=target)
    except (videolib.VideoError, tracklib.TrackError) as exc:
        db.rollback()
        jobs.update(job_id, status="error", error=str(exc))
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        jobs.update(job_id, status="error", error=public_error(exc, "Сдать таску не удалось."))
    finally:
        # Упал коммит — строки откатились, а файлы новых кадров уже на томе.
        if made:
            materialize.drop_frame_files(project_id, task_id, made)
        for vid in [video_busy.task_key(task_id), *video_ids]:
            video_busy.release(vid)
        db.close()


def _accept(db, task, user):
    """Размеченные и фоновые кадры уходят в датасет; остальные ждут.

    Кадр с непроверенной рамкой агента тоже ждёт: непроверенное в данные
    проекта не попадает, а выбросить его молча значило бы потерять работу."""
    pending = db.execute(
        select(Image).where(
            Image.task_id == task.id,
            Image.task_status.in_(ACCEPTABLE),
            Image.dataset_id.is_(None),
            Image.origin_image_id.is_(None),
            ~task_frames.has_pending(),
        )
    ).scalars().all()
    # Копии кадров датасета в датасет не идут — их правки ложатся на исходники
    handed, files = copies.hand_over(db, task, lambda o: _drop_from_dataset(db, o, user))
    db.info.setdefault("drop_files", []).extend(files)
    out = {"copies": handed} if any(handed.values()) else {}
    if out:
        _log(db, task, user, "copies_handed", **handed)
    if not pending:
        _log(db, task, user, "done", accepted=0)
        return {"accepted": 0, **out}
    dataset = _target_dataset(db, task, user)
    for img in pending:
        img.dataset_id = dataset.id
    _log(db, task, user, "accepted", accepted=len(pending), dataset=dataset.name)
    return {"accepted": len(pending), "dataset": dataset.name, **out}


def _drop_from_dataset(db, image, user):
    """Кадр уходит из датасета: при живой таске-происхождении мягко (там его вернут),
    иначе насовсем. Отдаёт (каталог, id) — файлы стереть после коммита — или None."""
    origin = db.get(Task, image.task_id) if image.task_id else None
    if origin is not None and origin.status != "closed":
        _soft_delete(db, origin, user, image)
        return None
    base = config.image_base_dir(image.project_id, image.task_id)
    db.delete(image)
    return base, image.id


def _drop_after_commit(db):
    """Файлы кадров, удалённых насовсем в этой транзакции: только после коммита,
    иначе откат оставил бы строки без файлов."""
    for base, image_id in db.info.pop("drop_files", []):
        _drop_files(base, image_id)


def _held(db, image):
    """409, если у кадра датасета живая копия в таске: исходник только для чтения."""
    held = task_frames.live_copies(db, [image.id]).get(image.id)
    if held is None:
        return None
    return jsonify({"error": f"Кадр в таске «{held[1]}» — правьте его там.", "code": "in_task",
                    "task_id": str(held[0]), "task_name": held[1]}), 409


def _drop_files(base, image_id):
    """Три размера кадра на томе. Отсутствие файла — не ошибка."""
    for sub in ("images", "thumbs", "preview"):
        try:
            os.remove(os.path.join(base, sub, f"{image_id}.jpg"))
        except OSError:
            pass


# Как называются работы на человеческом языке. Разметчику нечего делать со
# словом «chunkset», ему нужно знать, что происходит.
STAGE_TEXT = {
    "index": "разбираю на кадры",
    "strip": "клею киноленту",
    "variant": "готовлю ступень качества",
}


def _prepare_state(db, video):
    """Готов ли ролик к работе и что с ним делают прямо сейчас.

    У нарезки требований нет: участки выбирают по самому файлу, а кинолента —
    удобство. У разметки требования жёсткие: без таблиц кадров и пакетов ролик
    не открыть, а без качества по умолчанию нечего показывать. Пока их нет,
    пускать в редактор нельзя — он честно скажет «готовится», но человек уже
    решит, что сломалось.
    """
    progress = queue.progress_of(db, video.id)
    stage = (progress or {}).get("kind")
    # Ждёт чужие ролики — так и пишем, без процента: иначе все карточки разом «клеят ленту».
    waiting = (progress or {}).get("status") == "queued"
    state = {
        "busy": progress is not None,
        "stage": stage,
        "stage_text": "в очереди" if waiting else STAGE_TEXT.get(stage) if stage else None,
        "processed": 0 if waiting else (progress or {}).get("processed", 0),
        "total": 0 if waiting else (progress or {}).get("total", 0),
        "ready": True,
        "error": None,
    }
    if video.mode != "annotate":
        return state

    src = video_index.table(queue.asset(db, video.id, chunklib.SOURCE))
    default = chunklib.default_for(src) if src else None
    asset = queue.asset(db, video.id, default) if default else None
    state["ready"] = bool(
        video.frame_count and asset and asset.file_status == "ready" and asset.file_path
    )
    if asset and asset.file_status == "error":
        state["ready"] = False
        state["error"] = asset.error or "Подготовить ролик не удалось."
    elif not state["ready"] and not state["busy"]:
        failure = queue.last_failure(db, video.id, queue.KIND_INDEX)
        if failure:
            state["error"] = failure.error or "Ролик не удалось разобрать на кадры."
    return state


def _drop_video_files(path):
    """Ролик и всё, что вокруг него наросло: копии ступеней, перегоны,
    кинолента, распакованные кадры. Отсутствие файла — не ошибка."""
    dirs, files = chunklib.leftovers(path)
    for folder in dirs:
        shutil.rmtree(folder, ignore_errors=True)
    for name in [path] + files:
        try:
            os.remove(name)
        except OSError:
            pass


def _video_busy(db, task):
    vids = db.execute(select(TaskVideo.id, TaskVideo.file_name).where(TaskVideo.task_id == task.id)).all()
    busy = [name for vid, name in vids if video_busy.current(vid)]
    if busy:
        return jsonify({
            "error": f"По ролику «{busy[0]}» идёт нарезка — дождитесь конца.",
            "code": "video_busy",
        }), 409
    return None


def _agent_running(db, task):
    agent = db.execute(
        select(AgentRun.id).where(AgentRun.task_id == task.id,
                                  AgentRun.status.in_(("queued", "waiting_gpu", "running")))
    ).first()
    if agent:
        return jsonify({"error": "По таске идёт агент — дождитесь его конца или остановите.",
                        "code": "agent_running"}), 409
    return None


def _close_blockers(db, task):
    """409, если закрытие оборвало бы работу; иначе None. Разметку роликов закрытие
    из работы сперва сдаёт (`_start_handover`) и только потом удаляет ролики."""
    return _video_busy(db, task) or _agent_running(db, task)


def _close(db, task, user):
    """Закрытие доводит «Готово» до конца: размеченные и фоновые кадры уходят
    в датасет, а убирается только черновое — нетронутые, отложенные и
    забракованные кадры и исходники видео. Раньше удалялось всё без датасета,
    и кадр, размеченный после «Готово», пропадал вместе с разметкой."""
    accepted = _accept(db, task, user)
    db.flush()
    # Агента звали и на уже принятые кадры: его непроверенное с ними не уходит.
    unchecked = db.execute(
        Annotation.__table__.delete().where(
            Annotation.pending.is_(True),
            Annotation.image_id.in_(select(Image.id).where(
                Image.task_id == task.id, Image.dataset_id.isnot(None))),
        )
    ).rowcount
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
        path = os.path.join(config.DATA_DIR, v.file_path)
        # Ролик уносит с собой всё, что вокруг него наросло: перегоны, копии
        # ступеней, киноленту, распакованные кадры. Раньше убирались только
        # кадры, а перегоны и копии оставались на томе навсегда — и весят они
        # больше самого исходника.
        _drop_video_files(path)
        video_index.forget(v.id)
        db.delete(v)
    _log(db, task, user, "closed", removed_images=removed, removed_videos=len(videos),
         removed_unchecked=unchecked)
    return {**accepted, "removed_images": removed, "removed_videos": len(videos),
            "removed_unchecked": unchecked}


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
            # Клеить ленту здесь нельзя. На двадцатиминутном ролике это два
            # десятка перемоток по исходнику — секунды в потоке, который в это
            # время не отвечает никому, а браузер успевает оборвать соединение
            # и показать значок битой картинки.
            # Недавний отказ — не ставим заново: битый ролик иначе крутил ленту
            # на каждый опрос и душил подготовку чужих роликов.
            if queue.enqueue(db, row.id, queue.KIND_STRIP) is None:
                failure = queue.last_failure(db, row.id, queue.KIND_STRIP)
                return jsonify({
                    "status": "failed", "code": "strip_failed",
                    "error": (failure.error if failure else None) or "Ленты не будет.",
                }), 409
            return jsonify({
                "status": "preparing",
                "error": "Лента ещё готовится.",
                "retry_after_ms": 1500,
            }), 202
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
        resp = send_file(path, conditional=True)
        # Ролик неизменен, пока существует: он загружен один раз и не
        # перезаписывается. Без этого браузер переспрашивал сервер на каждой
        # перемотке — а перемотка в нарезке это основное действие.
        resp.headers["Cache-Control"] = "private, max-age=86400"
        return resp
    finally:
        db.close()


@bp.delete("/api/tasks/<task_id>/videos/<video_id>")
def delete_video(task_id, video_id):
    """Убрать ролик из таски вместе со всем, что из него нарезано.

    Ролик живёт до закрытия таски именно затем, чтобы к нему возвращаться и
    перевыбирать кадры. Значит и уйти он должен целиком: оставить кадры без
    ролика — это оставить их без ответа на вопрос «откуда они».

    Кадры, уже принятые в датасет, не трогаем: это данные проекта, а не
    черновик таски. Их число возвращаем — человек должен знать, что осталось.
    """
    db, task, project, user, role, err = _resolve_task(task_id, "editor")
    if err:
        return err
    try:
        denied = _refusal(task, user, role, "fill")
        if denied:
            return denied
        vid = _uuid_or_none(video_id)
        row = db.get(TaskVideo, vid) if vid else None
        if row is None or row.task_id != task.id:
            return jsonify({"error": "Видео не найдено."}), 404
        # Посреди нарезки ролик не удаляем: следующие кадры легли бы без источника.
        busy = video_busy.refusal(row.id)
        if busy:
            return busy

        frames = db.execute(
            select(Image).where(Image.source_video_id == row.id)
        ).scalars().all()
        base = config.image_base_dir(task.project_id, task.id)
        removed, kept = 0, 0
        for image in frames:
            if image.dataset_id is not None:
                kept += 1
                continue
            _drop_files(base, image.id)
            db.delete(image)
            removed += 1

        path = os.path.join(config.DATA_DIR, row.file_path)
        name = row.file_name
        _log(db, task, user, "video_removed", file=name, removed=removed, kept=kept)
        # Строку удаляем первой: по каскаду с ней уходят ступени, очередь и
        # разметка ролика. Файлы — следом, когда база уже согласилась.
        db.delete(row)
        db.commit()
        _ping(db, task.id, task.project_id, user)
        _drop_video_files(path)
        video_index.forget(vid)
        return jsonify({"removed": removed, "kept_accepted": kept, "file_name": name})
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
            # Перекодирование теряет тег поворота — поворачиваем сами, иначе кадр набок.
            rgb = images.upright(img).convert("RGB")
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
        denied = _refusal(task, user, role, "fill")
        if denied:
            return denied
        full = upload.room_error(request.content_length or 0)
        if full:
            return jsonify({"error": full, "code": "no_space"}), 507
        files = request.files.getlist("files")
        if not files:
            return jsonify({"error": "Файлы не переданы."}), 400

        # Таги приходят списком на каждый файл, по тому же порядку. «Всем один
        # набор» и «каждому свой» — для сервера одно и то же: карточка загрузки
        # уже решила, что кому, и второго понятия здесь заводить незачем.
        try:
            per_file = json.loads(request.form.get("tags") or "[]")
        except ValueError:
            per_file = []

        base = config.image_base_dir(task.project_id, task.id)
        added, skipped = 0, 0
        for index, file in enumerate(files):
            ext = os.path.splitext(file.filename or "")[1].lower()
            if ext not in IMAGE_EXTS:
                skipped += 1
                continue
            image = _save_upload(db, task, user, file, base)
            if image is None:
                skipped += 1
                continue
            want = per_file[index] if index < len(per_file) else None
            if want:
                tags.attach(db, "image", image.id,
                            tags.valid_ids(db, project.id, want))
            added += 1
        _log(db, task, user, "images_added", added=added, skipped=skipped)
        db.commit()
        _ping(db, task.id, task.project_id, user)
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
        denied = _refusal(task, user, role, "fill")
        if denied:
            return denied
        full = upload.room_error(request.content_length or 0)
        if full:
            return jsonify({"error": full, "code": "no_space"}), 507
        file = request.files.get("file")
        if not file or not file.filename:
            return jsonify({"error": "Файл не передан."}), 400
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in config.VIDEO_EXTENSIONS:
            return jsonify({"error": "Такой формат видео не поддерживается."}), 400
        # Режим выбирается здесь и больше не меняется: от него зависит и то,
        # где живёт разметка, и то, откуда в проекте берутся кадры.
        mode = (request.form.get("mode") or "cut").strip()
        if mode not in ("cut", "annotate"):
            return jsonify({"error": "Неизвестный режим работы с видео."}), 400

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

        # Частота нужна прямо сейчас: без неё покадровая разметка невозможна,
        # и отказать надо на загрузке, а не через минуту фоновой работы.
        # ``probe`` читает только заголовки, это дёшево.
        if mode == "annotate" and not meta.get("fps"):
            os.remove(path)
            return jsonify({
                "error": "В видео нет частоты кадров — размечать его покадрово нельзя."
            }), 400

        row = TaskVideo(
            id=vid, task_id=task.id, file_name=file.filename,
            file_path=os.path.relpath(path, config.DATA_DIR),
            size_bytes=os.path.getsize(path), segments=[],
            mode=mode, created_by=user.id, **meta,
        )
        db.add(row)
        _log(db, task, user, "video_added", file=file.filename,
             duration_ms=meta.get("duration_ms"), mode=mode)
        db.commit()
        _ping(db, task.id, task.project_id, user)

        # Дальше — только заявки в очередь. Раньше здесь строилась таблица
        # кадров и клеилась кинолента, и загрузка держала поток gunicorn всё
        # это время: на большом ролике — секунды, при нескольких загрузках
        # разом — весь пул. Теперь тяжёлое делает воркер, а загрузка
        # заканчивается ровно тогда, когда файл лёг на том.
        queue.enqueue(db, row.id, queue.KIND_STRIP)
        # Таблица кадров и ролику под нарезку: по ней момент плана переводится
        # в кадр точно, как у плеера, а не прикидкой по частоте.
        queue.enqueue(db, row.id, queue.KIND_INDEX)
        return jsonify({
            "id": str(vid), "file_name": row.file_name,
            "size_bytes": row.size_bytes, "mode": mode,
            "frame_count": None, "preparing": mode == "annotate", **meta,
        }), 201
    finally:
        db.close()


def _clock(db, row):
    """Момент ↔ кадр для ролика: по таблице кадров, а пока её нет — по частоте."""
    index = video_index.get(db, row)
    if index is not None:
        return FrameClock(pts=index["pts"], time_base=index["time_base"])
    return FrameClock(fps=row.fps, count=row.frame_count)


def _plan_diff(db, row, segments, clock=None):
    """Что случится, если применить план к уже нарезанным кадрам.

    Всё в номерах кадров: момент плана и нарезанный кадр сравниваются через
    один `FrameClock`. Кадр считается покрытым в любом состоянии, включая
    забракованный: план не воскрешает то, что разметчик выбросил осознанно.
    Принятое в датасет план не удаляет — это уже данные проекта, а не таски.
    """
    clock = clock or _clock(db, row)
    want = videolib.plan_frames(segments, row.duration_ms, clock)
    rows = db.execute(
        select(
            Image.id,
            Image.source_frame_no,
            Image.source_time_ms,
            Image.task_status,
            Image.dataset_id,
            func.count(Annotation.id),
        )
        .outerjoin(Annotation, Annotation.image_id == Image.id)
        .where(Image.source_video_id == row.id)
        .group_by(Image.id)
    ).all()

    def frame_of(no, ms):
        # У кадров, нарезанных до номеров, есть только время.
        return no if no is not None else clock.frame(ms)

    covered = set()
    drop, doomed, annotated, kept = [], [], [], 0
    for image_id, no, ms, status, dataset_id, boxes in rows:
        f = frame_of(no, ms)
        if f is not None:
            covered.add(f)
        if (f is not None and f in want) or status == "deleted":
            continue
        if dataset_id is not None:
            kept += 1
            continue
        drop.append(image_id)
        doomed.append(ms or 0)
        if boxes:
            annotated.append({"ms": ms or 0, "boxes": boxes})
    annotated.sort(key=lambda x: x["ms"])
    return {
        "moments": sorted(want.values()),
        "frames": len(want),
        "add": sorted(f for f in want if f not in covered),
        "drop": drop,
        "doomed": sorted(doomed),
        "annotated": annotated,
        "kept_accepted": kept,
        # Моменты плана, чей кадр уже есть: по ним плашки на таймлайне.
        "existing": sorted(ms for f, ms in want.items() if f in covered),
        "exact": clock.exact,
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
        clock = _clock(db, row)
        est = videolib.estimate(segments, row.duration_ms, row.width, row.height, clock)
        if est.get("error"):
            return jsonify(est)
        diff = _plan_diff(db, row, segments, clock)
        est.update(
            add=len(diff["add"]),
            remove=len(diff["drop"]),
            remove_annotated=diff["annotated"],
            kept_accepted=diff["kept_accepted"],
            existing=diff["existing"],
            doomed=diff["doomed"],
            # Без таблицы кадров число — прикидка по частоте; таблица строится.
            exact=diff["exact"],
        )
        return jsonify(est)
    finally:
        db.close()


def _run_cut_job(job_id, task_id, video_id, segments, user_id):
    db = SessionLocal()
    # Кадры после последнего коммита: при сбое их строки откатятся, а файлы
    # остались бы на томе без записей — убираем их сами.
    pending = []
    base = None
    try:
        task = db.get(Task, task_id)
        row = db.get(TaskVideo, video_id)
        path = os.path.join(config.DATA_DIR, row.file_path)
        # Режем по таблице кадров: ролики, загруженные до неё, получают её здесь.
        index = video_index.ensure(db, row, path)
        clock = FrameClock(pts=index["pts"], time_base=index["time_base"])
        diff = _plan_diff(db, row, segments, clock)
        frames = diff["add"]
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

        jobs.update(job_id, total=len(frames), message="Режу кадры", phase="cut")
        created = []
        # Таги ролика читаем один раз: кадров десятки тысяч, и запрос на
        # каждый превратил бы нарезку в перекличку с базой.
        video_tags = tags.ids_of(db, "video", row.id)

        def on_frame(frame_no, time_ms, img):
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
                source_frame_no=frame_no,
                created_by=user_id,
            )
            db.add(image)
            db.flush()
            tags.link(db, "image", image.id, video_tags)
            full, size, nbytes = videolib.save_frame(img, base, image.id)
            image.file_path = os.path.relpath(full, config.DATA_DIR)
            image.width, image.height = size
            image.size_bytes = nbytes
            created.append(image.id)
            pending.append(image.id)
            if len(created) % 25 == 0:
                db.commit()
                pending.clear()

        videolib.extract_frames(path, frames, on_frame, pts=index["pts"],
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
        _drop_pending(base, pending)
        jobs.update(job_id, status="error", error=str(exc))
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        _drop_pending(base, pending)
        jobs.update(job_id, status="error",
                    error=public_error(exc, "Нарезка ролика прервалась."))
    finally:
        db.close()
        video_busy.release(video_id)


def _drop_pending(base, ids):
    if base:
        for image_id in ids:
            _drop_files(base, image_id)


@bp.post("/api/tasks/<task_id>/videos/<video_id>/cut")
def cut_video(task_id, video_id):
    db, task, project, user, role, err = _resolve_task(task_id, "editor")
    if err:
        return err
    try:
        denied = _refusal(task, user, role, "fill")
        if denied:
            return denied
        vid = _uuid_or_none(video_id)
        row = db.get(TaskVideo, vid) if vid else None
        if row is None or row.task_id != task.id:
            return jsonify({"error": "Видео не найдено."}), 404
        # Размечаемый ролик даёт кадры закрытием разметки; нарезанные из него
        # кадры нигде бы не показались.
        if row.mode != "cut":
            return jsonify({"error": "Этот ролик загружен для разметки, а не для нарезки."}), 409
        segments = (request.get_json(silent=True) or {}).get("segments") or []
        try:
            diff = _plan_diff(db, row, segments)
        except videolib.VideoError as exc:
            return jsonify({"error": str(exc)}), 400
        # Пустой план законен — это «убрать всё нарезанное». Отказываем только
        # когда применение вообще ничего не изменит.
        if not diff["add"] and not diff["drop"]:
            return jsonify({"error": "Плану нечего менять."}), 400

        slot = video_busy.take(row.id, "cut")
        if slot is None:
            return video_busy.refusal(row.id)
        job_id = jobs.create("video-cut", total=len(diff["add"]), message="Подготовка",
                             project_id=project.id, owner=user.id)
        slot["job_id"] = job_id
        threading.Thread(
            target=_run_cut_job,
            args=(job_id, task.id, row.id, segments, user.id),
            daemon=True,
        ).start()
        return jsonify({"job_id": job_id}), 202
    finally:
        db.close()


def _task_boxes(db, ids):
    """{image_id: [рамка в формате редактора]} — для списка кадров и ответа 409."""
    by_image = {i: [] for i in ids}
    if not ids:
        return by_image
    found = db.execute(
        select(Annotation, LabelClass.class_index, LabelClass.name,
               LabelClass.color)
        .join(LabelClass, LabelClass.id == Annotation.class_id)
        .where(Annotation.image_id.in_(ids))
    ).all()
    authors, agents = _authorship(db, [row[0] for row in found])
    for ann, idx, name, color in found:
        wire = shapes.to_wire(ann.ann_type, ann.geometry)
        if not wire:
            continue
        by_image[ann.image_id].append({
            "id": str(ann.id), **wire,
            "class_index": idx, "name": name, "color": color,
            "source": ann.source,
            "pending": ann.pending,
            "conf": (ann.attributes or {}).get("conf"),
            "author": authors.get(ann.created_by),
            # Рамка агента или поправленная рамка агента: что именно,
            # говорит `source`.
            "agent": agents.get(ann.agent_version_id),
            "reviewer": authors.get(ann.reviewed_by),
        })
    return by_image


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
        # Один кадр — редактор перечитывает его, когда кадр поправил сосед
        if request.args.get("image"):
            q = q.where(Image.id == _uuid_or_none(request.args["image"]))
        if status == "agent":
            q = q.where(task_frames.agent_pending())
        elif status:
            q = q.where(Image.task_status == status)
        source = request.args.get("source")
        if source and source not in task_frames.SOURCES:
            source = _uuid_or_none(source)
        clause = task_frames.source_clause(task.id, source)
        if clause is not None:
            q = q.where(clause)
        matched = db.execute(
            select(func.count()).select_from(q.subquery())
        ).scalar_one()
        images = db.execute(
            q.order_by(QUEUE_ORDER, Image.file_name).limit(limit).offset(offset)
        ).scalars().all()

        ids = [i.id for i in images]
        by_image = _task_boxes(db, ids)
        img_tags = tags.of(db, "image", ids)
        # Копия кадра датасета: откуда она — «Исходник» в редакторе
        origins = {oid: (ds_id, name) for oid, ds_id, name in db.execute(
            select(Image.id, Dataset.id, Dataset.name).join(Dataset, Dataset.id == Image.dataset_id)
            .where(Image.id.in_([i.origin_image_id for i in images if i.origin_image_id]))
        ).all()} if any(i.origin_image_id for i in images) else {}
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
                    "rev": img.annotations_rev,
                    "accepted": img.dataset_id is not None,
                    "source_video_id": (
                        str(img.source_video_id) if img.source_video_id else None
                    ),
                    "source_time_ms": img.source_time_ms,
                    "tag_ids": [str(t) for t in img_tags.get(img.id, [])],
                    "annotations": len(by_image[img.id]),
                    "boxes": by_image[img.id],
                    **({"origin": {
                        "image_id": str(img.origin_image_id),
                        "dataset_id": str(origins[img.origin_image_id][0]) if img.origin_image_id in origins else None,
                        "dataset_name": origins.get(img.origin_image_id, (None, None))[1],
                    }} if img.origin_image_id else {}),
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
    больше полусотни боксов. Гонки закрыты блокировкой строки кадра и версией
    разметки (`rev`): запись поверх чужой правки получает 409 `stale`. Взаимная
    блокировка с агентом повторяется — она не ошибка человека.
    """
    for attempt in range(3):
        db = SessionLocal()
        try:
            return _save_annotations(db, image_id)
        except OperationalError as exc:
            db.rollback()
            if getattr(exc.orig, "pgcode", None) != "40P01" or attempt == 2:
                raise
        finally:
            db.close()


def _save_annotations(db, image_id):
    user = current_user(db)
    if user is None:
        return jsonify({"error": "Не выполнен вход."}), 401
    iid = _uuid_or_none(image_id)
    # Строка кадра под замком до конца записи: две записи одного кадра
    # больше не перемешивают удаление и вставку (было 500 и deadlock).
    image = db.execute(
        select(Image).where(Image.id == iid).with_for_update()
    ).scalar_one_or_none() if iid else None
    if image is None:
        return jsonify({"error": "Изображение не найдено."}), 404
    project = db.get(Project, image.project_id)
    role = role_in(db, user, project)
    if not has_role(role, "editor"):
        return jsonify({"error": "Недостаточно прав в проекте."}), 403
    # Принятый кадр — данные проекта: правит любой редактор, таска тут ни при чём.
    # Кроме исходника, чья копия сейчас в работе: у кадра один хозяин.
    if image.task_id and image.dataset_id is None:
        task = db.get(Task, image.task_id)
        denied = _refusal(task, user, role)
        if denied:
            return denied
    elif image.dataset_id is not None:
        held = _held(db, image)
        if held:
            return held

    data = json_body()
    # Битое тело раньше читалось как «боксов нет» и стирало разметку кадра.
    boxes = data.get("boxes")
    if not isinstance(boxes, list) or not all(isinstance(b, dict) for b in boxes):
        raise InputError("boxes: ожидается список фигур.", "boxes")
    # Клиент шлёт версию, которую видел; без неё (агенты, старые клиенты) — без сверки.
    seen = data.get("rev")
    if seen is not None and seen != image.annotations_rev:
        # Свежая разметка — в ответе: клиенту не нужен второй запрос, чтобы её показать.
        return jsonify({
            "error": "Кадр уже изменили — перечитайте его, правка поверх чужой стёрла бы её.",
            "code": "stale",
            "rev": image.annotations_rev,
            "task_status": image.task_status,
            "boxes": _task_boxes(db, [image.id])[image.id],
        }), 409
    by_index = {
        c.class_index: c
        for c in db.execute(
            select(LabelClass).where(LabelClass.project_id == project.id)
        ).scalars()
    }
    width = image.width or 0
    height = image.height or 0

    # Классы, которых в проекте больше нет. Раньше такой бокс молча
    # пропускался — и открытый редактор, переживший удаление класса,
    # терял разметку без единого слова: сохранение стирает всю разметку
    # кадра и вставляет заново, так что «пропустить» здесь значит «стереть».
    # Теперь честный отказ: человек перечитает кадр и увидит, что стало.
    unknown = sorted({
        raw.get("class_index") for raw in (data.get("boxes") or [])
        if by_index.get(raw.get("class_index")) is None
    }, key=lambda v: (v is None, v))
    if unknown:
        return jsonify({
            "error": (
                "Класс исчез из проекта, пока кадр был открыт. "
                "Перечитайте разметку кадра."
            ),
            "code": "class_gone",
            "class_index": unknown,
        }), 409

    fresh = []
    clamped = 0
    existing = {
        str(a.id): {
            "class_id": a.class_id, "ann_type": a.ann_type,
            "geometry": a.geometry, "source": a.source,
            "created_by": a.created_by, "agent_version_id": a.agent_version_id,
            "attributes": a.attributes, "pending": a.pending, "reviewed_by": a.reviewed_by,
        }
        for a in db.execute(
            select(Annotation).where(Annotation.image_id == image.id)
        ).scalars()
    }
    # Ключ запроса остался «boxes»: он давно в клиенте и в тестах, а под
    # ним теперь идут обе фигуры. Что именно пришло, говорит `kind`.
    positions = []  # номер присланной фигуры для каждой записанной
    for pos, raw in enumerate(data["boxes"]):
        cls = by_index[raw.get("class_index")]
        parsed = shapes.from_wire(raw, width, height)
        if parsed is None:
            continue
        positions.append(pos)
        ann_type, geometry, area = parsed
        # Подрезку считаем только у боксов: у контура «сдвинулось ли что-то
        # при подрезке» — вопрос к каждой точке, и складывать их в одно
        # число значило бы отчитываться цифрой, которой нельзя верить.
        if ann_type == "bbox" and (
            round(float(raw.get("w", 0)), 2) != geometry["w"]
            or round(float(raw.get("x", 0)), 2) != geometry["x"]
        ):
            clamped += 1
        fresh.append({
            "id": str(raw.get("id") or ""), "class_id": cls.id,
            "ann_type": ann_type, "geometry": geometry, "area": area,
            "source": raw.get("source"), "pending": raw.get("pending"),
        })

    # Разметка по-прежнему заменяется целиком, но автор переживает замену:
    # нетронутая рамка агента остаётся его, поправленная — того, кто правил.
    # «Подтвердить кадр» — то же сохранение с `confirm`: так оно идёт в общей
    # очереди редактора и сверяется по версии, как любая правка.
    # Ctrl+Z — запись с `undo`: стёртое и изменённое своей же записью возвращается прежней версией.
    restore = attribution.versions(db, [item["id"] for item in fresh], user.id) if data.get("undo") else None
    settled = attribution.settle(existing, fresh, user.id, confirm=bool(data.get("confirm")), restore=restore)
    attribution.keep_versions(db, existing, settled, user.id)
    db.execute(
        Annotation.__table__.delete().where(Annotation.image_id == image.id)
    )
    written = []
    for pos, item, row in zip(positions, fresh, settled):
        if row is None:
            continue
        # Номер рамки прежний, если она пришла со своим: по нему редактор
        # узнаёт её при следующем сохранении.
        ann_id = _uuid_or_none(row.pop("id"))
        ann = Annotation(image_id=image.id, area=item["area"], **row,
                         **({"id": ann_id} if ann_id else {}))
        db.add(ann)
        written.append((pos, ann))

    # Статус кадра идёт за проверенным содержимым: есть рамка человека или
    # проверенная агентова — размечен; стёрли всё — снова нетронутый, если его
    # не откладывали осознанно. Одно непроверенное агента кадр не размечает:
    # «размечен» — это решение человека. У забракованного статус не трогаем.
    checked = any(not ann.pending for _, ann in written)
    if (image.task_id or image.dataset_id) and image.task_status != "deleted":
        if checked:
            image.task_status = "annotated"
        elif fresh:
            if image.task_status == "annotated":
                image.task_status = "empty" if image.dataset_id else "new"
        elif image.task_status == "annotated" or image.dataset_id:
            # Кадр в датасете без объектов остаётся данными — фоновым примером («Пусто» в датасете).
            image.task_status = "empty" if image.dataset_id else "new"
    image.annotations_rev += 1
    db.commit()
    _ping_frame(db, image, user)
    # id и автор — по порядку присланного (null — фигура отброшена): без id
    # клиента каждая запись считалась бы новой рамкой, и settle не работал.
    saved = [None] * len(data["boxes"])
    for pos, ann in written:
        saved[pos] = {"id": str(ann.id), "source": ann.source, "pending": ann.pending}
    return jsonify({"saved": len(written), "clamped": clamped, "shapes": saved,
                    "task_status": image.task_status, "rev": image.annotations_rev})


def _authorship(db, anns):
    """Подписи к рамкам: ({user_id: имя}, {agent_version_id: {name, version}})."""
    user_ids = {a.created_by for a in anns if a.created_by} | {a.reviewed_by for a in anns if a.reviewed_by}
    version_ids = {a.agent_version_id for a in anns if a.agent_version_id}
    authors = {
        u.id: u.display_name
        for u in db.execute(select(User).where(User.id.in_(user_ids))).scalars()
    } if user_ids else {}
    agents = attribution.agent_names(db, version_ids)
    return authors, agents


@bp.patch("/api/images/<image_id>/task-status")
def set_image_status(image_id):
    """Приговор кадру: отложить, объявить фоновым, забраковать или вернуть.

    «deleted» снимает `dataset_id`: забракованный кадр перестаёт быть данными
    проекта сразу, а файлы за ним уберёт `_close` — он и так чистит всё, у чего
    нет датасета. Возврат восстанавливает статус и датасет, которые были до
    брака; присланный статус при этом не важен.
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
        denied = _refusal(task, user, role) or (_held(db, image) if image.dataset_id is not None else None)
        if denied:
            return denied
        status = json_body().get("status")
        if status not in ("new", "skipped", "annotated", "empty", "deleted"):
            return jsonify({"error": "Неизвестное состояние кадра."}), 400

        was = image.task_status
        if status == "deleted":
            _soft_delete(db, task, user, image)
        elif was == "deleted":
            _restore(db, image, status)
            _log(db, task, user, "image_restored", file=image.file_name)
        else:
            image.task_status = status
        db.commit()
        _ping(db, task.id, task.project_id, user, i=str(image.id))
        return jsonify({"task_status": image.task_status, "counts": _counts(db, task.id)})
    finally:
        db.close()


def _soft_delete(db, task, user, image):
    """Брак в живой таске: кадр выходит из данных, но помнит, кем был."""
    if image.task_status != "deleted":
        image.status_before_delete = image.task_status
        image.dataset_before_delete = image.dataset_id
        _log(db, task, user, "image_deleted", file=image.file_name)
    image.task_status = "deleted"
    image.dataset_id = None


def _restore(db, image, asked):
    """«Вернуть»: прежний статус и датасет, если он жив; без памяти — присланный."""
    before = image.status_before_delete or asked
    image.task_status = before
    if before in ("annotated", "empty") and image.dataset_before_delete \
            and db.get(Dataset, image.dataset_before_delete) is not None:
        image.dataset_id = image.dataset_before_delete
    image.status_before_delete = None
    image.dataset_before_delete = None


@bp.put("/api/images/<image_id>/tags")
def set_image_tags(image_id):
    """Таги кадра. Только через таску и только этому кадру — так решили, когда
    заводили таги: массовая правка после приёмки слишком легко переписывает
    чужую работу.

    В закрытой таске правка РАЗРЕШЕНА, в отличие от разметки. Закрытие
    останавливает работу над картинкой, а таг — не работа над картинкой, а её
    паспорт: таски закрывают сразу после приёмки, а набор собирают через
    месяц, и к этому времени ошибку в таге уже нечем было бы исправить.
    """
    db = SessionLocal()
    try:
        user = current_user(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        iid = _uuid_or_none(image_id)
        image = db.get(Image, iid) if iid else None
        if image is None or (image.task_id is None and image.dataset_id is None):
            return jsonify({"error": "Кадр не найден."}), 404
        project = db.get(Project, image.project_id)
        role = role_in(db, user, project)
        if image.dataset_id is not None:
            # Кадр датасета: любой редактор, по одному кадру (решение 14.10.2026), кроме исходника в работе
            if not has_role(role, "editor"):
                return jsonify({"error": "Недостаточно прав в проекте."}), 403
            denied = _held(db, image)
            # Таг — тоже правка в датасете: сдача копии такой кадр не тронет
            image.copy_rev = None
        else:
            # Как разметка, но админ правит и в «Готово», и в закрытой: таг — паспорт кадра,
            # и ошибку в нём иначе нечем исправить.
            denied = _refusal(db.get(Task, image.task_id), user, role, "tag")
        if denied:
            return denied
        want = tags.valid_ids(db, project.id, json_body().get("tags"))
        tags.set_for(db, "image", image.id, want)
        db.commit()
        _ping_frame(db, image, user)
        return jsonify({"tags": [str(t) for t in want]})
    finally:
        db.close()


@bp.put("/api/tasks/<task_id>/videos/<video_id>/tags")
def set_video_tags(task_id, video_id):
    """Таги ролика. Достаются каждому кадру, нарезанному ПОСЛЕ этой правки:
    таг кадра — снимок, а не ссылка. Уже нарезанные кадры не перекрашиваются,
    иначе правка руками одному кадру однажды пропала бы молча."""
    db, task, project, user, role, err = _resolve_task(task_id, "editor")
    if err:
        return err
    try:
        denied = _refusal(task, user, role, "fill")
        if denied:
            return denied
        vid = _uuid_or_none(video_id)
        video = db.get(TaskVideo, vid) if vid else None
        if video is None or video.task_id != task.id:
            return jsonify({"error": "Ролик не найден."}), 404
        want = tags.valid_ids(db, project.id, (
            request.get_json(silent=True) or {}
        ).get("tags"))
        tags.set_for(db, "video", video.id, want)
        db.commit()
        return jsonify({"tags": [str(t) for t in want]})
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
        # Принятый кадр — данные проекта: как и его разметку, удаляет любой редактор.
        if task is not None and image.dataset_id is None:
            denied = _refusal(task, user, role)
            if denied:
                return denied
        held = _held(db, image) if image.dataset_id is not None else None
        if held:
            return held

        if task is not None and task.status != "closed":
            _soft_delete(db, task, user, image)
            db.commit()
            _ping(db, task.id, task.project_id, user, i=str(image.id))
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
