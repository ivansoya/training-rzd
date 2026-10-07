"""Агент на кадре из редактора: строка превью без изображения — кадр ролика.

Revision ID: c2b3d4e5f6a7
Revises: c1a2b3d4e5f6
"""
from typing import Sequence, Union

from alembic import op

revision: str = "c2b3d4e5f6a7"
down_revision: Union[str, None] = "c1a2b3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("agent_previews", "image_id", nullable=True)


def downgrade() -> None:
    op.execute("DELETE FROM agent_previews WHERE image_id IS NULL")
    op.alter_column("agent_previews", "image_id", nullable=False)
