"""Агенты разметки: род графа, полка весов, прогоны, происхождение рамки.

Агент живёт в тех же `aug_graphs`, что и аугментации, — ради общего черновика
и версий. Отличает его поле `kind`, и имя уникально внутри рода: агент и граф
аугментаций с одинаковым именем друг другу не мешают.

`agent_version_id` у разметки — ссылка на версию агента, а не на агента:
агента правят, и на вопрос «что это нарисовало» честный ответ — версия.

Revision ID: e3a7c9b15d42
Revises: d8a3f1c7e2b4
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "e3a7c9b15d42"
down_revision: Union[str, None] = "d8a3f1c7e2b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

STATUS = sa.Enum(
    "queued", "waiting_gpu", "running", "done", "error", "stopped",
    name="agent_run_status",
)


def _audit():
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("created_by", UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
    ]


def upgrade() -> None:
    op.add_column("aug_graphs", sa.Column(
        "kind", sa.String(16), nullable=False, server_default="aug"))
    op.drop_constraint("uq_aug_graph_name", "aug_graphs", type_="unique")
    op.create_unique_constraint(
        "uq_aug_graph_name", "aug_graphs", ["owner_id", "kind", "name"])
    op.drop_index("ix_aug_graphs_owner", table_name="aug_graphs")
    op.create_index("ix_aug_graphs_owner", "aug_graphs",
                    ["owner_id", "kind", "archived_at"])

    for table in ("annotations", "video_annotations"):
        op.add_column(table, sa.Column(
            "agent_version_id", UUID(as_uuid=True),
            sa.ForeignKey("aug_graph_versions.id", ondelete="SET NULL"),
            nullable=True))

    op.create_table(
        "agent_weights",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("owner_id", UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("file_path", sa.String(1024), nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("task", sa.String(16), nullable=False),
        sa.Column("imgsz", sa.Integer),
        sa.Column("names", JSONB(), nullable=False),
        sa.Column("source_run_id", UUID(as_uuid=True),
                  sa.ForeignKey("train_runs.id", ondelete="SET NULL")),
        *_audit(),
        sa.UniqueConstraint("owner_id", "sha256", name="uq_agent_weights_file"),
    )

    op.create_table(
        "agent_class_maps",
        sa.Column("graph_id", UUID(as_uuid=True),
                  sa.ForeignKey("aug_graphs.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("project_id", UUID(as_uuid=True),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("mapping", JSONB(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )

    op.create_table(
        "agent_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", UUID(as_uuid=True),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("task_id", UUID(as_uuid=True),
                  sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("graph_id", UUID(as_uuid=True),
                  sa.ForeignKey("aug_graphs.id", ondelete="SET NULL")),
        sa.Column("version_id", UUID(as_uuid=True),
                  sa.ForeignKey("aug_graph_versions.id", ondelete="SET NULL")),
        sa.Column("params", JSONB(), nullable=False),
        sa.Column("status", STATUS, nullable=False, server_default="queued"),
        sa.Column("queue_reason", sa.String(200)),
        sa.Column("processed", sa.Integer, nullable=False, server_default="0"),
        sa.Column("total", sa.Integer),
        sa.Column("stats", JSONB()),
        sa.Column("gpu_lease_id", UUID(as_uuid=True),
                  sa.ForeignKey("gpu_leases.id", ondelete="SET NULL")),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("worker_id", sa.String(64)),
        sa.Column("cancel_requested", sa.Boolean, nullable=False,
                  server_default=sa.false()),
        sa.Column("error", sa.Text),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        *_audit(),
    )
    op.create_index(
        "uq_agent_run_active", "agent_runs", ["task_id"], unique=True,
        postgresql_where=sa.text("status IN ('queued', 'waiting_gpu', 'running')"))
    op.create_index(
        "ix_agent_runs_pick", "agent_runs", ["status", "created_at"],
        postgresql_where=sa.text("status IN ('queued', 'waiting_gpu')"))
    op.create_index("ix_agent_runs_task", "agent_runs", ["task_id", "created_at"])


def downgrade() -> None:
    op.drop_table("agent_runs")
    STATUS.drop(op.get_bind(), checkfirst=True)
    op.drop_table("agent_class_maps")
    op.drop_table("agent_weights")
    for table in ("video_annotations", "annotations"):
        op.drop_column(table, "agent_version_id")
    op.drop_index("ix_aug_graphs_owner", table_name="aug_graphs")
    op.create_index("ix_aug_graphs_owner", "aug_graphs", ["owner_id", "archived_at"])
    op.drop_constraint("uq_aug_graph_name", "aug_graphs", type_="unique")
    op.create_unique_constraint("uq_aug_graph_name", "aug_graphs", ["owner_id", "name"])
    op.drop_column("aug_graphs", "kind")
