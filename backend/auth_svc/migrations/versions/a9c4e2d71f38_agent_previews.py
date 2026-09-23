"""Превью агента: запросы от редактора к `training-worker`.

Считает воркер — у него карта и тёплые модели, — а спрашивает веб. Строка —
это и очередь, и почтовый ящик для ответа. Живёт минуты: старые ответы
вычищает сама ручка при следующем запросе.

Revision ID: a9c4e2d71f38
Revises: e3a7c9b15d42
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "a9c4e2d71f38"
down_revision: Union[str, None] = "e3a7c9b15d42"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "agent_previews",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("image_id", UUID(as_uuid=True),
                  sa.ForeignKey("images.id", ondelete="CASCADE"), nullable=False),
        sa.Column("doc", JSONB, nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("result", JSONB, nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index("ix_agent_previews_queued", "agent_previews", ["created_at"],
                    postgresql_where=sa.text("status = 'queued'"))


def downgrade() -> None:
    op.drop_table("agent_previews")
