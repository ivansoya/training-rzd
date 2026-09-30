"""Наборы образцов для «Сети по тексту»: векторы YOLOE и вырезки SAM 3 на полке.

Revision ID: d4b8e2f6a1c7
Revises: c7e1f4a2b953
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "d4b8e2f6a1c7"
down_revision: Union[str, None] = "c7e1f4a2b953"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "agent_examples",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("owner_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("parent_id", UUID(as_uuid=True), sa.ForeignKey("agent_examples.id", ondelete="SET NULL")),
        sa.Column("project_id", UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="SET NULL")),
        sa.Column("project_name", sa.String(255), nullable=False),
        sa.Column("class_id", UUID(as_uuid=True), sa.ForeignKey("classes.id", ondelete="SET NULL")),
        sa.Column("class_name", sa.String(255), nullable=False),
        sa.Column("params", JSONB, nullable=False),
        sa.Column("items", JSONB, nullable=False),
        sa.Column("dir", sa.String(1024), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("error", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL")),
    )
    op.create_index("ix_agent_examples_queued", "agent_examples", ["created_at"],
                    postgresql_where=sa.text("status = 'queued'"))


def downgrade() -> None:
    op.drop_index("ix_agent_examples_queued", table_name="agent_examples")
    op.drop_table("agent_examples")
