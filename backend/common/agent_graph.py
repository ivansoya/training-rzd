"""Граф агента разметки: форма, классы и прогон одного кадра.

По проводу идёт образец «кадр плюс обнаружения». «Кадр» начинает поток с
пустым списком, «Сеть» дописывает к пришедшему свои обнаружения, «Объединение»
сводит ветки и гасит дубли, «Выход» — то, что ляжет в разметку.

**Номер класса сети дальше «Сети» не идёт.** У каждой сети своя нумерация:
`0` у детектора вагонов и `0` у детектора пути — разные вещи. Узел переводит
номер в имя класса агента по своей таблице, и дальше по проводу обнаружение
несёт только имя. Одно имя у двух сетей — один класс, и «Объединение» гасит
дубли между ними; разные имена не смешиваются никогда.

«Фильтр» режет по порогу своего класса и по размеру рамки. «Уточнение SAM»
дописывает обнаружению обводку (`parts`) и подтягивает рамку к маске; не
справился SAM — обнаружение идёт дальше рамкой, как пришло: сеть объект
нашла, и терять находку из-за неудачной маски незачем, человек всё равно
смотрит каждый кадр.

Чистый модуль, без базы и torch: его читают и `dataprep` (проверка при
сохранении версии), и `training-worker` (прогон), а закрывается он числами.
Сеть сюда приходит функцией `predict(node) -> [(номер, уверенность, x, y, w, h)]`,
SAM — функцией `segment(node, box) -> (маски, оценки)`.
"""

KINDS = ("frame", "net", "merge", "filter", "sam", "output")
MAX_NODES = 100
MAX_INPUTS = 8
MERGE_IOU = 0.55

# Тот же список, что у полуавтомата (autolabel_svc/runners/sam2_runner.py).
SAM_MODELS = ("sam2.1_hiera_tiny", "sam2.1_hiera_small",
              "sam2.1_hiera_base_plus", "sam2.1_hiera_large")
# Настройки по умолчанию — как у полуавтомата в редакторе таски: ткнул
# человек той же рамкой с теми же настройками — получил тот же контур.
SAM_DEFAULTS = {"model": "sam2.1_hiera_small", "detail": "auto", "score_min": 0.3,
                "min_area": 64, "fill_holes": True, "polygon_points": 64}
# Маска меньше этой доли рамки — SAM очертил не объект, а пятнышко на нём.
MASK_MIN_SHARE = 0.05
# Маска, вылезшая за рамку, обрезается по рамке с таким запасом: сеть нередко
# режет край объекта, и запас даёт маске его вернуть, но не утечь на соседа.
MASK_SLACK = 0.10


class AgentGraphError(ValueError):
    """Ошибка формы. Текст показывается человеку целиком."""


def title(node):
    names = {"frame": "Кадр", "net": "Сеть", "merge": "Объединение",
             "filter": "Фильтр", "sam": "Уточнение SAM", "output": "Выход"}
    label = (node.get("params") or {}).get("label")
    base = names.get(node.get("type"), str(node.get("type")))
    return f"«{base} — {label}»" if label else f"«{base}»"


def inputs_count(node):
    try:
        n = int((node.get("params") or {}).get("inputs", 2))
    except (TypeError, ValueError):
        n = 2
    return max(2, min(MAX_INPUTS, n))


def ports(node):
    kind = node.get("type")
    if kind == "frame":
        return [], ["out"]
    if kind in ("net", "filter", "sam"):
        return ["in"], ["out"]
    if kind == "merge":
        return [f"i{i}" for i in range(inputs_count(node))], ["out"]
    if kind == "output":
        return ["in"], []
    raise AgentGraphError(f"Неизвестный узел: {kind!r}")


def net_classes(node):
    """Таблица сети: [(номер, имя класса агента)] — только включённые."""
    out = []
    for i, row in enumerate((node.get("params") or {}).get("classes") or []):
        if not isinstance(row, dict) or not row.get("on"):
            continue
        name = str(row.get("agent") or "").strip()
        if name:
            out.append((i, name))
    return out


def classes(doc):
    """Классы агента по порядку появления: [{name, sources: [(узел, номер)]}].

    Производные от графа: сменили веса или галочку — список другой. Поэтому
    сопоставление с проектом держится за имена, а не за номера.
    """
    found = {}
    for node in doc.get("nodes") or []:
        if node.get("type") != "net":
            continue
        for i, name in net_classes(node):
            found.setdefault(name, []).append((node["id"], i))
    return [{"name": n, "sources": s} for n, s in found.items()]


