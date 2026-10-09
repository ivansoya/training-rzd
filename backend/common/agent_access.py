"""Агент — личный, но подключается к проекту ссылкой (решение 09.10.2026).

Правит только владелец. Участники проекта, к которому агент подключён, видят
его, открывают только на чтение и запускают на тасках; веса и образцы берутся
с полки владельца по id. Копия забирает зависимости себе: веса — строкой на
своей полке с жёсткой ссылкой на тот же файл, наборы образцов — новыми
строками с папкой из жёстких ссылок. Тогда прежний владелец может чистить
полку, не ломая чужую копию.

Общий модуль, потому что смотрят сюда и dataprep (графы), и training (запуск).
"""
import copy
import os
import shutil
import uuid

from sqlalchemy import select

from common import agent_graph, config
from common.models import (
    AgentExamples, AgentWeights, AugGraph, ProjectAugGraph, ProjectMember,
)

# Полка весов и наборов образцов — та же, что у training_svc (agents.SHELF, examples.SHELF).
SHELF = os.path.join(config.DATA_DIR, "_weights", "users")


def projects_of(db, graph_id):
    """Проекты, к которым агент подключён."""
    return set(db.execute(
        select(ProjectAugGraph.project_id).where(ProjectAugGraph.graph_id == graph_id)
    ).scalars())


def attached(db, graph, project_id) -> bool:
    return db.get(ProjectAugGraph, (project_id, graph.id)) is not None


def may_view(db, user, graph) -> bool:
    """Открыть агента: свой — всегда, чужой — если он в общем проекте."""
    if graph is None or graph.kind != "agent" or user is None:
        return False
    if graph.owner_id == user.id:
        return True
    shared = projects_of(db, graph.id)
    if not shared:
        return False
    return db.execute(
        select(ProjectMember.project_id).where(
            ProjectMember.user_id == user.id, ProjectMember.project_id.in_(shared)
        ).limit(1)
    ).first() is not None


def may_use(db, user, graph, project) -> bool:
    """Запустить на таске проекта: свой агент или подключённый к этому проекту.
    Права на саму таску (исполнитель, admin) проверяет вызывающий."""
    if graph is None or graph.kind != "agent" or graph.archived_at is not None:
        return False
    return graph.owner_id == user.id or attached(db, graph, project.id)


def _free_name(db, owner_id, name):
    """Имя копии, не занятое у нового владельца: «X», «X (копия)», «X (копия 2)»…"""
    taken = set(db.execute(select(AugGraph.name).where(
        AugGraph.owner_id == owner_id, AugGraph.kind == "agent", AugGraph.archived_at.is_(None)
    )).scalars())
    if name not in taken:
        return name
    for k in range(1, 1000):
        cand = f"{name} (копия{'' if k == 1 else ' ' + str(k)})"[:160]
        if cand not in taken:
            return cand
    return f"{name} {uuid.uuid4().hex[:6]}"[:160]


def _link(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst):
        return
    try:
        os.link(src, dst)
    except OSError:
        shutil.copyfile(src, dst)


def _own_weights(db, row, user_id):
    """Веса на полке `user_id`: та же строка, тот же файл у него, или новая строка-ссылка."""
    if row.owner_id == user_id:
        return row
    same = db.execute(select(AgentWeights).where(
        AgentWeights.owner_id == user_id, AgentWeights.sha256 == row.sha256)).scalar_one_or_none()
    if same is not None:
        return same
    final = os.path.join(SHELF, str(user_id), f"{row.sha256}.pt")
    _link(os.path.join(config.DATA_DIR, row.file_path), final)
    got = AgentWeights(
        owner_id=user_id, name=row.name, sha256=row.sha256,
        file_path=os.path.relpath(final, config.DATA_DIR), size_bytes=row.size_bytes,
        task=row.task, imgsz=row.imgsz, names=list(row.names or []),
        source_run_id=row.source_run_id, created_by=user_id,
    )
    db.add(got)
    db.flush()
    return got


def _own_examples(db, row, user_id):
    """Набор образцов на полке `user_id`: новая строка, папка — жёсткими ссылками."""
    if row.owner_id == user_id:
        return row
    got = AgentExamples(
        owner_id=user_id, parent_id=None, project_id=row.project_id, project_name=row.project_name,
        class_id=row.class_id, class_name=row.class_name, params=copy.deepcopy(row.params),
        items=copy.deepcopy(row.items), dir="", status=row.status, error=row.error,
        created_by=user_id,
    )
    db.add(got)
    db.flush()
    out = os.path.join(SHELF, str(user_id), "examples", str(got.id))
    os.makedirs(out, exist_ok=True)
    src = os.path.join(config.DATA_DIR, row.dir) if row.dir else None
    if src and os.path.isdir(src):
        for name in os.listdir(src):
            _link(os.path.join(src, name), os.path.join(out, name))
    got.dir = os.path.relpath(out, config.DATA_DIR)
    return got


def copy_doc(db, doc, user_id):
    """Документ агента с весами и образцами, переложенными на полку `user_id`.
    Пропавшие зависимости остаются ссылками как есть — проверка версии скажет."""
    doc = copy.deepcopy(doc)
    for node in doc.get("nodes") or []:
        params = node.get("params") or {}
        if node.get("type") == "net" and params.get("weights"):
            row = db.get(AgentWeights, _uuid(params["weights"]))
            if row is not None:
                params["weights"] = str(_own_weights(db, row, user_id).id)
        if node.get("type") == "text":
            for prompt in params.get("prompts") or []:
                if isinstance(prompt, dict) and agent_graph.is_examples(prompt) and prompt.get("set"):
                    row = db.get(AgentExamples, _uuid(prompt["set"]))
                    if row is not None:
                        prompt["set"] = str(_own_examples(db, row, user_id).id)
    return doc


def new_copy(db, graph, doc, user):
    """Новый граф-агент `user` из документа `doc` (уже после `copy_doc`).
    Версию пишет вызывающий — у dataprep для этого свои проверки."""
    got = AugGraph(owner_id=user.id, kind="agent", name=_free_name(db, user.id, graph.name),
                   description=graph.description, created_by=user.id)
    db.add(got)
    db.flush()
    got.draft = doc
    return got


def _uuid(value):
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None
