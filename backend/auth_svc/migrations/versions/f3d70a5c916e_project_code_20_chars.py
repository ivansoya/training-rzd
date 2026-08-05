"""project code is always 20 generated chars

Revision ID: f3d70a5c916e
Revises: e5b8c02f7a11
Create Date: 2026-08-04 12:00:00.000000

"""
import secrets
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'f3d70a5c916e'
down_revision: Union[str, None] = 'e5b8c02f7a11'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Копия алфавита из auth_svc/core.py: миграция — снимок прошлого и не должна
# ломаться, если генератор в коде когда-нибудь сменится.
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def upgrade() -> None:
    # Старые коды сочинял человек, они короче 20 — перевыпускаем все, иначе
    # CHECK ниже не встанет. Ссылки на /projects/<старый-код> перестают работать.
    conn = op.get_bind()
    used = set()
    for (pid,) in conn.execute(sa.text("SELECT id FROM projects")).fetchall():
        code = "".join(secrets.choice(ALPHABET) for _ in range(20))
        while code in used:
            code = "".join(secrets.choice(ALPHABET) for _ in range(20))
        used.add(code)
        conn.execute(
            sa.text("UPDATE projects SET code = :code WHERE id = :id"),
            {"code": code, "id": pid},
        )
    op.alter_column(
        "projects", "code", type_=sa.String(20), existing_type=sa.String(64),
        existing_nullable=False,
    )
    op.create_check_constraint(
        "ck_projects_code_len", "projects", "char_length(code) = 20"
    )


def downgrade() -> None:
    # Прежние коды не восстанавливаются — откат вернёт только форму колонки.
    op.drop_constraint("ck_projects_code_len", "projects", type_="check")
    op.alter_column(
        "projects", "code", type_=sa.String(64), existing_type=sa.String(20),
        existing_nullable=False,
    )
