"""Кадр помнит статус и датасет до брака: «Вернуть» восстанавливает их.

Revision ID: f7b2c3d4e5a6
Revises: e6a1b2c3d4f5
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f7b2c3d4e5a6"
down_revision: Union[str, None] = "e6a1b2c3d4f5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

STATUS = postgresql.ENUM(
    "new", "skipped", "annotated", "empty", "deleted",
    name="image_task_status", create_type=False,
)


def upgrade() -> None:
    op.add_column("images", sa.Column("status_before_delete", STATUS, nullable=True))
    op.add_column("images", sa.Column("dataset_before_delete", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_images_dataset_before_delete", "images", "datasets",
        ["dataset_before_delete"], ["id"], ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_images_dataset_before_delete", "images", type_="foreignkey")
    op.drop_column("images", "dataset_before_delete")
    op.drop_column("images", "status_before_delete")
