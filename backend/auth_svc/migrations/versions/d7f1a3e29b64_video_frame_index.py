"""Отпечаток таблицы кадров у ролика.

Сама таблица живёт файлом рядом с видео: девяносто тысяч чисел в строке БД не
ищутся, не соединяются и читаются только целиком. В базе остаётся отпечаток —
по нему сервер отказывается материализовать план разметки, посчитанный по
другой нумерации кадров.

Revision ID: d7f1a3e29b64
Revises: c94af2b17d05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d7f1a3e29b64"
down_revision: Union[str, None] = "c94af2b17d05"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "task_videos", sa.Column("index_version", sa.String(length=32), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("task_videos", "index_version")
