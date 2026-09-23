"""Ручки агентов разметки: полка весов, окно запуска, прогоны.

Сам граф агента — в `dataprep`, вместе с графами аугментаций (общий черновик
и версии). Здесь то, что требует ultralytics и видеокарты: разбор весов и
очередь прогонов для `training-worker`.

Агент принадлежит человеку: полку, агентов и сопоставление классов видит и
запускает только владелец. Запуск — в тех тасках, где он и так может
размечать: исполнитель или администратор проекта.
"""
import hashlib
import os
import time
import uuid
from datetime import timedelta

from flask import Blueprint, jsonify, request
from sqlalchemy import func, select, text
from sqlalchemy import tuple_ as sa_tuple
from sqlalchemy.exc import IntegrityError

from common import agent_graph, config, live, task_frames
from common.auth import current_user, has_role, role_in
from common.db import SessionLocal
from common.models import (
    AgentClassMap, AgentPreview, AgentRun, AgentWeights, Annotation, AugGraph, AugGraphVersion, Image,
    LabelClass, Project, ProjectMember, Task, TaskVideo, TrainRun, VideoScout, utcnow,
)
from training_svc import agent_preview as agent_preview_lib, pt_guard

bp = Blueprint("agents", __name__)

SHELF = os.path.join(config.DATA_DIR, "_weights", "users")
CHUNK = 1 << 20
# Потолок одного файла весов. Самый крупный yolo11x — около 110 МБ; гигабайт
# с запасом, а больше — почти наверняка не тот файл.
MAX_WEIGHTS_BYTES = 1 << 30
ACTIVE = ("queued", "waiting_gpu", "running")


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


# --------------------------------------------------------------------------- #
# Полка весов
# --------------------------------------------------------------------------- #
def _weights_view(row, runs=None):
    run = (runs or {}).get(row.source_run_id)
    return {
        "id": str(row.id),
        "name": row.name,
        "task": row.task,
        "imgsz": row.imgsz,
        "names": row.names,
        "size_bytes": row.size_bytes,
        "created_at": row.created_at.isoformat(),
        "run": {"id": str(run.id), "name": run.name} if run else None,
    }


def _inspect(path):
    """Имена классов, задача и размер входа — с проверенного файла.

    Сперва холостое чтение (`pt_guard`): открыть чужой pickle напрямую значит
    выполнить чужой код. Потом ultralytics на процессоре — только чтобы
    прочитать паспорт, ни одного кадра он здесь не видит.
    """
    pt_guard.check(path)
    from ultralytics import YOLO

    # Временный файл кончается на .pt нарочно: формат ultralytics узнаёт по
    # расширению. Имена — у самой сети: `model.names` поднял бы предсказатель.
    model = YOLO(path)
    names = model.model.names
    names = names if isinstance(names, dict) else dict(enumerate(names))
    count = (max(names) + 1) if names else 0
    listed = [str(names.get(i, i)) for i in range(count)]
    args = (getattr(model, "ckpt", None) or {}).get("train_args") or {}
    imgsz = args.get("imgsz") if isinstance(args, dict) else getattr(args, "imgsz", None)
    try:
        imgsz = int(imgsz) if imgsz else None
    except (TypeError, ValueError):
        imgsz = None
    return {"names": listed, "task": str(model.task or "detect"), "imgsz": imgsz}


def _shelve(db, user, tmp, sha, size, name, run_id=None):
    """Положить проверенный файл на полку. Одинаковый файл — одна строка."""
    same = db.execute(
        select(AgentWeights).where(AgentWeights.owner_id == user.id,
                                   AgentWeights.sha256 == sha)
    ).scalar_one_or_none()
    if same is not None:
        os.remove(tmp)
        return same, False
    try:
        info = _inspect(tmp)
    except Exception:
        os.remove(tmp)
        raise
    if not info["names"]:
        os.remove(tmp)
        raise ValueError("В весах нет ни одного класса.")
    final = os.path.join(SHELF, str(user.id), f"{sha}.pt")
    os.replace(tmp, final)
    row = AgentWeights(
        owner_id=user.id, name=name[:255], sha256=sha,
        file_path=os.path.relpath(final, config.DATA_DIR), size_bytes=size,
        task=info["task"], imgsz=info["imgsz"], names=info["names"],
        source_run_id=run_id, created_by=user.id,
    )
    db.add(row)
    db.commit()
    return row, True


