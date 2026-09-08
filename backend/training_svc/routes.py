"""Ручки обучения, железа и живой связи.

Всё тяжёлое отсюда ушло: обучение запускает воркер, взяв бронь у диспетчера.
Здесь остались список, состояние, остановка — и живая связь, ради которой
состояние и переехало в базу.
"""
import os
import uuid

from flask import Blueprint, Response, jsonify, request, send_file
from sqlalchemy import select

from common import config, gpu, live
from common.auth import current_user, has_role, project_by_code, role_in
from common.db import SessionLocal
from common.models import (
    GpuDevice, TrainEpoch, TrainRun, TrainSet, User, utcnow,
)
from common.storage import load_json
from training_svc import trainer

bp = Blueprint("training", __name__)


def _uuid(value):
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _me():
    db = SessionLocal()
    user = current_user(db)
    if user is None:
        db.close()
        return None, None, (jsonify({"error": "Не выполнен вход."}), 401)
    return db, user, None


def _resolve(code, needed="viewer"):
    db = SessionLocal()
    user = current_user(db)
    if user is None:
        db.close()
        return None, None, None, (jsonify({"error": "Не выполнен вход."}), 401)
    project = project_by_code(db, code)
    if project is None:
        db.close()
        return None, None, None, (jsonify({"error": "Проект не найден."}), 404)
    if not has_role(role_in(db, user, project), needed):
        db.close()
        return None, None, None, (
            jsonify({"error": "Недостаточно прав в проекте."}), 403
        )
    return db, project, user, None


# --------------------------------------------------------------------------- #
# Модели
# --------------------------------------------------------------------------- #
@bp.get("/api/models")
def list_models():
    """Модели под задачу набора.

    Фильтруем по задаче, а не показываем все с пометкой: набор боксов и
    сегментационная модель — несовместимая пара, и выбрать её должно быть
    невозможно, а не «можно, но потом не обучится».
    """
    from training_svc import weights

    want = request.args.get("task")
    custom = load_json(config.MODELS_FILE, []) or []
    # `cached` — веса уже на томе; иначе первый запуск начнёт со скачивания
    # (пять–сорок мегабайт с GitHub), и форма честно об этом говорит.
    models = [
        dict(m, builtin=True, pretrained=True,
             cached=weights.is_cached(m["spec"]))
        for m in trainer.BUILTIN_MODELS
    ]
    models += [dict(m, builtin=False, pretrained=True, cached=True)
               for m in custom]
    if want in ("detect", "segment"):
        models = [m for m in models if (m.get("task") or "detect") == want]
    return jsonify({
        "available": trainer.is_available(),
        "models": models,
        # Форма строится по той же спецификации, что проверяет запрос:
        # умолчания и пределы в одном месте, а не в двух.
        "params": trainer.param_spec_view(),
        "aug_defaults": trainer.YOLO_AUG_DEFAULTS,
    })


# --------------------------------------------------------------------------- #
# Железо
# --------------------------------------------------------------------------- #
@bp.get("/api/gpu")
def gpu_state():
    """Что на картах и кто в очереди.

    Свою строку очереди видит каждый — иначе ожидание необъяснимо. Подробности
    по картам и чужие задачи — только обслуживанию.
    """
    db, user, err = _me()
    if err:
        return err
    try:
        staff = bool(user.is_staff)
        return jsonify({
            "staff": staff,
            "devices": gpu.devices_view(db) if staff else [],
            "queue": gpu.queue_view(db, user_id=user.id, staff=staff),
            "live": live.SLOTS.view(),
        })
    finally:
        db.close()


@bp.patch("/api/gpu/devices/<device_id>")
def set_device_limits(device_id):
    db, user, err = _me()
    if err:
        return err
    try:
        if not user.is_staff:
            return jsonify({"error": "Железо настраивает обслуживание."}), 403
        data = request.get_json(silent=True) or {}
        dev = gpu.set_limits(
            db, _uuid(device_id),
            reserved_mb=data.get("reserved_mb"),
            max_heavy=data.get("max_heavy"),
            enabled=data.get("enabled"),
        )
        if dev is None:
            return jsonify({"error": "Карта не найдена."}), 404
        return jsonify(gpu.devices_view(db))
    finally:
        db.close()


