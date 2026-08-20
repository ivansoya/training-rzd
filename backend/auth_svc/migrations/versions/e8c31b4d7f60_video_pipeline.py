"""Конвейер видео: очередь работ, ступени качества и таблица кадров в базе.

Три изменения одной причины — нарезка перестала быть делом веб-процесса.

``video_jobs`` — очередь тяжёлой работы. Раньше нарезку заводил
``threading.Thread`` прямо в обработчике запроса: она делила потоки gunicorn со
всем остальным API, не переживала перезапуск и заводилась заново на каждый
промах по битому ролику. Очередь в базе видна всем процессам, переживает
рестарт и помнит отказ.

``video_assets`` — ступени качества. У ролика появляются полные копии 1080p,
720p и 480p; перегон вырезается из копии перекладыванием пакетов, а не
перекодированием оригинала. Пути к копиям и каталогам перегонов хранятся
здесь же: файл появляется фоновой задачей, и наличие пути в базе — это и есть
признак того, что она дошла до конца.

``task_videos.frame_index`` — сама таблица кадров. Прежнее решение держать её
файлом рядом с роликом было верным по букве и дорогим по счёту: каждый запрос
перегона читал файл с тома и разворачивал дельты заново.

Revision ID: e8c31b4d7f60
Revises: d7f1a3e29b64
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e8c31b4d7f60"
down_revision: Union[str, None] = "d7f1a3e29b64"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# create_type=False, а тип создаётся явно ниже: иначе `create_table` попробует
# создать его второй раз — по разу на каждую колонку.
ASSET_STATUS = postgresql.ENUM(
    "pending", "building", "ready", "error",
    name="video_asset_status", create_type=False,
)
JOB_KIND = postgresql.ENUM(
    "index", "strip", "variant", "chunkset", "chunk",
    name="video_job_kind", create_type=False,
)
JOB_STATUS = postgresql.ENUM(
    "queued", "running", "done", "error",
    name="video_job_status", create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()
    ASSET_STATUS.create(bind, checkfirst=True)
    JOB_KIND.create(bind, checkfirst=True)
    JOB_STATUS.create(bind, checkfirst=True)

    op.add_column(
        "task_videos",
        sa.Column("frame_index", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )

    op.create_table(
        "video_assets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("video_id", sa.Uuid(), nullable=False),
        sa.Column("quality", sa.String(length=16), nullable=False),
        sa.Column("file_status", ASSET_STATUS, nullable=False,
                  server_default="pending"),
        sa.Column("file_path", sa.String(length=1024), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("chunks_status", ASSET_STATUS, nullable=False,
                  server_default="pending"),
        sa.Column("chunks_dir", sa.String(length=1024), nullable=True),
        sa.Column("chunks_ready", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("chunks_total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["video_id"], ["task_videos.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("video_id", "quality", name="uq_video_asset_quality"),
    )

    op.create_table(
        "video_jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("video_id", sa.Uuid(), nullable=False),
        sa.Column("kind", JOB_KIND, nullable=False),
        sa.Column("quality", sa.String(length=16), nullable=False, server_default=""),
        sa.Column("chunk_no", sa.Integer(), nullable=False, server_default="-1"),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="50"),
        sa.Column("status", JOB_STATUS, nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["video_id"], ["task_videos.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    # Повтор одной и той же работы отсекает база, а не проверка перед
    # вставкой: между проверкой и вставкой помещается второй такой же запрос.
    op.create_index(
        "uq_video_job_active",
        "video_jobs",
        ["video_id", "kind", "quality", "chunk_no"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running')"),
    )
    op.create_index(
        "ix_video_jobs_pick", "video_jobs", ["status", "priority", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_video_jobs_pick", table_name="video_jobs")
    op.drop_index("uq_video_job_active", table_name="video_jobs")
    op.drop_table("video_jobs")
    op.drop_table("video_assets")
    op.drop_column("task_videos", "frame_index")

    bind = op.get_bind()
    JOB_STATUS.drop(bind, checkfirst=True)
    JOB_KIND.drop(bind, checkfirst=True)
    ASSET_STATUS.drop(bind, checkfirst=True)
