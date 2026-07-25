"""Shared SQLAlchemy setup. Only services that talk to PostgreSQL (auth for
now) install SQLAlchemy and import this module; the file-based services are
untouched. Table creation is done by the auth service on startup — when the
schema first changes we switch to Alembic migrations.
"""
import os
import time

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql+psycopg2://app:app@db:5432/app"
)


class Base(DeclarativeBase):
    pass


engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def wait_for_db(timeout_s: float = 60.0) -> None:
    """Block until PostgreSQL accepts connections (container may start later)."""
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1.0)
