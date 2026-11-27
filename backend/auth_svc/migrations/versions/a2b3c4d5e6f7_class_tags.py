"""Таги классов: свой справочник проекта и связи «класс — таг».

Отдельно от тагов кадров: те говорят, в каких условиях снят кадр, эти — по
какому признаку классы отделяют друг от друга. Классов и разметки миграция не
трогает: у существующих классов тагов просто нет.

Revision ID: a2b3c4d5e6f7
Revises: f1b2c3d4e5f6
"""
import sqlalchemy as sa
from alembic import op

revision = "a2b3c4d5e6f7"
down_revision = "f1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "class_tags",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("project_id", sa.Uuid(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.UniqueConstraint("project_id", "name", name="uq_class_tag_name"),
    )
    op.create_table(
        "label_class_tags",
        sa.Column("class_id", sa.Uuid(), sa.ForeignKey("classes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag_id", sa.Uuid(), sa.ForeignKey("class_tags.id", ondelete="CASCADE"), primary_key=True),
    )
    op.create_index("ix_label_class_tags_tag", "label_class_tags", ["tag_id"])


def downgrade():
    op.drop_index("ix_label_class_tags_tag", table_name="label_class_tags")
    op.drop_table("label_class_tags")
    op.drop_table("class_tags")
