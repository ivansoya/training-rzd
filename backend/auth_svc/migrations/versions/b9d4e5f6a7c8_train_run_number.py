"""Номер прогона в проекте и время постановки в очередь.

Revision ID: b9d4e5f6a7c8
Revises: a8c3d4e5f6b7
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b9d4e5f6a7c8"
down_revision: Union[str, None] = "a8c3d4e5f6b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("train_runs", sa.Column("number", sa.Integer(), nullable=True))
    op.add_column("train_runs", sa.Column("queued_at", sa.DateTime(timezone=True), nullable=True))
    # Старым прогонам — номера по дате запуска, очередь — по дате создания
    op.execute("""
        UPDATE train_runs r SET number = s.n FROM (
            SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS n
            FROM train_runs
        ) s WHERE s.id = r.id
    """)
    op.execute("UPDATE train_runs SET queued_at = created_at")
    op.alter_column("train_runs", "number", nullable=False)
    op.alter_column("train_runs", "queued_at", nullable=False)
    op.create_unique_constraint("uq_train_run_number", "train_runs", ["project_id", "number"])
    op.drop_index("ix_train_runs_pick", table_name="train_runs")
    op.create_index(
        "ix_train_runs_pick", "train_runs", ["status", "queued_at"],
        postgresql_where=sa.text("status IN ('queued', 'waiting_gpu')"),
    )


def downgrade() -> None:
    op.drop_index("ix_train_runs_pick", table_name="train_runs")
    op.create_index(
        "ix_train_runs_pick", "train_runs", ["status", "created_at"],
        postgresql_where=sa.text("status IN ('queued', 'waiting_gpu')"),
    )
    op.drop_constraint("uq_train_run_number", "train_runs", type_="unique")
    op.drop_column("train_runs", "queued_at")
    op.drop_column("train_runs", "number")
