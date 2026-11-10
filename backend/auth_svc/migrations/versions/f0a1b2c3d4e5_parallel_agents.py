"""Группа копий одного агента с общей очередью работы.

Revision ID: f0a1b2c3d4e5
Revises: e9f0a1b2c3d4
"""
import sqlalchemy as sa
from alembic import op

revision = "f0a1b2c3d4e5"
down_revision = "e9f0a1b2c3d4"
branch_labels = depends_on = None


def upgrade():
    op.add_column("agent_runs", sa.Column("parent_id", sa.Uuid(),
                  sa.ForeignKey("agent_runs.id", ondelete="CASCADE")))
    op.add_column("agent_runs", sa.Column("is_group", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_index("ix_agent_runs_parent_id", "agent_runs", ["parent_id"])
    op.drop_index("uq_agent_run_active", table_name="agent_runs")
    op.create_index("uq_agent_run_active", "agent_runs", ["task_id"], unique=True,
                    postgresql_where=sa.text("status IN ('queued', 'waiting_gpu', 'running') AND parent_id IS NULL"))


def downgrade():
    # Сначала завершить группы: старый воркер не умеет продолжать их очередь.
    if op.get_bind().execute(sa.text("SELECT 1 FROM agent_runs WHERE (is_group OR parent_id IS NOT NULL) AND status IN ('queued', 'waiting_gpu', 'running') LIMIT 1")).first():
        raise RuntimeError("Перед откатом миграции завершите параллельные прогоны агентов.")
    op.drop_index("uq_agent_run_active", table_name="agent_runs")
    op.create_index("uq_agent_run_active", "agent_runs", ["task_id"], unique=True,
                    postgresql_where=sa.text("status IN ('queued', 'waiting_gpu', 'running')"))
    op.drop_index("ix_agent_runs_parent_id", table_name="agent_runs")
    op.drop_column("agent_runs", "parent_id")
    op.drop_column("agent_runs", "is_group")
