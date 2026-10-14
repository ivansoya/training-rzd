"""Кадры размечаемого ролика рождаются сдачей таски (решение 14.10.2026): ручного закрытия нет.

`task_videos.annotation_closed_at` уходит; у кадра — `handed_rev`, счётчик правок на прошлой сдаче.
Уже созданным кадрам ролика ставим 0: закрытие писало разметку без счётчика, и всё, что выше, —
правка руками после него. Нетронутые черновики убирает `python -m datasets_svc.materialize --yes` (с файлами).

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d0e1f2a3b4c5"
down_revision: Union[str, None] = "c9d0e1f2a3b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("images", sa.Column("handed_rev", sa.Integer(), nullable=True))
    op.execute(
        "UPDATE images SET handed_rev = 0 WHERE source_frame_no IS NOT NULL AND source_video_id IN "
        "(SELECT id FROM task_videos WHERE mode = 'annotate')"
    )
    op.drop_column("task_videos", "annotation_closed_at")


def downgrade() -> None:
    op.add_column("task_videos", sa.Column("annotation_closed_at", sa.DateTime(timezone=True), nullable=True))
    op.drop_column("images", "handed_rev")
