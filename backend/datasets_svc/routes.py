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
import uuid

from flask import Blueprint, jsonify

from common import jobs
from common.auth import current_user, has_role, hw_view, role_in
from common.config import DATA_DIR, HOST_STAT_PATH, PROJECTS_DIR
from common.db import SessionLocal
from common.models import Project

bp = Blueprint("datasets", __name__)


@bp.get("/api/health")
def health():
    return jsonify({"status": "ok", "service": "datasets"})


@bp.get("/api/jobs/<job_id>")
def get_job(job_id):
    job = jobs.get(job_id)
    with SessionLocal() as db:
        user = current_user(db)
        if user is None:
            return jsonify({"error": "Нужно войти."}), 401
        if not job or not _may_see(db, user, job):
            return jsonify({"error": "job not found"}), 404
    return jsonify(job)


def _may_see(db, user, job) -> bool:
    """Джобу видит её автор и любой участник её проекта; ничейная — никто."""
    if job.get("owner") == str(user.id):
        return True
    try:
        project = db.get(Project, uuid.UUID(job["project_id"]))
    except (KeyError, TypeError, ValueError):
        return False
    return project is not None and has_role(role_in(db, user, project), "viewer")


# Обход тома — недёшев, а спрашивают о месте часто (мастер сборки набора
# считает по нему оценку). Держим ответ несколько секунд.
_storage_cache = {"t": 0.0, "data": None}


def _sizes(path, inner):
    """Байты под `path` и под вложенным `inner` — за один проход по тому.

    Жёсткая ссылка (кадр в наборе) считается один раз: по паре (устройство,
    inode). `inner` обходится первым — общий файл засчитывается проектам."""
    seen = set()

    def walk(top, skip=None):
        n = 0
        for root, dirs, files in os.walk(top):
            if skip:
                dirs[:] = [d for d in dirs if os.path.join(root, d) != skip]
            for f in files:
                try:
                    st = os.lstat(os.path.join(root, f))
                except OSError:
                    continue
                if (st.st_dev, st.st_ino) not in seen:
                    seen.add((st.st_dev, st.st_ino))
                    n += st.st_size
        return n

    part = walk(inner)
    return part + walk(path, skip=os.path.normpath(inner)), part


@bp.get("/api/storage")
def storage():
    """Место на диске: сколько занято и сколько осталось.

    Меряем настоящий диск хоста, когда он проброшен: внутри контейнера
    ``disk_usage`` показывает виртуальный том Docker, который объявляет около
    терабайта независимо от того, что под ним.
    """
    with SessionLocal() as db:
        user = current_user(db)
        if not hw_view(user):
            return jsonify({"error": "Только для администраторов стенда."}), 403
    now = time.time()
    cached = _storage_cache["data"]
    if cached and now - _storage_cache["t"] < 3:
        return jsonify(cached)
    stat_path = DATA_DIR
    if HOST_STAT_PATH and os.path.isdir(HOST_STAT_PATH):
        stat_path = HOST_STAT_PATH
    du = shutil.disk_usage(stat_path)
    data_bytes, projects_bytes = _sizes(DATA_DIR, PROJECTS_DIR)
    data = {
        # Всё, что платформа держит на общем томе: кадры проектов, обучающие
        # наборы, веса, проверочные ролики. Именно это число падает, когда
        # что-то удаляют, — виртуальный диск хоста при этом не сжимается.
        "data_bytes": data_bytes,
        "projects_bytes": projects_bytes,
        "disk_total": du.total,
        "disk_free": du.free,
        "disk_used": du.used,
    }
    _storage_cache.update(t=now, data=data)
    return jsonify(data)