def check(doc, weights=None):
    """Проверить форму. `weights` — {id: число классов в весах} у владельца;
    без него файлы весов не сверяются (черновик, тесты).

    Возвращает узлы в порядке прогона.
    """
    if not isinstance(doc, dict):
        raise AgentGraphError("Граф должен быть объектом.")
    nodes, edges = doc.get("nodes"), doc.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise AgentGraphError("В графе должны быть списки узлов и связей.")
    if len(nodes) > MAX_NODES:
        raise AgentGraphError(f"В агенте {len(nodes)} узлов — больше {MAX_NODES} нельзя.")

    by_id = {}
    for node in nodes:
        if not isinstance(node, dict) or not node.get("id"):
            raise AgentGraphError("У каждого узла должен быть свой номер.")
        if node["id"] in by_id:
            raise AgentGraphError(f"Номер узла повторяется: {node['id']}.")
        if node.get("type") not in KINDS:
            raise AgentGraphError(f"{title(node)}: неизвестный тип {node.get('type')!r}.")
        by_id[node["id"]] = node

    for kind, word in (("frame", "«Кадра»"), ("output", "«Выхода»")):
        count = sum(1 for n in nodes if n["type"] == kind)
        if count != 1:
            raise AgentGraphError(f"В агенте должен быть ровно один узел {word}, сейчас {count}.")

    taken_in, taken_out = {}, set()
    for edge in edges:
        src, dst = by_id.get(edge.get("from")), by_id.get(edge.get("to"))
        if src is None or dst is None:
            raise AgentGraphError(f"Связь ведёт в никуда: {edge}.")
        if edge.get("out") not in ports(src)[1]:
            raise AgentGraphError(f"{title(src)}: нет выходного гнезда {edge.get('out')!r}.")
        if edge.get("in") not in ports(dst)[0]:
            raise AgentGraphError(f"{title(dst)}: нет входного гнезда {edge.get('in')!r}.")
        key = (dst["id"], edge["in"])
        if key in taken_in:
            raise AgentGraphError(f"{title(dst)}: в одно гнездо приходят два провода.")
        taken_in[key] = src["id"]
        taken_out.add(src["id"])

    for node in nodes:
        for name in ports(node)[0]:
            if (node["id"], name) not in taken_in:
                raise AgentGraphError(f"{title(node)}: вход {name!r} ни к чему не подключён.")
        if node["type"] != "output" and node["id"] not in taken_out:
            raise AgentGraphError(f"{title(node)}: выход никуда не ведёт.")
        if node["type"] == "net":
            params = node.get("params") or {}
            wid = params.get("weights")
            if not wid:
                raise AgentGraphError(f"{title(node)}: не выбраны веса.")
            if weights is not None:
                if wid not in weights:
                    raise AgentGraphError(f"{title(node)}: этих весов нет на вашей полке.")
                if len(params.get("classes") or []) != weights[wid]:
                    raise AgentGraphError(
                        f"{title(node)}: таблица классов не совпадает с весами — "
                        "выберите веса заново.")
            if not net_classes(node):
                raise AgentGraphError(f"{title(node)}: не включён ни один класс.")
        if node["type"] == "sam":
            model = (node.get("params") or {}).get("model") or SAM_DEFAULTS["model"]
            if model not in SAM_MODELS:
                raise AgentGraphError(f"{title(node)}: неизвестная модель {model!r}.")

    order = _topo(nodes, taken_in)
    if order is None:
        raise AgentGraphError("Провода образуют кольцо.")
    if not classes(doc):
        raise AgentGraphError("У агента нет ни одного класса.")
    return order


def _topo(nodes, taken_in):
    need = {n["id"]: 0 for n in nodes}
    feeds = {}
    for (dst, _), src in taken_in.items():
        need[dst] += 1
        feeds.setdefault(src, []).append(dst)
    ready = [n["id"] for n in nodes if need[n["id"]] == 0]
    order = []
    while ready:
        nid = ready.pop(0)
        order.append(nid)
        for nxt in feeds.get(nid, ()):
            need[nxt] -= 1
            if need[nxt] == 0:
                ready.append(nxt)
    return order if len(order) == len(nodes) else None


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def nms(dets, threshold=MERGE_IOU):
    """Дубли гасятся только внутри одного класса агента: «вагон» и «цистерна»
    на одном объекте — два мнения, а не дубль, и решает их не этот узел."""
    kept = []
    for det in sorted(dets, key=lambda d: -d["conf"]):
        if all(k["cls"] != det["cls"] or iou(k["box"], det["box"]) < threshold for k in kept):
            kept.append(det)
    return kept


