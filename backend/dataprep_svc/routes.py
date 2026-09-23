"""Ручки подготовки данных: графы, их версии и обучающие наборы.

Граф принадлежит человеку и живёт вне проектов — его правят в личной
библиотеке. В проект он попадает ссылкой, а не копией: удачный граф переносят
из проекта в проект, и копия разошлась бы с оригиналом на первой же правке.

Прогон всегда внутри проекта: только там есть кадры, классы и права.
"""
import hashlib
import json
import os
import time
import uuid

from flask import Blueprint, jsonify, request, send_file
from sqlalchemy import String, cast, func, select

from common import agent_graph
from common import selection as sel_lib
from common.auth import current_user, has_role, project_by_code, role_in
from common.db import SessionLocal
from common.models import (
    GRAPH_KINDS, AgentWeights, AugGraph, AugGraphUse, AugGraphVersion,
    DataprepJob, Project, ProjectAugGraph, TrainSet, TrainSetFeed, User, utcnow,
)
from common import config, live
from common import prep_queue as queue
from common import similarity
from common import polygon as polylib
from common.models import Annotation, Image, LabelClass, ProjectMember, VideoAnnotation
from dataprep_svc import albu, engine, feeds, preview as previewlib
from dataprep_svc import samples as samples_lib, testframe
from dataprep_svc.graph import plan as planlib
from dataprep_svc.graph import schema
from dataprep_svc.graph.schema import GraphError

bp = Blueprint("dataprep", __name__)


# --------------------------------------------------------------------------- #
# Права
# --------------------------------------------------------------------------- #
def _me():
    """(db, user, ошибка). Закрывает db вызывающий, когда ошибки нет."""
    db = SessionLocal()
    user = current_user(db)
    if user is None:
        db.close()
        return None, None, (jsonify({"error": "Не выполнен вход."}), 401)
    return db, user, None


def _resolve(code, needed="viewer"):
    """(db, project, user, ошибка). Тот же разбор прав, что у данных проекта."""
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


def _uuid(value):
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


# --------------------------------------------------------------------------- #
# Каталог узлов
# --------------------------------------------------------------------------- #
@bp.get("/api/aug/catalogue")
def catalogue():
    return jsonify(albu.catalogue())


