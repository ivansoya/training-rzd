"""Настоящая копия графа — сохраняется на каждой правке, мимо версий.

Раньше правка жила только во вкладке: закрыл — пропала, если не нажал
«Сохранить версию». А версия — это запись «набор собран вот этим», и рожать её
на каждое движение ползунка значило бы обесценить. Черновик лежит отдельно от
версий, одной строкой на граф.

Revision ID: d8a3f1c7e2b4
Revises: c1d5e7a94b28
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "d8a3f1c7e2b4"
down_revision: Union[str, None] = "c1d5e7a94b28"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("aug_graphs", sa.Column("draft", JSONB(), nullable=True))
    op.add_column("aug_graphs", sa.Column(
        "draft_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("aug_graphs", "draft_at")
    op.drop_column("aug_graphs", "draft")