def _num(value, default=None):
    try:
        return default if value is None or value == "" else float(value)
    except (TypeError, ValueError):
        return default


def filter_dets(dets, params):
    """Порог и галочка — по имени класса агента; класса нет в таблице —
    проходит: фильтр режет только то, что ему велели, и добавленный выше
    класс не пропадёт молча. Размер — меньшая сторона не меньше `min_side`,
    большая не больше `max_side`, в пикселях кадра."""
    rows = {r.get("cls"): r for r in params.get("classes") or [] if isinstance(r, dict)}
    lo, hi = _num(params.get("min_side")), _num(params.get("max_side"))
    out = []
    for det in dets:
        row = rows.get(det["cls"])
        if row is not None and (not row.get("on", True) or det["conf"] < _num(row.get("conf"), 0.0)):
            continue
        _, _, w, h = det["box"]
        if (lo is not None and min(w, h) < lo) or (hi is not None and max(w, h) > hi):
            continue
        out.append(det)
    return out


def outline(det, masks, scores, params):
    """Обнаружение после SAM: с обводкой и рамкой по маске — или как было.

    Выбор маски, чистка и обводка — те же, что у полуавтомата
    (`common.contours`). Своё здесь только обрезка по рамке с запасом и
    решение «SAM не справился»."""
    import numpy as np

    from common import contours

    p = {**SAM_DEFAULTS, **{k: v for k, v in (params or {}).items() if v is not None}}
    mask, score = contours.pick_mask(masks, scores, p["detail"])
    if score < float(p["score_min"]):
        return det
    x, y, w, h = det["box"]
    dx, dy = w * MASK_SLACK, h * MASK_SLACK
    x0, y0 = max(0, int(x - dx)), max(0, int(y - dy))
    x1, y1 = int(np.ceil(x + w + dx)), int(np.ceil(y + h + dy))
    clipped = np.zeros_like(mask)
    clipped[y0:y1, x0:x1] = mask[y0:y1, x0:x1]
    clipped = contours.clean_mask(clipped, int(p["min_area"]), bool(p["fill_holes"]))
    if clipped.sum() < MASK_MIN_SHARE * w * h:
        return det
    parts = contours.polygons_from_mask(clipped, int(p["polygon_points"]))
    if not parts:
        return det
    return {**det, "box": contours.mask_bounds(clipped), "parts": parts, "sam": round(score, 3)}


def run(doc, predict, order=None, segment=None):
    """Прогнать один кадр. Возвращает обнаружения «Выхода»:
    [{"cls": имя класса агента, "conf": float, "box": (x, y, w, h)}] и, после
    SAM, ещё `parts` — обводка кольцами точек и `sam` — оценка маски."""
    by_id = {n["id"]: n for n in doc["nodes"]}
    order = order or check(doc)
    feeds = {(e["to"], e["in"]): e["from"] for e in doc["edges"]}
    value = {}
    result = []
    for nid in order:
        node = by_id[nid]
        ins = [value[feeds[(nid, name)]] for name in ports(node)[0]]
        kind = node["type"]
        if kind == "frame":
            value[nid] = []
        elif kind == "net":
            table = dict(net_classes(node))
            own = [
                {"cls": table[int(c)], "conf": float(conf), "box": (x, y, w, h)}
                for c, conf, x, y, w, h in predict(node)
                if int(c) in table
            ]
            value[nid] = ins[0] + own
        elif kind == "merge":
            threshold = float((node.get("params") or {}).get("iou", MERGE_IOU))
            value[nid] = nms([d for branch in ins for d in branch], threshold)
        elif kind == "filter":
            value[nid] = filter_dets(ins[0], node.get("params") or {})
        elif kind == "sam":
            params = node.get("params") or {}
            value[nid] = [outline(d, *segment(node, d["box"]), params) for d in ins[0]]
        else:
            result = ins[0]
    return result
