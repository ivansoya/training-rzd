"""Cookie-session helpers shared by the auth and core blueprints."""
from datetime import datetime, timedelta, timezone

from flask import request
from sqlalchemy import select

from auth_svc.security import SESSION_COOKIE, SESSION_TTL, hash_token, new_session_token
from common.models import AuthSession, User, utcnow

# Younger than this = "online"; last_seen writes are throttled to once a minute.
ONLINE_WINDOW = timedelta(minutes=2)
LAST_SEEN_THROTTLE = timedelta(seconds=60)


def set_cookie(resp, token: str):
    resp.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(SESSION_TTL.total_seconds()),
        httponly=True,
        samesite="Lax",
        path="/",
    )


def start_session(db, user: User) -> str:
    token = new_session_token()
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=hash_token(token),
            expires_at=utcnow() + SESSION_TTL,
        )
    )
    return token


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def current_session(db):
    """Return (session, user) for a valid cookie, else (None, None).
    Touches user.last_seen_at (throttled) so online status stays fresh."""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None, None
    sess = db.execute(
        select(AuthSession).where(AuthSession.token_hash == hash_token(token))
    ).scalar_one_or_none()
    if sess is None:
        return None, None
    now = datetime.now(timezone.utc)
    if _aware(sess.expires_at) < now:
        db.delete(sess)
        db.commit()
        return None, None
    user = db.get(User, sess.user_id)
    if user is None or not user.is_active:
        return None, None
    seen = _aware(user.last_seen_at)
    if seen is None or now - seen > LAST_SEEN_THROTTLE:
        user.last_seen_at = now
        db.commit()
    return sess, user


def is_online(user: User) -> bool:
    seen = _aware(user.last_seen_at)
    return seen is not None and datetime.now(timezone.utc) - seen < ONLINE_WINDOW
