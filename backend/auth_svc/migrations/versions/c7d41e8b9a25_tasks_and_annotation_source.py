"""tasks, task videos, task events; image task fields; annotation source

Revision ID: c7d41e8b9a25
Revises: b3f2c9a71d40
Create Date: 2026-07-26 20:40:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'c7d41e8b9a25'
down_revision: Union[str, None] = 'b3f2c9a71d40'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

task_status = postgresql.ENUM(
    "queued", "in_progress", "done", "updating", "closed",
    name="task_status", create_type=False,
)
image_task_status = postgresql.ENUM(
    "new", "skipped", "annotated", name="image_task_status", create_type=False
)
annotation_source = postgresql.ENUM(
    "human", "model", name="annotation_source", create_type=False
)


def upgrade() -> None:
    bind = op.get_bind()
    task_status.create(bind, checkfirst=True)
    image_task_status.create(bind, checkfirst=True)
    annotation_source.create(bind, checkfirst=True)

    op.create_table(
        "tasks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("status", task_status, nullable=False, server_default="queued"),
        sa.Column("assignee_id", sa.Uuid(), nullable=True),
        sa.Column("target_dataset_id", sa.Uuid(), nullable=True),
        sa.Column("target_dataset_name", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["assignee_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["target_dataset_id"], ["datasets.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tasks_project", "tasks", ["project_id"])

    op.create_table(
        "task_videos",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("task_id", sa.Uuid(), nullable=False),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("file_path", sa.String(length=1024), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("fps", sa.Float(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "task_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("task_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.String(length=48), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_task_events_task", "task_events", ["task_id", "created_at"])

    # Кадр в таске ещё не принадлежит датасету. Составной ключ
    # (dataset_id, project_id) это переживает: в Postgres действует MATCH
    # SIMPLE — при пустой колонке ссылки ограничение не проверяется.
    op.alter_column("images", "dataset_id", existing_type=sa.Uuid(), nullable=True)
    op.add_column("images", sa.Column("task_id", sa.Uuid(), nullable=True))
    op.add_column(
        "images",
        sa.Column("task_status", image_task_status, nullable=False, server_default="new"),
    )
    op.add_column("images", sa.Column("source_video_id", sa.Uuid(), nullable=True))
    op.add_column("images", sa.Column("source_time_ms", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_images_task", "images", "tasks", ["task_id"], ["id"], ondelete="SET NULL"
    )
    op.create_foreign_key(
        "fk_images_source_video", "images", "task_videos",
        ["source_video_id"], ["id"], ondelete="SET NULL",
    )
    op.create_index("ix_images_task", "images", ["task_id", "task_status"])

    op.add_column(
        "annotations",
        sa.Column("source", annotation_source, nullable=False, server_default="human"),
    )


def downgrade() -> None:
    op.drop_column("annotations", "source")
    op.drop_index("ix_images_task", table_name="images")
    op.drop_constraint("fk_images_source_video", "images", type_="foreignkey")
    op.drop_constraint("fk_images_task", "images", type_="foreignkey")
    op.drop_column("images", "source_time_ms")
    op.drop_column("images", "source_video_id")
    op.drop_column("images", "task_status")
    op.drop_column("images", "task_id")
    op.alter_column("images", "dataset_id", existing_type=sa.Uuid(), nullable=False)
    op.drop_index("ix_task_events_task", table_name="task_events")
    op.drop_table("task_events")
    op.drop_table("task_videos")
    op.drop_index("ix_tasks_project", table_name="tasks")
    op.drop_table("tasks")
    bind = op.get_bind()
    annotation_source.drop(bind, checkfirst=True)
    image_task_status.drop(bind, checkfirst=True)
    task_status.drop(bind, checkfirst=True)
