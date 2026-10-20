"""Прежние версии рамок для Ctrl+Z в редакторах.

Отмена должна возвращать рамку агента как было — «на проверке» и с автором.
Сервер стёртую рамку не узнаёт, поэтому запись кадра откладывает час прежние
версии рамок, которые стирает или меняет (решение 20.10.2026).

Revision ID: a4b5c6d7e8f9
Revises: f3a4b5c6d7e8
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "a4b5c6d7e8f9"
down_revision: Union[str, None] = "f3a4b5c6d7e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "annotation_versions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("ann_id", sa.Uuid(), nullable=False),
        sa.Column("row", sa.JSON().with_variant(JSONB(), "postgresql"), nullable=False),
        sa.Column("saved_by", sa.Uuid(), nullable=False),
        sa.Column("saved_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_annotation_versions_ann_id", "annotation_versions", ["ann_id"])
    op.create_index("ix_annotation_versions_saved_at", "annotation_versions", ["saved_at"])


def downgrade() -> None:
    op.drop_table("annotation_versions")
