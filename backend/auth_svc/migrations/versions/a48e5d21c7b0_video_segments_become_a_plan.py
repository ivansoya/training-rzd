"""task_videos.segments becomes a cut plan, not a history

Revision ID: a48e5d21c7b0
Revises: f3d70a5c916e
Create Date: 2026-08-04 21:00:00.000000

"""
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a48e5d21c7b0'
down_revision: Union[str, None] = 'f3d70a5c916e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Защита от порченых данных: цикл по участку не должен стать бесконечным.
MAX_STEPS = 200_000


def _moments(plan, duration_ms):
    out = set()
    for seg in plan or []:
        start = int(seg.get("start_ms", 0))
        end = int(seg.get("end_ms", 0))
        step = max(1, int(seg.get("step_ms", 1000)))
        if duration_ms:
            end = min(end, int(duration_ms))
        t, n = start, 0
        while t < end and n < MAX_STEPS:
            out.add(t)
            t += step
            n += 1
    return out


def upgrade() -> None:
    # Раньше колонка копила историю нарезок, теперь описывает то, что должно
    # быть нарезано. История местами неполна — по ней кадров получается меньше,
    # чем существует. Дописываем недостающие моменты одиночными кадрами, иначе
    # первое же применение плана снесёт их вместе с разметкой.
    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, duration_ms, segments FROM task_videos")
    ).fetchall()
    for vid, duration_ms, segments in rows:
        plan = segments if isinstance(segments, list) else json.loads(segments or "[]")
        clean = [
            {
                "start_ms": int(s.get("start_ms", 0)),
                "end_ms": int(s.get("end_ms", 0)),
                "step_ms": max(1, int(s.get("step_ms", 1000))),
            }
            for s in plan
        ]
        covered = _moments(clean, duration_ms)
        existing = conn.execute(
            sa.text(
                "SELECT DISTINCT source_time_ms FROM images "
                "WHERE source_video_id = :vid AND source_time_ms IS NOT NULL "
                "AND task_status <> 'deleted'"
            ),
            {"vid": vid},
        ).scalars().all()
        # Забракованные не дописываем: план не должен их воскрешать.
        for ms in sorted(set(existing) - covered):
            clean.append({"start_ms": int(ms), "end_ms": int(ms) + 1, "step_ms": 1000})
        conn.execute(
            sa.text("UPDATE task_videos SET segments = :plan WHERE id = :vid"),
            {"plan": json.dumps(clean), "vid": vid},
        )


def downgrade() -> None:
    # Прежняя история не восстановима — план остаётся как есть, старый код
    # прочтёт его как список нарезанных участков без поля frames.
    pass
