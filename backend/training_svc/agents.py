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
import random
import time
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace

from flask import Blueprint, Response, jsonify, request, send_file
from sqlalchemy import func, select, text
from sqlalchemy import tuple_ as sa_tuple
from sqlalchemy.exc import IntegrityError

from common import (
    agent_access, agent_graph, agent_memory, attribution, config, frame_sizes, gpu, live, settings, shapes,
    task_frames,
)
from common import scout as scout_lib
from common.auth import current_user, has_role, project_by_code, role_in
from common.db import SessionLocal
from common.models import (
    AgentApply, AgentClassMap, AgentExamples, AgentPreview, AgentRun, AgentWeights, Annotation, AugGraph,
    AugGraphVersion, Dataset, GpuDevice, GpuLease, GpuUsageHint, Image, LabelClass, Project, ProjectAugGraph,
    ProjectMember, Task, TaskVideo, TrainRun, User, VideoAnnotation, VideoScout, utcnow,
)
from common.web import int_field, json_body, public_error
from common import agent_examples as ax
from training_svc import agent_preview as agent_preview_lib, agent_runner, examples as examples_lib, pt_guard

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
        # Лежат ли веса SAM 3 — редактору: без них «Сеть по тексту» с SAM 3
        # версию не сохранит, и узел должен сказать это сразу.
        return jsonify({"weights": [_weights_view(r, runs) for r in rows],
                        "sam3": config.sam3_ready()})
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
        return jsonify({"error": public_error(
            exc, "Веса не открываются: это не модель YOLO или файл повреждён.")}), 400
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
        return jsonify({"error": public_error(
            exc, "Веса не открываются: это не модель YOLO или файл повреждён.")}), 400
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
        # значит сломать версию, по которой уже размечали. Черновик — тоже:
        # без весов он не сохранится версией и не покажет превью, а человек
        # узнал бы об этом только там.
        used = _agents_using(db, user, row.id)
        if used:
            return jsonify({"error": "Веса нужны агентам: " + ", ".join(f"«{n}»" for n in used) + "."}), 409
        path = os.path.join(config.DATA_DIR, row.file_path)
        db.delete(row)
        db.commit()
        if os.path.isfile(path):
            os.remove(path)
        return jsonify({"ok": True})
    finally:
        db.close()


def _agents_using(db, user, weights_id):
    """Имена агентов человека, у которых веса стоят в версии или черновике."""
    # ponytail: перебор документов в питоне; у человека десятки версий, а не
    # тысячи. Станет много — JSONB-запрос по nodes[*].params.weights.
    wanted = str(weights_id)

    def uses(doc):
        return any(n.get("type") == "net" and (n.get("params") or {}).get("weights") == wanted
                   for n in (doc or {}).get("nodes") or [])

    names = {g.name for g in db.execute(
        select(AugGraph).where(AugGraph.owner_id == user.id, AugGraph.kind == "agent")).scalars()
        if uses(g.draft)}
    names |= {name for name, doc in db.execute(
        select(AugGraph.name, AugGraphVersion.doc)
        .join(AugGraph, AugGraph.id == AugGraphVersion.graph_id)
        .where(AugGraph.owner_id == user.id, AugGraph.kind == "agent")) if uses(doc)}
    return sorted(names)


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


def _queue_reason(db, run):
    """«В очереди» без слов не объясняет ничего: какой по счёту и кого ждёт."""
    if run.status != "queued":
        return None
    ahead = db.execute(
        select(AgentRun).where(
            AgentRun.status.in_(("queued", "waiting_gpu", "running")),
            AgentRun.created_at < run.created_at,
        ).order_by(AgentRun.created_at)
    ).scalars().all()
    if not ahead:
        return "Ждёт свободного исполнителя — начнётся через несколько секунд."
    busy = next((r for r in ahead if r.status == "running"), ahead[0])
    graph = db.get(AugGraph, busy.graph_id) if busy.graph_id else None
    left = (busy.total or 0) - (busy.processed or 0)
    tail = f", осталось кадров: {left}" if busy.total else ""
    return f"В очереди {len(ahead) + 1}-м: идёт прогон «{graph.name if graph else 'агента'}»{tail}."


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
        "queue_reason": run.queue_reason or _queue_reason(db, run),
        "agent": graph.name if graph else None,
        "version": version.version if version else None,
        "sources": run.params.get("sources") or [],
        "mode": run.params.get("mode") or "frames",
        "videos": run.params.get("videos") or [],
        "created_at": run.created_at.isoformat(),
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }


def _frame_sources(db, task):
    """Блоки кадров таски: файлы, нарезка и кадры каждого закрытого размечаемого ролика."""
    own = db.execute(
        select(TaskVideo.id).where(TaskVideo.task_id == task.id, TaskVideo.mode == "annotate",
                                   TaskVideo.id.in_(select(Image.source_video_id).where(Image.task_id == task.id)))
    ).scalars().all()
    return [*task_frames.SOURCES, *(str(v) for v in own)]


def _source_counts(db, task):
    out = {}
    for source in _frame_sources(db, task):
        clause = task_frames.source_clause(task.id, source)
        base = select(func.count(Image.id)).where(Image.task_id == task.id, clause)
        out[source] = {
            "new": db.execute(base.where(Image.task_status == "new")).scalar_one(),
            # Новые кадры, чьё непроверенное прогон заменит.
            "agent": db.execute(base.where(Image.task_status == "new",
                                           task_frames.has_pending())).scalar_one(),
        }
    return out


