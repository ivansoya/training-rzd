"""Медленный пул готовит ролик за роликом: все ступени раннего, потом следующий.

Раньше работы шли слоями по всем роликам разом — ленты всех, потом копии
всех, — и готовым не становился ни один. На voran 20.10.2026 копия первого из
шести роликов была готова в 16:06:43, а открылся он в 16:11:27: ждал, пока
склеятся ленты пяти остальных.

Строки заводятся в транзакции, которая откатывается: живой воркер стенда
незакоммиченного не видит и работ не перехватит, а ``claim`` идёт в настоящий
Postgres с его ``SKIP LOCKED``.
"""
import uuid
from datetime import datetime, timedelta, timezone

from common.models import TaskVideo
from conftest import DB_DSN
from datasets_svc import video_queue as queue
from sqlalchemy import create_engine
from sqlalchemy.orm import Session


def test_медленный_пул_доделывает_ролик_прежде_следующего(task):
    # Задолго до настоящих роликов стенда: наши встают первыми и при живой очереди.
    old = datetime(2000, 1, 1, tzinfo=timezone.utc)
    with create_engine(DB_DSN).connect() as conn:
        outer = conn.begin()
        db = Session(bind=conn, join_transaction_mode="create_savepoint")
        try:
            first, second = (
                TaskVideo(task_id=uuid.UUID(task["id"]), file_name=n, file_path=n,
                          mode="annotate", created_at=old + timedelta(minutes=i))
                for i, n in enumerate(("first.mp4", "second.mp4"))
            )
            db.add_all([first, second])
            db.commit()
            a, b = first.id, second.id
            # Заявки вперемешку, как их ставит жизнь: лента второго раньше копий первого.
            queue.enqueue(db, b, queue.KIND_STRIP)
            queue.enqueue(db, a, queue.KIND_VARIANT, quality="720")
            queue.enqueue(db, b, queue.KIND_VARIANT, quality="720")
            queue.enqueue(db, a, queue.KIND_VARIANT, quality="480", priority=35)

            taken = []
            for _ in range(4):
                job = queue.claim(db, queue.SLOW_KINDS)
                taken.append((job.video_id, job.kind, job.quality))
        finally:
            db.close()
            outer.rollback()

    assert taken == [(a, "variant", "720"), (a, "variant", "480"), (b, "strip", ""), (b, "variant", "720")]
