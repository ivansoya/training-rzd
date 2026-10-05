"""Ручки обучения, железа и живой связи.

Всё тяжёлое отсюда ушло: обучение запускает воркер, взяв бронь у диспетчера.
Здесь остались список, состояние, остановка — и живая связь, ради которой
состояние и переехало в базу.
"""
import os
import uuid

from flask import Blueprint, Response, jsonify, request, send_file
from sqlalchemy import func, select

from common import config, gpu, live
from common.auth import current_user, has_role, may_manage, project_by_code, role_in
from common.db import SessionLocal
from common.models import (
    AugGraph, AugGraphVersion, GpuDevice, Project, TrainEpoch, TrainRun, TrainSet,
    TrainSetFeed, User, utcnow,
)
from common.web import InputError, int_field, json_body
from common.storage import load_json
from training_svc import metrics as metrics_lib, trainer

NOT_YOURS = "Удалять и останавливать чужое может администратор проекта."

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
        data = json_body()
        enabled = data.get("enabled")
        if enabled is not None and not isinstance(enabled, bool):
            raise InputError("enabled: ожидается да или нет.", "enabled")
        dev = gpu.set_limits(
            db, _uuid(device_id),
            reserved_mb=int_field(data, "reserved_mb", lo=0, hi=1 << 20,
                                  label="Запас памяти, МБ"),
            max_heavy=int_field(data, "max_heavy", lo=1, hi=64,
                                label="Тяжёлых задач"),
            enabled=enabled,
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
# Метрики карточек: по ним же разница с прошлым прогоном
KPI = ("metrics/mAP50(B)", "metrics/mAP50-95(B)",
       "metrics/precision(B)", "metrics/recall(B)")
SPARK = 40


def _num(v):
    return isinstance(v, (int, float)) and v == v


def _digest(db, runs):
    """Лучшая эпоха, её метрики и ряд mAP50 — одним запросом на весь список.

    Лучшую эпоху бегун до 01.10.2026 не записывал (искал ключ ``fitness``,
    которого у ultralytics в метриках нет) — досчитываем по строкам эпох.
    """
    if not runs:
        return {}
    rows, secs = {}, {}
    for row in db.execute(
        select(TrainEpoch.run_id, TrainEpoch.epoch, TrainEpoch.metrics, TrainEpoch.seconds)
        .where(TrainEpoch.run_id.in_([r.id for r in runs]))
    ):
        rows.setdefault(row.run_id, []).append((row.epoch, row.metrics or {}))
        secs[row.run_id] = secs.get(row.run_id, 0.0) + (row.seconds or 0.0)
    out = {}
    for run in runs:
        done = (run.summary or {}).get("epochs_done")
        last = min(int(done), run.epochs) if done else run.epochs
        got = sorted((r for r in rows.get(run.id, []) if r[0] <= last), key=lambda r: r[0])
        best = (run.best_epoch, run.best_fitness)
        if best[0] is None:
            best = metrics_lib.best_of(got, run.task, last)
        at = dict(got).get(best[0], {}) if best[0] else {}
        series = [round(float(m[KPI[0]]), 4) for _, m in got if _num(m.get(KPI[0]))]
        if len(series) > SPARK:
            step = len(series) / SPARK
            series = [series[int(i * step)] for i in range(SPARK - 1)] + [series[-1]]
        out[run.id] = {
            "done": max((e for e, _ in got), default=0),
            # Чистое время эпох: у продолженного «конец − начало» включало бы паузу
            "seconds": round(secs.get(run.id, 0.0)),
            "best": best,
            "metrics": {k: float(at[k]) for k in KPI if _num(at.get(k))},
            "spark": series,
        }
    return out


def _graphs(db, set_ids):
    """Графы обучающей половины каждого набора: имя и версия, без повторов."""
    out = {}
    ids = [i for i in set_ids if i]
    if not ids:
        return out
    for row in db.execute(
        select(TrainSetFeed.set_id, AugGraph.id, AugGraph.name, AugGraphVersion.version)
        .join(AugGraphVersion, AugGraphVersion.id == TrainSetFeed.graph_version_id)
        .join(AugGraph, AugGraph.id == AugGraphVersion.graph_id)
        .where(TrainSetFeed.set_id.in_(ids), TrainSetFeed.part == "train")
        .order_by(TrainSetFeed.position)
    ):
        have = out.setdefault(row.set_id, [])
        item = {"id": str(row.id), "name": row.name, "version": row.version}
        if item not in have:
            have.append(item)
    return out


WAITING = ("queued", "waiting_gpu", "preparing")


def _find(db, project, run_id):
    """Прогон по номеру в проекте или по uuid."""
    if str(run_id).isdigit():
        return db.execute(select(TrainRun).where(
            TrainRun.project_id == project.id, TrainRun.number == int(run_id)
        )).scalar_one_or_none()
    run = db.get(TrainRun, _uuid(run_id))
    return run if run is not None and run.project_id == project.id else None


def _resumable(run, done):
    """Почему нельзя продолжить, или None — можно. done — законченных эпох."""
    if run.status not in ("stopped", "error"):
        return "Продолжить можно только остановленное или упавшее обучение."
    if run.set_id is None:
        return "Набор удалён — учиться не на чем."
    if done >= run.epochs:
        return "Все эпохи уже пройдены."
    if not os.path.isfile(trainer.last_checkpoint(run)):
        return "Ни одна эпоха не закончилась — продолжать не с чего."
    return None


def _queue_reason(db, run):
    """Почему ран «в очереди»: какой он по счёту и чей прогон впереди."""
    if run.status != "queued":
        return None
    ahead = db.execute(
        select(TrainRun).where(
            TrainRun.status.in_(("queued", "waiting_gpu", "preparing", "running", "stopping")),
            TrainRun.queued_at < run.queued_at,
        ).order_by(TrainRun.queued_at)
    ).scalars().all()
    if not ahead:
        return "Ждёт свободного исполнителя — начнётся через несколько секунд."
    busy = next((r for r in ahead if r.status in ("running", "preparing", "stopping")), ahead[0])
    return f"В очереди {len(ahead) + 1}-м: впереди обучение «{busy.name}»."


def _run_view(db, run, *, full=False, digest=None, graphs=None):
    # Набор могли удалить: обучение живёт дальше, с весами и метриками.
    tset = db.get(TrainSet, run.set_id) if run.set_id else None
    dig = (digest if digest is not None else _digest(db, [run])).get(run.id) or {}
    best_epoch, best_fitness = dig.get("best") or (None, None)
    if graphs is None:
        graphs = _graphs(db, [run.set_id])
    author = db.get(User, run.created_by) if run.created_by else None
    got = {
        "id": str(run.id),
        "number": run.number,
        "name": run.name,
        "status": run.status,
        "queue_reason": run.queue_reason or _queue_reason(db, run),
        "task": run.task,
        "base_model": run.base_model,
        "imgsz": (run.params or {}).get("imgsz"),
        # До старта устройство не выбрано: «cpu» в колонке — заглушка, а не решение.
        "device": None if run.status in WAITING else run.device,
        "epochs": run.epochs,
        "current_epoch": run.current_epoch,
        "phase": run.phase,
        "current_batch": run.current_batch,
        "total_batches": run.total_batches,
        "val_batch": run.val_batch,
        "val_total": run.val_total,
        "batch_metrics": run.batch_metrics,
        "best_epoch": best_epoch,
        "best_fitness": best_fitness,
        "best_metrics": dig.get("metrics") or {},
        "spark": dig.get("spark") or [],
        "train_seconds": dig.get("seconds") or 0,
        "peak_vram_mb": run.peak_vram_mb,
        "has_weights": bool(run.weights_path),
        "weights_bytes": run.weights_bytes,
        "error": run.error,
        "author": author.display_name if author else None,
        "created_at": run.created_at.isoformat(),
        "queued_at": run.queued_at.isoformat() if run.queued_at else None,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "resumable": _resumable(run, dig.get("done", 0)) is None,
        "set": {
            "id": str(tset.id), "name": tset.name, "kind": tset.kind,
            "counts": tset.counts,
            "graphs": graphs.get(tset.id, []),
        } if tset else None,
    }
    if full:
        got["params"] = run.params
        got["summary"] = run.summary
        got["confusion"] = run.confusion
        got["curves"] = run.curves
        got["per_class"] = run.per_class
        got["previous"] = _previous(db, run)
    return got


def _next_number(db, project):
    """Следующий номер прогона; строка проекта под замком — два запуска разом не возьмут один."""
    db.execute(select(Project.id).where(Project.id == project.id).with_for_update())
    top = db.execute(select(func.max(TrainRun.number)).where(
        TrainRun.project_id == project.id)).scalar()
    return (top or 0) + 1


def _previous(db, run):
    """Прошлый законченный прогон на том же наборе — для разницы метрик."""
    if run.set_id is None:
        return None
    prev = db.execute(
        select(TrainRun).where(
            TrainRun.set_id == run.set_id, TrainRun.status == "done",
            TrainRun.created_at < run.created_at,
        ).order_by(TrainRun.created_at.desc()).limit(1)
    ).scalar_one_or_none()
    if prev is None:
        return None
    dig = _digest(db, [prev]).get(prev.id) or {}
    return {"id": str(prev.id), "number": prev.number, "name": prev.name,
            "best_metrics": dig.get("metrics") or {}}


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
        digest = _digest(db, rows)
        graphs = _graphs(db, {r.set_id for r in rows})
        return jsonify({
            "runs": [_run_view(db, r, digest=digest, graphs=graphs) for r in rows],
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
        has_graph = db.query(TrainSetFeed.id).filter(
            TrainSetFeed.set_id == tset.id,
            TrainSetFeed.graph_version_id.isnot(None),
        ).first() is not None
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
            project_id=project.id, number=_next_number(db, project),
            set_id=tset.id, name=name[:255],
            queued_at=utcnow(),
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
        run = _find(db, project, run_id)
        if run is None:
            return jsonify({"error": "Обучение не найдено."}), 404
        # Кнопки «Остановить» и «Удалить» — только тому, кому сервер их позволит.
        return jsonify({**_run_view(db, run, full=True),
                        "can_manage": may_manage(db, user, project, run)})
    finally:
        db.close()


@bp.get("/api/projects/<code>/runs/<run_id>/epochs")
def run_epochs(code, run_id):
    db, project, user, err = _resolve(code)
    if err:
        return err
    try:
        run = _find(db, project, run_id)
        if run is None:
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
        run = _find(db, project, run_id)
        if run is None:
            return jsonify({"error": "Обучение не найдено."}), 404
        if not may_manage(db, user, project, run):
            return jsonify({"error": NOT_YOURS}), 403
        if run.status in ("done", "error", "stopped"):
            return jsonify({"ok": True, "status": run.status})
        run.cancel_requested = True
        # Просьбу читает `watch_run` живого воркера. Если исполнитель молчит
        # дольше аренды (воркер перезапускали), читать её некому — ран
        # закрывается сразу, а не висит «останавливается» вечно.
        now = utcnow()
        if trainer.orphan_verdict(run.status, True, trainer.beat_of(run),
                                  now, gpu.LEASE_SECONDS):
            trainer.close_orphan(db, run, "stopped", now)
            return jsonify({"ok": True, "status": run.status})
        # Снимаем сразу всё, под чем ещё нет процесса обучения. Просьбу об
        # остановке читает только `watch_run`, а он появляется вместе с
        # процессом: пока `pid` пуст, флаг некому увидеть, и кнопка молчала бы
        # вечно. Особенно в `preparing` — там ран ждёт карту, `claim_run` его
        # уже не подберёт, и хозяина у него нет вовсе.
        if run.status in ("queued", "waiting_gpu") or run.pid is None:
            run.status = "stopped"
            run.finished_at = utcnow()
            if run.gpu_lease_id:
                gpu.cancel(db, run.gpu_lease_id, "Снято автором")
        db.commit()
        live.notify(db, "run", run.id, project.id, s=run.status)
        return jsonify({"ok": True, "status": run.status})
    finally:
        db.close()


@bp.post("/api/projects/<code>/runs/<run_id>/resume")
def resume_run(code, run_id):
    """Продолжить остановленное или упавшее обучение с last.pt — в конец очереди."""
    db, project, user, err = _resolve(code, "editor")
    if err:
        return err
    try:
        run = _find(db, project, run_id)
        if run is None:
            return jsonify({"error": "Обучение не найдено."}), 404
        if not may_manage(db, user, project, run):
            return jsonify({"error": NOT_YOURS}), 403
        dig = _digest(db, [run]).get(run.id) or {}
        why = _resumable(run, dig.get("done", 0))
        if why:
            return jsonify({"error": why}), 409
        run.status = "queued"
        run.queued_at = utcnow()
        run.cancel_requested = False
        run.error = None
        run.queue_reason = None
        run.finished_at = None
        run.phase = None
        run.pid = None
        run.worker_id = None
        run.gpu_lease_id = None
        run.current_batch = 0
        run.total_batches = None
        run.val_batch = 0
        run.val_total = None
        run.batch_metrics = None
        db.commit()
        live.notify(db, "run", run.id, project.id, s="queued")
        return jsonify(_run_view(db, run)), 202
    finally:
        db.close()


@bp.delete("/api/projects/<code>/runs/<run_id>")
def delete_run(code, run_id):
    db, project, user, err = _resolve(code, "editor")
    if err:
        return err
    try:
        run = _find(db, project, run_id)
        if run is None:
            return jsonify({"error": "Обучение не найдено."}), 404
        if not may_manage(db, user, project, run):
            return jsonify({"error": NOT_YOURS}), 403
        if run.status in ("running", "preparing", "stopping"):
            return jsonify({
                "error": "Обучение ещё идёт. Сперва остановите его."
            }), 409
        import shutil

        # Из очереди: бронь карты снимаем, иначе она висела бы без хозяина.
        if run.gpu_lease_id:
            gpu.cancel(db, run.gpu_lease_id, "Обучение удалено")
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
        run = _find(db, project, run_id)
        if run is None or not run.weights_path:
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
