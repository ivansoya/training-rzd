"""video annotation closing; hidden ranges instead of per-key visibility

Revision ID: c94af2b17d05
Revises: b8e4c1d90a72
Create Date: 2026-08-13 09:00:00.000000

Материализация перестаёт быть вечной синхронизацией и становится событием:
разметку ролика закрывают, и она превращается в обычные кадры таски. Заодно
заслонённость переезжает из флага у ключа в отрезки у трека — её тянут мышью
за края, и края обязаны быть собственной сущностью.
"""
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'c94af2b17d05'
down_revision: Union[str, None] = 'b8e4c1d90a72'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "task_videos",
        sa.Column("annotation_closed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "video_tracks",
        sa.Column(
            "hidden_ranges",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="[]",
        ),
    )

    # Уже размеченное не теряем: ключ с visible = false открывал заслонённый
    # участок до следующего ключа, значит из каждой такой пары получается
    # отрезок. Последний тянется до конца жизни трека.
    conn = op.get_bind()
    rows = conn.execute(sa.text(
        "SELECT t.id, t.start_frame, t.end_frame,"
        "       a.frame_no, a.visible"
        "  FROM video_tracks t"
        "  JOIN video_annotations a ON a.track_id = t.id"
        " ORDER BY t.id, a.frame_no"
    )).fetchall()

    by_track: dict = {}
    for track_id, start_frame, end_frame, frame_no, visible in rows:
        entry = by_track.setdefault(track_id, {"end": end_frame, "keys": []})
        entry["keys"].append((frame_no, visible))

    for track_id, entry in by_track.items():
        keys = entry["keys"]
        last = entry["end"] if entry["end"] is not None else (
            max(f for f, _ in keys) if keys else 0
        )
        ranges = []
        for i, (frame_no, visible) in enumerate(keys):
            if visible:
                continue
            to = keys[i + 1][0] if i + 1 < len(keys) else last + 1
            if to > frame_no:
                ranges.append([frame_no, to])
        if ranges:
            conn.execute(
                sa.text(
                    "UPDATE video_tracks SET hidden_ranges = CAST(:r AS jsonb)"
                    " WHERE id = :i"
                ),
                {"r": json.dumps(ranges), "i": track_id},
            )

    # Колонку убираем совсем: оставленная и никем не пишущаяся, через месяц
    # она прочитается как рабочая.
    op.drop_column("video_annotations", "visible")


def downgrade() -> None:
    op.add_column(
        "video_annotations",
        sa.Column("visible", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.drop_column("video_tracks", "hidden_ranges")
    op.drop_column("task_videos", "annotation_closed_at")