@bp.post("/api/gpu/leases/<lease_id>/kill")
def kill_lease(lease_id):
    db, user, err = _me()
    if err:
        return err
    try:
        if not user.is_staff:
            return jsonify({"error": "Снимать задачи может обслуживание."}), 403
        if not gpu.kill(db, _uuid(lease_id)):
            return jsonify({"error": "Задача не найдена."}), 404
        return jsonify({"ok": True})
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Обучения
# --------------------------------------------------------------------------- #
def _run_view(db, run, *, full=False):
    # Набор могли удалить: обучение живёт дальше, с весами и метриками.
    tset = db.get(TrainSet, run.set_id) if run.set_id else None
    author = db.get(User, run.created_by) if run.created_by else None
    got = {
        "id": str(run.id),
        "name": run.name,
        "status": run.status,
        "queue_reason": run.queue_reason,
        "task": run.task,
        "base_model": run.base_model,
        "device": run.device,
        "epochs": run.epochs,
        "current_epoch": run.current_epoch,
        "phase": run.phase,
        "current_batch": run.current_batch,
        "total_batches": run.total_batches,
        "val_batch": run.val_batch,
        "val_total": run.val_total,
        "batch_metrics": run.batch_metrics,
        "best_epoch": run.best_epoch,
        "best_fitness": run.best_fitness,
        "peak_vram_mb": run.peak_vram_mb,
        "has_weights": bool(run.weights_path),
        "weights_bytes": run.weights_bytes,
        "error": run.error,
        "author": author.display_name if author else None,
        "created_at": run.created_at.isoformat(),
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "set": {
            "id": str(tset.id), "name": tset.name, "kind": tset.kind,
            "counts": tset.counts,
        } if tset else None,
    }
    if full:
        got["params"] = run.params
        got["summary"] = run.summary
        got["confusion"] = run.confusion
        got["curves"] = run.curves
        got["per_class"] = run.per_class
    return got


@bp.get("/api/projects/<code>/runs")
def list_runs(code):
    db, project, user, err = _resolve(code)
    if err:
        return err
    try:
        rows = db.execute(
            select(TrainRun).where(TrainRun.project_id == project.id)
            .order_by(TrainRun.created_at.desc())
        ).scalars().all()
        return jsonify({
            "runs": [_run_view(db, r) for r in rows],
            "role": role_in(db, user, project),
        })
    finally:
        db.close()


@bp.post("/api/projects/<code>/runs")
def start_run(code):
    db, project, user, err = _resolve(code, "editor")
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        tset = db.get(TrainSet, _uuid(data.get("set_id")))
        if tset is None or tset.project_id != project.id:
            return jsonify({"error": "Обучающий набор не найден."}), 404
        if tset.status != "ready":
            return jsonify({
                "error": "Набор ещё не собран — учиться пока не на чем."
            }), 409

        task = trainer.TASK_OF_KIND.get(tset.kind, "detect")
        model_id = data.get("model") or (
            "yolo11s-seg" if task == "segment" else "yolo11s"
        )
        known = {m["id"]: m for m in trainer.BUILTIN_MODELS}
        custom = {m["id"]: m for m in (load_json(config.MODELS_FILE, []) or [])}
        model = known.get(model_id) or custom.get(model_id)
        if model is None:
            return jsonify({"error": "Такой модели нет."}), 404
        if (model.get("task") or "detect") != task:
            return jsonify({
                "error": (
                    f"Набор размечен как «{tset.kind}», а модель решает другую "
                    "задачу. Выберите модель под этот вид разметки."
                )
            }), 400

        params = trainer.filter_params(data.get("params") or {})
        for key in ("epochs", "imgsz", "batch", "patience"):
            params.setdefault(key, trainer.PARAM_SPEC[key]["default"])

        # Набор из графа уже аугментирован на диске — встроенные аугментации
        # YOLO к нему не применяются, что бы ни пришло в запросе. Режим
        # записывается в параметры, чтобы на странице обучения было видно,
        # почему ручек аугментаций там нет.
        has_graph = bool(tset.graph_version_id or tset.val_graph_version_id)
        if has_graph:
            params = {k: v for k, v in params.items()
                      if k not in trainer.AUG_KEYS}
            params["augment_mode"] = "graph"
        else:
            params.setdefault("augment_mode", "yolo")

        # Предобученные веса — умолчание; «с нуля» — только по явной галочке,
        # и только у встроенных моделей: у своих описания сети нет.
        pretrained = params.get("pretrained", True)
        if pretrained or not model.get("scratch"):
            spec = model.get("path") or model.get("spec")
        else:
            spec = model["scratch"]
        params["pretrained"] = bool(pretrained)

        name = (data.get("name") or f"{tset.name} · {model_id}").strip()
        run = TrainRun(
            project_id=project.id, set_id=tset.id, name=name[:255],
            base_model=model_id, task=task,
            base_weights_path=spec,
            params=params, device="cpu", status="queued",
            epochs=int(params["epochs"]), created_by=user.id,
        )
        db.add(run)
        db.commit()
        live.notify(db, "run", run.id, project.id, s="queued")
        return jsonify(_run_view(db, run)), 202
    finally:
        db.close()


@bp.get("/api/projects/<code>/runs/<run_id>")
def get_run(code, run_id):
    db, project, user, err = _resolve(code)
    if err:
        return err
    try:
        run = db.get(TrainRun, _uuid(run_id))
        if run is None or run.project_id != project.id:
            return jsonify({"error": "Обучение не найдено."}), 404
        return jsonify(_run_view(db, run, full=True))
    finally:
        db.close()


