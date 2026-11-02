"""Вопросы в разметке: обсуждение спорного места таски, сообщения и колокольчик (решение 29.10.2026).

Revision ID: e9f0a1b2c3d4
Revises: d7e8f9a0b1c2
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e9f0a1b2c3d4"
down_revision: Union[str, None] = "d7e8f9a0b1c2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "task_questions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("task_id", sa.Uuid(), nullable=False),
        sa.Column("image_id", sa.Uuid(), nullable=True),
        sa.Column("video_id", sa.Uuid(), nullable=True),
        sa.Column("frame_no", sa.Integer(), nullable=True),
        sa.Column("object_id", sa.Uuid(), nullable=True),
        sa.Column("object_kind", sa.String(length=8), nullable=True),
        sa.Column("class_id", sa.Uuid(), nullable=True),
        sa.Column("place", sa.String(length=300), nullable=False),
        sa.Column("time_ms", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=8), nullable=False, server_default="open"),
        sa.Column("resolved_by", sa.Uuid(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["image_id"], ["images.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["video_id"], ["task_videos.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["class_id"], ["classes.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["resolved_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_task_questions_task", "task_questions", ["task_id", "status"])
    op.create_table(
        "question_messages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("question_id", sa.Uuid(), nullable=False),
        sa.Column("author_id", sa.Uuid(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["question_id"], ["task_questions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_question_messages_q", "question_messages", ["question_id", "created_at"])
    op.create_table(
        "question_inbox",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("question_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["question_id"], ["task_questions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["message_id"], ["question_messages.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("user_id", "question_id"),
    )


def downgrade() -> None:
    op.drop_table("question_inbox")
    op.drop_index("ix_question_messages_q", table_name="question_messages")
    op.drop_table("question_messages")
    op.drop_index("ix_task_questions_task", table_name="task_questions")
    op.drop_table("task_questions")