def _version_classes(db, version, project):
    """Используемые классы версии для окна запуска: [{id, name, color, ref,
    lock}]. У версий до списка классов в паспорте только имена — тогда классы
    берутся из документа. Ссылка показывает живое имя класса проекта, а в своём
    проекте ещё и `lock` — id класса, с которым она сопоставлена намертво."""
    got = (version.stats or {}).get("classes") or []
    if not got or not isinstance(got[0], dict):
        got = agent_graph.classes(version.doc)
    refs = {_uuid((c.get("ref") or {}).get("cls")) for c in got if c.get("ref")} - {None}
    live = {c.id: c for c in db.execute(select(LabelClass).where(LabelClass.id.in_(refs))).scalars()} if refs else {}
    out = []
    for c in got:
        row = {k: c.get(k) for k in ("id", "name", "color", "ref")}
        ref = c.get("ref") or {}
        hit = live.get(_uuid(ref.get("cls")))
        if hit is not None:
            row.update(name=hit.name, color=hit.color)
            if hit.project_id == project.id:
                row["lock"] = str(hit.id)
        out.append(row)
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
        cards = gpu.cards(db)
        # Две группы (решение 09.10.2026): подключённые к проекту — все, и свои
        # неподключённые. Свой агент к проекту сам не подключается.
        linked = set(db.execute(select(ProjectAugGraph.graph_id).where(
            ProjectAugGraph.project_id == project.id)).scalars())
        owners = {}
        for graph in db.execute(
            select(AugGraph).where(AugGraph.kind == "agent", AugGraph.archived_at.is_(None),
                                   (AugGraph.owner_id == user.id) | AugGraph.id.in_(linked or {None}))
            .order_by(AugGraph.name)
        ).scalars():
            versions = db.execute(
                select(AugGraphVersion).where(AugGraphVersion.graph_id == graph.id)
                .order_by(AugGraphVersion.version.desc())
            ).scalars().all()
            if not versions:
                continue
            head = next((v for v in versions if v.id == graph.head_version_id), versions[0])
            if graph.owner_id and graph.owner_id not in owners:
                got = db.get(User, graph.owner_id)
                owners[graph.owner_id] = got.display_name if got else None
            agents.append({
                "id": str(graph.id), "name": graph.name,
                "group": "project" if graph.id in linked else "mine",
                "mine": graph.owner_id == user.id,
                "owner": owners.get(graph.owner_id),
                "verdict": _verdict(db, head.doc, cards=cards)["verdict"],
                "head": str(head.id),
                "versions": [
                    {"id": str(v.id), "version": v.version,
                     "classes": _version_classes(db, v, project),
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
            "resources": {"cards": cards, "queued": gpu.queued_count(db)},
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
        if not agent_access.may_use(db, user, graph, project):
            return jsonify({"error": "Агент не найден."}), 404
        version = db.get(AugGraphVersion, _uuid(data.get("version_id")))
        if version is None or version.graph_id != graph.id:
            return jsonify({"error": "Версия не от этого агента."}), 404
        mode = data.get("mode") or "frames"
        if mode not in ("frames", "annotate", "scout"):
            return jsonify({"error": "Неизвестный режим прогона."}), 400
        known = _frame_sources(db, task)
        sources = [s for s in data.get("sources") or [] if s in known]
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
            step = max(1, min(10000, int(data.get("step", agent_graph.VIDEO_STEP))))
            gap = max(0.0, min(60.0, float(data.get("gap") if data.get("gap") is not None
                                           else agent_graph.SCOUT_GAP_S)))
        except (TypeError, ValueError):
            return jsonify({"error": "Шаг и допуск — числа."}), 400

        # Сопоставление приходит по id класса агента, а прогон пишет по имени:
        # имя в версии уникально, и разведка с разметкой видят его же. Ссылка
        # на класс этого проекта сопоставлена намертво, что бы ни прислали.
        project_classes = {
            str(c) for c in db.execute(
                select(LabelClass.id).where(LabelClass.project_id == project.id)
            ).scalars()
        }
        raw = data.get("mapping") or {}
        by_id, mapping = {}, {}
        for c in agent_graph.classes(version.doc):
            target = raw.get(c["id"], raw.get(c["name"]))
            ref = c.get("ref") or {}
            if ref.get("cls") in project_classes:
                target = ref["cls"]
            by_id[c["id"]] = mapping[c["name"]] = target if target in project_classes else None
        # Разведке сопоставление не нужно: она хранит имена классов агента и в
        # разметку не пишет ничего.
        if mode != "scout" and not any(mapping.values()):
            return jsonify({"error": "Ни один класс агента не сопоставлен с классом проекта."}), 400

        # Потолок тайлов сверяется на кадрах этого проекта: при сохранении
        # версии их могло ещё не быть. Полка — владельца агента.
        shelf = db.execute(select(AgentWeights).where(AgentWeights.owner_id == graph.owner_id)).scalars().all()
        try:
            agent_graph.check(agent_graph.prepare(version.doc), clamp=True, frame=frame_sizes.largest(db, [project.id]),
                              inputs={str(w.id): w.imgsz for w in shelf})
        except agent_graph.AgentGraphError as exc:
            return jsonify({"error": str(exc)}), 400
        verdict = _verdict(db, version.doc, scout=mode == "scout")["verdict"]
        if verdict["state"] == agent_memory.NEVER:
            return jsonify({"error": verdict["reason"], "verdict": verdict}), 409

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
        # Помнится по id класса агента: переименование класса его не сбрасывает.
        saved = db.get(AgentClassMap, (graph.id, project.id))
        if mode != "scout" and saved is None:
            db.add(AgentClassMap(graph_id=graph.id, project_id=project.id, mapping=by_id))
        elif mode != "scout":
            saved.mapping = {**(saved.mapping or {}), **by_id}
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
            select(Project.id, Project.code, Project.name, func.count(Image.id))
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .join(Image, Image.project_id == Project.id)
            .where(ProjectMember.user_id == user.id)
            .group_by(Project.id).order_by(Project.name)
        ).all()
        # Размер кадра — для итога тайлинга: сколько тайлов выйдет на кадр.
        frames = frame_sizes.of_projects(db, [r[0] for r in rows])
        return jsonify({"projects": [{"code": c, "name": n, "images": k, "frame": frames.get(pid)}
                                     for pid, c, n, k in rows]})
    finally:
        db.close()


@bp.get("/api/agents/class-sources")
def class_sources():
    """Проекты человека с их классами — для окна «Классы агента»: из них
    берут ссылки, по ним же ссылки показывают живые имя и цвет."""
    db, user, err = _me()
    if err:
        return err
    try:
        projects = db.execute(
            select(Project).join(ProjectMember, ProjectMember.project_id == Project.id)
            .where(ProjectMember.user_id == user.id).order_by(Project.name)
        ).scalars().all()
        by_project = {}
        for c in db.execute(select(LabelClass).where(LabelClass.project_id.in_([p.id for p in projects]))
                            .order_by(LabelClass.class_index)).scalars():
            by_project.setdefault(c.project_id, []).append(
                {"id": str(c.id), "name": c.name, "color": c.color, "class_index": c.class_index})
        return jsonify({"projects": [{"id": str(p.id), "code": p.code, "name": p.name,
                                      "classes": by_project.get(p.id, [])} for p in projects]})
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


def _preview_input(db, user, data):
    """Агент, черновик и проект превью. Возвращает (doc, project, ошибка)."""
    graph = db.get(AugGraph, _uuid(data.get("graph_id")))
    # Чужой агент из общего проекта смотрится только на чтение — но превью ему можно:
    # оно ничего не пишет. Полка весов и образцов — владельца.
    if not agent_access.may_view(db, user, graph):
        return None, None, (jsonify({"error": "Агент не найден."}), 404)
    doc = agent_graph.prepare(data.get("doc"))
    project = db.execute(select(Project).where(Project.code == data.get("project"))).scalar_one_or_none()
    if project is None or not has_role(role_in(db, user, project), "viewer"):
        return None, None, (jsonify({"error": "Проект не найден."}), 404)
    shelf = db.execute(select(AgentWeights).where(AgentWeights.owner_id == graph.owner_id)).scalars().all()
    try:
        agent_graph.check(doc, weights={str(w.id): len(w.names or []) for w in shelf}, sam3=config.sam3_ready(),
                          examples=examples_lib.readiness(db, graph.owner_id, doc),
                          frame=frame_sizes.largest(db, [project.id]), inputs={str(w.id): w.imgsz for w in shelf})
    except agent_graph.AgentGraphError as exc:
        return None, None, (jsonify({"error": str(exc)}), 400)
    doc["owner"] = _owner_of(graph)
    return doc, project, None


def _owner_of(graph):
    """Владелец агента для воркера превью: с его полки берутся веса и образцы."""
    return str(graph.owner_id) if graph.owner_id else None


def _human(db, project, image):
    """Ручная разметка кадра — для сравнения с агентом."""
    classes = {c.id: c for c in db.execute(
        select(LabelClass).where(LabelClass.project_id == project.id)).scalars()}
    return [
        {"cls": classes[a.class_id].name, "color": classes[a.class_id].color,
         "type": a.ann_type, "geometry": a.geometry}
        for a in db.execute(select(Annotation).where(Annotation.image_id == image.id)).scalars()
        if a.class_id in classes and not a.pending
    ]


def _frame(image):
    # Эталон для сверки — проверенная разметка: кадр в данных проекта (импорт тоже) или «размечен»/«пусто» в таске.
    # Новый, отложенный и брак не проверены: находки агента там не сравнить ни с чем.
    return {"id": str(image.id), "file_name": image.file_name, "width": image.width, "height": image.height,
            "status": image.task_status,
            "truth": image.dataset_id is not None or image.task_status in ("annotated", "empty")}


def _ask_worker(db, user, image, doc):
    """Положить запрос воркеру и дождаться ответа в той же строке. `image` пуст —
    кадр ролика, он в `doc.apply`."""
    db.execute(AgentPreview.__table__.delete().where(
        AgentPreview.created_at < utcnow() - timedelta(minutes=PREVIEW_KEEP_MIN)))
    row = AgentPreview(user_id=user.id, image_id=image.id if image is not None else None, doc=doc)
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
    return row


def _not_done(row, extra=None):
    """Ответ, если воркер не посчитал; None — посчитал."""
    if row.status == "superseded":
        return jsonify({"superseded": True}), 409
    if row.status == "waiting_gpu":
        # Процессора нет: ждём карту, человек видит причину и может повторить.
        return jsonify({"error": row.error, "code": "waiting_gpu", **(extra or {})}), 503
    if row.status == "queued":
        return jsonify({"error": "Воркер не ответил — он запущен?"}), 504
    if row.status == "error":
        return jsonify({"error": row.error, **(extra or {})}), 422
    return None


@bp.post("/api/agents/preview")
def agent_preview():
    """Один кадр через черновик агента: вход и выход каждого узла."""
    db, user, err = _me()
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        doc, project, err = _preview_input(db, user, data)
        if err:
            return err
        image = _preview_frame(db, project, data.get("image_id"), data.get("step") or "same")
        if image is None:
            return jsonify({"error": "В проекте нет кадров."}), 404
        human = _human(db, project, image)
        row = _ask_worker(db, user, image, doc)
        frame = _frame(image)
        bad = _not_done(row, {"image": frame, "human": human})
        if bad:
            return bad
        return jsonify({"image": frame, "human": human, **row.result})
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Агент на одном кадре из редактора (кнопка «Агент», G)
#
# Решение владельца (2026-10-07): тот же агент, что на блоке, но на текущем
# кадре и сразу — тёплыми моделями превью, а не очередью прогонов (там один
# прогон на таску, и кнопка стояла бы, пока агент идёт по блоку). Рамки встают
# на проверку тем же кодом, что у прогона: прежнее непроверенное кадра
# заменяется, повторы лежащих рамок отбрасываются.
# --------------------------------------------------------------------------- #
def _saved_mapping(db, graph, version, project):
    """Класс агента (имя) → id класса проекта: ссылкой или запомненным для пары
    «агент + проект». Новых сопоставлений здесь не спрашивают — это окно запуска."""
    project_classes = {str(c) for c in db.execute(
        select(LabelClass.id).where(LabelClass.project_id == project.id)).scalars()}
    saved = db.get(AgentClassMap, (graph.id, project.id))
    remembered = (saved.mapping or {}) if saved else {}
    out = {}
    for c in agent_graph.classes(version.doc):
        ref = (c.get("ref") or {}).get("cls")
        target = ref if ref in project_classes else remembered.get(c["id"], remembered.get(c["name"]))
        out[c["name"]] = target if target in project_classes else None
    return out


def _image_boxes(db, image):
    """Разметка кадра в виде редактора — ответ после агента, без второго запроса."""
    classes = {c.id: c for c in db.execute(
        select(LabelClass).where(LabelClass.project_id == image.project_id)).scalars()}
    anns = db.execute(select(Annotation).where(Annotation.image_id == image.id)).scalars().all()
    agents = attribution.agent_names(db, {a.agent_version_id for a in anns if a.agent_version_id})
    users = {u.id: u.display_name for u in db.execute(
        select(User).where(User.id.in_({a.created_by for a in anns if a.created_by}
                                       | {a.reviewed_by for a in anns if a.reviewed_by} or {None}))).scalars()}
    out = []
    for a in anns:
        wire = shapes.to_wire(a.ann_type, a.geometry)
        c = classes.get(a.class_id)
        if not wire or c is None:
            continue
        out.append({"id": str(a.id), **wire, "class_index": c.class_index, "name": c.name, "color": c.color,
                    "source": a.source, "pending": a.pending, "conf": (a.attributes or {}).get("conf"),
                    "author": users.get(a.created_by), "agent": agents.get(a.agent_version_id),
                    "reviewer": users.get(a.reviewed_by)})
    return out


@bp.put("/api/agents/tasks/<task_id>/mapping")
def save_mapping(task_id):
    """Окно «Агент таски»: сопоставление классов агента с классами проекта — без
    запуска. Помнится на пару «агент + проект», как при запуске; классы-ссылки
    на этот проект сопоставлены сами и сюда не пишутся."""
    db, user, err = _me()
    if err:
        return err
    try:
        task, project, err = _task(db, user, task_id)
        if err:
            return err
        data = request.get_json(silent=True) or {}
        graph = db.get(AugGraph, _uuid(data.get("graph_id")))
        if not agent_access.may_use(db, user, graph, project):
            return jsonify({"error": "Агент не найден."}), 404
        raw = data.get("mapping")
        if not isinstance(raw, dict):
            return jsonify({"error": "mapping: класс агента → класс проекта."}), 400
        project_classes = {str(c) for c in db.execute(
            select(LabelClass.id).where(LabelClass.project_id == project.id)).scalars()}
        clean = {str(k): (v if v in project_classes else None) for k, v in raw.items()}
        saved = db.get(AgentClassMap, (graph.id, project.id))
        if saved is None:
            saved = AgentClassMap(graph_id=graph.id, project_id=project.id, mapping=clean)
            db.add(saved)
        else:
            saved.mapping = {**(saved.mapping or {}), **clean}
        db.commit()
        return jsonify({"mapping": saved.mapping})
    finally:
        db.close()


@bp.post("/api/agents/tasks/<task_id>/apply")
def apply_agent(task_id):
    """Агент на одном кадре таски: `image_id` или `video_id` + `frame_no`."""
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
            return jsonify({"error": "Звать агента можно в своей таске."}), 403
        data = request.get_json(silent=True) or {}
        graph = db.get(AugGraph, _uuid(data.get("graph_id")))
        if not agent_access.may_use(db, user, graph, project):
            return jsonify({"error": "Агент не найден."}), 404
        version = db.get(AugGraphVersion, _uuid(data.get("version_id")))
        if version is None or version.graph_id != graph.id:
            return jsonify({"error": "Версия не от этого агента."}), 404
        mapping = _saved_mapping(db, graph, version, project)
        if not any(mapping.values()):
            return jsonify({"error": "Классы агента не сопоставлены с классами проекта — сопоставьте их в окне запуска.",
                            "code": "unmapped"}), 400

        image = video = None
        if data.get("image_id"):
            image = db.get(Image, _uuid(data["image_id"]))
            if image is None or image.task_id != task.id or image.task_status == "deleted":
                return jsonify({"error": "Кадр не найден в таске."}), 404
            target = {"image": str(image.id)}
        else:
            video = db.get(TaskVideo, _uuid(data.get("video_id")))
            if video is None or video.task_id != task.id or video.mode != "annotate":
                return jsonify({"error": "Ролик не найден в таске."}), 404
            if video.annotation_closed_at is not None:
                return jsonify({"error": "Разметка ролика закрыта."}), 409
            try:
                frame_no = int(data.get("frame_no"))
            except (TypeError, ValueError):
                return jsonify({"error": "frame_no: номер кадра."}), 400
            target = {"video": str(video.id), "frame": frame_no}

        shelf = db.execute(select(AgentWeights).where(AgentWeights.owner_id == graph.owner_id)).scalars().all()
        doc = agent_graph.prepare(version.doc)
        try:
            agent_graph.check(doc, clamp=True, frame=frame_sizes.largest(db, [project.id]),
                              inputs={str(w.id): w.imgsz for w in shelf})
        except agent_graph.AgentGraphError as exc:
            return jsonify({"error": str(exc)}), 400
        row = _ask_worker(db, user, image, {**doc, "apply": target, "owner": _owner_of(graph)})
        bad = _not_done(row)
        if bad:
            return bad
        found = row.result.get("found") or []
        db.add(AgentApply(graph_id=graph.id, project_id=project.id, user_id=user.id, boxes=len(found)))
        db.commit()
        # Автор рамок агента — его владелец, как у прогона
        owner = SimpleNamespace(version_id=version.id, created_by=graph.owner_id)
        if image is not None:
            put = agent_runner._write(db, owner, image, found, mapping)
            db.refresh(image)
            return jsonify({"put": put, "found": len(found), "boxes": _image_boxes(db, image),
                            "rev": image.annotations_rev, "task_status": image.task_status,
                            "ms": row.result.get("ms"), "device": row.result.get("device")})
        try:
            put = agent_runner._write_video(db, owner, video, target["frame"], found, mapping)
        except agent_runner.VideoClosed:
            return jsonify({"error": "Разметку ролика закрыли — агенту писать некуда."}), 409
        return jsonify({"put": put, "found": len(found), "ms": row.result.get("ms"),
                        "device": row.result.get("device")})
    finally:
        db.close()


PREVIEW_FRAMES_MAX = 12


@bp.post("/api/agents/preview/frames")
def agent_preview_frames():
    """«Выход» агента на нескольких случайных кадрах проекта одним прогоном моделей."""
    db, user, err = _me()
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        doc, project, err = _preview_input(db, user, data)
        if err:
            return err
        n = max(1, min(PREVIEW_FRAMES_MAX, int(data.get("count") or 6)))
        images = db.execute(select(Image).where(Image.project_id == project.id)
                            .order_by(func.random()).limit(n)).scalars().all()
        if not images:
            return jsonify({"error": "В проекте нет кадров."}), 404
        row = _ask_worker(db, user, images[0], {**doc, "batch": [str(i.id) for i in images]})
        bad = _not_done(row)
        if bad:
            return bad
        outs = {f["id"]: f["out"] for f in row.result["frames"]}
        frames = [{"image": _frame(i), "human": _human(db, project, i), "out": outs.get(str(i.id), [])}
                  for i in images]
        return jsonify({"frames": frames, "device": row.result["device"],
                        "sequential": row.result.get("sequential"), "ms": row.result["ms"]})
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
                "file_name": video.file_name,
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


@bp.get("/api/agents/tasks/<task_id>/scouts/<video_id>")
def task_scout(task_id, video_id):
    """Разведка одного ролика: числа, покадровые находки и их классы в проекте."""
    db, user, err = _me()
    if err:
        return err
    try:
        task, _project, err = _task(db, user, task_id)
        if err:
            return err
        video = db.get(TaskVideo, _uuid(video_id))
        if video is None or video.task_id != task.id:
            return jsonify({"error": "Ролик не найден в таске."}), 404
        scout = db.execute(select(VideoScout).where(VideoScout.video_id == video.id)).scalar_one_or_none()
        if scout is None:
            return jsonify({"error": "Этот ролик агент ещё не разведывал."}), 404
        version = db.get(AugGraphVersion, scout.version_id) if scout.version_id else None
        return jsonify({
            "file_name": video.file_name,
            "fps": video.fps,
            "agent": scout.agent_name,
            "version": version.version if version else None,
            "step": scout.step,
            "last_frame": scout.last_frame,
            "created_at": scout.created_at.isoformat(),
            "segments": scout.segments,
            # Покадровые находки — призракам на кадре и точкам на дорожках;
            # классы агента сведены к классам проекта, если сопоставлены.
            "frames": scout.frames,
            "mapped": scout_lib.class_view(scout_lib.classes(db, scout, task.project_id)),
            **agent_graph.scout_stats(scout.frames),
        })
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Наборы образцов «Сети по тексту»: собрать, убрать/переставить/добрать
# --------------------------------------------------------------------------- #
EXAMPLES_WAIT_S = 180   # четыре размера YOLOE по 32 образца — секунды; запас на очередь
MAX_EXAMPLES = 256


def _examples_row(db, user, set_id):
    row = db.get(AgentExamples, _uuid(set_id))
    return row if row is not None and row.owner_id == user.id else None


def _shared_owners(db, user):
    """Владельцы агентов, подключённых к проектам человека: их наборы образцов он видит
    на чтение — иначе карточки классов чужого агента в общем проекте пустые."""
    mine = select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
    return {user.id} | set(db.execute(
        select(AugGraph.owner_id).join(ProjectAugGraph, ProjectAugGraph.graph_id == AugGraph.id)
        .where(AugGraph.kind == "agent", ProjectAugGraph.project_id.in_(mine), AugGraph.owner_id.isnot(None))
    ).scalars())


def _wait_examples(db, row):
    """Сборку делает воркер: ждём ответа в той же строке, как превью."""
    db.execute(text(f"NOTIFY {examples_lib.CHANNEL}"))
    db.commit()
    deadline = time.monotonic() + EXAMPLES_WAIT_S
    while time.monotonic() < deadline:
        db.refresh(row)
        if row.status != "queued":
            break
        time.sleep(0.2)
    if row.status == "queued":
        return jsonify({"error": "Воркер не ответил — он запущен?", "set": examples_lib.view(row)}), 504
    if row.status == "error":
        return jsonify({"error": row.error, "set": examples_lib.view(row)}), 422
    return jsonify({"set": examples_lib.view(row)}), 201


@bp.get("/api/agents/examples/sources")
def examples_sources():
    """Что можно собрать в проекте: датасеты и ручные рамки по классам."""
    db, user, err = _me()
    if err:
        return err
    try:
        project = db.execute(
            select(Project).where(Project.code == request.args.get("project"))).scalar_one_or_none()
        if project is None or not has_role(role_in(db, user, project), "viewer"):
            return jsonify({"error": "Проект не найден."}), 404
        datasets = db.execute(
            select(Dataset.id, Dataset.name, func.count(Image.id))
            .outerjoin(Image, Image.dataset_id == Dataset.id)
            .where(Dataset.project_id == project.id).group_by(Dataset.id).order_by(Dataset.name)
        ).all()
        classes = {c.id: {"id": str(c.id), "name": c.name, "color": c.color, "datasets": {}}
                   for c in db.execute(select(LabelClass).where(LabelClass.project_id == project.id)
                                       .order_by(LabelClass.class_index)).scalars()}
        seen = set()
        for class_id, dataset_id, image_id, ann_type, geometry in db.execute(
                select(Annotation.class_id, Image.dataset_id, Image.id, Annotation.ann_type, Annotation.geometry)
                .join(Image, Image.id == Annotation.image_id)
                .where(Image.project_id == project.id, Image.dataset_id.isnot(None),
                       Annotation.source == "human")):
            if class_id not in classes:
                continue
            stat = classes[class_id]["datasets"].setdefault(
                str(dataset_id), {"boxes": 0, "usable": 0, "frames": 0})
            stat["boxes"] += 1
            if ax.usable(ax.geometry_box(ann_type, geometry)):
                stat["usable"] += 1
                if (class_id, image_id) not in seen:
                    seen.add((class_id, image_id))
                    stat["frames"] += 1
        return jsonify({
            "project": {"code": project.code, "name": project.name},
            "datasets": [{"id": str(i), "name": n, "frames": k} for i, n, k in datasets],
            "classes": list(classes.values()),
        })
    finally:
        db.close()


@bp.post("/api/agents/examples")
def create_examples():
    db, user, err = _me()
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        project = db.execute(select(Project).where(Project.code == data.get("project"))).scalar_one_or_none()
        if project is None or not has_role(role_in(db, user, project), "viewer"):
            return jsonify({"error": "Проект не найден."}), 404
        cls = db.get(LabelClass, _uuid(data.get("class_id")))
        if cls is None or cls.project_id != project.id:
            return jsonify({"error": "Класса нет в проекте."}), 404
        if data.get("items") is not None:
            return _examples_by_hand(db, user, project, cls, data)
        try:
            # Не `or`: ноль — это ошибка человека, а не просьба об умолчании.
            n = int(data.get("n", 32))
            collage = int(data.get("collage", 6))
            ctx = float(data.get("ctx", 2.5))
        except (TypeError, ValueError):
            return jsonify({"error": "Числа набора — не числа."}), 400
        if not 1 <= n <= MAX_EXAMPLES or not 1 <= collage <= ax.COLLAGE_MAX or not 1 <= ctx <= 16:
            return jsonify({"error": f"Образцов от 1 до {MAX_EXAMPLES}, в коллаже от 1 до "
                                     f"{ax.COLLAGE_MAX}, вырезка от ×1 до ×16."}), 400
        datasets = [d for d in (_uuid(x) for x in data.get("datasets") or []) if d] or None
        row = AgentExamples(
            owner_id=user.id, project_id=project.id, project_name=project.name,
            class_id=cls.id, class_name=cls.name, items=[], dir="", status="queued",
            params={"datasets": [str(d) for d in datasets] if datasets else None, "n": n,
                    "collage": collage, "ctx": ctx, "seed": random.randrange(1 << 31)},
            created_by=user.id)
        db.add(row)
        db.flush()
        return _wait_examples(db, row)
    finally:
        db.close()


def _examples_by_hand(db, user, project, cls, data):
    """Набор из выбранных рамок в заданном порядке; `from` — набор, чьи векторы не пересчитывать."""
    raw = data.get("items")
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_EXAMPLES:
        return jsonify({"error": f"Образцов от 1 до {MAX_EXAMPLES}."}), 400
    items = []
    for it in raw:
        try:
            image_id, box = _uuid(it["image_id"]), [round(float(v), 1) for v in it["box"]]
        except (KeyError, TypeError, ValueError):
            image_id, box = None, []
        if image_id is None or len(box) != 4:
            return jsonify({"error": "Образец — это кадр и рамка на нём."}), 400
        items.append({"image_id": str(image_id), "box": box})
    parent = None
    if data.get("from"):
        parent = _examples_row(db, user, data["from"])
        if parent is None or parent.status != "ready" or parent.class_id != cls.id:
            return jsonify({"error": "Набора-основы нет."}), 404
    row = AgentExamples(
        owner_id=user.id, parent_id=parent.id if parent else None, project_id=project.id,
        project_name=project.name, class_id=cls.id, class_name=cls.name, items=[], dir="", status="queued",
        params={"items": items, "n": len(items), "datasets": None, "seed": random.randrange(1 << 31)},
        created_by=user.id)
    db.add(row)
    db.flush()
    return _wait_examples(db, row)


@bp.get("/api/agents/examples/boxes")
def example_boxes():
    """Ручные рамки класса проекта для окна «Образцы класса»."""
    db, user, err = _me()
    if err:
        return err
    try:
        project = db.execute(
            select(Project).where(Project.code == request.args.get("project"))).scalar_one_or_none()
        if project is None or not has_role(role_in(db, user, project), "viewer"):
            return jsonify({"error": "Проект не найден."}), 404
        cls = db.get(LabelClass, _uuid(request.args.get("class_id")))
        if cls is None or cls.project_id != project.id:
            return jsonify({"error": "Класса нет в проекте."}), 404
        boxes = examples_lib.class_boxes(db, project.id, cls.id)
        return jsonify({"boxes": boxes, "frames": len({b["image_id"] for b in boxes}),
                        "objects": len({b["group"] for b in boxes})})
    finally:
        db.close()


THUMB = 160


@bp.get("/api/agents/examples/boxes/crop")
def example_box_crop():
    """Миниатюра рамки для окна выбора: вырезка «авто» по ширине кадра и тонкая обводка."""
    import cv2

    db, user, err = _me()
    if err:
        return err
    try:
        image = db.get(Image, _uuid(request.args.get("image")))
        project = db.get(Project, image.project_id) if image is not None else None
        if project is None or not has_role(role_in(db, user, project), "viewer"):
            return jsonify({"error": "Кадр не найден."}), 404
        try:
            box = [float(v) for v in (request.args.get("box") or "").split(",")]
        except ValueError:
            box = []
        if len(box) != 4 or min(box[2:]) <= 0:
            return jsonify({"error": "Рамка — четыре числа x,y,w,h."}), 400
        pic = cv2.imread(os.path.join(config.DATA_DIR, image.file_path))
        if pic is None:
            return jsonify({"error": "Файла кадра нет."}), 404
        height, width = pic.shape[:2]
        x0, y0, x1, y1 = ax.auto_rect(box, width, width, height)
        crop = pic[y0:y1, x0:x1]
        s = THUMB / max(crop.shape[:2])
        small = cv2.resize(crop, (max(1, round(crop.shape[1] * s)), max(1, round(crop.shape[0] * s))),
                           interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
        x, y, w, h = box
        cv2.rectangle(small, (round((x - x0) * s), round((y - y0) * s)),
                      (round((x + w - x0) * s) - 1, round((y + h - y0) * s) - 1), (255, 176, 90), 1)
        _, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 85])
        resp = Response(buf.tobytes(), mimetype="image/jpeg")
        # Кадр по uuid не меняется — миниатюру можно держать в кеше браузера.
        resp.headers["Cache-Control"] = "private, max-age=2592000, immutable"
        return resp
    finally:
        db.close()


@bp.post("/api/agents/examples/collage")
def example_collage():
    """«Как видит SAM 3»: проход коллажа над кадром превью — тот квадрат, что уходит в модель.

    `items` — выбранные рамки по порядку, `side` — вход 644 или 1008, `tile` — сторона тайла
    (вид — первый тайл кадра), `pass` — номер прохода. Число проходов — в заголовке X-Passes."""
    import cv2
    import numpy as np

    db, user, err = _me()
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        raw = data.get("items")
        if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_EXAMPLES:
            return jsonify({"error": f"Образцов от 1 до {MAX_EXAMPLES}."}), 400
        try:
            items = [(_uuid(it["image_id"]), [float(v) for v in it["box"]]) for it in raw]
            side = int(data.get("side") or 1008)
            tile = int(data["tile"]) if data.get("tile") else None
            at = int(data.get("pass") or 0)
        except (KeyError, TypeError, ValueError):
            return jsonify({"error": "Образец — это кадр и рамка на нём."}), 400
        if side not in agent_graph.SAM3_SIDES or any(i is None or len(b) != 4 for i, b in items):
            return jsonify({"error": "Вход SAM 3 — 644 или 1008, образец — кадр и рамка."}), 400
        ids = {i for i, _ in items} | {_uuid(data.get("image_id"))}
        images = {i.id: i for i in db.execute(select(Image).where(Image.id.in_(ids - {None}))).scalars()}
        frame = images.get(_uuid(data.get("image_id")))
        if frame is None or len(images) != len(ids - {None}):
            return jsonify({"error": "Кадр не найден."}), 404
        for project_id in {i.project_id for i in images.values()}:
            if not has_role(role_in(db, user, db.get(Project, project_id)), "viewer"):
                return jsonify({"error": "Кадр не найден."}), 404

        pics = {}

        def pic(image):
            if image.id not in pics:
                pics[image.id] = cv2.imread(os.path.join(config.DATA_DIR, image.file_path))
            return pics[image.id]

        view = pic(frame)
        if view is None:
            return jsonify({"error": "Файла кадра нет."}), 404
        grow = False
        if tile and tile < max(view.shape[:2]):
            view, grow = view[:tile, :tile], tile < side
        vh, vw = view.shape[:2]
        crops = []
        for image_id, box in items:
            img = pic(images[image_id])
            if img is None:
                continue
            x0, y0, x1, y1 = ax.auto_rect(box, vw, img.shape[1], img.shape[0])
            crops.append((img[y0:y1, x0:x1], [box[0] - x0, box[1] - y0, box[2], box[3]]))
        plan = ax.collage_passes(len(crops), vw, vh)
        if not plan:
            return jsonify({"error": "Файлов образцов нет."}), 404
        strip, boxes = ax.collage_strip(crops, plan[min(max(0, at), len(plan) - 1)], vw)
        square, k = ax.model_square(np.vstack([strip, view]), side, grow)
        # Рамки-образцы, что уходят в модель подсказкой, — тонкой обводкой.
        for x1, y1, x2, y2 in boxes:
            cv2.rectangle(square, (round(x1 * k), round(y1 * k)), (round(x2 * k) - 1, round(y2 * k) - 1), (255, 176, 90), 1)
        _, buf = cv2.imencode(".jpg", square, [cv2.IMWRITE_JPEG_QUALITY, 85])
        resp = Response(buf.tobytes(), mimetype="image/jpeg")
        resp.headers["X-Passes"] = str(len(plan))
        resp.headers["Access-Control-Expose-Headers"] = "X-Passes"
        return resp
    finally:
        db.close()


@bp.post("/api/agents/examples/<set_id>/derive")
def derive_examples(set_id):
    """Новый набор из старого: `order` — uid в новом порядке (убрать и
    переставить, сразу), `collage` — сколько в коллаж, `add` — добрать
    столько (через воркер)."""
    db, user, err = _me()
    if err:
        return err
    try:
        parent = _examples_row(db, user, set_id)
        if parent is None or parent.status != "ready":
            return jsonify({"error": "Набор не найден."}), 404
        data = json_body()
        add = int_field(data, "add", lo=0, default=0, label="Сколько добавить")
        if add:
            if not 1 <= add <= MAX_EXAMPLES - len(parent.items):
                return jsonify({"error": f"В наборе не больше {MAX_EXAMPLES} образцов."}), 400
            # Ручной список родителя не наследуем: добор — случайный, от его же зерна.
            base = {k: v for k, v in parent.params.items() if k != "items"}
            row = AgentExamples(
                owner_id=user.id, parent_id=parent.id, project_id=parent.project_id,
                project_name=parent.project_name, class_id=parent.class_id, class_name=parent.class_name,
                params={**base, "add": add}, items=[], dir="", status="queued", created_by=user.id)
            db.add(row)
            db.flush()
            return _wait_examples(db, row)
        order = data.get("order") or [it["uid"] for it in parent.items]
        try:
            row = examples_lib.derive(db, parent, order, user.id, data.get("collage"))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        db.commit()
        return jsonify({"set": examples_lib.view(row)}), 201
    finally:
        db.close()


@bp.get("/api/agents/examples")
def list_examples():
    db, user, err = _me()
    if err:
        return err
    try:
        ids = [i for i in (_uuid(x) for x in (request.args.get("ids") or "").split(",")) if i]
        rows = db.execute(select(AgentExamples).where(
            AgentExamples.owner_id.in_(_shared_owners(db, user)), AgentExamples.id.in_(ids))).scalars() if ids else []
        return jsonify({"sets": [examples_lib.view(r) for r in rows]})
    finally:
        db.close()


@bp.get("/api/agents/examples/<set_id>/crops/<uid>")
def example_crop(set_id, uid):
    db, user, err = _me()
    if err:
        return err
    try:
        row = db.get(AgentExamples, _uuid(set_id))
        if row is None or row.owner_id not in _shared_owners(db, user) or not any(it["uid"] == uid for it in row.items):
            return jsonify({"error": "Образца нет."}), 404
        # Набор неизменяем — вырезку браузер может держать в кеше сколько угодно.
        return send_file(os.path.join(config.DATA_DIR, row.dir, f"{uid}.jpg"),
                         mimetype="image/jpeg", max_age=86400 * 30)
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Влезет ли агент на карту (решения 09.10.2026)
#
# Одна функция на редактор, окно запуска, страницу агентов проекта и сам
# прогон: число в редакторе и решение диспетчера разойтись не могут.
# --------------------------------------------------------------------------- #
def _verdict(db, doc, scout=False, cards=None):
    doc = agent_graph.prepare(doc)
    cards = gpu.cards(db) if cards is None else cards
    # Память сети считается по весу файла с полки — строки берём по id из узлов.
    ids = {n["id"]: _uuid((n.get("params") or {}).get("weights"))
           for n in doc.get("nodes") or [] if n.get("type") == "net"}
    weights = {nid: db.get(AgentWeights, wid) for nid, wid in ids.items() if wid}
    cpu_half = settings.get(db, settings.SAM3_CPU_HALF)
    mem = agent_memory.plan(doc, max((c["cap_mb"] for c in cards), default=0) or None, scout,
                            nets=agent_memory.net_info(weights), sam3_cpu_half=cpu_half)
    hint = db.get(GpuUsageHint, ("agent", agent_memory.signature(doc, mem["words"], scout=scout,
                                                                 sam3_cpu_half=cpu_half)))
    measured = int(hint.samples) if hint is not None and hint.samples else 0
    total = int(hint.high_mb) if measured else mem["total_mb"]
    return {
        "verdict": agent_memory.verdict(total, mem["heaviest"], cards, mem["units"]),
        "total_mb": total, "estimate_mb": mem["total_mb"], "measured": measured,
        "units": mem["units"], "heaviest": mem["heaviest"], "nodes": mem["nodes"], "words": mem["words"],
        "sam3_cpu_half": cpu_half,
    }


@bp.post("/api/agents/estimate")
def estimate_agent():
    """Плашка «Ресурсы» в редакторе: вердикт, блоки памяти по узлам и карты.
    `doc` — черновик как есть; `graph_id` — чей агент (смотреть можно и чужой)."""
    db, user, err = _me()
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        if data.get("graph_id"):
            graph = db.get(AugGraph, _uuid(data["graph_id"]))
            if not agent_access.may_view(db, user, graph):
                return jsonify({"error": "Агент не найден."}), 404
        doc = data.get("doc")
        if not isinstance(doc, dict) or not isinstance(doc.get("nodes"), list):
            return jsonify({"error": "doc: граф агента."}), 400
        cards = gpu.cards(db)
        return jsonify({**_verdict(db, doc, scout=data.get("mode") == "scout", cards=cards),
                        "cards": cards, "queued": gpu.queued_count(db)})
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Агенты проекта: подключённые карточками и журнал прогонов
# --------------------------------------------------------------------------- #
def _project(db, user, code, needed="viewer"):
    project = project_by_code(db, code)
    role = role_in(db, user, project) if project is not None else None
    if project is None or not has_role(role, "viewer"):
        return None, None, (jsonify({"error": "Проект не найден."}), 404)
    if not has_role(role, needed):
        return None, None, (jsonify({"error": "Недостаточно прав в проекте."}), 403)
    return project, role, None


def _speed(rows):
    """Кадров в минуту по законченным прогонам: обработано за время работы."""
    frames = seconds = 0
    for r in rows:
        if r.started_at and r.finished_at and r.processed:
            frames += r.processed
            seconds += max(1.0, (r.finished_at - r.started_at).total_seconds())
    return round(frames / seconds * 60, 1) if seconds else None


def _confirmed(db, graph_id, project_id):
    """Доля рамок агента в проекте, которую человек уже принял: (принято, всего)."""
    versions = select(AugGraphVersion.id).where(AugGraphVersion.graph_id == graph_id)
    q = (select(Annotation.pending, func.count(Annotation.id))
         .join(Image, Image.id == Annotation.image_id)
         .where(Image.project_id == project_id, Annotation.agent_version_id.in_(versions))
         .group_by(Annotation.pending))
    got = dict(db.execute(q).all())
    # Рамки в роликах — тем же счётом: агент таски на видео ставит только их.
    vq = (select(VideoAnnotation.pending, func.count(VideoAnnotation.id))
          .join(TaskVideo, TaskVideo.id == VideoAnnotation.video_id)
          .join(Task, Task.id == TaskVideo.task_id)
          .where(Task.project_id == project_id, VideoAnnotation.agent_version_id.in_(versions))
          .group_by(VideoAnnotation.pending))
    for pending, n in db.execute(vq).all():
        got[pending] = got.get(pending, 0) + n
    total = sum(got.values())
    return got.get(False, 0), total


@bp.get("/api/projects/<code>/agents")
def project_agents(code):
    db, user, err = _me()
    if err:
        return err
    try:
        project, role, err = _project(db, user, code)
        if err:
            return err
        cards = gpu.cards(db)
        members = set(db.execute(select(ProjectMember.user_id).where(
            ProjectMember.project_id == project.id)).scalars())
        week = utcnow() - timedelta(days=7)
        out = []
        for graph in db.execute(
            select(AugGraph).join(ProjectAugGraph, ProjectAugGraph.graph_id == AugGraph.id)
            .where(ProjectAugGraph.project_id == project.id, AugGraph.kind == "agent")
            .order_by(AugGraph.name)
        ).scalars():
            head = db.get(AugGraphVersion, graph.head_version_id) if graph.head_version_id else None
            owner = db.get(User, graph.owner_id) if graph.owner_id else None
            runs = db.execute(select(AgentRun).where(
                AgentRun.graph_id == graph.id, AgentRun.project_id == project.id)).scalars().all()
            done = [r for r in runs if r.status == "done"]
            accepted, boxes = _confirmed(db, graph.id, project.id)
            applies = db.execute(select(func.count(AgentApply.id)).where(
                AgentApply.graph_id == graph.id, AgentApply.project_id == project.id,
                AgentApply.created_at >= week)).scalar() or 0
            est = _verdict(db, head.doc, cards=cards) if head else None
            last = max(runs, key=lambda r: r.created_at, default=None)
            out.append({
                "id": str(graph.id), "name": graph.name, "description": graph.description,
                "owner": {"id": str(owner.id), "name": owner.display_name} if owner else None,
                # Ушёл из проекта или удалён — агент работает дальше, правит только владелец.
                "owner_here": bool(owner and owner.id in members),
                "mine": graph.owner_id == user.id,
                "archived": graph.archived_at is not None,
                "version": head.version if head else None,
                "version_id": str(head.id) if head else None,
                "verdict": est["verdict"] if est else None,
                "total_mb": est["total_mb"] if est else None,
                "measured": est["measured"] if est else 0,
                "heaviest": est["heaviest"] if est else None,
                # Как в «Моих агентах»: классы из статистики версии, а не из документа.
                "classes": len((head.stats or {}).get("classes") or []) if head else 0,
                "runs": len(runs),
                "last_run_at": last.created_at if last else None,
                "last_status": last.status if last else None,
                "speed": _speed(done),
                "boxes": boxes, "accepted": accepted,
                "applies_week": int(applies),
            })
        for item in out:
            item["last_run_at"] = item["last_run_at"].isoformat() if item["last_run_at"] else None
        return jsonify({
            "agents": out,
            "cards": cards,
            "queued": gpu.queued_count(db),
            # Подключает владелец агента с правом разметки; отключает он же или admin.
            "can_link": has_role(role, "editor"),
            "can_unlink_any": role == "admin",
            # Копию делает участник с правом разметки — как в /api/aug/graphs/<id>/copy.
            "can_copy": has_role(role, "editor"),
        })
    finally:
        db.close()


@bp.post("/api/projects/<code>/agents")
def link_agent(code):
    db, user, err = _me()
    if err:
        return err
    try:
        project, _role, err = _project(db, user, code, "editor")
        if err:
            return err
        graph = db.get(AugGraph, _uuid((request.get_json(silent=True) or {}).get("graph_id")))
        if graph is None or graph.kind != "agent" or graph.owner_id != user.id or graph.archived_at:
            return jsonify({"error": "Подключить можно только своего агента."}), 404
        if graph.head_version_id is None:
            return jsonify({"error": "Сначала сохраните версию агента — запускают версии, а не черновик."}), 409
        if db.get(ProjectAugGraph, (project.id, graph.id)) is None:
            db.add(ProjectAugGraph(project_id=project.id, graph_id=graph.id, created_by=user.id))
            db.commit()
        return jsonify({"ok": True}), 201
    finally:
        db.close()


@bp.delete("/api/projects/<code>/agents/<graph_id>")
def unlink_agent(code, graph_id):
    db, user, err = _me()
    if err:
        return err
    try:
        project, role, err = _project(db, user, code)
        if err:
            return err
        graph = db.get(AugGraph, _uuid(graph_id))
        link = db.get(ProjectAugGraph, (project.id, graph.id)) if graph is not None else None
        if link is None or graph.kind != "agent":
            return jsonify({"error": "Агент к проекту не подключён."}), 404
        # Владелец ушёл — без admin агент остался бы в проекте навсегда.
        if graph.owner_id != user.id and role != "admin":
            return jsonify({"error": "Отключает владелец агента или администратор проекта."}), 403
        db.delete(link)
        db.commit()
        return jsonify({"ok": True})
    finally:
        db.close()


JOURNAL_PAGE = 50


@bp.get("/api/projects/<code>/agent-runs")
def agent_journal(code):
    """Журнал прогонов агентов по таскам проекта: свежие сверху, страницами.
    Фильтры: `agent`, `status`, `task`, `user`; `before` — created_at последней строки."""
    db, user, err = _me()
    if err:
        return err
    try:
        project, _role, err = _project(db, user, code)
        if err:
            return err
        q = select(AgentRun).where(AgentRun.project_id == project.id)
        for arg, col in (("agent", AgentRun.graph_id), ("task", AgentRun.task_id), ("user", AgentRun.created_by)):
            if request.args.get(arg):
                q = q.where(col == _uuid(request.args[arg]))
        status = request.args.get("status")
        if status == "active":
            q = q.where(AgentRun.status.in_(ACTIVE))
        elif status:
            q = q.where(AgentRun.status == status)
        # Сколько всего и сколько живых — по фильтрам, но без страницы.
        counted = db.execute(select(AgentRun.status, func.count(AgentRun.id))
                             .where(AgentRun.id.in_(q.with_only_columns(AgentRun.id)))
                             .group_by(AgentRun.status)).all()
        totals = {"all": sum(n for _s, n in counted),
                  "running": sum(n for st, n in counted if st == "running"),
                  "waiting": sum(n for st, n in counted if st in ("queued", "waiting_gpu"))}
        before = request.args.get("before")
        if before:
            try:
                q = q.where(AgentRun.created_at < datetime.fromisoformat(before))
            except ValueError:
                return jsonify({"error": "before: время строки."}), 400
        rows = db.execute(q.order_by(AgentRun.created_at.desc()).limit(JOURNAL_PAGE + 1)).scalars().all()
        more = len(rows) > JOURNAL_PAGE
        rows = rows[:JOURNAL_PAGE]

        graphs = {g.id: g for g in db.execute(select(AugGraph).where(
            AugGraph.id.in_({r.graph_id for r in rows} or {None}))).scalars()}
        versions = {v.id: v.version for v in db.execute(select(AugGraphVersion).where(
            AugGraphVersion.id.in_({r.version_id for r in rows} or {None}))).scalars()}
        tasks = {t.id: t.name for t in db.execute(select(Task).where(
            Task.id.in_({r.task_id for r in rows} or {None}))).scalars()}
        people = {u.id: u.display_name for u in db.execute(select(User).where(
            User.id.in_({r.created_by for r in rows} or {None}))).scalars()}
        leases = {lz.id: lz for lz in db.execute(select(GpuLease).where(
            GpuLease.id.in_({r.gpu_lease_id for r in rows} or {None}))).scalars()}
        cards = {d.id: d.name for d in db.execute(select(GpuDevice)).scalars()}
        classes = {str(c.id): {"name": c.name, "color": c.color} for c in db.execute(
            select(LabelClass).where(LabelClass.project_id == project.id)).scalars()}

        def view(r):
            lease = leases.get(r.gpu_lease_id)
            res = (r.stats or {}).get("res") or {}
            mapping = (r.params or {}).get("mapping") or {}
            end = r.finished_at or (utcnow() if r.status == "running" else None)
            return {
                **_run_view(db, r),
                "agent_id": str(r.graph_id) if r.graph_id else None,
                "agent": graphs[r.graph_id].name if r.graph_id in graphs else None,
                "version": versions.get(r.version_id),
                "task": {"id": str(r.task_id), "name": tasks.get(r.task_id)},
                "user": people.get(r.created_by),
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "seconds": int((end - r.started_at).total_seconds()) if end and r.started_at else None,
                "card": res.get("card") or (cards.get(lease.device_id) if lease else None),
                # Номера карт: у агента, поделённого по картам, их несколько.
                "cards": res.get("cards"),
                "want_mb": res.get("want_mb") or (lease.want_mb if lease else None),
                "peak_mb": lease.peak_mb if lease else None,
                "waited_s": res.get("waited_s"),
                "sequential": bool(res.get("sequential")),
                "words": res.get("words"),
                "mapping": [{"agent": k, "to": classes.get(str(v))} for k, v in mapping.items()],
                "step": (r.params or {}).get("step"),
            }

        facets = {
            "agents": [{"id": str(g), "name": n} for g, n in db.execute(
                select(AugGraph.id, AugGraph.name).join(AgentRun, AgentRun.graph_id == AugGraph.id)
                .where(AgentRun.project_id == project.id).distinct().order_by(AugGraph.name)).all()],
            "tasks": [{"id": str(t), "name": n} for t, n in db.execute(
                select(Task.id, Task.name).join(AgentRun, AgentRun.task_id == Task.id)
                .where(AgentRun.project_id == project.id).distinct().order_by(Task.name)).all()],
            "users": [{"id": str(u), "name": n} for u, n in db.execute(
                select(User.id, User.display_name).join(AgentRun, AgentRun.created_by == User.id)
                .where(AgentRun.project_id == project.id).distinct().order_by(User.display_name)).all()],
        }
        return jsonify({"runs": [view(r) for r in rows], "more": more, "totals": totals, "facets": facets})
    finally:
        db.close()
