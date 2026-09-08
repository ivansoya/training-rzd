"""staff flag and the GPU dispatcher

Revision ID: f1a20c3d5e70
Revises: e8c31b4d7f60
Create Date: 2026-09-06 10:00:00.000000

Диспетчер идёт первой ревизией, потому что он ничего не требует, а требуют
его все: и обучение, и признаки кадров, и полуавтомат. Право на железо —
отдельный бит у пользователя, а не роль в проекте: администратор своего
проекта не должен снимать чужое обучение с карты.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'f1a20c3d5e70'
down_revision: Union[str, None] = 'e8c31b4d7f60'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

LEASE_STATUS = sa.Enum(
    "queued", "held", "released", "expired", "denied", "cancelled",
    name="gpu_lease_status",
)


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("is_staff", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
    )

    op.create_table(
        "gpu_devices",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("host", sa.String(64), nullable=False),
        sa.Column("device_index", sa.Integer(), nullable=False),
        sa.Column("uuid_str", sa.String(64), unique=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("total_mb", sa.Integer(), nullable=False),
        sa.Column("reserved_mb", sa.Integer(), nullable=False,
                  server_default="1024"),
        sa.Column("sam2_reserve_mb", sa.Integer(), nullable=False,
                  server_default="0"),
        sa.Column("max_heavy", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("enabled", sa.Boolean(), nullable=False,
                  server_default=sa.true()),
        sa.Column("seen_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("host", "device_index", name="uq_gpu_device_slot"),
    )
    op.create_index("ix_gpu_devices_live", "gpu_devices", ["enabled"])

    op.create_table(
        "gpu_leases",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("device_id", sa.Uuid(),
                  sa.ForeignKey("gpu_devices.id", ondelete="CASCADE")),
        sa.Column("holder", sa.String(32), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("ref_id", sa.Uuid()),
        sa.Column("project_id", sa.Uuid(),
                  sa.ForeignKey("projects.id", ondelete="SET NULL")),
        sa.Column("user_id", sa.Uuid(),
                  sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("want_mb", sa.Integer(), nullable=False),
        sa.Column("granted_mb", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("peak_mb", sa.Integer()),
        sa.Column("status", LEASE_STATUS, nullable=False,
                  server_default="queued"),
        sa.Column("queue_priority", sa.Integer(), nullable=False,
                  server_default="50"),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("reason", sa.String(200)),
        sa.Column("title", sa.String(160)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("granted_at", sa.DateTime(timezone=True)),
        sa.Column("released_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_gpu_leases_held", "gpu_leases", ["device_id", "status"])
    op.create_index("ix_gpu_leases_queue", "gpu_leases",
                    ["queue_priority", "created_at"])
    op.create_index("ix_gpu_leases_ref", "gpu_leases", ["ref_id"])

    op.create_table(
        "gpu_usage_hints",
        sa.Column("kind", sa.String(32), primary_key=True),
        sa.Column("signature", sa.String(64), primary_key=True),
        sa.Column("samples", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("high_mb", sa.Integer(), nullable=False),
        sa.Column("last_mb", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("gpu_usage_hints")
    op.drop_index("ix_gpu_leases_ref", table_name="gpu_leases")
    op.drop_index("ix_gpu_leases_queue", table_name="gpu_leases")
    op.drop_index("ix_gpu_leases_held", table_name="gpu_leases")
    op.drop_table("gpu_leases")
    op.drop_index("ix_gpu_devices_live", table_name="gpu_devices")
    op.drop_table("gpu_devices")
    op.drop_column("users", "is_staff")
    LEASE_STATUS.drop(op.get_bind(), checkfirst=True)
