"""Tiny file-based job store for tracking progress of long operations.

Jobs are persisted as JSON files so any gunicorn worker can read a job's
progress regardless of which worker started the background thread.
"""
import json
import os
import threading
import time
import uuid

_DIR = None
_lock = threading.Lock()


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


def create(job_type, total=0, message=""):
    job_id = uuid.uuid4().hex[:12]
    _write(job_id, {
        "id": job_id,
        "type": job_type,
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


def _cleanup_old(max_age=3600):
    """Drop job files older than `max_age` seconds."""
    now = time.time()
    try:
        for f in os.listdir(_DIR):
            if not f.endswith(".json"):
                continue
            full = os.path.join(_DIR, f)
            try:
                if now - os.path.getmtime(full) > max_age:
                    os.remove(full)
            except OSError:
                pass
    except OSError:
        pass
