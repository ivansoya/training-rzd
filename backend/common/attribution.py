"""Чья рамка после сохранения кадра.

Сохранение кадра заменяет его разметку целиком — так автосохранение остаётся
атомарным. Но стереть и вставить заново значит потерять автора: до агентов
каждая рамка становилась рамкой того, кто нажал «сохранить», и это было
неважно. Теперь важно — рамка агента подписана «Иван, агент „Путеец“ v3».

Правило, решённое владельцем:

* рамка пришла с тем же `id`, класс и геометрия те же — авторство прежнее;
* тот же `id`, но сдвинута или перекрашена — рамка теперь того, кто правил
  (`source='human'`), а версия агента остаётся происхождением;
* новая рамка — того, кто сохранил. Её `source` берётся у клиента (так
  полуавтомат помечает свои), но **версию агента клиент задать не может**:
  иначе любой запрос подписал бы рамку чужим агентом.

Проверка (`pending`) идёт за правкой: нетронутая рамка агента ждёт проверки
дальше, поправленная — проверена (человек её посмотрел и сдвинул), новая —
проверена. «Подтвердить кадр» — `pending: false` у рамки от клиента или
`confirm` на весь кадр; поставить флаг клиент не может.

Кто снял рамку агента с проверки — `reviewed_by`: подтвердил её или поправил.
У проверенной рамки он переживает следующие сохранения.

Один и тот же `id` дважды (скопировали рамку) — прежнее авторство достаётся
первой, вторая считается новой.

Рамка, пришедшая со своим `id`, сохраняет и сам `id`. Иначе после первого же
сохранения у всех рамок кадра были бы новые номера, редактор слал бы старые,
и второе сохранение того же кадра стирало бы авторство агента молча.

Непроверенная рамка с `id`, которого в базе уже нет, не пишется: её стёрли
очисткой или прогоном, а устаревший редактор вернул бы её проверенной.

Ctrl+Z (решение 20.10.2026) — запись с пометкой «отмена»: рамка возвращается той прежней
версией, что совпала с присланной (класс, фигура, флаг проверки), — автором-агентом и «на
проверке», и своё «Принять» отменяется. Версии откладывает своя же запись кадра (`keep_versions`)
и держит час; стёртое очисткой, прогоном агента и чужой записью отменой не воскресает.
"""
import uuid
from datetime import timedelta

UNDO_SECONDS = 3600
_ROW = ("class_id", "ann_type", "geometry", "source", "created_by", "agent_version_id", "attributes")
_IDS = ("class_id", "created_by", "agent_version_id", "reviewed_by")


def _shape_same(a, b):
    return a["class_id"] == b["class_id"] and a["ann_type"] == b["ann_type"] and a["geometry"] == b["geometry"]


def _back(restore, item, old):
    """Прежняя версия, которую просит отмена; None — просить нечего или рамка и так такая."""
    if not restore or not item.get("id"):
        return None
    want = bool(item.get("pending"))
    if old is not None and _shape_same(old, item) and bool(old.get("pending")) == want:
        return None
    return next((v for v in restore.get(item["id"], [])
                 if _shape_same(v, item) and bool(v.get("pending")) == want), None)


