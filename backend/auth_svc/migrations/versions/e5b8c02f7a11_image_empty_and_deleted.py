"""empty and deleted image task statuses

Revision ID: e5b8c02f7a11
Revises: d2a6f1c483be
Create Date: 2026-07-27 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = 'e5b8c02f7a11'
down_revision: Union[str, None] = 'd2a6f1c483be'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # «empty» — кадр осознанно без объектов: фоновый пример, уходит в датасет
    # наравне с размеченными. «deleted» — забракован, но виден в таске до её
    # закрытия, поэтому это состояние, а не удаление строки.
    op.execute("ALTER TYPE image_task_status ADD VALUE IF NOT EXISTS 'empty'")
    op.execute("ALTER TYPE image_task_status ADD VALUE IF NOT EXISTS 'deleted'")


def downgrade() -> None:
    # Значения из enum в Postgres не выкинуть — тип пересоздаётся целиком.
    op.execute("UPDATE images SET task_status = 'new' WHERE task_status = 'empty'")
    op.execute("UPDATE images SET task_status = 'skipped' WHERE task_status = 'deleted'")
    op.execute("ALTER TYPE image_task_status RENAME TO image_task_status_old")
    op.execute(
        "CREATE TYPE image_task_status AS ENUM ('new', 'skipped', 'annotated')"
    )
    op.execute("ALTER TABLE images ALTER COLUMN task_status DROP DEFAULT")
    op.execute(
        "ALTER TABLE images ALTER COLUMN task_status TYPE image_task_status "
        "USING task_status::text::image_task_status"
    )
    op.execute("ALTER TABLE images ALTER COLUMN task_status SET DEFAULT 'new'")
    op.execute("DROP TYPE image_task_status_old")