# --------------------------------------------------------------------------- #
# Графы
# --------------------------------------------------------------------------- #
def digest_of(doc):
    """Отпечаток смысла графа, без координат узлов.

    Подвинули узел мышью — смысл не поменялся, и новой версии быть не должно.
    Иначе «сохранить», нажатое рефлекторно, за вечер нарожает тридцать версий,
    и запись «набор собран версией 7» перестанет что-либо значить.
    """
    def clean(node):
        params = {
            k: v for k, v in (node.get("params") or {}).items()
            if k not in ("pos", "x", "y")
        }
        return {"id": node.get("id"), "type": node.get("type"),
                "params": params}

    body = {
        "nodes": sorted((clean(n) for n in doc.get("nodes", [])),
                        key=lambda n: str(n["id"])),
        "edges": sorted(
            ({k: e.get(k) for k in ("from", "out", "to", "in")}
             for e in doc.get("edges", [])),
            key=lambda e: (str(e["from"]), str(e["out"]),
                           str(e["to"]), str(e["in"])),
        ),
    }
    text = json.dumps(body, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()


def _graph_view(db, graph, head=None):
    if head is None and graph.head_version_id:
        head = db.get(AugGraphVersion, graph.head_version_id)
    owner = db.get(User, graph.owner_id) if graph.owner_id else None
    used_by = db.execute(
        select(func.count(func.distinct(TrainSet.id)))
        .join(TrainSetFeed, TrainSetFeed.set_id == TrainSet.id)
        .join(AugGraphVersion,
              AugGraphVersion.id == TrainSetFeed.graph_version_id)
        .where(AugGraphVersion.graph_id == graph.id)
    ).scalar() or 0
    return {
        "id": str(graph.id),
        "kind": graph.kind,
        "name": graph.name,
        "description": graph.description,
        "owner": owner.display_name if owner else None,
        "owner_id": str(graph.owner_id) if graph.owner_id else None,
        "archived": graph.archived_at is not None,
        "created_at": graph.created_at.isoformat(),
        "version": head.version if head else 0,
        "version_id": str(head.id) if head else None,
        "stats": head.stats if head else None,
        "ports": head.port_names if head else {"in": [], "out": []},
        "used_by_sets": int(used_by),
    }


@bp.get("/api/aug/graphs")
def list_graphs():
    db, user, err = _me()
    if err:
        return err
    try:
        kind = request.args.get("kind") or "aug"
        rows = db.execute(
            select(AugGraph)
            .where(AugGraph.owner_id == user.id, AugGraph.kind == kind,
                   AugGraph.archived_at.is_(None))
            .order_by(AugGraph.created_at.desc())
        ).scalars().all()
        return jsonify({"graphs": [_graph_view(db, g) for g in rows]})
    finally:
        db.close()


@bp.post("/api/aug/graphs")
def create_graph():
    db, user, err = _me()
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip()
        kind = data.get("kind") or "aug"
        if kind not in GRAPH_KINDS:
            return jsonify({"error": "Неизвестный род графа."}), 400
        if not name:
            return jsonify({"error": "У графа должно быть имя."}), 400
        taken = db.execute(
            select(AugGraph).where(
                AugGraph.owner_id == user.id, AugGraph.kind == kind,
                AugGraph.name == name,
            )
        ).scalar_one_or_none()
        if taken is not None:
            return jsonify({"error": "Такое имя уже занято."}), 409

        graph = AugGraph(
            owner_id=user.id, name=name, kind=kind,
            description=(data.get("description") or "").strip() or None,
            created_by=user.id,
        )
        db.add(graph)
        db.commit()

        if kind == "agent":
            # У нового агента ещё нет весов, а версия без весов не проходит
            # проверку. Поэтому он рождается черновиком, без версии: версия
            # появится, когда человек выберет веса и нажмёт «Сохранить».
            graph.draft = _starter("agent")
            graph.draft_at = utcnow()
            db.commit()
            return jsonify(_graph_view(db, graph)), 201

        doc = data.get("doc") or _starter()
        version, error = _save_version(db, graph, doc, user, note="Начало")
        if error:
            return error
        return jsonify(_graph_view(db, graph, version)), 201
    finally:
        db.close()


def _starter(kind="aug"):
    """Пустой граф: источник, один поток и выход.

    Не «совсем пустой холст»: три узла сразу показывают, что по проводу идёт
    поток и что у него есть начало и конец. Пустой холст этого не объясняет.
    У агента — кадр, сеть без весов и выход: с этого начинается любой агент.
    """
    if kind == "agent":
        return {
            "v": 1,
            "nodes": [
                {"id": "frame", "type": "frame", "params": {}, "pos": [60, 180]},
                {"id": "net", "type": "net",
                 "params": {"weights": None, "classes": [], "conf": 0.25,
                            "iou": 0.6}, "pos": [320, 180]},
                {"id": "out", "type": "output", "params": {}, "pos": [600, 180]},
            ],
            "edges": [
                {"from": "frame", "out": "out", "to": "net", "in": "in"},
                {"from": "net", "out": "out", "to": "out", "in": "in"},
            ],
        }
    return {
        "v": 1,
        "nodes": [
            {"id": "src", "type": "source",
             "params": {"label": "Источник"}, "pos": [60, 180]},
            {"id": "flow", "type": "flow",
             "params": {"label": "Аугментации", "ops": []}, "pos": [320, 180]},
            {"id": "out", "type": "output",
             "params": {"label": "Выход"}, "pos": [600, 180]},
        ],
        "edges": [
            {"from": "src", "out": "out", "to": "flow", "in": "in"},
            {"from": "flow", "out": "out", "to": "out", "in": "in"},
        ],
    }


def _aug_version(db, version_id):
    """Версия графа аугментаций — или None, в том числе для версии агента.

    Все пути «версия → набор» идут через неё: агент, вставленный блоком или
    указанный строкой сборки, собрал бы набор детектором вместо трансформов.
    """
    row = db.get(AugGraphVersion, version_id) if version_id else None
    if row is None:
        return None
    graph = db.get(AugGraph, row.graph_id)
    return row if graph is not None and graph.kind == "aug" else None


def _loader(db):
    def load(graph_id, version_id):
        row = _aug_version(db, _uuid(version_id))
        return row.doc if row is not None else None
    return load


def _agent_stats(db, graph, doc):
    """Проверить агента и снять его паспорт. Бросает AgentGraphError."""
    weights = {
        str(w.id): len(w.names or [])
        for w in db.execute(
            select(AgentWeights).where(AgentWeights.owner_id == graph.owner_id)
        ).scalars()
    }
    agent_graph.check(doc, weights=weights)
    return {
        # Классы агента — в паспорт версии: окно запуска сопоставляет их с
        # классами проекта, не разбирая документ.
        "classes": [c["name"] for c in agent_graph.classes(doc)],
        "nets": sum(1 for n in doc["nodes"] if n["type"] == "net"),
        "nodes": len(doc["nodes"]),
    }


def _save_version(db, graph, doc, user, note=None):
    """Новая версия графа. Возвращает (версия, ошибка)."""
    if graph.kind == "agent":
        try:
            stats = _agent_stats(db, graph, doc)
        except agent_graph.AgentGraphError as exc:
            return None, (jsonify({"error": str(exc)}), 400)
        return _store_version(db, graph, doc, user, note, stats,
                              {"in": [], "out": []})

    loader = _loader(db)
    try:
        ports = planlib.group_ports_for(doc, loader)
        schema.check(doc, group_ports=ports)
        stats = planlib.counts(doc, 1.0, loader)
        # Источники — списком, с номером узла и подписью: по ним мастер
        # сборки спрашивает, что вливать в каждый. Кладём в паспорт версии,
        # а не считаем на лету: версия неизменна, а разбирать её документ
        # ради двух строк пришлось бы на каждое открытие мастера.
        stats["sources"] = [
            {"id": n["id"], "name": schema.source_name(n)}
            for n in schema.sources_of(doc)
        ]
    except GraphError as exc:
        return None, (jsonify({"error": str(exc)}), 400)
    return _store_version(db, graph, doc, user, note, stats,
                          planlib.port_names(doc))


def _store_version(db, graph, doc, user, note, stats, port_names):
    digest = digest_of(doc)
    same = db.execute(
        select(AugGraphVersion).where(
            AugGraphVersion.graph_id == graph.id,
            AugGraphVersion.digest == digest,
        )
    ).scalar_one_or_none()
    if same is not None:
        graph.head_version_id = same.id
        db.commit()
        return same, None

    top = db.execute(
        select(func.max(AugGraphVersion.version)).where(
            AugGraphVersion.graph_id == graph.id
        )
    ).scalar() or 0
    version = AugGraphVersion(
        graph_id=graph.id, version=int(top) + 1, doc=doc, digest=digest,
        stats=stats, port_names=port_names,
        note=(note or "").strip() or None, created_by=user.id,
    )
    db.add(version)
    db.flush()

    # Рёбра «эта версия вставляет вот этот блок» — отдельной таблицей: по ним
    # ловится кольцо и по ним же отвечается «граф нельзя убрать».
    for node in doc.get("nodes", []):
        if node.get("type") != "group":
            continue
        params = node.get("params") or {}
        used_graph = _uuid(params.get("graph_id"))
        used_version = _uuid(params.get("version_id"))
        if used_graph is None or used_version is None:
            continue
        db.add(AugGraphUse(
            version_id=version.id, used_graph_id=used_graph,
            used_version_id=used_version,
        ))
    graph.head_version_id = version.id
    db.commit()
    return version, None


@bp.get("/api/aug/graphs/<graph_id>")
def get_graph(graph_id):
    db, user, err = _me()
    if err:
        return err
    try:
        graph = db.get(AugGraph, _uuid(graph_id))
        # Агента видит только владелец: делиться агентами пока не решено.
        if graph is None or (graph.kind == "agent" and graph.owner_id != user.id):
            return jsonify({"error": "Граф не найден."}), 404
        asked = _uuid(request.args.get("version") or "")
        want = asked or graph.head_version_id
        version = db.get(AugGraphVersion, want) if want else None
        if version is not None and version.graph_id != graph.id:
            return jsonify({"error": "Версия не от этого графа."}), 404
        # Без номера версии открывается настоящая копия — та, что сохранялась
        # на каждой правке. Черновик виден только владельцу: чужой граф
        # смотрят по версиям, недоделанное — его личное дело.
        mine = bool(user.id == graph.owner_id)
        head_doc = version.doc if version else _starter(graph.kind)
        draft = graph.draft if (mine and asked is None) else None
        return jsonify({
            **_graph_view(db, graph, version),
            "doc": draft if draft is not None else head_doc,
            "draft_at": graph.draft_at.isoformat()
            if draft is not None and graph.draft_at else None,
            "changed": draft is not None and digest_of(draft) != digest_of(head_doc),
            "mine": mine,
        })
    finally:
        db.close()


@bp.put("/api/aug/graphs/<graph_id>/draft")
def save_draft(graph_id):
    """Сохранить настоящую копию. Форма не проверяется: недоделанный граф —
    нормальное состояние посреди работы, и терять его из-за этого нельзя."""
    db, user, err = _me()
    if err:
        return err
    try:
        graph = db.get(AugGraph, _uuid(graph_id))
        if graph is None or graph.owner_id != user.id:
            return jsonify({"error": "Граф не найден."}), 404
        doc = (request.get_json(silent=True) or {}).get("doc")
        if not isinstance(doc, dict) or not isinstance(doc.get("nodes"), list) \
                or not isinstance(doc.get("edges"), list):
            return jsonify({"error": "Граф должен быть объектом с узлами и связями."}), 400
        if len(doc["nodes"]) > schema.MAX_NODES:
            return jsonify({"error": "Слишком большой граф."}), 400
        head = db.get(AugGraphVersion, graph.head_version_id) \
            if graph.head_version_id else None
        graph.draft = doc
        graph.draft_at = utcnow()
        db.commit()
        return jsonify({
            "draft_at": graph.draft_at.isoformat(),
            "changed": digest_of(doc) != digest_of(
                head.doc if head else _starter(graph.kind)),
        })
    finally:
        db.close()


@bp.get("/api/aug/graphs/<graph_id>/versions")
def list_versions(graph_id):
    db, user, err = _me()
    if err:
        return err
    try:
        graph = db.get(AugGraph, _uuid(graph_id))
        if graph is None or (graph.kind == "agent" and graph.owner_id != user.id):
            return jsonify({"error": "Граф не найден."}), 404
        rows = db.execute(
            select(AugGraphVersion)
            .where(AugGraphVersion.graph_id == graph.id)
            .order_by(AugGraphVersion.version.desc())
        ).scalars().all()
        names = {
            u.id: u.display_name
            for u in db.execute(select(User)).scalars()
        }
        return jsonify({"versions": [
            {
                "id": str(v.id),
                "version": v.version,
                "note": v.note,
                "stats": v.stats,
                "author": names.get(v.created_by),
                "created_at": v.created_at.isoformat(),
            }
            for v in rows
        ]})
    finally:
        db.close()


@bp.post("/api/aug/graphs/<graph_id>/versions")
def save_version(graph_id):
    db, user, err = _me()
    if err:
        return err
    try:
        graph = db.get(AugGraph, _uuid(graph_id))
        if graph is None:
            return jsonify({"error": "Граф не найден."}), 404
        if graph.owner_id != user.id:
            return jsonify({
                "error": "Граф чужой. Сделайте свою копию, чтобы править."
            }), 403
        data = request.get_json(silent=True) or {}
        version, error = _save_version(
            db, graph, data.get("doc") or {}, user, note=data.get("note")
        )
        if error:
            return error
        # Настоящая копия теперь и есть версия — держать её отдельно незачем.
        graph.draft = None
        graph.draft_at = None
        db.commit()
        return jsonify({
            **_graph_view(db, graph, version),
            "doc": version.doc,
            "fresh": True,
        }), 201
    finally:
        db.close()


@bp.patch("/api/aug/graphs/<graph_id>")
def patch_graph(graph_id):
    db, user, err = _me()
    if err:
        return err
    try:
        graph = db.get(AugGraph, _uuid(graph_id))
        if graph is None or graph.owner_id != user.id:
            return jsonify({"error": "Граф не найден."}), 404
        data = request.get_json(silent=True) or {}
        if "name" in data:
            name = (data["name"] or "").strip()
            if not name:
                return jsonify({"error": "У графа должно быть имя."}), 400
            graph.name = name
        if "description" in data:
            graph.description = (data["description"] or "").strip() or None
        if "archived" in data:
            graph.archived_at = utcnow() if data["archived"] else None
        if "head_version_id" in data:
            want = _uuid(data["head_version_id"])
            version = db.get(AugGraphVersion, want) if want else None
            if version is None or version.graph_id != graph.id:
                return jsonify({"error": "Версия не от этого графа."}), 404
            graph.head_version_id = version.id
        db.commit()
        return jsonify(_graph_view(db, graph))
    finally:
        db.close()


@bp.delete("/api/aug/graphs/<graph_id>")
def delete_graph(graph_id):
    db, user, err = _me()
    if err:
        return err
    try:
        graph = db.get(AugGraph, _uuid(graph_id))
        if graph is None or graph.owner_id != user.id:
            return jsonify({"error": "Граф не найден."}), 404
        used = db.execute(
            select(func.count(func.distinct(TrainSet.id)))
            .join(TrainSetFeed, TrainSetFeed.set_id == TrainSet.id)
            .join(AugGraphVersion,
                  AugGraphVersion.id == TrainSetFeed.graph_version_id)
            .where(AugGraphVersion.graph_id == graph.id)
        ).scalar() or 0
        if graph.kind == "agent":
            # Рамки хранят ссылку на версию агента; удаление обнулило бы её,
            # и подпись «агент „Путеец“ v3» превратилась бы в безымянную.
            # Считаются и рамки на незакрытых роликах: их кадров ещё нет, но
            # происхождение потерялось бы так же.
            marked = sum(db.execute(
                select(func.count(table.id))
                .join(AugGraphVersion, AugGraphVersion.id == table.agent_version_id)
                .where(AugGraphVersion.graph_id == graph.id)
            ).scalar() or 0 for table in (Annotation, VideoAnnotation))
            if marked:
                return jsonify({
                    "error": (
                        f"Агента нельзя удалить: его рамок в проектах — {marked}. "
                        "Уберите его в архив, он перестанет предлагаться."
                    )
                }), 409
        if used:
            return jsonify({
                "error": (
                    f"Граф нельзя удалить: по нему собрано наборов — {used}. "
                    "Их паспорт ссылается на его версии. Уберите граф из "
                    "списка (архив), он перестанет предлагаться."
                )
            }), 409
        db.delete(graph)
        db.commit()
        return jsonify({"ok": True})
    finally:
        db.close()


@bp.post("/api/aug/counts")
def counts():
    """Числа на проводах для редактора.

    Тот же счёт делает браузер, и обычно рисует их сам. Эта ручка нужна
    редактору, когда в графе есть блоки: их содержимое лежит на сервере.
    """
    db, user, err = _me()
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        try:
            base = float(data.get("base") or 1)
        except (TypeError, ValueError):
            base = 1.0
        try:
            return jsonify(planlib.counts(
                data.get("doc") or {}, base, _loader(db)
            ))
        except GraphError as exc:
            return jsonify({"error": str(exc)}), 400
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Превью узла
# --------------------------------------------------------------------------- #
def _annotated(project_id):
    """Кадры проекта, на которых есть разметка. Кадр-фон превью не годится:
    на нём нечего терять, и счёт «объекты было → стало» ничего не скажет."""
    return select(Image).where(
        Image.project_id == project_id,
        select(Annotation.id).where(Annotation.image_id == Image.id).exists(),
    )


@bp.get("/api/aug/preview/projects")
def preview_projects():
    """Проекты, из которых превью может взять кадр. Первыми — те, к которым
    подключён граф: его и собирают на их кадрах."""
    db, user, err = _me()
    if err:
        return err
    try:
        graph_id = _uuid(request.args.get("graph"))
        linked = set()
        if graph_id is not None:
            linked = set(db.execute(
                select(ProjectAugGraph.project_id)
                .where(ProjectAugGraph.graph_id == graph_id)
            ).scalars())
        rows = db.execute(
            select(Project)
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .where(
                ProjectMember.user_id == user.id,
                _annotated(Project.id).exists(),
            )
            .order_by(Project.name)
        ).scalars().all()
        rows.sort(key=lambda p: p.id not in linked)
        return jsonify({"projects": [
            {"code": p.code, "name": p.name, "linked": p.id in linked}
            for p in rows
        ]})
    finally:
        db.close()


def _project_frame(db, project, image_id, salt=None):
    """(кадр, образец, классы) — заказанный кадр или случайный размеченный.
    Заказанный могли удалить с прошлого раза — тогда тоже случайный.

    ``salt`` — выбрать «случайный» по соли, а не жребием: соседние источники
    такта в превью получают свои кадры, и на каждом движении ползунка они
    меняться не должны."""
    query = _annotated(project.id)
    image = None
    if image_id is not None:
        image = db.execute(query.where(Image.id == image_id)).scalars().first()
    if image is None:
        order = (func.md5(func.concat(cast(Image.id, String), salt))
                 if salt else func.random())
        image = db.execute(query.order_by(order).limit(1)).scalars().first()
    if image is None:
        return None, None, None

    classes = db.execute(
        select(LabelClass).where(LabelClass.project_id == project.id)
        .order_by(LabelClass.class_index)
    ).scalars().all()
    index = {c.id: i for i, c in enumerate(classes)}
    picture = albu.imread_rgb(os.path.join(config.DATA_DIR, image.file_path))
    h, w = picture.shape[:2]
    boxes, polys = [], []
    # Контур едет контуром, рамка рамкой — как их разметили. Сборка боксового
    # набора свела бы контур к рамке, но смотреть надо на то, что есть.
    for ann in db.execute(
        select(Annotation).where(Annotation.image_id == image.id)
    ).scalars():
        cls = index.get(ann.class_id)
        if cls is None:
            continue
        if ann.ann_type == "polygon":
            parts = polylib.parts_of(ann.geometry or {})
            if parts:
                polys.append((cls, parts))
            continue
        line = sel_lib.box_line(cls, ann.geometry or {}, w, h)
        if line is not None:
            _, cx, cy, bw, bh = line.split()
            boxes.append((cls, float(cx), float(cy), float(bw), float(bh)))
    return (
        image,
        engine.Sample(picture, boxes, polys),
        [{"name": c.name, "color": c.color} for c in classes],
    )


@bp.post("/api/aug/preview")
def node_preview():
    """Что выходит из узла, если пустить через граф один кадр.

    Граф приходит черновиком, а не версией: иначе правку не увидеть до
    «Сохранить версию». Кадр — из проекта, где у человека есть роль, или
    нарисованный тестовый. См. ``dataprep_svc/preview.py``.
    """
    db, user, err = _me()
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        doc = data.get("doc") or {}
        if len(doc.get("nodes") or []) > schema.MAX_NODES:
            return jsonify({"error": "Слишком большой граф."}), 400
        frame = data.get("frame") or {}
        node_id = str(data.get("node") or "")
        sources = previewlib.upstream(doc, node_id)
        feed = {}

        if frame.get("project"):
            project = project_by_code(db, str(frame["project"]))
            if project is None or not has_role(role_in(db, user, project), "viewer"):
                return jsonify({"error": "Нет доступа к кадрам проекта."}), 403
            try:
                image, sample, classes = _project_frame(
                    db, project, _uuid(frame.get("image"))
                )
            except (OSError, ValueError) as exc:
                return jsonify({"error": f"Кадр не прочитался: {exc}"}), 404
            if image is None:
                return jsonify({"error": "В проекте нет размеченных кадров."}), 404
            h, w = sample.image.shape[:2]
            where = {"kind": "project", "project": project.code,
                     "project_name": project.name, "image": str(image.id),
                     "name": image.file_name, "width": w, "height": h}
            ids = [str(image.id)]
            # Такт: первый источник получает выбранный кадр, остальные — свои,
            # подобранные от него солью.
            for k, source in enumerate(sources):
                if k == 0:
                    feed[source] = sample
                    continue
                try:
                    other, extra, _ = _project_frame(
                        db, project, None, salt=f"{image.id}:{k}"
                    )
                except (OSError, ValueError):
                    other = None
                if other is not None:
                    feed[source] = extra
                    ids.append(str(other.id))
            image_id = "+".join(ids)
        else:
            classes = list(testframe.CLASSES)
            where = {"kind": "test", "width": testframe.W,
                     "height": testframe.H}
            feed = {source: testframe.sample() for source in sources}
            image_id = "test"

        loader = _loader(db)
        try:
            ins, out = previewlib.ends(doc, loader, node_id)
            compiled = engine.compile_graph(
                doc, loader, with_masks=True, trace=True
            )
            got = previewlib.run(
                compiled, feed, image_id, ins=ins, out=out,
                seed=f"preview:{int(data.get('seed') or 0)}",
            )
        except (GraphError, ValueError) as exc:
            return jsonify({"error": str(exc)}), 400

        body = {"frame": where, "classes": classes}
        if got is None:
            return jsonify({**body, "reached": False})
        return jsonify({**body, "reached": True,
                        **previewlib.describe(compiled, got,
                                              next(iter(feed.values())))})
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Графы внутри проекта
# --------------------------------------------------------------------------- #
@bp.get("/api/projects/<code>/aug")
def project_graphs(code):
    db, project, user, err = _resolve(code)
    if err:
        return err
    try:
        rows = db.execute(
            select(AugGraph)
            .join(ProjectAugGraph, ProjectAugGraph.graph_id == AugGraph.id)
            .where(ProjectAugGraph.project_id == project.id,
                   AugGraph.kind == "aug")
            .order_by(AugGraph.name)
        ).scalars().all()
        mine = db.execute(
            select(AugGraph).where(
                AugGraph.owner_id == user.id, AugGraph.kind == "aug",
                AugGraph.archived_at.is_(None),
            ).order_by(AugGraph.name)
        ).scalars().all()
        linked = {g.id for g in rows}
        return jsonify({
            "graphs": [_graph_view(db, g) for g in rows],
            "mine": [
                _graph_view(db, g) for g in mine if g.id not in linked
            ],
            "role": role_in(db, user, project),
        })
    finally:
        db.close()


@bp.post("/api/projects/<code>/aug")
def link_graph(code):
    db, project, user, err = _resolve(code, "editor")
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        graph = db.get(AugGraph, _uuid(data.get("graph_id")))
        if graph is None or graph.kind != "aug":
            return jsonify({"error": "Граф не найден."}), 404
        if db.get(ProjectAugGraph, (project.id, graph.id)) is None:
            db.add(ProjectAugGraph(
                project_id=project.id, graph_id=graph.id, created_by=user.id
            ))
            db.commit()
        return jsonify(_graph_view(db, graph)), 201
    finally:
        db.close()


@bp.delete("/api/projects/<code>/aug/<graph_id>")
def unlink_graph(code, graph_id):
    db, project, user, err = _resolve(code, "editor")
    if err:
        return err
    try:
        row = db.get(ProjectAugGraph, (project.id, _uuid(graph_id)))
        if row is not None:
            db.delete(row)
            db.commit()
        return jsonify({"ok": True})
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Обучающие наборы
# --------------------------------------------------------------------------- #
def _graph_label(db, version_id):
    """Как назвать версию графа в списке наборов. Удалённой она быть не может
    (ссылка с RESTRICT), но пересобранный набор старой версии — может."""
    version = db.get(AugGraphVersion, version_id) if version_id else None
    if version is None:
        return None
    row = db.get(AugGraph, version.graph_id)
    return {
        "id": str(version.graph_id),
        "name": row.name if row else "— удалён —",
        "version": version.version,
        "version_id": str(version.id),
    }


def _set_view(db, tset):
    rows = feeds.load(db, tset.id)
    labels = {v: _graph_label(db, v) for v in feeds.versions_of(rows)}
    # «graph» — первый граф обучающей половины. Остался ради списка наборов:
    # там одна строка на набор, и назвать в ней все графы всё равно негде.
    graph = next(
        (labels[r["graph_version_id"]] for r in rows
         if r["part"] == "train" and r["graph_version_id"]), None
    )
    job = queue.progress_of(db, queue.KIND_BUILD, tset.id)
    if job is None and tset.status == "deleting":
        job = queue.progress_of(db, queue.KIND_DELETE, tset.id)
    return {
        "id": str(tset.id),
        "name": tset.name,
        "kind": tset.kind,
        "status": tset.status,
        "split_mode": tset.split_mode,
        "val_ratio": tset.val_ratio,
        "seed": tset.seed,
        "counts": tset.counts,
        "size_bytes": tset.size_bytes,
        "hardlinked_bytes": tset.hardlinked_bytes,
        "graph": graph,
        # Имя графа рядом со строкой: в списке строк «версия 7 графа „Ночь“»
        # читается, а uuid — нет.
        "feeds": [
            {**shown, "graph": labels.get(row["graph_version_id"])}
            for row, shown in zip(rows, feeds.view(rows))
        ],
        "built_at": tset.built_at.isoformat() if tset.built_at else None,
        "created_at": tset.created_at.isoformat(),
        "error": tset.error,
        "job": job,
    }


@bp.get("/api/projects/<code>/trainsets")
def list_sets(code):
    db, project, user, err = _resolve(code)
    if err:
        return err
    try:
        rows = db.execute(
            select(TrainSet).where(TrainSet.project_id == project.id)
            .order_by(TrainSet.created_at.desc())
        ).scalars().all()
        return jsonify({
            "sets": [_set_view(db, s) for s in rows],
            "role": role_in(db, user, project),
        })
    finally:
        db.close()


@bp.post("/api/projects/<code>/trainsets/preview")
def preview_set(code):
    """Что получится при текущем выборе. Считается на каждое изменение."""
    db, project, user, err = _resolve(code)
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        sel = sel_lib.parse(data)
        picked = sel_lib.gather(db, project, sel)

        embeddings = None
        cluster_of = None
        # Замер — от групп до раскладки: именно кластеризация стоит секунды,
        # и подпись «считаю» в мастере должна обещать честное время.
        started = time.monotonic()
        if sel["split_mode"] == "smart":
            ids = [i.id for i in picked.images]
            missing = similarity.missing_for(db, ids)
            # Последний отказ — рядом с полосой. Без него сорвавшийся счёт
            # выглядел как «нажал, и ничего»: полоса на нуле, кнопка снова
            # доступна, причина только в логе воркера.
            failed = queue.last_error(db, queue.KIND_EMBED, project.id)
            embeddings = {
                "ready": len(ids) - len(missing),
                "total": len(ids),
                "missing": len(missing),
                "job": queue.progress_of(db, queue.KIND_EMBED, project.id),
                "failure": {
                    "error": failed.error,
                    "at": failed.finished_at.isoformat() if failed.finished_at else None,
                } if failed is not None and missing else None,
            }
            if not missing:
                cluster_of = similarity.clusters_for(
                    db, ids, sel.get("seed", 0)
                )

        split_of, ratio, warnings = sel_lib.assign(
            picked, sel, cluster_of=cluster_of
        )
        train = sum(1 for v in split_of.values() if v == "train")
        val = sum(1 for v in split_of.values() if v == "val")
        # Фон делится вместе со всеми, и куда он лёг — тоже результат:
        # без этой строки 580 кадров без разметки в таблице по классам
        # просто не существовали.
        background = {"train": 0, "val": 0}
        for img in picked.images:
            if not picked.anns.get(img.id):
                background[split_of.get(img.id, "train")] += 1

        # По классу считаем и кадры (для «train/val»), и объекты: первое
        # говорит, есть ли чем проверять, второе — есть ли чему учить.
        per_class = {}
        for img in picked.images:
            side = split_of.get(img.id, "train")
            seen = set()
            for ann in picked.anns.get(img.id, []):
                cid = picked.export_id.get(ann.class_id)
                if cid is None:
                    continue
                row = per_class.setdefault(
                    cid, {"train": 0, "val": 0, "annotations": 0}
                )
                row["annotations"] += 1
                if cid not in seen:
                    row[side] += 1
                    seen.add(cid)

        # Класс без проверочных кадров — предупреждение, не вмешательство:
        # умное деление держит группу целиком, и это его смысл.
        warnings.extend(sel_lib.coverage_warnings(
            (c.name, per_class.get(i, {}).get("train", 0),
             per_class.get(i, {}).get("val", 0))
            for i, c in enumerate(picked.classes)
        ))

        # Строки сборки: сколько кадров возьмёт каждая и во сколько образцов
        # превратит. Без этих чисел кнопка «Собрать» обещает вслепую — а
        # ошибка в привязке стоит часа сборки и десятков гигабайт.
        rows = feeds.parse(data.get("feeds"))
        docs = {}
        for version_id in feeds.versions_of(rows):
            version = _aug_version(db, version_id)
            if version is not None:
                docs[version_id] = version.doc
        units = feeds.plan_units(
            rows, docs.get, picked, split_of, load_version=_loader(db)
        )
        warnings.extend(feeds.cross_half_warnings(rows))
        covered = {u["part"]: set() for u in units}
        for unit in units:
            covered[unit["part"]].update(i.id for i in unit["images"])
        for part, total in (("train", train), ("val", val)):
            missed = total - len(covered.get(part, ()))
            if missed > 0:
                warnings.append(
                    f"Кадров половины «{part}», которых не берёт ни одна "
                    f"строка: {missed}. В набор они не попадут."
                )

        return jsonify({
            "images": len(picked.images),
            "train": train,
            "val": val,
            "val_ratio": round(ratio, 4),
            "feeds": [
                {
                    "part": u["part"],
                    "position": u["position"],
                    "source_node": u["source_node"],
                    "source_name": u["source_name"],
                    "feed": u["feed"],
                    "images": len(u["images"]),
                    "samples": int(round(u["expected"])),
                }
                for u in units
            ],
            "samples": int(round(sum(u["expected"] for u in units))),
            "dropped": picked.dropped,
            "no_tag": picked.no_tag,
            "background": picked.background,
            "no_size": picked.no_size,
            "wrong_kind": picked.wrong_kind,
            "classes": [
                {
                    "export_id": i,
                    "name": c.name,
                    **per_class.get(i, {"train": 0, "val": 0, "annotations": 0}),
                }
                for i, c in enumerate(picked.classes)
            ],
            "groups": len(set(cluster_of.values())) if cluster_of else None,
            "background_split": background,
            "embeddings": embeddings,
            "warnings": warnings,
            # Сколько заняло деление — мастер показывает это, пока ждёт
            # следующего ответа: две секунды тишины читаются как зависание.
            "split_ms": int((time.monotonic() - started) * 1000),
        })
    finally:
        db.close()


@bp.post("/api/projects/<code>/trainsets/embed")
def start_embed(code):
    """Заказать признаки кадров. Считает их видеокарта, а не этот сервис."""
    db, project, user, err = _resolve(code, "editor")
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        sel = sel_lib.parse(data)
        picked = sel_lib.gather(db, project, sel)
        ids = [str(i.id) for i in picked.images]
        missing = similarity.missing_for(db, [i.id for i in picked.images])
        if not missing:
            return jsonify({"ok": True, "missing": 0})
        job = queue.enqueue(
            db, project_id=project.id, kind=queue.KIND_EMBED,
            target_id=project.id, payload={"images": [str(i) for i in missing]},
            total=len(missing), user_id=user.id,
            force=bool(data.get("force")),
        )
        if job is None:
            return jsonify({
                "error": "Счёт признаков недавно не удался. Повторим позже."
            }), 409
        return jsonify({
            "ok": True, "missing": len(missing), "job_id": str(job.id),
            "images": len(ids),
        }), 202
    finally:
        db.close()


@bp.post("/api/projects/<code>/trainsets")
def create_set(code):
    db, project, user, err = _resolve(code, "editor")
    if err:
        return err
    try:
        if project.status == "importing":
            return jsonify({"error": "Проект ещё импортируется."}), 409
        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "У набора должно быть имя."}), 400
        sel = sel_lib.parse(data)
        if not sel["datasets"]:
            return jsonify({"error": "Выберите хотя бы один датасет."}), 400
        if not sel["classes"]:
            return jsonify({"error": "Выберите хотя бы один класс."}), 400
        taken = db.execute(
            select(TrainSet).where(
                TrainSet.project_id == project.id, TrainSet.name == name
            )
        ).scalar_one_or_none()
        if taken is not None:
            return jsonify({"error": "Набор с таким именем уже есть."}), 409

        rows = feeds.parse(data.get("feeds"))
        for version_id in feeds.versions_of(rows):
            if _aug_version(db, version_id) is None:
                return jsonify({"error": "Версия графа не найдена."}), 404

        seed = data.get("seed")
        try:
            seed = int(seed)
        except (TypeError, ValueError):
            # Зерно из отпечатка имени: человек его видит и может переписать,
            # а «случайное случайное» невозможно повторить и объяснить.
            seed = int(
                hashlib.sha1(f"{project.id}:{name}".encode()).hexdigest()[:12],
                16,
            )

        spec = dict(data)
        spec.pop("name", None)
        tset = TrainSet(
            project_id=project.id, name=name, kind=sel["ann_type"],
            status="queued", spec=spec, split_mode=sel["split_mode"],
            val_ratio=sel["val_ratio"], seed=seed,
            created_by=user.id,
        )
        db.add(tset)
        db.flush()
        feeds.save(db, tset.id, rows)
        db.commit()

        job = queue.enqueue(
            db, project_id=project.id, kind=queue.KIND_BUILD,
            target_id=tset.id, user_id=user.id,
        )
        if job is None:
            tset.status = "error"
            tset.error = "Сборка недавно не удалась. Повторим позже."
            db.commit()
            return jsonify({"error": tset.error}), 409
        return jsonify(_set_view(db, tset)), 202
    finally:
        db.close()


