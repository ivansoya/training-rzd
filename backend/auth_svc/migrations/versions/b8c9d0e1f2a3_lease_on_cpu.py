"""Бронь процессора: задача, которой человек разрешил считать на процессоре (решение 11.10.2026).

Карта не вмещает задачу или выключена — по подтверждению она встаёт в очередь к процессору
сервера, а он считает одну такую задачу разом.

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b8c9d0e1f2a3"
down_revision: Union[str, None] = "a7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("gpu_leases", sa.Column("on_cpu", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("gpu_leases", "on_cpu")
