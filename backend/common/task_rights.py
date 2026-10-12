"""Кто что может в таске: по состоянию, роли в проекте и составу исполнителей.

Решение 12.10.2026. До него состояние таски ни на что не влияло, кроме
«закрыто». Без базы — общее для datasets и training и закрывается таблицей случаев.
"""

# Переходы, которые вообще имеют смысл. Всё остальное — ошибка в интерфейсе.
MOVES = {
    "queued": {"in_progress", "closed"},
    "in_progress": {"done", "queued", "closed"},
    "done": {"updating", "closed"},
    "updating": {"done", "closed"},
    "closed": set(),
}
# В них идёт работа над кадрами; на очереди только готовят материал.
WORK = ("in_progress", "updating")


def _editor(role):
    return role in ("editor", "admin")


def can_edit(status, role, me, assignees):
    """Работа над кадрами: разметка, состояния кадров, агенты, разведка.
    Админ работает и без назначения, но тоже только «в работе»."""
    return status in WORK and _editor(role) and (role == "admin" or me in assignees)


def can_fill(status, role, me, assignees, author):
    """Источники: загрузка, план нарезки, удаление ролика, таги ролика, имя.
    На очереди ещё и автор — иначе в свою ничью таску не загрузить."""
    if status == "queued":
        return _editor(role) and (role == "admin" or me in assignees or me == author)
    return can_edit(status, role, me, assignees)


def can_tag_frame(status, role, me, assignees):
    """Таг — паспорт кадра: админ правит и в «Готово», и в закрытой таске."""
    return role == "admin" or can_edit(status, role, me, assignees)


def moves(status, role, me, assignees):
    """Куда этот человек может перевести таску."""
    if not _editor(role):
        return set()
    if role == "admin":
        return set(MOVES[status])
    if status == "queued":
        # Ничью берёт любой редактор, назначенную — только её люди.
        return {"in_progress"} if not assignees or me in assignees else set()
    if me not in assignees:
        return set()
    return MOVES[status] - {"closed"}


def joins_on_take(status, target, assignees):
    """Взявший ничью таску с очереди становится её исполнителем; к назначенным не добавляют."""
    return status == "queued" and target == "in_progress" and not assignees


def rights(status, role, me, assignees, author):
    """Всё сразу — для ответа клиенту."""
    return {
        "edit": can_edit(status, role, me, assignees),
        "fill": can_fill(status, role, me, assignees, author),
        "tag_frames": can_tag_frame(status, role, me, assignees),
        "moves": sorted(moves(status, role, me, assignees)),
        "assign": role == "admin" and status != "closed",
    }
