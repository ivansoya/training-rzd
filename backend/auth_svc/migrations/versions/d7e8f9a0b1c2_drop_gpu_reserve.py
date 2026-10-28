"""Без неприкосновенного запаса карты: держал память под запуск SAM2, а SAM2 отмечает свою сам (решение 28.10.2026).

Revision ID: d7e8f9a0b1c2
Revises: c6d7e8f9a0b1
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d7e8f9a0b1c2"
down_revision: Union[str, None] = "c6d7e8f9a0b1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("gpu_devices", "reserved_mb")


def downgrade() -> None:
    op.add_column("gpu_devices", sa.Column("reserved_mb", sa.Integer(), nullable=False, server_default="1024"))