@bp.get("/api/projects/<code>/runs/<run_id>/epochs")
def run_epochs(code, run_id):
    db, project, user, err = _resolve(code)
    if err:
        return err
    try:
        run = db.get(TrainRun, _uuid(run_id))
        if run is None or run.project_id != project.id:
            return jsonify({"error": "Обучение не найдено."}), 404
        since = request.args.get("since", type=int) or 0
        rows = db.execute(
            select(TrainEpoch).where(
                TrainEpoch.run_id == run.id, TrainEpoch.epoch > since
            ).order_by(TrainEpoch.epoch)
        ).scalars().all()
        return jsonify({"epochs": [
            {"epoch": r.epoch, "metrics": r.metrics, "seconds": r.seconds}
            for r in rows
        ]})
    finally:
        db.close()


@bp.post("/api/projects/<code>/runs/<run_id>/stop")
def stop_run(code, run_id):
    db, project, user, err = _resolve(code, "editor")
    if err:
        return err
    try:
        run = db.get(TrainRun, _uuid(run_id))
        if run is None or run.project_id != project.id:
            return jsonify({"error": "Обучение не найдено."}), 404
        if run.status in ("done", "error", "stopped"):
            return jsonify({"ok": True, "status": run.status})
        run.cancel_requested = True
        if run.status in ("queued", "waiting_gpu"):
            # Ещё не начали — снимаем сразу и отпускаем бронь.
            run.status = "stopped"
            run.finished_at = utcnow()
            if run.gpu_lease_id:
                gpu.cancel(db, run.gpu_lease_id, "Снято автором")
        db.commit()
        live.notify(db, "run", run.id, project.id, s=run.status)
        return jsonify({"ok": True, "status": run.status})
    finally:
        db.close()


@bp.delete("/api/projects/<code>/runs/<run_id>")
def delete_run(code, run_id):
    db, project, user, err = _resolve(code, "editor")
    if err:
        return err
    try:
        run = db.get(TrainRun, _uuid(run_id))
        if run is None or run.project_id != project.id:
            return jsonify({"error": "Обучение не найдено."}), 404
        if run.status in ("running", "preparing", "stopping"):
            return jsonify({
                "error": "Обучение ещё идёт. Сперва остановите его."
            }), 409
        import shutil

        shutil.rmtree(config.run_dir(project.id, run.id), ignore_errors=True)
        db.delete(run)
        db.commit()
        return jsonify({"ok": True})
    finally:
        db.close()


@bp.get("/api/projects/<code>/runs/<run_id>/weights")
def run_weights(code, run_id):
    db, project, user, err = _resolve(code)
    if err:
        return err
    try:
        run = db.get(TrainRun, _uuid(run_id))
        if run is None or run.project_id != project.id or not run.weights_path:
            return jsonify({"error": "Весов нет."}), 404
        path = os.path.join(config.DATA_DIR, run.weights_path)
        if not os.path.isfile(path):
            return jsonify({"error": "Файл весов пропал с тома."}), 404
        return send_file(
            path, mimetype="application/octet-stream", as_attachment=True,
            download_name=f"{run.name}.pt".replace("/", "-"),
        )
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Живая связь
# --------------------------------------------------------------------------- #
@bp.get("/api/projects/<code>/stream")
def stream(code):
    """Одно соединение на вкладку.

    Мест конечное число: поток gunicorn занят на всё время висящего ответа, и
    раздать больше, чем есть потоков, нельзя никаким ростом. Кончились — не
    молчим и не рвём соединение без объяснения, а отвечаем 503 и говорим
    клиенту перейти на опрос. Он так и делает, и пишет об этом человеку.
    """
    db, project, user, err = _resolve(code)
    if err:
        return err
    project_id = str(project.id)
    db.close()

    if not live.SLOTS.take():
        got = live.SLOTS.view()
        return jsonify({
            "error": (
                f"Живая связь занята: {got['used']} из {got['hard']} мест. "
                "Обновляю опросом."
            ),
            "fallback": "poll",
            "slots": got,
        }), 503, {"Retry-After": "5"}

    sub = live.LISTENER.subscribe(project_id)

    def body():
        try:
            yield from live.sse(sub)
        finally:
            live.LISTENER.unsubscribe(sub)
            live.SLOTS.give()

    return Response(
        body(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@bp.get("/api/projects/<code>/live")
def live_poll(code):
    """Запасной путь, когда мест живой связи не осталось.

    Одна ручка на весь раздел: страница спрашивает раз в полторы секунды и
    получает всё, что видит, — а не по запросу на каждое обучение.
    """
    db, project, user, err = _resolve(code)
    if err:
        return err
    try:
        runs = db.execute(
            select(TrainRun).where(
                TrainRun.project_id == project.id,
                TrainRun.status.in_((
                    "queued", "waiting_gpu", "preparing", "running", "stopping"
                )),
            ).order_by(TrainRun.created_at.desc())
        ).scalars().all()
        return jsonify({
            "runs": [_run_view(db, r) for r in runs],
            "queue": gpu.queue_view(db, user_id=user.id,
                                    staff=bool(user.is_staff)),
            "at": utcnow().isoformat(),
        })
    finally:
        db.close()


@bp.get("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "service": "training",
        "ultralytics": trainer.is_available(),
        "live": live.SLOTS.view(),
    })
