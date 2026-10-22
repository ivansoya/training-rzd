"""Ролик по Range: у ступени таблица пакетов, перегоны и их работы уходят.

«Исходное» отдаётся из оригинала по Range, ступень — одним файлом (решение
22.10.2026). Старые строки ступеней описывают перегоны, которых больше нет, —
стираются; разметки ролика они не касаются. Размечаемые ролики встают в
очередь на таблицу пакетов, дальше обычный путь: ступени пережмутся с потолком,
а перегоны прежней раскладки воркер уберёт с тома.

Revision ID: b5c6d7e8f9a0
Revises: a4b5c6d7e8f9
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "b5c6d7e8f9a0"
down_revision: Union[str, None] = "a4b5c6d7e8f9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("video_assets", sa.Column("frame_index", sa.JSON().with_variant(JSONB(), "postgresql")))
    op.execute("DELETE FROM video_assets")
    for name in ("chunks_status", "chunks_dir", "chunks_ready", "chunks_total"):
        op.drop_column("video_assets", name)
    op.execute("DELETE FROM video_jobs WHERE kind IN ('chunk', 'chunkset', 'variant')")
    op.execute("""
        INSERT INTO video_jobs (id, video_id, kind, quality, chunk_no, priority, status,
                                attempts, progress, total, created_at)
        SELECT gen_random_uuid(), v.id, 'index', '', -1, 10, 'queued', 0, 0, 0, now()
        FROM task_videos v
        WHERE v.mode = 'annotate'
          AND NOT EXISTS (SELECT 1 FROM video_jobs j WHERE j.video_id = v.id
                          AND j.kind = 'index' AND j.status IN ('queued', 'running'))
    """)


def downgrade() -> None:
    op.add_column("video_assets", sa.Column("chunks_status", sa.Enum(name="video_asset_status", create_type=False),
                                            nullable=False, server_default="pending"))
    op.add_column("video_assets", sa.Column("chunks_dir", sa.String(1024)))
    op.add_column("video_assets", sa.Column("chunks_ready", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("video_assets", sa.Column("chunks_total", sa.Integer(), nullable=False, server_default="0"))
    op.drop_column("video_assets", "frame_index")
