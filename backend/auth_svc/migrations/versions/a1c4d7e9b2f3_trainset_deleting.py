"""Удаление набора как состояние, а не как надежда.

Удаление шло так: воркер сносил папку, потом удалял строку. Строку удалить
не давал внешний ключ от обучений (RESTRICT), работа падала, очередь
повторяла её трижды, а на экране набор всё это время значился «готов» —
уже без единого файла. Так 08.09.2026 пропал «Варан · набор».

Две правки. Статус «deleting» ставится ДО начала работы: список видит его
сразу и честно. Обучения переживают удаление набора: `set_id` становится
пустым, веса и метрики остаются — они уже посчитаны и никому не мешают.

Revision ID: a1c4d7e9b2f3
Revises: f6a71c93b08d
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a1c4d7e9b2f3"
down_revision: Union[str, None] = "f6a71c93b08d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TYPE train_set_status ADD VALUE IF NOT EXISTS 'deleting'")
    op.alter_column("train_runs", "set_id", existing_type=sa.Uuid(),
                    nullable=True)
    op.drop_constraint("train_runs_set_id_fkey", "train_runs", type_="foreignkey")
    op.create_foreign_key(
        "train_runs_set_id_fkey", "train_runs", "train_sets",
        ["set_id"], ["id"], ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("train_runs_set_id_fkey", "train_runs", type_="foreignkey")
    op.execute("DELETE FROM train_runs WHERE set_id IS NULL")
    op.create_foreign_key(
        "train_runs_set_id_fkey", "train_runs", "train_sets",
        ["set_id"], ["id"], ondelete="RESTRICT",
    )
    op.alter_column("train_runs", "set_id", existing_type=sa.Uuid(),
                    nullable=False)
    # Значение из enum в Postgres не выкинуть — тип пересоздаётся целиком.
    op.execute("UPDATE train_sets SET status = 'error' WHERE status = 'deleting'")
    op.execute("ALTER TYPE train_set_status RENAME TO train_set_status_old")
    op.execute(
        "CREATE TYPE train_set_status AS ENUM "
        "('draft', 'queued', 'building', 'ready', 'error')"
    )
    op.execute(
        "ALTER TABLE train_sets ALTER COLUMN status DROP DEFAULT, "
        "ALTER COLUMN status TYPE train_set_status "
        "USING status::text::train_set_status, "
        "ALTER COLUMN status SET DEFAULT 'draft'"
    )
    op.execute("DROP TYPE train_set_status_old")