@bp.get("/api/agents/weights")
def list_weights():
    db, user, err = _me()
    if err:
        return err
    try:
        rows = db.execute(
            select(AgentWeights).where(AgentWeights.owner_id == user.id)
            .order_by(AgentWeights.created_at.desc())
        ).scalars().all()
        run_ids = {r.source_run_id for r in rows if r.source_run_id}
        runs = {r.id: r for r in db.execute(
            select(TrainRun).where(TrainRun.id.in_(run_ids))).scalars()} if run_ids else {}
        return jsonify({"weights": [_weights_view(r, runs) for r in rows]})
    finally:
        db.close()


@bp.put("/api/agents/weights")
def upload_weights():
    """Загрузить `.pt` сырым телом запроса.

    Не multipart: тело пишется прямо в файл на томе и тут же считается
    отпечаток. Промежуточной копии, на которой одним запросом не доезжал
    архив импорта, здесь нет.
    """
    db, user, err = _me()
    if err:
        return err
    tmp = None
    try:
        name = os.path.basename(request.args.get("name") or "weights.pt")
        folder = os.path.join(SHELF, str(user.id))
        os.makedirs(folder, exist_ok=True)
        tmp = os.path.join(folder, f"_upload-{uuid.uuid4().hex}.pt")
        digest = hashlib.sha256()
        size = 0
        with open(tmp, "wb") as fh:
            while True:
                chunk = request.stream.read(CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_WEIGHTS_BYTES:
                    raise ValueError("Файл больше гигабайта — это не веса YOLO.")
                digest.update(chunk)
                fh.write(chunk)
        if size == 0:
            raise ValueError("Файл пустой.")
        row, fresh = _shelve(db, user, tmp, digest.hexdigest(), size, name)
        tmp = None
        return jsonify({**_weights_view(row), "fresh": fresh}), 201 if fresh else 200
    except pt_guard.UnsafeWeights as exc:
        return jsonify({"error": str(exc), "code": "unsafe"}), 400
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001 — ultralytics не открыл файл
        return jsonify({"error": f"Веса не открываются: {exc}"}), 400
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)
        db.close()


@bp.get("/api/agents/train-runs")
def trained_runs():
    """Готовые обучения в проектах, где у человека есть роль, — источник весов."""
    db, user, err = _me()
    if err:
        return err
    try:
        rows = db.execute(
            select(TrainRun, Project)
            .join(Project, Project.id == TrainRun.project_id)
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .where(ProjectMember.user_id == user.id, TrainRun.status == "done",
                   TrainRun.weights_path.isnot(None))
            .order_by(TrainRun.finished_at.desc())
            .limit(200)
        ).all()
        return jsonify({"runs": [
            {"id": str(r.id), "name": r.name, "project": p.name,
             "base_model": r.base_model, "task": r.task,
             "weights_bytes": r.weights_bytes,
             "finished_at": r.finished_at.isoformat() if r.finished_at else None}
            for r, p in rows
        ]})
    finally:
        db.close()


@bp.post("/api/agents/weights/from-run")
def weights_from_run():
    """Взять веса обучения на полку — жёсткой ссылкой, диск не тратится."""
    db, user, err = _me()
    if err:
        return err
    tmp = None
    try:
        run = db.get(TrainRun, _uuid((request.get_json(silent=True) or {}).get("run_id")))
        project = db.get(Project, run.project_id) if run else None
        if run is None or project is None or role_in(db, user, project) is None:
            return jsonify({"error": "Обучение не найдено."}), 404
        src = os.path.join(config.DATA_DIR, run.weights_path or "")
        if not run.weights_path or not os.path.isfile(src):
            return jsonify({"error": "У обучения нет файла весов."}), 409
        digest = hashlib.sha256()
        with open(src, "rb") as fh:
            for chunk in iter(lambda: fh.read(CHUNK), b""):
                digest.update(chunk)
        folder = os.path.join(SHELF, str(user.id))
        os.makedirs(folder, exist_ok=True)
        tmp = os.path.join(folder, f"_link-{uuid.uuid4().hex}.pt")
        try:
            os.link(src, tmp)
        except OSError:
            # Другой том или файловая система без ссылок — честная копия.
            import shutil
            shutil.copyfile(src, tmp)
        row, fresh = _shelve(db, user, tmp, digest.hexdigest(),
                             os.path.getsize(src), f"{run.name}.pt", run.id)
        tmp = None
        return jsonify({**_weights_view(row, {run.id: run}), "fresh": fresh}), 201 if fresh else 200
    except pt_guard.UnsafeWeights as exc:
        return jsonify({"error": str(exc), "code": "unsafe"}), 400
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001 — ultralytics не открыл файл
        return jsonify({"error": f"Веса не открываются: {exc}"}), 400
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)
        db.close()


