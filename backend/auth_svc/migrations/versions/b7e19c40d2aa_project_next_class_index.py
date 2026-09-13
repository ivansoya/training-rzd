"""Отметка следующего номера класса, переживающая удаление.

Номер класса уходит в мету выгрузки, и «3 = Шпала» из прошлого экспорта не
должно однажды означать другой класс. Выдавать «первый свободный» нельзя —
номер удалённого класса возвращался в оборот. Считать `max + 1` по живым
классам тоже мало: удаление самого верхнего снова освобождает его номер.

Поэтому отметка живёт у проекта и только растёт. Заполняется по тому, что уже
роздано: `max(class_index) + 1`, а у проекта без классов — ноль.

Revision ID: b7e19c40d2aa
Revises: d5b83c1f7ae2
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b7e19c40d2aa"
down_revision: Union[str, None] = "d5b83c1f7ae2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column(
            "next_class_index",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.execute(
        "UPDATE projects p SET next_class_index = COALESCE(("
        " SELECT max(c.class_index) + 1 FROM classes c"
        " WHERE c.project_id = p.id), 0)"
    )


def downgrade() -> None:
    op.drop_column("projects", "next_class_index")
