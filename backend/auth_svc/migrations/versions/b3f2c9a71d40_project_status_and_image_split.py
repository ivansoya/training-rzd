"""project status and image split

Revision ID: b3f2c9a71d40
Revises: 67a1737386bc
Create Date: 2026-07-26 11:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'b3f2c9a71d40'
down_revision: Union[str, None] = '67a1737386bc'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

project_status = postgresql.ENUM(
    "importing", "ready", name="project_status", create_type=False
)
image_split = postgresql.ENUM(
    "train", "val", "test", "other", name="image_split", create_type=False
)


def upgrade() -> None:
    bind = op.get_bind()
    project_status.create(bind, checkfirst=True)
    image_split.create(bind, checkfirst=True)
    # Projects that already exist were created empty, so they are not importing.
    op.add_column(
        "projects",
        sa.Column("status", project_status, nullable=False, server_default="ready"),
    )
    op.add_column(
        "images",
        sa.Column("split", image_split, nullable=False, server_default="other"),
    )
    op.create_index("ix_images_split", "images", ["project_id", "split"])


def downgrade() -> None:
    op.drop_index("ix_images_split", table_name="images")
    op.drop_column("images", "split")
    op.drop_column("projects", "status")
    bind = op.get_bind()
    image_split.drop(bind, checkfirst=True)
    project_status.drop(bind, checkfirst=True)