@bp.delete("/api/agents/weights/<weights_id>")
def delete_weights(weights_id):
    db, user, err = _me()
    if err:
        return err
    try:
        row = db.get(AgentWeights, _uuid(weights_id))
        if row is None or row.owner_id != user.id:
            return jsonify({"error": "Весов нет."}), 404
        # Версия агента неизменна и ссылается на веса по номеру: убрать файл
        # значит сломать версию, по которой уже размечали.
        used = _used_by_versions(db, user, row.id)
        if used:
            return jsonify({"error": f"Веса нужны версиям агентов: {used}."}), 409
        path = os.path.join(config.DATA_DIR, row.file_path)
        db.delete(row)
        db.commit()
        if os.path.isfile(path):
            os.remove(path)
        return jsonify({"ok": True})
    finally:
        db.close()


def _used_by_versions(db, user, weights_id):
    # ponytail: перебор документов в питоне; у человека десятки версий, а не
    # тысячи. Станет много — JSONB-запрос по nodes[*].params.weights.
    wanted = str(weights_id)
    count = 0
    for doc, in db.execute(
        select(AugGraphVersion.doc)
        .join(AugGraph, AugGraph.id == AugGraphVersion.graph_id)
        .where(AugGraph.owner_id == user.id, AugGraph.kind == "agent")
    ):
        if any(n.get("type") == "net" and (n.get("params") or {}).get("weights") == wanted
               for n in (doc or {}).get("nodes") or []):
            count += 1
    return count


# --------------------------------------------------------------------------- #
# Запуск в таске
# --------------------------------------------------------------------------- #
def _task(db, user, task_id):
    """(task, project, ошибка). Запускать можно там, где можно размечать."""
    task = db.get(Task, _uuid(task_id))
    project = db.get(Project, task.project_id) if task else None
    if task is None or project is None:
        return None, None, (jsonify({"error": "Таска не найдена."}), 404)
    role = role_in(db, user, project)
    if not has_role(role, "viewer"):
        return None, None, (jsonify({"error": "Недостаточно прав в проекте."}), 403)
    return task, project, None


def _may_work(db, user, task, project):
    role = role_in(db, user, project)
    return has_role(role, "editor") and (role == "admin" or task.assignee_id == user.id)


def _run_view(db, run):
    version = db.get(AugGraphVersion, run.version_id) if run.version_id else None
    graph = db.get(AugGraph, run.graph_id) if run.graph_id else None
    return {
        "id": str(run.id),
        "status": run.status,
        "processed": run.processed,
        "total": run.total,
        "stats": run.stats or {},
        "error": run.error,
        "queue_reason": run.queue_reason,
        "agent": graph.name if graph else None,
        "version": version.version if version else None,
        "sources": run.params.get("sources") or [],
        "mode": run.params.get("mode") or "frames",
        "videos": run.params.get("videos") or [],
        "created_at": run.created_at.isoformat(),
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }


def _source_counts(db, task):
    out = {}
    for source in task_frames.SOURCES:
        clause = task_frames.source_clause(task.id, source)
        base = select(func.count(Image.id)).where(Image.task_id == task.id, clause)
        out[source] = {
            "new": db.execute(base.where(Image.task_status == "new")).scalar_one(),
            "agent": db.execute(base.where(task_frames.agent_pending())).scalar_one(),
        }
    return out