@bp.get("/api/projects/<code>/trainsets/<set_id>")
def get_set(code, set_id):
    db, project, user, err = _resolve(code)
    if err:
        return err
    try:
        tset = db.get(TrainSet, _uuid(set_id))
        if tset is None or tset.project_id != project.id:
            return jsonify({"error": "Набор не найден."}), 404
        return jsonify(_set_view(db, tset))
    finally:
        db.close()


def _palette(db, project, tset):
    """Классы набора по порядку выгрузки: имя, цвет и сколько их где.

    Имена и счётчики берём из `report.json` — он написан сборкой и говорит
    ровно про этот набор. Цвет живёт в проекте, поэтому доклеивается по имени:
    у переименованного класса цвет потеряется, и это честнее, чем показать
    чужой.
    """
    report = {}
    try:
        with open(config.trainset_report(tset.project_id, tset.id),
                  "r", encoding="utf-8") as fh:
            report = json.load(fh)
    except (OSError, ValueError):
        report = {}
    colors = {
        row.name: row.color for row in db.execute(
            select(LabelClass).where(LabelClass.project_id == project.id)
        ).scalars()
    }
    out = []
    for row in report.get("classes") or []:
        name = row.get("name") or f"класс {row.get('export_id')}"
        out.append({
            "export_id": int(row.get("export_id", len(out))),
            "name": name,
            "color": colors.get(name, "#8a8f94"),
            "train": int(row.get("train", 0)),
            "val": int(row.get("val", 0)),
            "annotations": int(row.get("annotations", 0)),
        })
    return out, report.get("warnings") or []


