"""check videos shelf and model checks

Revision ID: f5e6407192b4
Revises: f4d53f608ca3
Create Date: 2026-09-06 10:40:00.000000

Полка проверочных роликов принадлежит проекту, а не таске. Ролик таски
удаляется вместе с её закрытием, и сравнить две модели на одном ролике через
месяц стало бы нечем.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'f5e6407192b4'
down_revision: Union[str, None] = 'f4d53f608ca3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

JSONB = postgresql.JSONB

CHECK_STATUS = sa.Enum(
    "queued", "waiting_gpu", "running", "done", "error", "stopped",
    name="model_check_status",
)


def upgrade() -> None:
    op.create_table(
        "check_videos",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("file_path", sa.String(1024), nullable=False),
        sa.Column("thumb_path", sa.String(1024)),
        sa.Column("duration_ms", sa.Integer()),
        sa.Column("fps", sa.Float()),
        sa.Column("width", sa.Integer()),
        sa.Column("height", sa.Integer()),
        sa.Column("frame_count", sa.Integer()),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False,
                  server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(),
                  sa.ForeignKey("users.id", ondelete="SET NULL")),
    )
    op.create_index("ix_check_videos_project", "check_videos",
                    ["project_id", "created_at"])

    op.create_table(
        "model_checks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("run_id", sa.Uuid(),
                  sa.ForeignKey("train_runs.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("video_id", sa.Uuid(),
                  sa.ForeignKey("check_videos.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("status", CHECK_STATUS, nullable=False,
                  server_default="queued"),
        sa.Column("params", JSONB()),
        sa.Column("processed_frames", sa.Integer(), nullable=False,
                  server_default="0"),
        sa.Column("total_frames", sa.Integer()),
        sa.Column("output_path", sa.String(1024)),
        sa.Column("output_bytes", sa.BigInteger()),
        sa.Column("stats", JSONB()),
        sa.Column("gpu_lease_id", sa.Uuid(),
                  sa.ForeignKey("gpu_leases.id", ondelete="SET NULL")),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("worker_id", sa.String(64)),
        sa.Column("pid", sa.Integer()),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
        sa.Column("error", sa.Text()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(),
                  sa.ForeignKey("users.id", ondelete="SET NULL")),
    )
    op.create_index(
        "uq_check_active", "model_checks", ["run_id", "video_id"], unique=True,
        postgresql_where=sa.text(
            "status IN ('queued', 'waiting_gpu', 'running')"
        ),
    )
    op.create_index("ix_model_checks_project", "model_checks",
                    ["project_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_model_checks_project", table_name="model_checks")
    op.drop_index("uq_check_active", table_name="model_checks")
    op.drop_table("model_checks")
    op.drop_index("ix_check_videos_project", table_name="check_videos")
    op.drop_table("check_videos")
    CHECK_STATUS.drop(op.get_bind(), checkfirst=True)