@bp.get("/api/agents/tasks/<task_id>")
def run_context(task_id):
    """Всё для окна «Разметить агентом» одним запросом."""
    db, user, err = _me()
    if err:
        return err
    try:
        task, project, err = _task(db, user, task_id)
        if err:
            return err
        agents = []
        for graph in db.execute(
            select(AugGraph).where(AugGraph.owner_id == user.id, AugGraph.kind == "agent",
                                   AugGraph.archived_at.is_(None))
            .order_by(AugGraph.name)
        ).scalars():
            versions = db.execute(
                select(AugGraphVersion).where(AugGraphVersion.graph_id == graph.id)
                .order_by(AugGraphVersion.version.desc())
            ).scalars().all()
            if not versions:
                continue
            agents.append({
                "id": str(graph.id), "name": graph.name,
                "head": str(graph.head_version_id) if graph.head_version_id else str(versions[0].id),
                "versions": [
                    {"id": str(v.id), "version": v.version,
                     "classes": (v.stats or {}).get("classes") or [],
                     "created_at": v.created_at.isoformat()}
                    for v in versions
                ],
            })
        maps = {
            str(m.graph_id): m.mapping
            for m in db.execute(
                select(AgentClassMap).where(AgentClassMap.project_id == project.id)
            ).scalars()
        }
        classes = [
            {"id": str(c.id), "class_index": c.class_index, "name": c.name, "color": c.color}
            for c in db.execute(
                select(LabelClass).where(LabelClass.project_id == project.id)
                .order_by(LabelClass.class_index)
            ).scalars()
        ]
        runs = db.execute(
            select(AgentRun).where(AgentRun.task_id == task.id)
            .order_by(AgentRun.created_at.desc()).limit(5)
        ).scalars().all()
        videos = [
            {"id": str(v.id), "file_name": v.file_name, "mode": v.mode,
             "closed": v.annotation_closed_at is not None,
             "frames": v.frame_count or (round(v.duration_ms / 1000 * v.fps) if v.duration_ms and v.fps else None)}
            for v in db.execute(
                select(TaskVideo).where(TaskVideo.task_id == task.id).order_by(TaskVideo.created_at)
            ).scalars()
        ]
        return jsonify({
            "agents": agents,
            "videos": videos,
            "classes": classes,
            "mappings": maps,
            "sources": _source_counts(db, task),
            "runs": [_run_view(db, r) for r in runs],
            "can_run": _may_work(db, user, task, project) and task.status != "closed",
        })
    finally:
        db.close()


