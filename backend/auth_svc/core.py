"""Core API: friends, projects, invitations. Lives in the auth service because
it owns the DB; splits out into its own service when it grows.
"""
import os
import secrets
import shutil
import threading
import time
import uuid

from flask import Blueprint, jsonify
from sqlalchemy import and_, delete, func, or_, select

from auth_svc.routes import ROLE_LABELS
from auth_svc.sessions import current_session, is_online
from common import config
from common.db import SessionLocal
from common.storage import has_control
from common.web import InputError, json_body, str_field
from common.models import (
    AgentRun,
    Annotation,
    DataprepJob,
    Dataset,
    Friendship,
    Image,
    LabelClass,
    ModelCheck,
    Project,
    ProjectInvitation,
    ProjectMember,
    Superclass,
    Task,
    TaskVideo,
    TrainRun,
    TrainSet,
    User,
    VideoJob,
)

bp = Blueprint("core", __name__, url_prefix="/api")

# Код проекта человек не придумывает: 20 знаков без похожих I, O, 0 и 1,
# чтобы продиктованный код нельзя было записать неверно.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LEN = 20
ROLES = ("admin", "editor", "viewer")
PROJECT_NAME_MAX = 255


def new_project_code(db) -> str:
    """Свободный код проекта. 100 бит энтропии — проверка тут только страховка."""
    for _ in range(10):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
        if not db.execute(select(Project.id).where(Project.code == code)).first():
            return code
    raise RuntimeError("cannot allocate a free project code")


def _person(user: User, online: bool | None = None, show_login: bool = True) -> dict:
    # Логин не раскрываем тому, кто нашёл человека по почте и ещё не получил ответа.
    data = {
        "id": str(user.id),
        "login": user.login if show_login else "",
        "display_name": user.display_name,
    }
    if online is not None:
        data["online"] = online
        data["last_seen_at"] = (
            user.last_seen_at.isoformat() if user.last_seen_at else None
        )
    return data


def _find_user(db, identity: str) -> User | None:
    identity = identity.strip().lower()
    if not identity:
        return None
    return db.execute(
        select(User).where(
            (func.lower(User.login) == identity) | (func.lower(User.email) == identity)
        )
    ).scalar_one_or_none()


def _parse_uuid(value) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------- friends ---

@bp.get("/friends")
def list_friends():
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        rows = db.execute(
            select(Friendship).where(
                or_(Friendship.requester_id == user.id, Friendship.addressee_id == user.id)
            ).order_by(Friendship.created_at)
        ).scalars().all()
        friends, incoming, outgoing = [], [], []
        for f in rows:
            other = f.addressee if f.requester_id == user.id else f.requester
            # Присутствие — только у друзей: заявка без ответа не даёт следить за человеком.
            accepted = f.status == "accepted"
            mine = f.requester_id == user.id
            item = {"friendship_id": str(f.id), "user": _person(
                other, is_online(other) if accepted else None,
                show_login=accepted or not mine,
            )}
            if f.status == "accepted":
                friends.append(item)
            elif f.requester_id == user.id:
                outgoing.append(item)
            else:
                incoming.append(item)
        return jsonify({"friends": friends, "incoming": incoming, "outgoing": outgoing})


