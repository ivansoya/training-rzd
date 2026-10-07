"""Рамки агента «на проверке» — флаг на рамке, а не состояние кадра.

Revision ID: c1a2b3d4e5f6
Revises: b9d4e5f6a7c8
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a2b3d4e5f6"
down_revision: Union[str, None] = "b9d4e5f6a7c8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for table in ("annotations", "video_annotations"):
        op.add_column(table, sa.Column("pending", sa.Boolean(), nullable=False,
                                       server_default=sa.false()))
    # Уверенность агента на кадре ролика — ярлыку «на проверке» и кадру таски.
    op.add_column("video_annotations", sa.Column("attributes", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=True))
    op.create_index("ix_annotations_pending", "annotations", ["image_id"],
                    postgresql_where=sa.text("pending"))
    # Прежде «не проверено» значило: кадр new и на нём нетронутая рамка агента.
    op.execute("""
        UPDATE annotations a SET pending = true FROM images i
        WHERE i.id = a.image_id AND i.task_status = 'new'
          AND a.source = 'model' AND a.agent_version_id IS NOT NULL
    """)
    # Одиночные рамки агента в незакрытых роликах подтверждения не видели вовсе.
    op.execute("""
        UPDATE video_annotations va SET pending = true FROM task_videos v
        WHERE v.id = va.video_id AND v.annotation_closed_at IS NULL
          AND va.track_id IS NULL AND va.source = 'model' AND va.agent_version_id IS NOT NULL
    """)


def downgrade() -> None:
    op.drop_index("ix_annotations_pending", table_name="annotations")
    op.drop_column("video_annotations", "attributes")
    for table in ("annotations", "video_annotations"):
        op.drop_column(table, "pending")
