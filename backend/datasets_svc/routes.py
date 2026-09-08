"""Общие ручки сервиса данных: фоновые задачи и место на диске.

Здесь осталось ровно два дела. Файловые датасеты старого приложения на /tools
удалены вместе с ним: датасет теперь принадлежит проекту и живёт в базе, а не
папкой на томе.

`/api/jobs/<id>` остаётся общей точкой опроса фоновых задач: ими живут мастер
импорта, окно выгрузки, страница таски и нарезка ролика. Тяжёлые очереди
(видео, подготовка данных, обучение) держат своё состояние в базе и сюда не
ходят — эта ручка про короткие задачи, которых ждут, не отходя от экрана.
"""
import os
import shutil
import time

from flask import Blueprint, jsonify

from common import jobs
from common.config import DATA_DIR, HOST_STAT_PATH, PROJECTS_DIR

bp = Blueprint("datasets", __name__)


@bp.get("/api/health")
def health():
    return jsonify({"status": "ok", "service": "datasets"})


@bp.get("/api/jobs/<job_id>")
def get_job(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "job not found"}), 404
    return jsonify(job)


# Обход тома — недёшев, а спрашивают о месте часто (мастер сборки набора
# считает по нему оценку). Держим ответ несколько секунд.
_storage_cache = {"t": 0.0, "data": None}


def _dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


@bp.get("/api/storage")
def storage():
    """Место на диске: сколько занято и сколько осталось.

    Меряем настоящий диск хоста, когда он проброшен: внутри контейнера
    ``disk_usage`` показывает виртуальный том Docker, который объявляет около
    терабайта независимо от того, что под ним.
    """
    now = time.time()
    cached = _storage_cache["data"]
    if cached and now - _storage_cache["t"] < 3:
        return jsonify(cached)
    stat_path = DATA_DIR
    if HOST_STAT_PATH and os.path.isdir(HOST_STAT_PATH):
        stat_path = HOST_STAT_PATH
    du = shutil.disk_usage(stat_path)
    data = {
        # Всё, что платформа держит на общем томе: кадры проектов, обучающие
        # наборы, веса, проверочные ролики. Именно это число падает, когда
        # что-то удаляют, — виртуальный диск хоста при этом не сжимается.
        "data_bytes": _dir_size(DATA_DIR),
        "projects_bytes": _dir_size(PROJECTS_DIR),
        "disk_total": du.total,
        "disk_free": du.free,
        "disk_used": du.used,
    }
    _storage_cache.update(t=now, data=data)
    return jsonify(data)