@bp.post("/api/agents/tasks/<task_id>/runs")
def start_agent_run(task_id):
    db, user, err = _me()
    if err:
        return err
    try:
        task, project, err = _task(db, user, task_id)
        if err:
            return err
        if task.status == "closed":
            return jsonify({"error": "Таска закрыта."}), 409
        if not _may_work(db, user, task, project):
            return jsonify({"error": "Запускать агента можно в своей таске."}), 403
        data = request.get_json(silent=True) or {}
        graph = db.get(AugGraph, _uuid(data.get("graph_id")))
        if graph is None or graph.kind != "agent" or graph.owner_id != user.id:
            return jsonify({"error": "Агент не найден."}), 404
        version = db.get(AugGraphVersion, _uuid(data.get("version_id")))
        if version is None or version.graph_id != graph.id:
            return jsonify({"error": "Версия не от этого агента."}), 404
        mode = data.get("mode") or "frames"
        if mode not in ("frames", "annotate", "scout"):
            return jsonify({"error": "Неизвестный режим прогона."}), 400
        sources = [s for s in data.get("sources") or [] if s in task_frames.SOURCES]
        if mode == "frames" and not sources:
            return jsonify({"error": "Выберите, что размечать."}), 400
        videos = []
        if mode != "frames":
            # Разведка смотрит ролики обоих режимов; разметка — только
            # размечаемые и ещё не закрытые: у закрытого кадры уже в таске.
            for vid in data.get("videos") or []:
                video = db.get(TaskVideo, _uuid(vid))
                if video is None or video.task_id != task.id:
                    continue
                if mode == "annotate" and (video.mode != "annotate" or video.annotation_closed_at):
                    continue
                videos.append(str(video.id))
            if not videos:
                return jsonify({"error": "Выберите ролики." if mode == "scout" else
                                "Выберите размечаемые ролики с незакрытой разметкой."}), 400
        try:
            step = max(1, min(10000, int(data.get("step") or agent_graph.VIDEO_STEP)))
            gap = max(0.0, min(60.0, float(data.get("gap") if data.get("gap") is not None
                                           else agent_graph.SCOUT_GAP_S)))
        except (TypeError, ValueError):
            return jsonify({"error": "Шаг и допуск — числа."}), 400

        # Сопоставление: только классы этой версии и только классы проекта.
        agent_classes = (version.stats or {}).get("classes") or []
        project_classes = {
            str(c) for c in db.execute(
                select(LabelClass.id).where(LabelClass.project_id == project.id)
            ).scalars()
        }
        raw = data.get("mapping") or {}
        mapping = {}
        for name in agent_classes:
            target = raw.get(name)
            mapping[name] = target if target in project_classes else None
        # Разведке сопоставление не нужно: она хранит имена классов агента и в
        # разметку не пишет ничего.
        if mode != "scout" and not any(mapping.values()):
            return jsonify({"error": "Ни один класс агента не сопоставлен с классом проекта."}), 400

        total = None
        if mode == "frames":
            total = sum(
                db.execute(
                    select(func.count(Image.id)).where(
                        Image.task_id == task.id, Image.task_status == "new",
                        task_frames.source_clause(task.id, s))
                ).scalar_one()
                for s in sources
            )
            if not total:
                return jsonify({"error": "В выбранных блоках нет новых кадров."}), 400

        # Сопоставление помнится на пару «агент + проект»: в следующий раз
        # окно откроется уже заполненным. Старые ключи других версий не
        # теряются — у версии 2 мог быть класс, которого нет у версии 3.
        # Разведка сопоставления не спрашивает — и помнить ей нечего.
        saved = db.get(AgentClassMap, (graph.id, project.id))
        if mode != "scout" and saved is None:
            db.add(AgentClassMap(graph_id=graph.id, project_id=project.id, mapping=mapping))
        elif mode != "scout":
            saved.mapping = {**(saved.mapping or {}), **mapping}
        run = AgentRun(
            project_id=project.id, task_id=task.id, graph_id=graph.id,
            version_id=version.id,
            params={"mode": mode, "sources": sources, "videos": videos, "step": step,
                    "gap": gap, "mapping": mapping},
            total=total, created_by=user.id,
        )
        db.add(run)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return jsonify({"error": "По этой таске агент уже идёт."}), 409
        live.notify(db, "agent", run.id, project.id, s="queued")
        return jsonify(_run_view(db, run)), 202
    finally:
        db.close()


@bp.post("/api/agents/runs/<run_id>/stop")
def stop_agent_run(run_id):
    db, user, err = _me()
    if err:
        return err
    try:
        run = db.get(AgentRun, _uuid(run_id))
        project = db.get(Project, run.project_id) if run else None
        if run is None or project is None:
            return jsonify({"error": "Прогон не найден."}), 404
        if run.created_by != user.id and role_in(db, user, project) != "admin":
            return jsonify({"error": "Остановить может тот, кто запустил."}), 403
        if run.status in ACTIVE:
            run.cancel_requested = True
            if run.status == "queued":
                # Воркер его ещё не брал — снимать некому, снимаем сами.
                run.status = "stopped"
                run.finished_at = utcnow()
            db.commit()
            live.notify(db, "agent", run.id, project.id, s=run.status)
        return jsonify(_run_view(db, run))
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Превью агента в редакторе
#
# Считает `training-worker` (training_svc/agent_preview.py) — у него карта и
# тёплые модели. Здесь выбор кадра, ручная разметка кадра для сравнения и
# ожидание ответа воркера в строке `agent_previews`.
# --------------------------------------------------------------------------- #
PREVIEW_WAIT_S = 180   # первая загрузка SAM2 large с HuggingFace — минуты
PREVIEW_KEEP_MIN = 10


@bp.get("/api/agents/preview/projects")
def preview_projects():
    db, user, err = _me()
    if err:
        return err
    try:
        rows = db.execute(
            select(Project.code, Project.name, func.count(Image.id))
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .join(Image, Image.project_id == Project.id)
            .where(ProjectMember.user_id == user.id)
            .group_by(Project.id).order_by(Project.name)
        ).all()
        return jsonify({"projects": [{"code": c, "name": n, "images": k} for c, n, k in rows]})
    finally:
        db.close()


