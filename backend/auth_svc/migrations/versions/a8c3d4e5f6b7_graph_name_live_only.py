"""Имя графа уникально только среди живых: архивный не держит имя.

Revision ID: a8c3d4e5f6b7
Revises: f7b2c3d4e5a6
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a8c3d4e5f6b7"
down_revision: Union[str, None] = "f7b2c3d4e5a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint("uq_aug_graph_name", "aug_graphs", type_="unique")
    op.create_index(
        "uq_aug_graph_name", "aug_graphs", ["owner_id", "kind", "name"],
        unique=True, postgresql_where=sa.text("archived_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_aug_graph_name", table_name="aug_graphs")
    op.create_unique_constraint(
        "uq_aug_graph_name", "aug_graphs", ["owner_id", "kind", "name"]
    )