@bp.post("/friends")
def add_friend():
    data = json_body()
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        identity = str_field(data, "identity", max_len=255)
        target = _find_user(db, identity)
        if target is None:
            return jsonify({"error": "Пользователь с таким логином или почтой не найден."}), 404
        by_login = identity.lower() == target.login.lower()
        if target.id == user.id:
            return jsonify({"error": "Нельзя добавить в друзья самого себя."}), 400
        existing = db.execute(
            select(Friendship).where(
                or_(
                    (Friendship.requester_id == user.id) & (Friendship.addressee_id == target.id),
                    (Friendship.requester_id == target.id) & (Friendship.addressee_id == user.id),
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            if existing.status == "accepted":
                return jsonify({"error": f"{target.display_name} уже в друзьях."}), 409
            if existing.requester_id == user.id:
                return jsonify({"error": "Заявка уже отправлена — ждём ответа."}), 409
            # They asked first: adding them back means accepting.
            existing.status = "accepted"
            db.commit()
            return jsonify({"accepted": True, "user": _person(target)})
        db.add(Friendship(requester_id=user.id, addressee_id=target.id, status="pending"))
        db.commit()
        return jsonify({"requested": True, "user": _person(target, show_login=by_login)}), 201


@bp.post("/friends/<fid>/accept")
def accept_friend(fid):
    fuuid = _parse_uuid(fid)
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        f = db.get(Friendship, fuuid) if fuuid else None
        if f is None or f.addressee_id != user.id or f.status != "pending":
            return jsonify({"error": "Заявка не найдена."}), 404
        f.status = "accepted"
        db.commit()
        return jsonify({"ok": True})


@bp.delete("/friends/<fid>")
def remove_friend(fid):
    """Decline a request or remove an accepted friend — the row is deleted."""
    fuuid = _parse_uuid(fid)
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        f = db.get(Friendship, fuuid) if fuuid else None
        if f is None or user.id not in (f.requester_id, f.addressee_id):
            return jsonify({"error": "Запись не найдена."}), 404
        db.delete(f)
        db.commit()
        return jsonify({"ok": True})


# --------------------------------------------------------------- projects ---

def _membership(db, user: User, project: Project) -> ProjectMember | None:
    return db.execute(
        select(ProjectMember).where(
            (ProjectMember.project_id == project.id) & (ProjectMember.user_id == user.id)
        )
    ).scalar_one_or_none()


@bp.get("/projects")
def list_projects():
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        memberships = db.execute(
            select(ProjectMember)
            .where(ProjectMember.user_id == user.id)
            .order_by(ProjectMember.created_at.desc())
        ).scalars().all()
        result = []
        for m in memberships:
            p = m.project
            members = db.execute(
                select(ProjectMember).where(ProjectMember.project_id == p.id)
                .order_by(ProjectMember.created_at)
            ).scalars().all()
            datasets_count = db.execute(
                select(func.count()).select_from(Dataset).where(Dataset.project_id == p.id)
            ).scalar_one()
            # Цифры для плитки проекта: по ним выбирают, куда идти работать.
            images_count = db.execute(
                select(func.count()).select_from(Image)
                .where(Image.project_id == p.id, Image.dataset_id.isnot(None))
            ).scalar_one()
            annotations_count = db.execute(
                select(func.count()).select_from(Annotation)
                .join(Image, Annotation.image_id == Image.id)
                .where(Image.project_id == p.id, Image.dataset_id.isnot(None))
            ).scalar_one()
            classes_count = db.execute(
                select(func.count()).select_from(LabelClass)
                .where(LabelClass.project_id == p.id)
            ).scalar_one()
            # Размечено — как на обзоре: кадр с рамкой или осознанный фон
            in_data = (Image.project_id == p.id) & Image.dataset_id.isnot(None)
            boxed = select(Annotation.image_id).join(Image, Image.id == Annotation.image_id).where(in_data)
            done_count = db.execute(
                select(func.count()).select_from(Image).where(
                    in_data, or_(Image.id.in_(boxed), Image.task_status == "empty"),
                )
            ).scalar_one()
            open_tasks = db.execute(
                select(func.count()).select_from(Task)
                .where(Task.project_id == p.id, Task.status != "closed")
            ).scalar_one()
            run = db.execute(
                select(TrainRun).where(TrainRun.project_id == p.id)
                .order_by(TrainRun.created_at.desc()).limit(1)
            ).scalar_one_or_none()
            result.append(
                {
                    "id": str(p.id),
                    "name": p.name,
                    "code": p.code,
                    "description": p.description,
                    "status": p.status,
                    "role": m.role,
                    "role_label": ROLE_LABELS.get(m.role, m.role),
                    "members_count": len(members),
                    "members": [
                        {"display_name": x.user.display_name, "online": is_online(x.user)}
                        for x in members[:5]
                    ],
                    "datasets_count": datasets_count,
                    "images_count": images_count,
                    "annotations_count": annotations_count,
                    "classes_count": classes_count,
                    "tasks_open": open_tasks,
                    "done_count": done_count,
                    "last_run": run and {
                        "name": run.name,
                        "status": run.status,
                        "epoch": run.current_epoch,
                        "epochs": run.epochs,
                        "at": (run.finished_at or run.started_at or run.created_at).isoformat(),
                    },
                    "created_at": p.created_at.isoformat(),
                }
            )
        return jsonify({"projects": result})


@bp.post("/projects")
def create_project():
    data = json_body()
    name = str_field(data, "name", max_len=4096)
    description = str_field(data, "description", max_len=5000, label="Описание") or None
    invites = data.get("invites") or []
    if not isinstance(invites, list) or not all(isinstance(i, dict) for i in invites):
        raise InputError("invites: ожидается список приглашений.", "invites")

    if not name:
        return jsonify({"errors": {"name": "Укажите название проекта."}}), 400
    # Колонка projects.name — String(255): длиннее падало 500 в базе.
    if len(name) > PROJECT_NAME_MAX:
        return jsonify({"errors": {"name": f"Название длиннее {PROJECT_NAME_MAX} символов."}}), 400
    if has_control(name):
        return jsonify({"errors": {"name": "В названии не должно быть переносов строк и управляющих символов."}}), 400

    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401

        # Проект всегда рождается пустым; в importing его переводит мастер,
        # когда началась заливка архива.
        project = Project(
            name=name,
            code=new_project_code(db),
            description=description,
            created_by=user.id,
        )
        db.add(project)
        db.flush()
        db.add(
            ProjectMember(
                project_id=project.id, user_id=user.id, role="admin", created_by=user.id
            )
        )
        invited = 0
        for inv in invites:
            target_id = _parse_uuid(inv.get("user_id"))
            role = inv.get("role")
            if target_id is None or role not in ROLES or target_id == user.id:
                continue
            if db.get(User, target_id) is None:
                continue
            db.add(
                ProjectInvitation(
                    project_id=project.id,
                    user_id=target_id,
                    role=role,
                    status="pending",
                    created_by=user.id,
                )
            )
            invited += 1
        db.commit()
        return jsonify({"code": project.code, "invited": invited}), 201


@bp.get("/projects/<code>")
def project_detail(code):
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        project = db.execute(
            select(Project).where(Project.code == code.upper())
        ).scalar_one_or_none()
        if project is None:
            return jsonify({"error": "Проект не найден."}), 404
        my = _membership(db, user, project)
        if my is None:
            return jsonify({"error": "Вы не участник этого проекта."}), 403

        members = db.execute(
            select(ProjectMember)
            .where(ProjectMember.project_id == project.id)
            .order_by(ProjectMember.created_at)
        ).scalars().all()
        members_json = [
            {
                **_person(m.user, is_online(m.user)),
                "role": m.role,
                "role_label": ROLE_LABELS.get(m.role, m.role),
            }
            for m in members
        ]

        images_count = db.execute(
            select(func.count()).select_from(Image)
            .where(Image.project_id == project.id, Image.dataset_id.isnot(None))
        ).scalar_one()
        size_bytes = db.execute(
            select(func.coalesce(func.sum(Image.size_bytes), 0)).where(
                Image.project_id == project.id, Image.dataset_id.isnot(None)
            )
        ).scalar_one()
        annotations_count = db.execute(
            select(func.count())
            .select_from(Annotation)
            .join(Image, Annotation.image_id == Image.id)
            .where(Image.project_id == project.id, Image.dataset_id.isnot(None))
        ).scalar_one()

        datasets = db.execute(
            select(Dataset).where(Dataset.project_id == project.id).order_by(Dataset.created_at)
        ).scalars().all()
        datasets_json = []
        for d in datasets:
            d_images = db.execute(
                select(func.count()).select_from(Image).where(Image.dataset_id == d.id)
            ).scalar_one()
            datasets_json.append(
                {
                    "id": str(d.id),
                    "name": d.name,
                    "identifier": d.identifier,
                    "images_count": d_images,
                    "created_at": d.created_at.isoformat(),
                }
            )

        classes = db.execute(
            select(
                LabelClass.class_index,
                LabelClass.name,
                LabelClass.color,
                Superclass.name.label("superclass"),
                func.count(Image.id).label("cnt"),
            )
            .outerjoin(Annotation, Annotation.class_id == LabelClass.id)
            # Полосы классов считают то же множество, что паспорт: разметку на
            # кадрах датасетов. Черновики и брак таски сюда не идут — иначе
            # сумма полос (887) расходилась с «878 разметок» рядом.
            .outerjoin(Image, and_(Image.id == Annotation.image_id, Image.dataset_id.isnot(None)))
            .outerjoin(Superclass, Superclass.id == LabelClass.superclass_id)
            .where(LabelClass.project_id == project.id)
            .group_by(LabelClass.id, Superclass.name)
            .order_by(func.count(Image.id).desc())
        ).all()
        classes_json = [
            {
                "class_index": c.class_index,
                "name": c.name,
                "color": c.color,
                "superclass": c.superclass,
                "annotations": c.cnt,
            }
            for c in classes
        ]

        creator = db.get(User, project.created_by) if project.created_by else None
        payload = {
            "project": {
                "id": str(project.id),
                "name": project.name,
                "code": project.code,
                "description": project.description,
                "status": project.status,
                "created_at": project.created_at.isoformat(),
                "created_by": creator.display_name if creator else None,
            },
            "my_role": my.role,
            "members": members_json,
            "stats": {
                "images": images_count,
                "annotations": annotations_count,
                "size_bytes": int(size_bytes),
                "datasets": len(datasets_json),
                "classes": len(classes_json),
                # Закрытые не считаем: в перечне разделов число говорит
                # «сколько работы», а закрытая таска работой уже не является.
                "tasks": db.execute(
                    select(func.count(Task.id)).where(
                        Task.project_id == project.id, Task.status != "closed"
                    )
                ).scalar_one(),
            },
            "datasets": datasets_json,
            "classes": classes_json,
        }
        if my.role == "admin":
            pending = db.execute(
                select(ProjectInvitation).where(
                    (ProjectInvitation.project_id == project.id)
                    & (ProjectInvitation.status == "pending")
                )
            ).scalars().all()
            payload["pending_invitations"] = [
                {
                    "id": str(i.id),
                    "user": _person(i.user, show_login=False),
                    "role_label": ROLE_LABELS.get(i.role, i.role),
                }
                for i in pending
            ]
        return jsonify(payload)


@bp.post("/projects/<code>/invite")
def invite_to_project(code):
    data = json_body()
    role = data.get("role")
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        project = db.execute(
            select(Project).where(Project.code == code.upper())
        ).scalar_one_or_none()
        if project is None:
            return jsonify({"error": "Проект не найден."}), 404
        my = _membership(db, user, project)
        if my is None or my.role != "admin":
            return jsonify({"error": "Приглашать может только администратор проекта."}), 403
        if role not in ROLES:
            return jsonify({"error": "Укажите роль: администратор, редактор или просмотр."}), 400
        identity = str_field(data, "identity", max_len=255)
        target = _find_user(db, identity)
        if target is None:
            return jsonify({"error": "Пользователь с таким логином или почтой не найден."}), 404
        by_login = identity.lower() == target.login.lower()
        if _membership(db, target, project) is not None:
            return jsonify({"error": f"{target.display_name} уже участник проекта."}), 409
        existing = db.execute(
            select(ProjectInvitation).where(
                (ProjectInvitation.project_id == project.id)
                & (ProjectInvitation.user_id == target.id)
            )
        ).scalar_one_or_none()
        if existing is not None:
            if existing.status == "pending":
                return jsonify({"error": "Приглашение уже отправлено — ждём ответа."}), 409
            # Re-invite after a decline: reuse the row.
            existing.status = "pending"
            existing.role = role
            existing.created_by = user.id
            db.commit()
            return jsonify({"ok": True, "user": _person(target, show_login=by_login)})
        db.add(
            ProjectInvitation(
                project_id=project.id,
                user_id=target.id,
                role=role,
                status="pending",
                created_by=user.id,
            )
        )
        db.commit()
        return jsonify({"ok": True, "user": _person(target, show_login=by_login)}), 201


# ------------------------------------------------------------ invitations ---

@bp.get("/invitations")
def my_invitations():
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        rows = db.execute(
            select(ProjectInvitation)
            .where(
                (ProjectInvitation.user_id == user.id)
                & (ProjectInvitation.status == "pending")
            )
            .order_by(ProjectInvitation.created_at.desc())
        ).scalars().all()
        result = []
        for i in rows:
            inviter = db.get(User, i.created_by) if i.created_by else None
            result.append(
                {
                    "id": str(i.id),
                    "project": {"name": i.project.name, "code": i.project.code},
                    "role": i.role,
                    "role_label": ROLE_LABELS.get(i.role, i.role),
                    "invited_by": inviter.display_name if inviter else None,
                }
            )
        return jsonify({"invitations": result})


def _get_my_pending_invitation(db, user, iid):
    iuuid = _parse_uuid(iid)
    inv = db.get(ProjectInvitation, iuuid) if iuuid else None
    if inv is None or inv.user_id != user.id or inv.status != "pending":
        return None
    return inv


@bp.post("/invitations/<iid>/accept")
def accept_invitation(iid):
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        # Строка приглашения под блокировкой: два «Принять» подряд (двойной
        # щелчок) шли параллельно, оба видели pending, и второй падал 500 на
        # уникальности участника. Теперь второй ждёт первого и получает тот же
        # ответ — повтор принятия безвреден.
        iuuid = _parse_uuid(iid)
        inv = db.get(ProjectInvitation, iuuid, with_for_update=True) if iuuid else None
        if inv is not None and inv.user_id == user.id and inv.status == "accepted" \
                and _membership(db, user, inv.project) is not None:
            return jsonify({"ok": True, "code": inv.project.code})
        if inv is None or inv.user_id != user.id or inv.status != "pending":
            return jsonify({"error": "Приглашение не найдено."}), 404
        inv.status = "accepted"
        db.add(
            ProjectMember(
                project_id=inv.project_id,
                user_id=user.id,
                role=inv.role,
                created_by=inv.created_by,
            )
        )
        db.commit()
        return jsonify({"ok": True, "code": inv.project.code})


@bp.post("/invitations/<iid>/decline")
def decline_invitation(iid):
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        inv = _get_my_pending_invitation(db, user, iid)
        if inv is None:
            return jsonify({"error": "Приглашение не найдено."}), 404
        inv.status = "declined"
        db.commit()
        return jsonify({"ok": True})


# ---------------------------------------------------------- project removal ---

def _project_as_member(db, user, code):
    """Проект и членство в нём. Чужой проект — «не найден», а не «запрещено»:
    незачем подтверждать постороннему, что такой код существует."""
    project = db.execute(
        select(Project).where(Project.code == (code or "").strip().upper())
    ).scalar_one_or_none()
    my = _membership(db, user, project) if project is not None else None
    return (project, my) if my is not None else (None, None)


def _busy_reason(db, project) -> str | None:
    """Что в проекте сейчас работает. Удалять под работающим воркером нельзя:
    он допишет файлы в уже снесённую папку и упадёт на пропавших строках."""
    pid = project.id
    if project.status == "importing":
        return "идёт импорт архива"
    checks = [
        ("идёт обучение", select(func.count()).select_from(TrainRun).where(
            TrainRun.project_id == pid,
            TrainRun.status.in_(("queued", "waiting_gpu", "preparing", "running", "stopping")))),
        ("идёт проверка модели", select(func.count()).select_from(ModelCheck).where(
            ModelCheck.project_id == pid,
            ModelCheck.status.in_(("queued", "waiting_gpu", "running")))),
        ("работает агент разметки", select(func.count()).select_from(AgentRun).where(
            AgentRun.project_id == pid,
            AgentRun.status.in_(("queued", "waiting_gpu", "running")))),
        ("идёт подготовка данных", select(func.count()).select_from(DataprepJob).where(
            DataprepJob.project_id == pid, DataprepJob.status.in_(("queued", "running")))),
        ("обрабатывается видео", select(func.count()).select_from(VideoJob)
            .join(TaskVideo, TaskVideo.id == VideoJob.video_id)
            .join(Task, Task.id == TaskVideo.task_id)
            .where(Task.project_id == pid, VideoJob.status.in_(("queued", "running")))),
    ]
    found = [label for label, q in checks if db.execute(q).scalar_one()]
    return ", ".join(found) or None


TRASH_KEEP_SECONDS = 3600


def _trash_dir():
    return os.path.join(config.TMP_DIR, "deleted-projects")


def _stage_project_files(project_id):
    """Папка проекта (кадры, ролики, наборы, обучения, проверки — всё лежит
    под ней, см. common/config.py) уезжает в корзину одним переименованием —
    до удаления строк: не вышло переименовать — проект остаётся целым.
    Возвращает путь в корзине или None, если папки нет."""
    src = config.project_dir(project_id)
    if not os.path.isdir(src):
        return None
    os.makedirs(_trash_dir(), exist_ok=True)
    dst = os.path.join(_trash_dir(), f"{project_id}-{int(time.time())}")
    os.rename(src, dst)
    return dst


def _purge_trash(fresh):
    """Стереть корзину в фоне: в запросе нельзя — у больших проектов это
    минуты. Заодно хвосты, недочищенные до перезапуска контейнера: возраст —
    по метке в имени, mtime после переименования остаётся старым."""
    def run():
        if fresh:
            shutil.rmtree(fresh, True)
        try:
            names = os.listdir(_trash_dir())
        except OSError:
            return
        now = time.time()
        for name in names:
            stamp = name.rsplit("-", 1)[-1]
            if stamp.isdigit() and now - int(stamp) > TRASH_KEEP_SECONDS:
                shutil.rmtree(os.path.join(_trash_dir(), name), True)
    threading.Thread(target=run, daemon=True).start()


@bp.get("/projects/<code>/cost")
def project_cost(code):
    """Цена удаления: что уйдёт вместе с проектом и не мешает ли работа."""
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        project, _my = _project_as_member(db, user, code)
        if project is None:
            return jsonify({"error": "Проект не найден."}), 404
        pid = project.id

        def count(model, *where, join=None):
            q = select(func.count()).select_from(model)
            if join is not None:
                q = q.join(*join)
            return db.execute(q.where(*where)).scalar_one()

        return jsonify({
            "images": count(Image, Image.project_id == pid),
            "annotations": count(Annotation, Image.project_id == pid,
                                 join=(Image, Annotation.image_id == Image.id)),
            "tasks": count(Task, Task.project_id == pid),
            "train_sets": count(TrainSet, TrainSet.project_id == pid),
            "train_runs": count(TrainRun, TrainRun.project_id == pid),
            "busy": _busy_reason(db, project),
        })


@bp.patch("/projects/<code>")
def update_project(code):
    """Название и описание. Только админ; код проекта не меняется — он в ссылках."""
    data = json_body()
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        project, my = _project_as_member(db, user, code)
        if project is None:
            return jsonify({"error": "Проект не найден."}), 404
        if my.role != "admin":
            return jsonify({"error": "Менять проект может только администратор."}), 403
        if "name" in data:
            name = str_field(data, "name", max_len=4096)
            if not name:
                return jsonify({"errors": {"name": "Укажите название проекта."}}), 400
            if len(name) > PROJECT_NAME_MAX:
                return jsonify({"errors": {"name": f"Название длиннее {PROJECT_NAME_MAX} символов."}}), 400
            if has_control(name):
                return jsonify({"errors": {"name": "В названии не должно быть переносов строк и управляющих символов."}}), 400
            project.name = name
        if "description" in data:
            project.description = str_field(data, "description", max_len=5000,
                                            label="Описание") or None
        db.commit()
        return jsonify({"name": project.name, "description": project.description})


@bp.delete("/projects/<code>")
def delete_project(code):
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        project, my = _project_as_member(db, user, code)
        if project is None:
            return jsonify({"error": "Проект не найден."}), 404
        if my.role != "admin":
            return jsonify({"error": "Удалить проект может только администратор."}), 403
        busy = _busy_reason(db, project)
        if busy:
            return jsonify({"error": f"Сейчас в проекте {busy}. Дождитесь окончания или остановите работу."}), 409
        pid = project.id
        # ponytail: между проверкой и удалением воркер может взять новую
        # работу — окно в миллисекунды; закрывать его блокировкой строки
        # проекта во всех сервисах пока несоразмерно.
        # Строки уходят каскадом базы: все ссылки на projects — CASCADE или
        # SET NULL (проверено по pg_constraint). Удаление через ORM подняло
        # бы в память весь проект ради того же результата.
        try:
            staged = _stage_project_files(pid)
        except OSError:
            return jsonify({"error": "Не удалось убрать файлы проекта — проект не удалён. Попробуйте ещё раз."}), 500
        try:
            db.execute(delete(Project).where(Project.id == pid))
            db.commit()
        except Exception:
            # Строки остались — вернуть и папку, иначе проект без своих файлов.
            if staged:
                os.rename(staged, config.project_dir(pid))
            raise
    _purge_trash(staged)
    return jsonify({"ok": True, "files_removed": staged is not None})


# ---------------------------------------------------------------- members ---

def _admin_count_locked(db, project_id) -> int:
    """Число администраторов под блокировкой их строк: два админа, снимающие
    друг друга одновременно, иначе оба увидели бы «админов двое» и оставили
    проект без хозяина."""
    return len(db.execute(
        select(ProjectMember.id).where(
            ProjectMember.project_id == project_id, ProjectMember.role == "admin"
        ).with_for_update()
    ).all())


def _member_by_user(db, project, user_id):
    uid = _parse_uuid(user_id)
    if uid is None:
        return None
    return db.execute(select(ProjectMember).where(
        ProjectMember.project_id == project.id, ProjectMember.user_id == uid
    )).scalar_one_or_none()


@bp.patch("/projects/<code>/members/<user_id>")
def change_member_role(code, user_id):
    role = json_body().get("role")
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        project, my = _project_as_member(db, user, code)
        if project is None:
            return jsonify({"error": "Проект не найден."}), 404
        if my.role != "admin":
            return jsonify({"error": "Менять роли может только администратор проекта."}), 403
        if role not in ROLES:
            return jsonify({"error": "Укажите роль: администратор, редактор или просмотр."}), 400
        target = _member_by_user(db, project, user_id)
        if target is None:
            return jsonify({"error": "Участник не найден."}), 404
        if target.role == "admin" and role != "admin" and _admin_count_locked(db, project.id) < 2:
            return jsonify({"error": "В проекте должен остаться хотя бы один администратор."}), 409
        target.role = role
        db.commit()
        return jsonify({"ok": True, "role": role, "role_label": ROLE_LABELS[role]})


@bp.delete("/projects/<code>/members/<user_id>")
def remove_member(code, user_id):
    """Исключить участника; себя — значит выйти из проекта. Выйти может
    каждый, исключать других — только администратор."""
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        project, my = _project_as_member(db, user, code)
        if project is None:
            return jsonify({"error": "Проект не найден."}), 404
        target = _member_by_user(db, project, user_id)
        if target is None:
            return jsonify({"error": "Участник не найден."}), 404
        itself = target.user_id == user.id
        if not itself and my.role != "admin":
            return jsonify({"error": "Исключать участников может только администратор проекта."}), 403
        if target.role == "admin" and _admin_count_locked(db, project.id) < 2:
            return jsonify({"error": (
                "Вы последний администратор: назначьте администратором другого участника или удалите проект."
                if itself else "В проекте должен остаться хотя бы один администратор."
            )}), 409
        db.delete(target)
        db.commit()
        return jsonify({"ok": True})


@bp.delete("/projects/<code>/invitations/<iid>")
def revoke_invitation(code, iid):
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        project, my = _project_as_member(db, user, code)
        if project is None:
            return jsonify({"error": "Проект не найден."}), 404
        if my.role != "admin":
            return jsonify({"error": "Отзывать приглашения может только администратор проекта."}), 403
        iuuid = _parse_uuid(iid)
        inv = db.get(ProjectInvitation, iuuid) if iuuid else None
        if inv is None or inv.project_id != project.id or inv.status != "pending":
            return jsonify({"error": "Приглашение не найдено."}), 404
        # Строку удаляем, а не помечаем: повторное приглашение того же
        # человека всё равно начинается с чистого листа.
        db.delete(inv)
        db.commit()
        return jsonify({"ok": True})
