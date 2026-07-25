"""Auth endpoints: register (with email confirmation), login, logout,
current user, password change.

The session lives server-side (auth_sessions); the browser only holds a random
token in an httpOnly cookie, so no credentials are reachable from JS.
"""
import re
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, make_response, request
from sqlalchemy import func, select

from auth_svc import mailer
from auth_svc.security import hash_password, hash_token, new_session_token, verify_password
from auth_svc.security import SESSION_COOKIE
from auth_svc.sessions import current_session, set_cookie, start_session
from common.db import SessionLocal
from common.models import (
    AuthSession,
    EmailConfirmation,
    ProjectMember,
    User,
    utcnow,
)

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
LOGIN_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,31}$")
MIN_PASSWORD_LEN = 8
CONFIRMATION_TTL = timedelta(hours=24)

ROLE_LABELS = {"admin": "Администратор", "editor": "Редактор", "viewer": "Просмотр"}


def user_json(user: User) -> dict:
    return {
        "id": str(user.id),
        "email": user.email,
        "login": user.login,
        "display_name": user.display_name,
        "created_at": user.created_at.isoformat(),
    }


def _issue_confirmation(db, user: User) -> bool:
    """Replace any previous confirmation token and email a fresh link."""
    for old in db.execute(
        select(EmailConfirmation).where(EmailConfirmation.user_id == user.id)
    ).scalars():
        db.delete(old)
    token = new_session_token()
    db.add(
        EmailConfirmation(
            user_id=user.id,
            token_hash=hash_token(token),
            expires_at=utcnow() + CONFIRMATION_TTL,
        )
    )
    return mailer.send_confirmation_email(user.email, user.display_name, token)


@bp.post("/register")
def register():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    login = (data.get("login") or "").strip().lower()
    display_name = (data.get("display_name") or "").strip()
    password = data.get("password") or ""

    errors = {}
    if not EMAIL_RE.match(email):
        errors["email"] = "Укажите корректную почту."
    if not LOGIN_RE.match(login):
        errors["login"] = "Логин: 3–32 символа, строчные латинские буквы, цифры, «._-», начинается с буквы или цифры."
    if not display_name:
        errors["display_name"] = "Укажите имя для отображения."
    if len(password) < MIN_PASSWORD_LEN:
        errors["password"] = f"Пароль не короче {MIN_PASSWORD_LEN} символов."
    if errors:
        return jsonify({"errors": errors}), 400

    with SessionLocal() as db:
        if db.execute(select(User.id).where(func.lower(User.email) == email)).first():
            return jsonify({"errors": {"email": "Эта почта уже зарегистрирована."}}), 409
        if db.execute(select(User.id).where(func.lower(User.login) == login)).first():
            return jsonify({"errors": {"login": "Этот логин уже занят."}}), 409

        user = User(
            email=email,
            login=login,
            display_name=display_name,
            password_hash=hash_password(password),
        )
        db.add(user)
        db.flush()
        sent = _issue_confirmation(db, user)
        db.commit()
        # No session yet: login opens after the emailed link is used.
        return jsonify(
            {"pending_confirmation": True, "email": user.email, "mail_sent": sent}
        ), 201


@bp.post("/confirm")
def confirm_email():
    data = request.get_json(silent=True) or {}
    token = data.get("token") or ""
    if not token:
        return jsonify({"error": "Нет токена подтверждения."}), 400
    with SessionLocal() as db:
        conf = db.execute(
            select(EmailConfirmation).where(
                EmailConfirmation.token_hash == hash_token(token)
            )
        ).scalar_one_or_none()
        if conf is None:
            return jsonify({"error": "Ссылка недействительна: возможно, вы уже подтвердили почту или запросили новое письмо."}), 400
        expires = conf.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires < datetime.now(timezone.utc):
            return jsonify({"error": "Срок действия ссылки истёк. Запросите новое письмо."}), 400
        user = db.get(User, conf.user_id)
        if user is None:
            return jsonify({"error": "Пользователь не найден."}), 400
        user.email_confirmed_at = utcnow()
        db.delete(conf)
        token = start_session(db, user)  # confirmed = signed in at once
        db.commit()
        resp = make_response(jsonify({"user": user_json(user)}))
        set_cookie(resp, token)
        return resp


@bp.post("/resend")
def resend_confirmation():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    with SessionLocal() as db:
        user = db.execute(
            select(User).where(func.lower(User.email) == email)
        ).scalar_one_or_none()
        if user is not None and user.email_confirmed_at is None:
            _issue_confirmation(db, user)
            db.commit()
        # Uniform answer: no hints about which emails exist.
        return jsonify({"ok": True})


@bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    identity = (data.get("identity") or "").strip().lower()
    password = data.get("password") or ""
    if not identity or not password:
        return jsonify({"error": "Укажите логин (или почту) и пароль."}), 400

    with SessionLocal() as db:
        user = db.execute(
            select(User).where(
                (func.lower(User.login) == identity)
                | (func.lower(User.email) == identity)
            )
        ).scalar_one_or_none()
        if user is None or not verify_password(user.password_hash, password):
            return jsonify({"error": "Неверный логин или пароль."}), 401
        if not user.is_active:
            return jsonify({"error": "Аккаунт деактивирован."}), 403
        if user.email_confirmed_at is None:
            return jsonify(
                {
                    "error": "Почта не подтверждена. Откройте ссылку из письма или запросите новое.",
                    "code": "email_unconfirmed",
                    "email": user.email,
                }
            ), 403

        token = start_session(db, user)
        db.commit()

        resp = make_response(jsonify({"user": user_json(user)}))
        set_cookie(resp, token)
        return resp


@bp.post("/logout")
def logout():
    with SessionLocal() as db:
        sess, _ = current_session(db)
        if sess is not None:
            db.delete(sess)
            db.commit()
    resp = make_response(jsonify({"ok": True}))
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


@bp.get("/me")
def me():
    with SessionLocal() as db:
        _, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        memberships = db.execute(
            select(ProjectMember)
            .where(ProjectMember.user_id == user.id)
            .order_by(ProjectMember.created_at)
        ).scalars().all()
        projects = [
            {
                "id": str(m.project.id),
                "name": m.project.name,
                "code": m.project.code,
                "role": m.role,
                "role_label": ROLE_LABELS.get(m.role, m.role),
            }
            for m in memberships
        ]
        return jsonify({"user": user_json(user), "projects": projects})


@bp.post("/password")
def change_password():
    data = request.get_json(silent=True) or {}
    current = data.get("current") or ""
    new = data.get("new") or ""
    with SessionLocal() as db:
        sess, user = current_session(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        if not verify_password(user.password_hash, current):
            return jsonify({"error": "Текущий пароль указан неверно."}), 403
        if len(new) < MIN_PASSWORD_LEN:
            return jsonify(
                {"error": f"Новый пароль не короче {MIN_PASSWORD_LEN} символов."}
            ), 400
        user.password_hash = hash_password(new)
        # Drop every other session: a password change invalidates old devices.
        for other in db.execute(
            select(AuthSession).where(AuthSession.user_id == user.id)
        ).scalars():
            if other.id != sess.id:
                db.delete(other)
        db.commit()
        return jsonify({"ok": True})


@bp.get("/health")
def health():
    return jsonify({"ok": True})