def settle(existing, incoming, user_id, confirm=False, restore=None):
    """`existing` — {id: {class_id, ann_type, geometry, source, created_by,
    agent_version_id, pending, reviewed_by}}; `incoming` — [{id, class_id, ann_type, geometry,
    source}]. Возвращает строки для вставки по порядку `incoming`: те же поля, что у
    `existing`, или None — рамку не писать. `restore` — {id: [прежние версии]} у записи-отмены."""
    used = set()
    rows = []
    for item in incoming:
        old = existing.get(item.get("id"))
        back = _back(restore, item, old)
        if back is not None and item["id"] not in used:
            used.add(item["id"])
            pending = bool(back.get("pending")) and not confirm
            rows.append({"id": item["id"], **{k: back.get(k) for k in _ROW}, "pending": pending,
                         "reviewed_by": back.get("reviewed_by") if pending or not back.get("pending") else user_id})
            continue
        if old is None and item.get("id") and item.get("pending") and not confirm:
            rows.append(None)
            continue
        if old is not None and item["id"] not in used:
            used.add(item["id"])
            same = (old["class_id"] == item["class_id"]
                    and old["ann_type"] == item["ann_type"]
                    and old["geometry"] == item["geometry"])
            if same:
                # attributes (conf, оценка SAM) — только у нетронутой: после
                # правки они уже не про эту геометрию. У рамок видео колонки нет.
                # Клиент может только снять флаг (`pending: false`), поставить — нет.
                pending = bool(old.get("pending")) and not confirm and item.get("pending") is not False
                rows.append({"id": item["id"], **{k: old[k] for k in (
                    "class_id", "ann_type", "geometry", "source",
                    "created_by", "agent_version_id", "attributes") if k in old},
                    "pending": pending,
                    "reviewed_by": old.get("reviewed_by") if pending or not old.get("pending") else user_id})
                continue
            rows.append({
                "id": item["id"],
                "class_id": item["class_id"], "ann_type": item["ann_type"],
                "geometry": item["geometry"], "source": "human",
                "created_by": user_id,
                "agent_version_id": old["agent_version_id"],
                "pending": False,
                # Поправил рамку агента — значит, посмотрел её: это тоже проверка.
                "reviewed_by": (user_id if old.get("pending") else old.get("reviewed_by"))
                if old["agent_version_id"] else None,
            })
            continue
        rows.append({
            "id": None,
            "class_id": item["class_id"], "ann_type": item["ann_type"],
            "geometry": item["geometry"],
            "source": "model" if item.get("source") == "model" else "human",
            "created_by": user_id, "agent_version_id": None,
            "pending": False, "reviewed_by": None,
        })
    return rows


def keep_versions(db, existing, settled, user_id):
    """Отложить прежние версии рамок, которые эта запись кадра стирает или меняет, — для Ctrl+Z.
    Звать до вставки (`settled` ещё с `id`); заодно убирается отложенное старше часа."""
    from sqlalchemy import delete

    from common.models import AnnotationVersion, utcnow

    now = {r["id"]: r for r in settled if r and r.get("id")}
    for ann_id, old in existing.items():
        new = now.get(ann_id)
        if new is not None and all(new.get(k) == old.get(k) for k in (*_ROW, "pending", "reviewed_by")):
            continue
        row = {k: (str(v) if isinstance(v, uuid.UUID) else v) for k, v in old.items()}
        db.add(AnnotationVersion(ann_id=uuid.UUID(ann_id), row=row, saved_by=user_id))
    db.execute(delete(AnnotationVersion).where(AnnotationVersion.saved_at < utcnow() - timedelta(seconds=UNDO_SECONDS)))


def versions(db, ids, user_id):
    """{id: [версии]} — отложенное своими записями за час, свежие первыми; номера — снова UUID."""
    from sqlalchemy import select

    from common.models import AnnotationVersion, utcnow

    want = []
    for i in ids:
        try:
            want.append(uuid.UUID(str(i)))
        except ValueError:
            continue
    if not want:
        return {}
    out = {}
    for v in db.execute(
        select(AnnotationVersion).where(
            AnnotationVersion.ann_id.in_(want), AnnotationVersion.saved_by == user_id,
            AnnotationVersion.saved_at >= utcnow() - timedelta(seconds=UNDO_SECONDS),
        ).order_by(AnnotationVersion.saved_at.desc())
    ).scalars():
        row = {k: (uuid.UUID(v.row[k]) if k in _IDS and v.row.get(k) else v.row.get(k)) for k in v.row}
        out.setdefault(str(v.ann_id), []).append(row)
    return out


def agent_names(db, version_ids):
    """{agent_version_id: {id, name, version}} — подпись «агент „Путеец“ v3»;
    `id` — агент: панель редактора группирует его рамки на кадре."""
    from sqlalchemy import select

    from common.models import AugGraph, AugGraphVersion

    if not version_ids:
        return {}
    return {
        version.id: {"id": str(graph.id), "name": graph.name, "version": version.version}
        for version, graph in db.execute(
            select(AugGraphVersion, AugGraph)
            .join(AugGraph, AugGraph.id == AugGraphVersion.graph_id)
            .where(AugGraphVersion.id.in_(version_ids))
        ).all()
    }
