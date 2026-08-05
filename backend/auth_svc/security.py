"""Password hashing and session-token helpers for the auth service."""
import secrets
from datetime import timedelta

from werkzeug.security import check_password_hash, generate_password_hash

# Cookie name and token hashing live in common: the datasets service reads the
# same cookie, and two definitions would eventually drift apart.
from common.auth import SESSION_COOKIE, hash_token  # noqa: F401  (re-exported)

SESSION_TTL = timedelta(days=30)


def hash_password(password: str) -> str:
    return generate_password_hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    return check_password_hash(password_hash, password)


def new_session_token() -> str:
    return secrets.token_urlsafe(32)
