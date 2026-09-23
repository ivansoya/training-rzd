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

Один и тот же `id` дважды (скопировали рамку) — прежнее авторство достаётся
первой, вторая считается новой.

Рамка, пришедшая со своим `id`, сохраняет и сам `id`. Иначе после первого же
сохранения у всех рамок кадра были бы новые номера, редактор слал бы старые,
и второе сохранение того же кадра стирало бы авторство агента молча.
"""


def settle(existing, incoming, user_id):
    """`existing` — {id: {class_id, ann_type, geometry, source, created_by,
    agent_version_id}}; `incoming` — [{id, class_id, ann_type, geometry,
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
                rows.append({"id": item["id"], **{k: old[k] for k in (
                    "class_id", "ann_type", "geometry", "source",
                    "created_by", "agent_version_id")}})
                continue
            rows.append({
                "id": item["id"],
                "class_id": item["class_id"], "ann_type": item["ann_type"],
                "geometry": item["geometry"], "source": "human",
                "created_by": user_id,
                "agent_version_id": old["agent_version_id"],
            })
            continue
        rows.append({
            "id": None,
            "class_id": item["class_id"], "ann_type": item["ann_type"],
            "geometry": item["geometry"],
            "source": "model" if item.get("source") == "model" else "human",
            "created_by": user_id, "agent_version_id": None,
        })
    return rows
