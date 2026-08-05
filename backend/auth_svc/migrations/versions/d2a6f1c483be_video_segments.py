"""video segments on task_videos

Revision ID: d2a6f1c483be
Revises: c7d41e8b9a25
Create Date: 2026-07-26 22:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'd2a6f1c483be'
down_revision: Union[str, None] = 'c7d41e8b9a25'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Накопленные участки нарезки: к видео возвращаются и режут ещё, а
    # показать надо всю историю сразу.
    op.add_column(
        "task_videos",
        sa.Column("segments", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("task_videos", "segments")
