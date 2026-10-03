"""Ролики, по которым идёт фоновая работа: нарезка или закрытие разметки.

Проверка «уже идёт?» и запуск потока раньше не были атомарны: три закрытия
разом давали втрое больше кадров, две нарезки — дубли, ушедшие в датасет, а
удаление ролика посреди нарезки оставляло кадры без источника. Сервис данных
работает одним процессом gunicorn, поэтому реестра в памяти достаточно.
"""
import threading

_busy: dict = {}
_lock = threading.Lock()

KIND_TEXT = {"cut": "нарезка", "close": "закрытие разметки"}


def take(video_id, kind) -> dict | None:
    """Занять ролик. None — занят; иначе запись, в которую кладут job_id."""
    key = str(video_id)
    with _lock:
        if key in _busy:
            return None
        _busy[key] = {"kind": kind, "job_id": None}
        return _busy[key]


def current(video_id) -> dict | None:
    with _lock:
        got = _busy.get(str(video_id))
        return dict(got) if got else None


def release(video_id):
    with _lock:
        _busy.pop(str(video_id), None)


def refusal(video_id):
    """Ответ 409 занятому ролику, или None."""
    from flask import jsonify

    got = current(video_id)
    if got is None:
        return None
    return jsonify({
        "error": f"По ролику уже идёт {KIND_TEXT.get(got['kind'], 'работа')} — дождитесь её конца.",
        "code": "video_busy", "job_id": got["job_id"],
    }), 409
