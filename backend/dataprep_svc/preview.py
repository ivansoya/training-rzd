"""Превью узла: что выходит из выбранного узла, если пустить через граф один кадр.

Превью честное — тот же ``engine.run_frame`` и то же зерно, что при сборке.
Картинка, которую оно показывает, и есть та, что ляжет в набор; «лучший
случай» с вероятностями, выкрученными в единицу, рано или поздно обманул бы.

Честность упирается в разделители. Кадр с номером 0 по долям всегда уходит в
первую ветку, и превью второй ветки было бы вечно пустым. Поэтому номер кадра
(и зерно — от него зависит вероятностный разделитель) подбирается: граф
прогоняется вхолостую, без трансформов, пока образец не дойдёт до узла. Это
дёшево — картинки при холостом прогоне не трогаются. Подобранный номер —
законный: в сборке у кадра тоже какой-то номер, превью просто берёт такой, при
котором есть что показать.

Считающая часть не знает ни базы, ни файлов — закрыта числами в
``tests/unit/test_node_preview.py``.
"""
import copy

from dataprep_svc import engine
from dataprep_svc.graph import schema

# ponytail: восемь образцов на ответ — при ×60 считать все значило бы секунды
# на каждый сдвиг ползунка. Нужно больше — листать страницами с сервера.
LIMIT = 8
# Сколько номеров перебрать, прежде чем сказать «кадр сюда не доходит».
TRIES = 64


def ends(doc, load_version, node_id):
    """Узлы развёрнутого графа, где у выбранного узла вход и выход.

    У обычного узла это он сам. «Блок» после развёртки исчезает: вместо него
    внутренности с приставкой ``<блок>/``, а его гнёзда становятся пустыми
    «Потоками» — входы и выход вложенного графа.
    """
    node = next((n for n in doc.get("nodes") or [] if n.get("id") == node_id),
                None)
    if node is None:
        raise schema.GraphError("Такого узла в графе нет.")
    if node.get("type") != "group":
        return [node_id], node_id
    params = node.get("params") or {}
    inner = load_version(params.get("graph_id"), params.get("version_id"))
    if inner is None:
        raise schema.GraphError(f"{schema.node_title(node)}: вложенный граф не найден.")
    ids = {"input": [], "output": []}
    for n in inner.get("nodes") or []:
        if n.get("type") in ids:
            ids[n["type"]].append(f"{node_id}/{n['id']}")
    if not ids["output"]:
        raise schema.GraphError(f"{schema.node_title(node)}: у блока нет выхода.")
    return ids["input"], ids["output"][0]


def upstream(doc, node_id):
    """«Источники» корневого графа, из которых есть путь к узлу. Превью
    показывает такт: каждый из них получает свой кадр, как при сборке."""
    seen, stack = {node_id}, [node_id]
    edges = doc.get("edges") or []
    while stack:
        at = stack.pop()
        for e in edges:
            if e.get("to") == at and e.get("from") not in seen:
                seen.add(e["from"])
                stack.append(e["from"])
    return [n["id"] for n in doc.get("nodes") or []
            if n.get("type") == "source" and n["id"] in seen]


def arriving(compiled, at_port, node_id):
    """Образцы, пришедшие на входы узла."""
    ins, _ = schema.ports(compiled.by_id[node_id])
    return [
        item
        for name in ins
        for e in compiled.in_edges.get((node_id, name), ())
        for item in at_port.get((e["from"], e["out"]), ())
    ]


def leaving(compiled, at_port, node_id):
    """Образцы на выходах узла. У «Выхода» гнёзд нет — у него это пришедшее."""
    node = compiled.by_id[node_id]
    if node["type"] in schema.SINKS:
        return arriving(compiled, at_port, node_id)
    _, outs = schema.ports(node)
    return [item for name in outs for item in at_port.get((node_id, name), ())]


def trail(item):
    """Шаги, которыми получен образец, от источника к нему."""
    steps = []
    while item is not None:
        if item.step is not None:
            steps.append(item.step)
        item = item.prev
    return steps[::-1]


