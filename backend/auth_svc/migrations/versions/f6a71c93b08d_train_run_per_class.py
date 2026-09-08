"""Метрики обучения по классам.

Обучение отдавало четыре числа на весь набор, и «какой класс не выучен»
спросить было негде. Таблица по классам приходит одним разбором в конце
обучения и живёт своей колонкой: `summary` — это плоский набор чисел по всему
набору, и мешать в него таблицу нельзя.

Revision ID: f6a71c93b08d
Revises: f5e6407192b4
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f6a71c93b08d"
down_revision: Union[str, None] = "f5e6407192b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "train_runs",
        sa.Column("per_class", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("train_runs", "per_class")