@bp.get("/api/projects/<code>/trainsets/<set_id>/samples")
def set_samples(code, set_id):
    """Что лежит в собранном наборе: страница образцов с отбором.

    Отбор по классам — списком через запятую и «хоть один из них»: вопрос
    человека звучит «покажи, где эти классы», а не «где ровно эти».
    """
    db, project, user, err = _resolve(code)
    if err:
        return err
    try:
        tset = db.get(TrainSet, _uuid(set_id))
        if tset is None or tset.project_id != project.id:
            return jsonify({"error": "Набор не найден."}), 404
        if tset.status != "ready":
            return jsonify({
                "error": "Набор ещё не собран — смотреть пока нечего.",
                "status": tset.status,
            }), 409

        classes, warnings = _palette(db, project, tset)
        palette = {c["export_id"]: {"name": c["name"], "color": c["color"]}
                   for c in classes}

        split = request.args.get("split") or None
        if split not in (None, "train", "val"):
            split = None
        raw = (request.args.get("classes") or "").strip()
        wanted = []
        for piece in raw.split(","):
            piece = piece.strip()
            if piece:
                try:
                    wanted.append(int(piece))
                except ValueError:
                    continue
        without = request.args.get("empty") == "1"
        try:
            limit = min(max(int(request.args.get("limit", 60)), 1), 200)
            offset = max(int(request.args.get("offset", 0)), 0)
        except ValueError:
            limit, offset = 60, 0

        root, rows = samples_lib.index(tset.project_id, tset.id)
        matched, page = samples_lib.pick(
            rows, split=split, classes=wanted, without=without,
            offset=offset, limit=limit,
        )

        out = []
        for row in page:
            # Размер образца читаем заголовком файла: слою разметки нужно
            # соотношение сторон, иначе на плитке рамки разъедутся с
            # обрезанной картинкой. Шестьдесят заголовков на страницу — это
            # миллисекунды, декодировать ничего не надо.
            width, height = samples_lib.size_of(root, row)
            out.append({
                "file": row.get("file"),
                "name": os.path.basename(row.get("file") or ""),
                "split": row.get("split"),
                "objects": int(row.get("objects") or 0),
                "image_id": row.get("image_id"),
                "width": width,
                "height": height,
                "hardlink": bool(row.get("hardlink")),
                # `sid` — путь образца по графу, `ops` — что с ним сделали.
                # Ради них набор и смотрят: видно, из чего вырос кадр.
                "sid": row.get("sid") or "",
                "ops": row.get("ops") or [],
                "boxes": samples_lib.boxes_of(
                    samples_lib.read_label(root, row), palette,
                    width or 1, height or 1,
                ),
            })
        return jsonify({
            "set": _set_view(db, tset),
            "classes": classes,
            "warnings": warnings,
            "total": len(rows),
            "matched": matched,
            "samples": out,
            "role": role_in(db, user, project),
        })
    finally:
        db.close()


