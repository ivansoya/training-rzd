"""Замер памяти помнит, снят ли он при соседе (вариант «А», 11.10.2026).

Прогон агента рядом с другим меряет общую вершину процесса; такой замер больше
не ложится поверх одиночного, а одиночный сменяет его сразу.

Revision ID: a7b8c9d0e1f2
Revises: f2a3b4c5d6e7
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a7b8c9d0e1f2"
down_revision: Union[str, None] = "f2a3b4c5d6e7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("gpu_usage_hints", sa.Column("shared", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("gpu_usage_hints", "shared")
