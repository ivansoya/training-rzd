"""Таги кадров и роликов; строки сборки вместо двух графов у набора.

Таг — метка происхождения: в каких условиях снят кадр. Справочником проекта,
а не строкой в кадре: по тагам собирают обучающие наборы, и «Ночь» рядом с
«ночь» тихо развалили бы отбор пополам.

Вторая половина миграции — про набор. Он знал ровно два графа, по одному на
половину, и это жило двумя столбцами. Теперь на половину вешают несколько
графов, у графа несколько «Источников», и каждому источнику говорят, откуда
брать кадры. Столбцы превращаются в строки ``train_set_feeds``; собранные
раньше наборы получают по строке на половину и остаются пересобираемыми.

Revision ID: c1d5e7a94b28
Revises: b7e19c40d2aa
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "c1d5e7a94b28"
down_revision: Union[str, None] = "b7e19c40d2aa"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# create_type=False: типы уже есть или создаются явно ниже, иначе
# create_table попробует создать их по разу на колонку.
SPLIT = postgresql.ENUM(
    "train", "val", "test", "other", name="image_split", create_type=False
)
FEED = postgresql.ENUM(
    "train", "val", "tags", name="train_set_feed", create_type=False
)


def upgrade() -> None:
    op.create_table(
        "tags",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey(
            "projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey(
            "users.id", ondelete="SET NULL"), nullable=True),
        sa.UniqueConstraint("project_id", "name", name="uq_tag_name"),
    )
    op.create_table(
        "image_tags",
        sa.Column("image_id", sa.Uuid(), sa.ForeignKey(
            "images.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag_id", sa.Uuid(), sa.ForeignKey(
            "tags.id", ondelete="CASCADE"), primary_key=True),
    )
    op.create_index("ix_image_tags_tag", "image_tags", ["tag_id"])
    op.create_table(
        "video_tags",
        sa.Column("video_id", sa.Uuid(), sa.ForeignKey(
            "task_videos.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag_id", sa.Uuid(), sa.ForeignKey(
            "tags.id", ondelete="CASCADE"), primary_key=True),
    )
    op.create_index("ix_video_tags_tag", "video_tags", ["tag_id"])

    FEED.create(op.get_bind(), checkfirst=True)
    op.create_table(
        "train_set_feeds",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("set_id", sa.Uuid(), sa.ForeignKey(
            "train_sets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("part", SPLIT, nullable=False),
        sa.Column("position", sa.Integer(), nullable=False,
                  server_default="0"),
        sa.Column("graph_version_id", sa.Uuid(), sa.ForeignKey(
            "aug_graph_versions.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("source_node", sa.String(64), nullable=False,
                  server_default=""),
        sa.Column("feed", FEED, nullable=False),
        sa.Column("tag_ids", sa.JSON().with_variant(JSONB(), "postgresql"),
                  nullable=True),
        sa.UniqueConstraint("set_id", "part", "position", "source_node",
                            name="uq_set_feed"),
    )
    op.create_index("ix_set_feeds_set", "train_set_feeds", ["set_id"])

    # Старые наборы: по строке на половину. Источник графа не знаем — его имя
    # там ровно одно, и сборщик берёт единственный, если строка его не назвала.
    for part, column in (("train", "graph_version_id"),
                         ("val", "val_graph_version_id")):
        op.execute(
            "INSERT INTO train_set_feeds"
            " (id, set_id, part, position, graph_version_id, source_node,"
            "  feed, tag_ids)"
            f" SELECT gen_random_uuid(), id, '{part}', 0, {column}, '',"
            f" '{part}', NULL FROM train_sets"
        )
    op.drop_column("train_sets", "graph_version_id")
    op.drop_column("train_sets", "val_graph_version_id")


def downgrade() -> None:
    op.add_column("train_sets", sa.Column(
        "graph_version_id", sa.Uuid(),
        sa.ForeignKey("aug_graph_versions.id", ondelete="RESTRICT")))
    op.add_column("train_sets", sa.Column(
        "val_graph_version_id", sa.Uuid(),
        sa.ForeignKey("aug_graph_versions.id", ondelete="RESTRICT")))
    for part, column in (("train", "graph_version_id"),
                         ("val", "val_graph_version_id")):
        op.execute(
            f"UPDATE train_sets s SET {column} = ("
            "  SELECT f.graph_version_id FROM train_set_feeds f"
            f"  WHERE f.set_id = s.id AND f.part = '{part}'"
            "  ORDER BY f.position LIMIT 1)"
        )
    op.drop_table("train_set_feeds")
    FEED.drop(op.get_bind(), checkfirst=True)
    op.drop_table("video_tags")
    op.drop_table("image_tags")
    op.drop_table("tags")
