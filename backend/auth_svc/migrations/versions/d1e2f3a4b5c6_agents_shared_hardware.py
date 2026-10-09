"""Агенты по проекту и права на железо (решения 09.10.2026).

Уровни доступа к оборудованию вместо одного бита `is_staff`: нынешние
стаффы — «manage». У рамок — кто снял их с проверки. Счётчик «агент на кадре»
(G) и индекс журнала прогонов агентов проекта.

Revision ID: d1e2f3a4b5c6
Revises: c2b3d4e5f6a7
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d1e2f3a4b5c6"
down_revision: Union[str, None] = "c2b3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("hardware", sa.String(8), nullable=True))
    op.create_check_constraint("ck_users_hardware", "users", "hardware IN ('view', 'manage')")
    op.execute("UPDATE users SET hardware = 'manage' WHERE is_staff")
    op.drop_column("users", "is_staff")

    for table in ("annotations", "video_annotations"):
        op.add_column(table, sa.Column("reviewed_by", sa.Uuid(), nullable=True))
        op.create_foreign_key(f"fk_{table}_reviewed_by", table, "users", ["reviewed_by"], ["id"],
                              ondelete="SET NULL")

    op.create_table(
        "agent_applies",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("graph_id", sa.Uuid(), sa.ForeignKey("aug_graphs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("boxes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_agent_applies_project", "agent_applies", ["project_id", "created_at"])
    op.create_index("ix_agent_runs_project", "agent_runs", ["project_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_agent_runs_project", table_name="agent_runs")
    op.drop_index("ix_agent_applies_project", table_name="agent_applies")
    op.drop_table("agent_applies")
    for table in ("annotations", "video_annotations"):
        op.drop_constraint(f"fk_{table}_reviewed_by", table, type_="foreignkey")
        op.drop_column(table, "reviewed_by")
    op.add_column("users", sa.Column("is_staff", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.execute("UPDATE users SET is_staff = TRUE WHERE hardware = 'manage'")
    op.drop_constraint("ck_users_hardware", "users", type_="check")
    op.drop_column("users", "hardware")
