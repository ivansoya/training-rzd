"""Tiny file-based job store for tracking progress of long operations.

Jobs are persisted as JSON files on the shared data volume, so any service can
read a job's progress regardless of which service started the background work.
"""
import json
import os
import threading
import time
import uuid

_DIR = None
_lock = threading.Lock()
# Подметаем не только при старте: сервис живёт неделями, а джобы копились.
SWEEP_EVERY = 600
_swept = [0.0]


def configure(directory):
    global _DIR
    _DIR = directory
    os.makedirs(directory, exist_ok=True)
    _cleanup_old()


def _path(job_id):
    return os.path.join(_DIR, f"{job_id}.json")


def _write(job_id, data):
    with _lock:
        tmp = _path(job_id) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)
        os.replace(tmp, _path(job_id))


def create(job_type, total=0, message="", *, project_id=None, owner=None):
    """`project_id` и `owner` решают, кому джобу показывать (`/api/jobs/<id>`)."""
    job_id = uuid.uuid4().hex[:12]
    if time.time() - _swept[0] > SWEEP_EVERY:
        _cleanup_old()
    _write(job_id, {
        "id": job_id,
        "type": job_type,
        "project_id": str(project_id) if project_id else None,
        "owner": str(owner) if owner else None,
        "status": "running",
        "processed": 0,
        "total": total,
        "message": message,
        "result": None,
        "error": None,
        "updated": time.time(),
    })
    return job_id


def update(job_id, **fields):
    data = get(job_id)
    if data is None:
        return
    data.update(fields)
    data["updated"] = time.time()
    _write(job_id, data)


def get(job_id):
    if not _DIR:
        return None
    path = _path(job_id)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return None


def abandon_running(message):
    """Джобы «идёт» от прежнего процесса: их потоки умерли вместе с ним, и клиент ждал бы вечно.

    Звать только на старте единственного процесса, который ведёт джобы."""
    if not _DIR or not os.path.isdir(_DIR):
        return 0
    n = 0
    for f in os.listdir(_DIR):
        if not f.endswith(".json"):
            continue
        data = get(f[:-5])
        if data and data.get("status") == "running":
            update(data["id"], status="error", error=message)
            n += 1
    return n


def _cleanup_old(max_age=3600):
    """Drop finished job files older than `max_age` seconds."""
    now = time.time()
    _swept[0] = now
    try:
        for f in os.listdir(_DIR):
            if not f.endswith(".json"):
                continue
            full = os.path.join(_DIR, f)
            try:
                if now - os.path.getmtime(full) <= max_age:
                    continue
                # Идущую джобу не трогаем, даже если она давно молчит.
                with open(full, encoding="utf-8") as fh:
                    if json.load(fh).get("status") == "running":
                        continue
                os.remove(full)
            except (OSError, ValueError):
                pass
    except OSError:
        pass
