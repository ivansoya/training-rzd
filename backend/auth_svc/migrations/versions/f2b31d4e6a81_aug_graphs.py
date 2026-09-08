"""augmentation graphs, their versions and the uses between them

Revision ID: f2b31d4e6a81
Revises: f1a20c3d5e70
Create Date: 2026-09-06 10:10:00.000000

Граф принадлежит человеку, а не проекту: удачный граф переносят из проекта в
проект, и копия разошлась бы с оригиналом на первой же правке.

Внешний ключ на текущую версию заводится отдельным ALTER: таблицы ссылаются
друг на друга, и создать первой нельзя ни одну.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'f2b31d4e6a81'
down_revision: Union[str, None] = 'f1a20c3d5e70'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

JSONB = sa.dialects.postgresql.JSONB


def upgrade() -> None:
    op.create_table(
        "aug_graphs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("owner_id", sa.Uuid(),
                  sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(),
                  sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.UniqueConstraint("owner_id", "name", name="uq_aug_graph_name"),
    )
    op.create_index("ix_aug_graphs_owner", "aug_graphs",
                    ["owner_id", "archived_at"])

    op.create_table(
        "aug_graph_versions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("graph_id", sa.Uuid(),
                  sa.ForeignKey("aug_graphs.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("doc", JSONB(), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False),
        sa.Column("stats", JSONB()),
        sa.Column("port_names", JSONB(), nullable=False,
                  server_default='{"in": [], "out": []}'),
        sa.Column("note", sa.String(255)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(),
                  sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.UniqueConstraint("graph_id", "version", name="uq_aug_version_no"),
        sa.UniqueConstraint("graph_id", "digest", name="uq_aug_version_digest"),
    )
    op.create_index("ix_aug_versions_graph", "aug_graph_versions",
                    ["graph_id", "version"])

    # Кольцо ссылок разрывается здесь: колонка добавляется, когда обе таблицы
    # уже есть.
    op.add_column("aug_graphs", sa.Column("head_version_id", sa.Uuid()))
    op.create_foreign_key(
        "fk_aug_graph_head", "aug_graphs", "aug_graph_versions",
        ["head_version_id"], ["id"], ondelete="SET NULL",
    )

    op.create_table(
        "aug_graph_uses",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("version_id", sa.Uuid(),
                  sa.ForeignKey("aug_graph_versions.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("used_graph_id", sa.Uuid(),
                  sa.ForeignKey("aug_graphs.id", ondelete="RESTRICT"),
                  nullable=False),
        sa.Column("used_version_id", sa.Uuid(),
                  sa.ForeignKey("aug_graph_versions.id", ondelete="RESTRICT"),
                  nullable=False),
        sa.UniqueConstraint("version_id", "used_version_id", name="uq_aug_use"),
    )
    op.create_index("ix_aug_uses_used", "aug_graph_uses", ["used_graph_id"])

    op.create_table(
        "project_aug_graphs",
        sa.Column("project_id", sa.Uuid(),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("graph_id", sa.Uuid(),
                  sa.ForeignKey("aug_graphs.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(),
                  sa.ForeignKey("users.id", ondelete="SET NULL")),
    )


def downgrade() -> None:
    op.drop_table("project_aug_graphs")
    op.drop_index("ix_aug_uses_used", table_name="aug_graph_uses")
    op.drop_table("aug_graph_uses")
    op.drop_constraint("fk_aug_graph_head", "aug_graphs", type_="foreignkey")
    op.drop_column("aug_graphs", "head_version_id")
    op.drop_index("ix_aug_versions_graph", table_name="aug_graph_versions")
    op.drop_table("aug_graph_versions")
    op.drop_index("ix_aug_graphs_owner", table_name="aug_graphs")
    op.drop_table("aug_graphs")
