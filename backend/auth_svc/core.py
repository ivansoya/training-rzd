"""Core API: friends, projects, invitations. Lives in the auth service because
it owns the DB; splits out into its own service when it grows.
"""
import re
import uuid

from flask import Blueprint, jsonify, request
from sqlalchemy import func, or_, select

from auth_svc.routes import ROLE_LABELS
from auth_svc.sessions import current_session, is_online
from common.db import SessionLocal
from common.models import (
    Annotation,
    Dataset,
    Friendship,
    Image,
    LabelClass,
    Project,
    ProjectInvitation,
    ProjectMember,
    User,
)

bp = Blueprint("core", __name__, url_prefix="/api")

CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]{1,31}$")
ROLES = ("admin", "editor", "viewer")


def _person(user: User, online: bool | None = None) -> dict:
    data = {
        "id": str(user.id),
        "login": user.login,
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
            item = {"friendship_id": str(f.id), "user": _person(other, is_online(other))}
            if f.status == "accepted":
                friends.append(item)
            elif f.requester_id == user.id:
                outgoing.append(item)
            else:
                incoming.append(item)
        return jsonify({"friends": friends, "incoming": incoming, "outgoing": outgoing})


@bp.post("/friends")
def add_friend():
    data = request.get_json(silent=True) or {}
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        target = _find_user(db, data.get("identity") or "")
        if target is None:
            return jsonify({"error": "Пользователь с таким логином или почтой не найден."}), 404
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
        return jsonify({"requested": True, "user": _person(target)}), 201


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
            members_count = db.execute(
                select(func.count()).select_from(ProjectMember).where(ProjectMember.project_id == p.id)
            ).scalar_one()
            datasets_count = db.execute(
                select(func.count()).select_from(Dataset).where(Dataset.project_id == p.id)
            ).scalar_one()
            result.append(
                {
                    "id": str(p.id),
                    "name": p.name,
                    "code": p.code,
                    "description": p.description,
                    "role": m.role,
                    "role_label": ROLE_LABELS.get(m.role, m.role),
                    "members_count": members_count,
                    "datasets_count": datasets_count,
                    "created_at": p.created_at.isoformat(),
                }
            )
        return jsonify({"projects": result})


@bp.post("/projects")
def create_project():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    code = (data.get("code") or "").strip().upper()
    description = (data.get("description") or "").strip() or None
    invites = data.get("invites") or []

    errors = {}
    if not name:
        errors["name"] = "Укажите название проекта."
    if not CODE_RE.match(code):
        errors["code"] = "Код: 2–32 символа, заглавные латинские буквы, цифры и дефис."
    if errors:
        return jsonify({"errors": errors}), 400

    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        if db.execute(select(Project.id).where(Project.code == code)).first():
            return jsonify({"errors": {"code": "Проект с таким кодом уже есть."}}), 409

        project = Project(name=name, code=code, description=description, created_by=user.id)
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
            select(func.count()).select_from(Image).where(Image.project_id == project.id)
        ).scalar_one()
        size_bytes = db.execute(
            select(func.coalesce(func.sum(Image.size_bytes), 0)).where(
                Image.project_id == project.id
            )
        ).scalar_one()
        annotations_count = db.execute(
            select(func.count())
            .select_from(Annotation)
            .join(Image, Annotation.image_id == Image.id)
            .where(Image.project_id == project.id)
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
                LabelClass.name,
                LabelClass.color,
                func.count(Annotation.id).label("cnt"),
            )
            .outerjoin(Annotation, Annotation.class_id == LabelClass.id)
            .where(LabelClass.project_id == project.id)
            .group_by(LabelClass.id)
            .order_by(func.count(Annotation.id).desc())
        ).all()
        classes_json = [
            {"name": c.name, "color": c.color, "annotations": c.cnt} for c in classes
        ]

        creator = db.get(User, project.created_by) if project.created_by else None
        payload = {
            "project": {
                "id": str(project.id),
                "name": project.name,
                "code": project.code,
                "description": project.description,
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
                    "user": _person(i.user),
                    "role_label": ROLE_LABELS.get(i.role, i.role),
                }
                for i in pending
            ]
        return jsonify(payload)


@bp.post("/projects/<code>/invite")
def invite_to_project(code):
    data = request.get_json(silent=True) or {}
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
        target = _find_user(db, data.get("identity") or "")
        if target is None:
            return jsonify({"error": "Пользователь с таким логином или почтой не найден."}), 404
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
            return jsonify({"ok": True, "user": _person(target)})
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
        return jsonify({"ok": True, "user": _person(target)}), 201


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
        inv = _get_my_pending_invitation(db, user, iid)
        if inv is None:
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
