"""API полуавтоматической разметки.

Кадр сюда не загружают: сервис держит тот же том, что и остальные, и читает
файл сам — по image_id для изображения или по ролику и номеру кадра для
размечаемого видео. Права проверяются по сессионной куке — как в datasets_svc.
"""
import os
import uuid

from flask import Blueprint, jsonify, request

from autolabel_svc.manager import WorkerError, manager
from common import config
from common.auth import current_user, has_role, role_in
from common.db import SessionLocal
from common.models import Image, Project, Task, TaskVideo

bp = Blueprint("autolabel", __name__, url_prefix="/api/auto")

MODELS = ("sam2",)


def _uuid_or_none(value):
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _caller():
    """(user_id, error). Отдельно от кадра: сессию открывают до выбора кадра."""
    db = SessionLocal()
    try:
        user = current_user(db)
        if user is None:
            return None, (jsonify({"error": "Не выполнен вход."}), 401)
        return str(user.id), None
    finally:
        db.close()


def frame_key(data):
    """Чем кодировщик помечает закодированный кадр в своём кэше.

    У изображения это его id, у кадра видео — ролик и номер. Ключи не должны
    пересекаться: иначе кадр одного ролика подменил бы кадр другого.
    """
    if data.get("video_id") is not None:
        return f"v:{data['video_id']}:{int(data.get('frame_no') or 0)}"
    return str(data.get("image_id"))


def _frame(data):
    """(user_id, путь к кадру, error) одним походом в БД: predict зовут на
    каждый клик, и лишний запрос там стоит миллисекунд отклика.

    Кадр размечаемого видео берётся из того же распакованного кэша, который
    пишет datasets_svc, отдавая кадр редактору. Второго декодера здесь нет
    осознанно: видео умеет разбирать один сервис, и он же владеет кэшем.
    """
    db = SessionLocal()
    try:
        user = current_user(db)
        if user is None:
            return None, None, (jsonify({"error": "Не выполнен вход."}), 401)

        if data.get("video_id") is not None:
            return _video_frame(db, user, data)

        iid = _uuid_or_none(data.get("image_id"))
        image = db.get(Image, iid) if iid else None
        if image is None:
            return None, None, (jsonify({"error": "Изображение не найдено."}), 404)
        project = db.get(Project, image.project_id)
        if project is None or not has_role(role_in(db, user, project), "editor"):
            return None, None, (jsonify({"error": "Недостаточно прав в проекте."}), 403)
        path = os.path.join(config.DATA_DIR, image.file_path)
        if not os.path.exists(path):
            return None, None, (jsonify({"error": "Файл кадра не найден."}), 404)
        return str(user.id), path, None
    finally:
        db.close()


def _video_frame(db, user, data):
    vid = _uuid_or_none(data.get("video_id"))
    video = db.get(TaskVideo, vid) if vid else None
    if video is None:
        return None, None, (jsonify({"error": "Видео не найдено."}), 404)
    task = db.get(Task, video.task_id)
    project = db.get(Project, task.project_id) if task else None
    if project is None or not has_role(role_in(db, user, project), "editor"):
        return None, None, (jsonify({"error": "Недостаточно прав в проекте."}), 403)

    try:
        frame_no = int(data.get("frame_no"))
    except (TypeError, ValueError):
        return None, None, (jsonify({"error": "Не указан кадр."}), 400)
    # Путь строит общий помощник: этот файл кладёт datasets_svc, и два своих
    # склеивателя пути однажды разошлись бы — а разошлись бы они молча.
    path = config.task_video_frame_file(
        project.id, task.id, video.id, frame_no, video.width, video.height
    )
    if not os.path.exists(path):
        # Кадр вытеснили из кэша. Клиент умеет это чинить: запросит картинку
        # кадра, датасетный сервис распакует её заново, и клик повторится.
        return None, None, (
            jsonify({"error": "Кадр ещё не распакован.", "code": "frame_not_ready"}),
            409,
        )
    return str(user.id), path, None


@bp.post("/sessions")
def open_session():
    """Сессия на пользователя и модель. SAM2 открывают при входе в редактор,
    остальные модели — в момент первого обращения к ним."""
    user_id, err = _caller()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    model = data.get("model") or "sam2"
    if model not in MODELS:
        return jsonify({"error": f"Модель «{model}» не поддерживается."}), 400
    params = data.get("params") or {}
    try:
        session = manager.open(user_id, model, params)
        info = session.worker.call("info", {})
    except WorkerError as exc:
        return jsonify({"error": str(exc)}), 503
    return jsonify({"session_id": session.id, "model": model, "info": info}), 201


@bp.delete("/sessions/<session_id>")
def close_session(session_id):
    user_id, err = _caller()
    if err:
        return err
    return jsonify({"ok": manager.close(session_id, user_id)})


@bp.post("/sessions/<session_id>/warm")
def warm(session_id):
    """Прогрев кадра. Редактор зовёт его на текущий кадр и фоном на соседний:
    кодировщик — самая дорогая часть, клики после него мгновенные."""
    data = request.get_json(silent=True) or {}
    user_id, path, err = _frame(data)
    if err:
        return err
    session = manager.get(session_id, user_id)
    if session is None:
        return jsonify({"error": "Сессия не найдена."}), 404
    try:
        return jsonify(
            session.worker.call(
                "warm", {"image_path": path, "image_id": frame_key(data)}
            )
        )
    except WorkerError as exc:
        return jsonify({"error": str(exc)}), 503


@bp.post("/sessions/<session_id>/predict")
def predict(session_id):
    """Весь набор точек приходит целиком на каждый клик — воркер не помнит
    диалог, поэтому его перезапуск не теряет начатое выделение."""
    data = request.get_json(silent=True) or {}
    user_id, path, err = _frame(data)
    if err:
        return err
    session = manager.get(session_id, user_id)
    if session is None:
        return jsonify({"error": "Сессия не найдена."}), 404
    try:
        return jsonify(
            session.worker.call(
                "predict",
                {
                    "image_path": path,
                    "image_id": frame_key(data),
                    "prompts": data.get("prompts") or {},
                    "want": data.get("want") or ["box"],
                    "refine": data.get("refine") or {},
                    # В каких пикселях говорит клиент. Не «в каких примерно» —
                    # редактор видео рисует в размерах источника, а показывать
                    # при этом может ступень качества.
                    "space": data.get("space"),
                },
            )
        )
    except WorkerError as exc:
        return jsonify({"error": str(exc)}), 503


@bp.get("/health")
def health():
    return jsonify({"ok": True, "models": list(MODELS), **manager.stats()})