@bp.get("/api/projects/<code>/trainsets/<set_id>/file")
def set_file(code, set_id):
    """Один файл собранного набора. Путь проверяется, а не берётся на веру."""
    db, project, user, err = _resolve(code)
    if err:
        return err
    try:
        tset = db.get(TrainSet, _uuid(set_id))
        if tset is None or tset.project_id != project.id:
            return jsonify({"error": "Набор не найден."}), 404
        root = config.trainset_dir(tset.project_id, tset.id)
        full = samples_lib.inside(root, request.args.get("path") or "")
        if full is None or not os.path.isfile(full):
            return jsonify({"error": "Файла нет."}), 404
        return send_file(full, conditional=True)
    finally:
        db.close()


@bp.delete("/api/projects/<code>/trainsets/<set_id>")
def delete_set(code, set_id):
    db, project, user, err = _resolve(code, "editor")
    if err:
        return err
    try:
        tset = db.get(TrainSet, _uuid(set_id))
        if tset is None or tset.project_id != project.id:
            return jsonify({"error": "Набор не найден."}), 404
        # Порядок важен: сперва состояние в базе, потом работа. Список видит
        # «удаляется» сразу, а не по итогу; сорвётся уборка — воркер
        # переведёт набор в «error» с причиной, и просьбу можно повторить.
        building = queue.find_active(db, queue.KIND_BUILD, tset.id)
        if building is not None:
            queue.cancel(db, building.id)
        tset.status = "deleting"
        tset.error = None
        db.commit()
        # force: человек попросил явно, и прошлый отказ он видел в строке
        # набора — «недавно не удалась» здесь не довод.
        job = queue.enqueue(
            db, project_id=project.id, kind=queue.KIND_DELETE,
            target_id=tset.id, user_id=user.id, force=True,
        )
        live.notify(db, "prep", job.id if job else tset.id, project.id,
                    s="deleting")
        return jsonify(_set_view(db, tset)), 202
    finally:
        db.close()


@bp.get("/api/projects/<code>/dataprep/jobs")
def list_jobs(code):
    """Что сейчас делается с данными проекта — для полос на экране."""
    db, project, user, err = _resolve(code)
    if err:
        return err
    try:
        rows = db.execute(
            select(DataprepJob).where(
                DataprepJob.project_id == project.id,
                DataprepJob.status.in_(queue.ACTIVE),
            ).order_by(DataprepJob.priority, DataprepJob.created_at)
        ).scalars().all()
        return jsonify({"jobs": [
            {
                "id": str(j.id),
                "kind": j.kind,
                "target_id": str(j.target_id),
                "status": j.status,
                "processed": j.progress,
                "total": j.total,
                "stage": j.stage,
                "stage_text": j.stage_text,
            }
            for j in rows
        ]})
    finally:
        db.close()


@bp.get("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "service": "dataprep",
        "albumentations": albu.available(),
    })
