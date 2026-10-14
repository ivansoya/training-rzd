"""Кадры ролика, где агент ставил рамки.

Карточка таски пишет «проверено 340 · осталось 1 408 кадров». Осталось видно по
флагу проверки, а проверенное — нет: отклонённая рамка удаляется, и кадр, где
всё отклонили, ничем не отличался от кадра, куда агент не ходил.

Уже прогнанным роликам список восстанавливается из нынешних рамок агента;
прошлые отклонения так и остаются невидимыми.

Revision ID: e2f3a4b5c6d7
Revises: d0e1f2a3b4c5
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e2f3a4b5c6d7"
down_revision: Union[str, None] = "d0e1f2a3b4c5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "task_videos",
        sa.Column("agent_frames", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.execute("""
        UPDATE task_videos v SET agent_frames = s.frames
        FROM (SELECT video_id, jsonb_agg(DISTINCT frame_no ORDER BY frame_no) AS frames
              FROM video_annotations
              WHERE track_id IS NULL AND agent_version_id IS NOT NULL
              GROUP BY video_id) s
        WHERE v.id = s.video_id
    """)


def downgrade() -> None:
    op.drop_column("task_videos", "agent_frames")
