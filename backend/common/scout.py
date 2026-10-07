"""Разведка ролика для показа и «В разметку».

Находки хранятся по имени класса агента (`video_scouts.frames`). Чтобы
нарисовать их цветом проекта и взять в разметку, класс агента сводится к
классу проекта тем же путём, что и при запуске: ссылка на класс проекта —
намертво, иначе запомненное сопоставление пары «агент + проект».
"""
from sqlalchemy import select

from common import agent_graph
from common.models import AgentClassMap, AugGraphVersion, LabelClass


def classes(db, scout, project_id):
    """{имя класса агента: класс проекта (LabelClass) или None}."""
    version = db.get(AugGraphVersion, scout.version_id) if scout.version_id else None
    if version is None:
        return {}
    project = {c.id: c for c in db.execute(
        select(LabelClass).where(LabelClass.project_id == project_id)).scalars()}
    by_str = {str(k): v for k, v in project.items()}
    saved = db.get(AgentClassMap, (version.graph_id, project_id))
    remembered = (saved.mapping or {}) if saved else {}
    out = {}
    for c in agent_graph.classes(version.doc):
        ref = (c.get("ref") or {}).get("cls")
        target = ref if ref in by_str else remembered.get(c["id"])
        out[c["name"]] = by_str.get(str(target)) if target else None
    return out


def class_view(found):
    """Для клиента: {имя класса агента: {class_index, name, color} | None}."""
    return {name: ({"class_index": c.class_index, "name": c.name, "color": c.color} if c else None)
            for name, c in found.items()}
