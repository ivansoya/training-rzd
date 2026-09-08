"""training sets, their split, image embeddings and the dataprep queue

Revision ID: f3c42e5f7b92
Revises: f2b31d4e6a81
Create Date: 2026-09-06 10:20:00.000000

Кадры набора построчно не хранятся: набор из ста тысяч кадров при графе ×6 —
это шестьсот тысяч строк, которые ни с чем не соединяются и дублируют
содержимое папки. Их место — manifest.jsonl рядом с файлами. В базе остаётся
деление, и оно про ИСХОДНЫЙ кадр: сто тысяч вместо шестисот.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'f3c42e5f7b92'
down_revision: Union[str, None] = 'f2b31d4e6a81'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

JSONB = postgresql.JSONB

SET_KIND = sa.Enum("bbox", "polygon", name="train_set_kind")
SET_STATUS = sa.Enum("draft", "queued", "building", "ready", "error",
                     name="train_set_status")
SPLIT_MODE = sa.Enum("manual", "random", "balanced", "smart", name="split_mode")
JOB_KIND = sa.Enum("build_set", "embed", "delete_set", name="dataprep_job_kind")
JOB_STATUS = sa.Enum("queued", "running", "done", "error", "cancelled",
                     name="dataprep_job_status")
# Тип уже есть в базе с самой первой схемы — создавать второй раз нельзя.
IMAGE_SPLIT = postgresql.ENUM(
    "train", "val", "test", "other", name="image_split", create_type=False
)


def upgrade() -> None:
    op.create_table(
        "train_sets",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("kind", SET_KIND, nullable=False),
        sa.Column("status", SET_STATUS, nullable=False, server_default="draft"),
        sa.Column("spec", JSONB(), nullable=False),
        sa.Column("split_mode", SPLIT_MODE, nullable=False),
        sa.Column("val_ratio", sa.Float(), nullable=False),
        sa.Column("seed", sa.BigInteger(), nullable=False),
        sa.Column("graph_version_id", sa.Uuid(),
                  sa.ForeignKey("aug_graph_versions.id", ondelete="RESTRICT")),
        sa.Column("val_graph_version_id", sa.Uuid(),
                  sa.ForeignKey("aug_graph_versions.id", ondelete="RESTRICT")),
        sa.Column("counts", JSONB()),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False,
                  server_default="0"),
        sa.Column("hardlinked_bytes", sa.BigInteger(), nullable=False,
                  server_default="0"),
        sa.Column("dir_path", sa.String(1024)),
        sa.Column("built_at", sa.DateTime(timezone=True)),
        sa.Column("error", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(),
                  sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.UniqueConstraint("project_id", "name", name="uq_train_set_name"),
    )
    op.create_index("ix_train_sets_project", "train_sets",
                    ["project_id", "created_at"])

    op.create_table(
        "train_set_splits",
        sa.Column("set_id", sa.Uuid(),
                  sa.ForeignKey("train_sets.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("image_id", sa.Uuid(),
                  sa.ForeignKey("images.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("split", IMAGE_SPLIT, nullable=False),
        sa.Column("group_key", sa.String(64)),
    )
    op.create_index("ix_set_splits_split", "train_set_splits",
                    ["set_id", "split"])

    op.create_table(
        "image_embeddings",
        sa.Column("image_id", sa.Uuid(),
                  sa.ForeignKey("images.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("model", sa.String(48), primary_key=True),
        sa.Column("dim", sa.SmallInteger(), nullable=False),
        sa.Column("vector", sa.LargeBinary(), nullable=False),
        sa.Column("norm", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_image_emb_model", "image_embeddings", ["model"])

    op.create_table(
        "dataprep_jobs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("kind", JOB_KIND, nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("payload", JSONB()),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="50"),
        sa.Column("status", JOB_STATUS, nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text()),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("stage", sa.String(24)),
        sa.Column("stage_text", sa.String(160)),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
        sa.Column("worker_id", sa.String(64)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("created_by", sa.Uuid(),
                  sa.ForeignKey("users.id", ondelete="SET NULL")),
    )
    # Повтор одной и той же работы отсекается базой, а не проверкой перед
    # вставкой: между проверкой и вставкой помещается второй такой же запрос.
    op.create_index(
        "uq_dataprep_job_active", "dataprep_jobs", ["kind", "target_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running')"),
    )
    op.create_index("ix_dataprep_jobs_pick", "dataprep_jobs",
                    ["status", "priority", "created_at"])
    op.create_index("ix_dataprep_jobs_project", "dataprep_jobs",
                    ["project_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_dataprep_jobs_project", table_name="dataprep_jobs")
    op.drop_index("ix_dataprep_jobs_pick", table_name="dataprep_jobs")
    op.drop_index("uq_dataprep_job_active", table_name="dataprep_jobs")
    op.drop_table("dataprep_jobs")
    op.drop_index("ix_image_emb_model", table_name="image_embeddings")
    op.drop_table("image_embeddings")
    op.drop_index("ix_set_splits_split", table_name="train_set_splits")
    op.drop_table("train_set_splits")
    op.drop_index("ix_train_sets_project", table_name="train_sets")
    op.drop_table("train_sets")
    bind = op.get_bind()
    for enum in (JOB_STATUS, JOB_KIND, SPLIT_MODE, SET_STATUS, SET_KIND):
        enum.drop(bind, checkfirst=True)
