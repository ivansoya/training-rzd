"""Будильник циклов LISTEN переживает обрыв базы.

Нити превью и образцов звали `conn.poll()` без защиты: база перезапустилась —
нить умерла, процесс жил дальше, превью и G молчали до перезапуска воркера.
"""
import os
import threading
import time
import uuid

from common import live


def _until(fn, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        got = fn()
        if got:
            return got
        time.sleep(0.1)
    return None


def test_будильник_переживает_обрыв_соединения(db, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", os.environ.get("TEST_DB_DSN", "postgresql://app:app@db:5432/app"))
    channel = "test_wake_" + uuid.uuid4().hex[:8]
    stop, woke = threading.Event(), threading.Event()

    def run():
        for _ in live.wakeups(channel, stop, every=30):
            woke.set()

    def listeners():
        with db.cursor() as cur:
            cur.execute("SELECT pid FROM pg_stat_activity WHERE query = %s", (f"LISTEN {channel}",))
            return [r[0] for r in cur.fetchall()]

    def notify():
        with db.cursor() as cur:
            cur.execute(f"NOTIFY {channel}")

    threading.Thread(target=run, daemon=True).start()
    try:
        first = _until(listeners)
        assert first, "будильник не подписался"
        notify()
        assert woke.wait(5)
        woke.clear()

        with db.cursor() as cur:
            cur.execute("SELECT pg_terminate_backend(%s)", (first[0],))
        assert _until(lambda: [p for p in listeners() if p != first[0]]), "не переподключился"
        notify()
        assert woke.wait(5), "после обрыва NOTIFY не будит"
    finally:
        stop.set()
