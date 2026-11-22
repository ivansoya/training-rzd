"""Personal image edits and pending empty image proposals."""
import sqlalchemy as sa
from alembic import op

revision = "f1b2c3d4e5f6"
down_revision = "f0a1b2c3d4e5"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("images", sa.Column("agent_empty", sa.Boolean(), server_default=sa.false(), nullable=False))
    op.add_column("task_questions", sa.Column("by_agent", sa.Boolean(), server_default=sa.false(), nullable=False))
    op.create_table(
        "image_human_edits",
        sa.Column("image_id", sa.Uuid(), sa.ForeignKey("images.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    op.drop_table("image_human_edits")
    op.drop_column("task_questions", "by_agent")
    op.drop_column("images", "agent_empty")