def _preview_frame(db, project, image_id, step):
    """Кадр проекта: тот же, соседний по имени файла или случайный."""
    in_project = select(Image).where(Image.project_id == project.id)
    current = db.execute(in_project.where(Image.id == _uuid(image_id))).scalars().first() \
        if image_id else None
    if current is not None and step in ("next", "prev"):
        key = (Image.file_name, Image.id)
        here = sa_tuple(*key)
        there = sa_tuple(current.file_name, current.id)
        q = in_project.where(here > there).order_by(*key) if step == "next" \
            else in_project.where(here < there).order_by(*(k.desc() for k in key))
        return db.execute(q.limit(1)).scalars().first() or current
    if current is not None and step == "same":
        return current
    return db.execute(in_project.order_by(func.random()).limit(1)).scalars().first()


@bp.post("/api/agents/preview")
def agent_preview():
    """Один кадр через черновик агента: вход и выход каждого узла."""
    db, user, err = _me()
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        graph = db.get(AugGraph, _uuid(data.get("graph_id")))
        if graph is None or graph.kind != "agent" or graph.owner_id != user.id:
            return jsonify({"error": "Агент не найден."}), 404
        doc = data.get("doc")
        shelf = {str(w.id): len(w.names or []) for w in db.execute(
            select(AgentWeights).where(AgentWeights.owner_id == user.id)).scalars()}
        try:
            agent_graph.check(doc, weights=shelf)
        except agent_graph.AgentGraphError as exc:
            return jsonify({"error": str(exc)}), 400

        project = db.execute(select(Project).where(Project.code == data.get("project"))).scalar_one_or_none()
        if project is None or not has_role(role_in(db, user, project), "viewer"):
            return jsonify({"error": "Проект не найден."}), 404
        image = _preview_frame(db, project, data.get("image_id"), data.get("step") or "same")
        if image is None:
            return jsonify({"error": "В проекте нет кадров."}), 404

        classes = {c.id: c for c in db.execute(
            select(LabelClass).where(LabelClass.project_id == project.id)).scalars()}
        human = [
            {"cls": classes[a.class_id].name, "color": classes[a.class_id].color,
             "type": a.ann_type, "geometry": a.geometry}
            for a in db.execute(select(Annotation).where(Annotation.image_id == image.id)).scalars()
            if a.class_id in classes and a.source != "model"
        ]

        db.execute(AgentPreview.__table__.delete().where(
            AgentPreview.created_at < utcnow() - timedelta(minutes=PREVIEW_KEEP_MIN)))
        row = AgentPreview(user_id=user.id, image_id=image.id, doc=doc)
        db.add(row)
        db.flush()
        db.execute(text(f"NOTIFY {agent_preview_lib.CHANNEL}"))
        db.commit()

        deadline = time.monotonic() + PREVIEW_WAIT_S
        while time.monotonic() < deadline:
            db.refresh(row)
            if row.status != "queued":
                break
            time.sleep(0.05)
        frame = {"id": str(image.id), "file_name": image.file_name,
                 "width": image.width, "height": image.height}
        if row.status == "superseded":
            return jsonify({"superseded": True}), 409
        if row.status == "queued":
            return jsonify({"error": "Воркер не ответил — он запущен?"}), 504
        if row.status == "error":
            return jsonify({"error": row.error, "image": frame, "human": human}), 422
        return jsonify({"image": frame, "human": human, **row.result})
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Разведка роликов: полосы на шкале, сводка, план нарезки
# --------------------------------------------------------------------------- #
@bp.get("/api/agents/tasks/<task_id>/scouts")
def task_scouts(task_id):
    """Последняя разведка каждого ролика таски: участки по классам агента.

    Покадровые находки не отдаём — шкале и плану нужны участки, а кадров у
    часового ролика тысячи."""
    db, user, err = _me()
    if err:
        return err
    try:
        task, _project, err = _task(db, user, task_id)
        if err:
            return err
        out = {}
        for scout, video in db.execute(
            select(VideoScout, TaskVideo).join(TaskVideo, TaskVideo.id == VideoScout.video_id)
            .where(TaskVideo.task_id == task.id)
        ).all():
            out[str(video.id)] = {
                "agent": scout.agent_name,
                "step": scout.step,
                "gap_s": scout.gap_s,
                "last_frame": scout.last_frame,
                "fps": video.fps,
                "segments": scout.segments,
                "created_at": scout.created_at.isoformat(),
            }
        return jsonify({"scouts": out})
    finally:
        db.close()
