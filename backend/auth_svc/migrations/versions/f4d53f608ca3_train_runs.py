"""training runs and per-epoch metrics

Revision ID: f4d53f608ca3
Revises: f3c42e5f7b92
Create Date: 2026-09-06 10:30:00.000000

Состояние обучения переезжает из файлов на томе в базу. Ради этого всё и
затевалось: пока оно лежало в памяти одного процесса, у сервиса стоял один
рабочий процесс, и тридцать две открытые вкладки останавливали раздел всем.

Метрики — строкой на эпоху, а не массивом в ране: график тянут во время
обучения, и переписывать массив из трёхсот эпох на каждой эпохе значит
платить квадратом записей.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'f4d53f608ca3'
down_revision: Union[str, None] = 'f3c42e5f7b92'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

JSONB = postgresql.JSONB

TASK = sa.Enum("detect", "segment", name="train_task")
RUN_STATUS = sa.Enum(
    "queued", "waiting_gpu", "preparing", "running", "stopping",
    "done", "error", "stopped", name="train_run_status",
)


def upgrade() -> None:
    op.create_table(
        "train_runs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("set_id", sa.Uuid(),
                  sa.ForeignKey("train_sets.id", ondelete="RESTRICT"),
                  nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("base_model", sa.String(64), nullable=False),
        sa.Column("base_weights_path", sa.String(1024)),
        sa.Column("task", TASK, nullable=False),
        sa.Column("params", JSONB(), nullable=False),
        sa.Column("device", sa.String(32), nullable=False),
        sa.Column("status", RUN_STATUS, nullable=False, server_default="queued"),
        sa.Column("queue_reason", sa.String(200)),
        sa.Column("epochs", sa.Integer(), nullable=False),
        sa.Column("current_epoch", sa.Integer(), nullable=False,
                  server_default="0"),
        sa.Column("phase", sa.String(8)),
        sa.Column("current_batch", sa.Integer(), nullable=False,
                  server_default="0"),
        sa.Column("total_batches", sa.Integer()),
        sa.Column("val_batch", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("val_total", sa.Integer()),
        sa.Column("batch_metrics", JSONB()),
        sa.Column("summary", JSONB()),
        sa.Column("confusion", JSONB()),
        sa.Column("curves", JSONB()),
        sa.Column("best_epoch", sa.Integer()),
        sa.Column("best_fitness", sa.Float()),
        sa.Column("weights_path", sa.String(1024)),
        sa.Column("weights_bytes", sa.BigInteger()),
        sa.Column("gpu_lease_id", sa.Uuid(),
                  sa.ForeignKey("gpu_leases.id", ondelete="SET NULL")),
        sa.Column("peak_vram_mb", sa.Integer()),
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
    op.create_index("ix_train_runs_project", "train_runs",
                    ["project_id", "created_at"])
    op.create_index("ix_train_runs_set", "train_runs", ["set_id"])
    op.create_index(
        "ix_train_runs_pick", "train_runs", ["status", "created_at"],
        postgresql_where=sa.text("status IN ('queued', 'waiting_gpu')"),
    )

    op.create_table(
        "train_epochs",
        sa.Column("run_id", sa.Uuid(),
                  sa.ForeignKey("train_runs.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("epoch", sa.Integer(), primary_key=True),
        sa.Column("metrics", JSONB(), nullable=False),
        sa.Column("lr", sa.Float()),
        sa.Column("seconds", sa.Float()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("train_epochs")
    op.drop_index("ix_train_runs_pick", table_name="train_runs")
    op.drop_index("ix_train_runs_set", table_name="train_runs")
    op.drop_index("ix_train_runs_project", table_name="train_runs")
    op.drop_table("train_runs")
    bind = op.get_bind()
    RUN_STATUS.drop(bind, checkfirst=True)
    TASK.drop(bind, checkfirst=True)
