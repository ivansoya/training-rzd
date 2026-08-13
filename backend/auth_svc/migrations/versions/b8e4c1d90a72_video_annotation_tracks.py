"""video annotation mode, tracks and per-frame video annotations

Revision ID: b8e4c1d90a72
Revises: a48e5d21c7b0
Create Date: 2026-08-13 12:00:00.000000

Видео перестаёт быть только источником нарезки. Режим выбирается при загрузке
и дальше не меняется, поэтому уже загруженным роликам ставим «cut» — они и
были нарезкой.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'b8e4c1d90a72'
down_revision: Union[str, None] = 'a48e5d21c7b0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

video_mode = postgresql.ENUM("cut", "annotate", name="video_mode", create_type=False)
annotation_type = postgresql.ENUM(
    "bbox", "obb", "polygon", "mask", name="annotation_type", create_type=False
)
annotation_source = postgresql.ENUM(
    "human", "model", name="annotation_source", create_type=False
)


def upgrade() -> None:
    bind = op.get_bind()
    video_mode.create(bind, checkfirst=True)

    op.add_column(
        "task_videos",
        sa.Column("mode", video_mode, nullable=False, server_default="cut"),
    )
    op.add_column("task_videos", sa.Column("frame_count", sa.Integer(), nullable=True))

    # Номер кадра у изображения: по нему повторная сдача таски находит уже
    # созданный кадр и правит его, а не заводит второй такой же.
    op.add_column("images", sa.Column("source_frame_no", sa.Integer(), nullable=True))
    op.create_index(
        "ix_images_video_frame", "images", ["source_video_id", "source_frame_no"]
    )

    op.create_table(
        "video_tracks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("video_id", sa.Uuid(), nullable=False),
        sa.Column("class_id", sa.Uuid(), nullable=False),
        sa.Column("start_frame", sa.Integer(), nullable=False),
        sa.Column("end_frame", sa.Integer(), nullable=True),
        sa.Column("interpolate", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("export_step", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("label", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["video_id"], ["task_videos.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["class_id"], ["classes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_video_tracks_video", "video_tracks", ["video_id"])

    op.create_table(
        "video_annotations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("video_id", sa.Uuid(), nullable=False),
        sa.Column("track_id", sa.Uuid(), nullable=True),
        sa.Column("frame_no", sa.Integer(), nullable=False),
        sa.Column("class_id", sa.Uuid(), nullable=False),
        sa.Column("ann_type", annotation_type, nullable=False, server_default="bbox"),
        sa.Column("geometry", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("visible", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("source", annotation_source, nullable=False, server_default="human"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["video_id"], ["task_videos.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["track_id"], ["video_tracks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["class_id"], ["classes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("track_id", "frame_no", name="uq_track_frame"),
    )
    op.create_index(
        "ix_video_ann_video_frame", "video_annotations", ["video_id", "frame_no"]
    )


def downgrade() -> None:
    op.drop_index("ix_video_ann_video_frame", table_name="video_annotations")
    op.drop_table("video_annotations")
    op.drop_index("ix_video_tracks_video", table_name="video_tracks")
    op.drop_table("video_tracks")
    op.drop_index("ix_images_video_frame", table_name="images")
    op.drop_column("images", "source_frame_no")
    op.drop_column("task_videos", "frame_count")
    op.drop_column("task_videos", "mode")
    video_mode.drop(op.get_bind(), checkfirst=True)
