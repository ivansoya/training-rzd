"""Reading the session cookie — shared by every service that needs to know who
is calling. Issuing sessions stays in the auth service; this is the read side,
so the datasets service can authorize project work without importing it.
"""
import hashlib
from datetime import datetime, timezone

from flask import request
from sqlalchemy import select

from common.models import AuthSession, Project, ProjectMember, User

SESSION_COOKIE = "session"
# Roles ordered by power: an editor may do anything a viewer may.
ROLE_RANK = {"viewer": 0, "editor": 1, "admin": 2}


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _aware(dt):
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def current_user(db) -> User | None:
    """The signed-in user for this request, or None."""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    sess = db.execute(
        select(AuthSession).where(AuthSession.token_hash == hash_token(token))
    ).scalar_one_or_none()
    if sess is None or _aware(sess.expires_at) < datetime.now(timezone.utc):
        return None
    user = db.get(User, sess.user_id)
    return user if user is not None and user.is_active else None


def project_by_code(db, code: str) -> Project | None:
    return db.execute(
        select(Project).where(Project.code == code)
    ).scalar_one_or_none()


def role_in(db, user: User, project: Project) -> str | None:
    member = db.execute(
        select(ProjectMember).where(
            ProjectMember.project_id == project.id, ProjectMember.user_id == user.id
        )
    ).scalar_one_or_none()
    return member.role if member is not None else None


def has_role(role: str | None, needed: str) -> bool:
    if role is None:
        return False
    return ROLE_RANK.get(role, -1) >= ROLE_RANK[needed]
