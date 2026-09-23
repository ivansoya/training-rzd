"""Разведка роликов агентом: одна последняя на ролик.

Это информация, а не разметка: где и какие классы агента нашлись. Отсюда
полосы на шкале и предложенный план нарезки; в датасет отсюда не идёт ничего.

Revision ID: c7e1f4a2b953
Revises: a9c4e2d71f38
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "c7e1f4a2b953"
down_revision: Union[str, None] = "a9c4e2d71f38"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "video_scouts",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("video_id", UUID(as_uuid=True),
                  sa.ForeignKey("task_videos.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("run_id", UUID(as_uuid=True),
                  sa.ForeignKey("agent_runs.id", ondelete="SET NULL"), nullable=True),
        sa.Column("version_id", UUID(as_uuid=True),
                  sa.ForeignKey("aug_graph_versions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("agent_name", sa.String(255), nullable=True),
        sa.Column("step", sa.Integer, nullable=False),
        sa.Column("gap_s", sa.Float, nullable=False),
        sa.Column("last_frame", sa.Integer, nullable=False),
        sa.Column("frames", JSONB, nullable=False),
        sa.Column("segments", JSONB, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("video_scouts")
