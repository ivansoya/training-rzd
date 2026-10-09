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
"""


def settle(existing, incoming, user_id, confirm=False):
    """`existing` — {id: {class_id, ann_type, geometry, source, created_by,
    agent_version_id, pending, reviewed_by}}; `incoming` — [{id, class_id, ann_type, geometry,
    source}]. Возвращает строки для вставки: те же поля, что у `existing`."""
    used = set()
    rows = []
    for item in incoming:
        old = existing.get(item.get("id"))
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
