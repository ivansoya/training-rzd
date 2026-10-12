"""Несколько исполнителей таски (решение 12.10.2026): task_assignees вместо tasks.assignee_id.

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c9d0e1f2a3b4"
down_revision: Union[str, None] = "b8c9d0e1f2a3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "task_assignees",
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    )
    op.create_index("ix_task_assignees_user", "task_assignees", ["user_id"])
    op.execute("INSERT INTO task_assignees (task_id, user_id) "
               "SELECT id, assignee_id FROM tasks WHERE assignee_id IS NOT NULL")
    op.drop_column("tasks", "assignee_id")


def downgrade() -> None:
    op.add_column("tasks", sa.Column("assignee_id", sa.Uuid(),
                                     sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    # Назад влезает только один — берём любого.
    op.execute("UPDATE tasks SET assignee_id = a.user_id FROM "
               "(SELECT DISTINCT ON (task_id) task_id, user_id FROM task_assignees) a "
               "WHERE a.task_id = tasks.id")
    op.drop_table("task_assignees")