def run(compiled, feed, image_id, *, ins, out, seed, limit=LIMIT):
    """Прогнать такт ``feed`` ({источник: образец}) и снять образцы с выхода
    узла ``out``.

    Возвращает ``None``, если кадр до узла не доходит ни при каком номере
    (узел не подключён или ветка с нулевой долей), иначе словарь:
    ``shown`` — до ``limit`` пар (образец, его вход в узел), ``total`` — все
    образцы узла, ``dropped`` — {узел: сколько образцов потеряли разметку}.
    """
    if not feed:
        return None
    dry = copy.copy(compiled)
    dry.pipelines = {}
    for attempt in range(TRIES):
        chosen = seed if attempt == 0 else f"{seed}.{attempt}"
        for sample in feed.values():
            sample.ordinal = attempt
        peek = {}
        engine.run_frame(dry, None, chosen, image_id, feed=feed, peek=peek)
        if leaving(dry, peek, out):
            break
    else:
        return None

    peek, dropped = {}, {}

    def lost(node_id, _why):
        dropped[node_id] = dropped.get(node_id, 0) + 1

    engine.run_frame(compiled, None, chosen, image_id, feed=feed,
                     peek=peek, on_drop=lost)
    made = leaving(compiled, peek, out)
    entering = {id(x) for n in ins for x in arriving(compiled, peek, n)}
    shown = []
    for item in made[:limit]:
        # Вход узла — ближайший предок, который на вход и пришёл. Для
        # «Слияния» и разделителя это сам образец: они картинку не трогают.
        before = item
        while before is not None and id(before) not in entering:
            before = before.prev
        if before is None:
            before = item
            while before.prev is not None:
                before = before.prev
        shown.append((item, before))
    return {"shown": shown, "total": len(made), "dropped": dropped}


# --------------------------------------------------------------------------- #
# Ответ браузеру
# --------------------------------------------------------------------------- #
def shapes_of(item, scale):
    """Разметка образца в пикселях картинки, какой её получит браузер."""
    h, w = item.image.shape[:2]
    out = []
    for cls, cx, cy, bw, bh in item.boxes:
        out.append({"c": int(cls), "box": [
            round((cx - bw / 2) * w * scale, 1), round((cy - bh / 2) * h * scale, 1),
            round(bw * w * scale, 1), round(bh * h * scale, 1),
        ]})
    for cls, parts in item.polys:
        out.append({"c": int(cls), "rings": [
            [[round(x * scale, 1), round(y * scale, 1)] for x, y in ring]
            for ring in parts
        ]})
    return out


def jpeg_url(image, max_side=1280, quality=85):
    """Картинка для браузера и во сколько раз её уменьшили.

    Через граф кадр идёт в полном размере — размытие и шум albumentations
    считает в пикселях, и на уменьшенном кадре они выглядели бы сильнее, чем в
    наборе. Уменьшается только готовое.
    """
    import base64

    import cv2

    h, w = image.shape[:2]
    scale = min(1.0, max_side / max(h, w))
    if scale < 1.0:
        image = cv2.resize(image, (round(w * scale), round(h * scale)),
                           interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(image, cv2.COLOR_RGB2BGR),
                           [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("Не удалось сжать картинку превью.")
    return "data:image/jpeg;base64," + base64.b64encode(buf).decode(), scale


def describe(compiled, got, original):
    """Всё, что нужно доку превью. Одна и та же картинка уходит один раз:
    вход у копий «Умножения» общий, и слать его восемь раз незачем."""
    pics, index = [], {}

    def pic(item):
        key = id(item.image)
        if key not in index:
            url, scale = jpeg_url(item.image)
            h, w = item.image.shape[:2]
            index[key] = (len(pics), scale)
            pics.append({"url": url, "w": round(w * scale), "h": round(h * scale)})
        at, scale = index[key]
        return {"pic": at, "shapes": shapes_of(item, scale),
                "objects": len(item.boxes) + len(item.polys)}

    def step_view(step):
        node = compiled.by_id.get(step["node"]) or {}
        view = dict(step, ops=[o["op"] for o in engine._ops_of(node)])
        return view

    return {
        "pics": pics,
        "original": pic(original),
        "total": got["total"],
        "dropped": got["dropped"],
        "samples": [
            {
                "sid": item.sid,
                "after": pic(item),
                "before": pic(before),
                "trail": [step_view(s) for s in trail(item)],
            }
            for item, before in got["shown"]
        ],
    }
