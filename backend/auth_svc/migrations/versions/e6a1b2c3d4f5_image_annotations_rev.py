"""Версия разметки кадра: запись поверх чужой правки получает 409, а не стирает её.

Revision ID: e6a1b2c3d4f5
Revises: d4b8e2f6a1c7
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e6a1b2c3d4f5"
down_revision: Union[str, None] = "d4b8e2f6a1c7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "images",
        sa.Column("annotations_rev", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("images", "annotations_rev")
