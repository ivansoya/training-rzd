"""Размеры кадров проектов — для тайлинга агентов: число тайлов зависит от кадра.

Кадр ролика считается раз на каждый `VIDEO_STEP`-й кадр — столько их смотрит
агент, — а картинка таски или датасета один раз.
"""
from sqlalchemy import func, select

from common.agent_graph import VIDEO_STEP
from common.models import Image, ProjectMember, Task, TaskVideo


def _counts(db, project_ids):
    """{проект: {(ширина, высота): сколько кадров}}."""
    out = {}
    for pid, w, h, n in db.execute(
        select(Image.project_id, Image.width, Image.height, func.count())
        .where(Image.project_id.in_(project_ids), Image.width > 0, Image.height > 0)
        .group_by(Image.project_id, Image.width, Image.height)
    ).all():
        sizes = out.setdefault(pid, {})
        sizes[(w, h)] = sizes.get((w, h), 0) + n
    for pid, w, h, frames in db.execute(
        select(Task.project_id, TaskVideo.width, TaskVideo.height, TaskVideo.frame_count)
        .join(Task, Task.id == TaskVideo.task_id)
        .where(Task.project_id.in_(project_ids), TaskVideo.width > 0, TaskVideo.height > 0)
    ).all():
        sizes = out.setdefault(pid, {})
        sizes[(w, h)] = sizes.get((w, h), 0) + max(1, (frames or 0) // VIDEO_STEP)
    return out


def summary(sizes):
    """{(w, h): n} → {"w", "h", "share", "largest": [w, h]} или None:
    самый частый размер, его доля и самый большой кадр."""
    if not sizes:
        return None
    (w, h), n = max(sizes.items(), key=lambda kv: (kv[1], kv[0][0] * kv[0][1]))
    big = max(sizes, key=lambda s: s[0] * s[1])
    return {"w": w, "h": h, "share": round(n / sum(sizes.values()), 3), "largest": list(big)}


def of_projects(db, project_ids):
    """{проект: summary}."""
    return {pid: summary(s) for pid, s in _counts(db, list(project_ids)).items()}


def largest(db, project_ids):
    """(ширина, высота) самого большого кадра или None."""
    sizes = {s for per in _counts(db, list(project_ids)).values() for s in per}
    return max(sizes, key=lambda s: s[0] * s[1]) if sizes else None


def largest_for_user(db, user_id):
    """Самый большой кадр во всех проектах человека: агент не привязан к
    проекту, и версию проверяем на худшем кадре, где её могут запустить."""
    ids = db.execute(select(ProjectMember.project_id).where(ProjectMember.user_id == user_id)).scalars().all()
    return largest(db, ids) if ids else None

