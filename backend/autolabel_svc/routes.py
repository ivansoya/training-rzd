"""API полуавтоматической разметки.

Кадр сюда не загружают: сервис держит тот же том, что и остальные, и читает
файл по image_id. Права проверяются по сессионной куке — как в datasets_svc.
"""
import os
import uuid

from flask import Blueprint, jsonify, request

from autolabel_svc.manager import WorkerError, manager
from common import config
from common.auth import current_user, has_role, role_in
from common.db import SessionLocal
from common.models import Image, Project

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


def _frame(image_id):
    """(user_id, путь к кадру, error) одним походом в БД: predict зовут на
    каждый клик, и лишний запрос там стоит миллисекунд отклика."""
    db = SessionLocal()
    try:
        user = current_user(db)
        if user is None:
            return None, None, (jsonify({"error": "Не выполнен вход."}), 401)
        iid = _uuid_or_none(image_id)
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
    user_id, path, err = _frame(data.get("image_id"))
    if err:
        return err
    session = manager.get(session_id, user_id)
    if session is None:
        return jsonify({"error": "Сессия не найдена."}), 404
    try:
        return jsonify(
            session.worker.call("warm", {"image_path": path, "image_id": data["image_id"]})
        )
    except WorkerError as exc:
        return jsonify({"error": str(exc)}), 503


@bp.post("/sessions/<session_id>/predict")
def predict(session_id):
    """Весь набор точек приходит целиком на каждый клик — воркер не помнит
    диалог, поэтому его перезапуск не теряет начатое выделение."""
    data = request.get_json(silent=True) or {}
    user_id, path, err = _frame(data.get("image_id"))
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
                    "image_id": data["image_id"],
                    "prompts": data.get("prompts") or {},
                    "want": data.get("want") or ["box"],
                    "refine": data.get("refine") or {},
                },
            )
        )
    except WorkerError as exc:
        return jsonify({"error": str(exc)}), 503


@bp.get("/health")
def health():
    return jsonify({"ok": True, "models": list(MODELS), **manager.stats()})
