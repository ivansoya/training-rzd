"""Password hashing and session-token helpers for the auth service."""
import hashlib
import secrets
from datetime import timedelta

from werkzeug.security import check_password_hash, generate_password_hash

SESSION_COOKIE = "session"
SESSION_TTL = timedelta(days=30)


def hash_password(password: str) -> str:
    return generate_password_hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    return check_password_hash(password_hash, password)


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
