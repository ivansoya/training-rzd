"""Фоновые кадры размечаемого ролика.

Пустой кадр из видео до сих пор не мог попасть в датасет вообще: план
материализации — это «кадр → фигуры», и кадр без фигур в него не входил.
Фон при этом нужен обучению не меньше объектов.

Список номеров лежит на самом ролике. Пометок единицы, ставятся они по одной,
и отдельная таблица добавила бы соединение к каждому чтению разметки.

Revision ID: d5b83c1f7ae2
Revises: a1c4d7e9b2f3
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d5b83c1f7ae2"
down_revision: Union[str, None] = "a1c4d7e9b2f3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "task_videos",
        sa.Column("empty_frames", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("task_videos", "empty_frames")
