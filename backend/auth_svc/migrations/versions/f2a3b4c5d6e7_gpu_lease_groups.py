"""Задача на нескольких картах: брони одной группой (решения 10.10.2026).

Обучение на нескольких картах и агент, поделённый по картам блоками узлов, держат
по броне на часть; выдаются они все разом или ни одна.

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f2a3b4c5d6e7"
down_revision: Union[str, None] = "e1f2a3b4c5d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("gpu_leases", sa.Column("group_id", sa.Uuid(), nullable=True))
    op.add_column("gpu_leases", sa.Column("part", sa.SmallInteger(), nullable=True))
    op.add_column("gpu_leases", sa.Column("spread", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("gpu_leases", sa.Column("label", sa.String(80), nullable=True))
    op.create_index("ix_gpu_leases_group", "gpu_leases", ["group_id"])


def downgrade() -> None:
    op.drop_index("ix_gpu_leases_group", table_name="gpu_leases")
    for name in ("label", "spread", "part", "group_id"):
        op.drop_column("gpu_leases", name)
