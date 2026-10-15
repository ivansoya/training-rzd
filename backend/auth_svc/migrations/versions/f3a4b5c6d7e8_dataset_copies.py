"""Таска из датасета: копии кадров и отметка исходника.

Кадр датасета уходит в таску копией и возвращается на место при сдаче
(решения 14.10.2026). Копия помнит исходник, исходник — свою версию на
момент взятия: разошлась — кадр правили в датасете, сдача его не трогает.

Revision ID: f3a4b5c6d7e8
Revises: e2f3a4b5c6d7
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f3a4b5c6d7e8"
down_revision: Union[str, None] = "e2f3a4b5c6d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("images", sa.Column("origin_image_id", sa.Uuid(), nullable=True))
    op.add_column("images", sa.Column("copy_rev", sa.Integer(), nullable=True))
    op.create_index("ix_images_origin", "images", ["origin_image_id"])


def downgrade() -> None:
    op.drop_index("ix_images_origin", table_name="images")
    op.drop_column("images", "copy_rev")
    op.drop_column("images", "origin_image_id")
