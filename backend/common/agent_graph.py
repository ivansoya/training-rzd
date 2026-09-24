"""Граф агента разметки: форма, классы и прогон одного кадра.

По проводу идёт образец «кадр плюс обнаружения». «Кадр» начинает поток с
пустым списком, «Сеть» дописывает к пришедшему свои обнаружения,
«Объединение» сводит ветки, «NMS» гасит дубли, «Выход» — то, что ляжет в
разметку.

**Номер класса сети дальше «Сети» не идёт.** У каждой сети своя нумерация:
`0` у детектора вагонов и `0` у детектора пути — разные вещи. Узел переводит
номер в имя класса агента по своей таблице, и дальше по проводу обнаружение
несёт только имя. Одно имя у двух сетей — один класс, и «NMS» гасит дубли
между ними; разные имена смешивает только галочка «Между классами».

**Гашение дублей — отдельный узел, и ставит его оператор.** Сети без NMS
(yolo26) отдают по две рамки на объект, а ultralytics для них NMS не
запускает вовсе. Прятать гашение внутрь «Сети» решили не делать (24.09.2026):
кто заливает веса, знает, какие они, а всё гашение видно на холсте.

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
import math
import statistics

KINDS = ("frame", "net", "merge", "nms", "filter", "sam", "output")
MAX_NODES = 100
MAX_INPUTS = 8
# Порог «NMS» по умолчанию. У РСМ yolo26n дубли перекрыты на 0,76–0,99, и
# 0,5–0,7 дали на 151 кадре одинаковый итог; 0,6 оставляет запас настоящим
# объектам, стоящим вплотную.
NMS_IOU = 0.6
# Одна ли это рамка у разных проходов TTA.
FUSE_IOU = 0.55

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
    names = {"frame": "Кадр", "net": "Сеть", "merge": "Объединение", "nms": "NMS",
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
    if kind in ("net", "nms", "filter", "sam"):
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
        if node["type"] == "nms":
            threshold = _num((node.get("params") or {}).get("iou"), NMS_IOU)
            if threshold is None or not 0 < threshold <= 1:
                raise AgentGraphError(f"{title(node)}: IoU — число больше 0 и не больше 1.")

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


def nms(dets, threshold=NMS_IOU, agnostic=False):
    """Из перекрытых рамок остаётся самая уверенная, координаты не
    усредняются. По умолчанию — внутри одного класса агента: «вагон» и
    «цистерна» на одном объекте — два мнения, а не дубль. `agnostic` —
    галочка «Между классами»: мнения спорят, и побеждает уверенное."""
    kept = []
    for det in sorted(dets, key=lambda d: -d["conf"]):
        if all((not agnostic and k["cls"] != det["cls"]) or iou(k["box"], det["box"]) < threshold
               for k in kept):
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


# --------------------------------------------------------------------------- #
# Плитки и TTA узла «Сеть»
#
# Плитка — ровно вход сети в пикселях кадра, без масштаба: ради этого плитки и
# режут — чтобы мелкий объект не ужимался вместе с кадром 2688×1520 до 1280.
# Целый кадр идёт отдельным проходом всегда: крупный объект плитка режет, и
# его половинки нашлись бы двумя обрывками.
#
# Сводятся проходы в два шага, и шаги разные нарочно. Проходы TTA смотрят на
# один вид — их рамки на объекте почти совпадают, поэтому WBF: координаты
# усредняются, уверенность делится на число проходов, и случайная находка
# одного прохода из шести не выдаётся за уверенную. Виды (кадр и плитки)
# видят объект по-разному — целиком и обрывками, у обрывка с целым IoU мал,
# и NMS его не погасит; поэтому склейка по доле перекрытия меньшей рамки в
# охватывающую, как GREEDYNMM у SAHI.
# --------------------------------------------------------------------------- #
TILE_OVERLAP = 0.2
GLUE_IOS = 0.5
TTA_SCALES = (0.8, 1.25)


def tiles(width, height, side, overlap=TILE_OVERLAP):
    """Плитки (x0, y0, x1, y1). Кадр не больше плитки — плиток нет."""
    if width <= side and height <= side:
        return []

    def starts(length):
        if length <= side:
            return [0]
        n = math.ceil((length - side) / (side * (1 - overlap))) + 1
        return [round(i * (length - side) / (n - 1)) for i in range(n)]

    return [(x, y, min(width, x + side), min(height, y + side))
            for y in starts(height) for x in starts(width)]


def variants(params):
    """Проходы TTA на вид: [(отражение, масштаб входа)]; первый — как есть."""
    scales = (1.0, *TTA_SCALES) if params.get("tta_scales") else (1.0,)
    flips = (False, True) if params.get("tta_flip") else (False,)
    return [(f, s) for s in scales for f in flips]


def views(params, width, height, side):
    """Виды кадра: целый первым, затем плитки, если они включены."""
    whole = [(0, 0, width, height)]
    if not params.get("tiles"):
        return whole
    overlap = _num(params.get("overlap"), TILE_OVERLAP)
    return whole + tiles(width, height, side, max(0.0, min(0.9, overlap)))


def ios(a, b):
    """Пересечение к площади меньшей рамки: обрывок внутри целой — 1."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    small = min(aw * ah, bw * bh)
    return ix * iy / small if small > 0 else 0.0


def wbf(dets, passes, threshold=FUSE_IOU):
    """Взвешенное слияние проходов одного вида. `dets` — [(cls, conf, box)] всех
    проходов вместе; уверенность итога — средняя по членам, умноженная на долю
    проходов, что объект увидели."""
    clusters = []   # [cls, [members], fused_box]
    for cls, conf, box in sorted(dets, key=lambda d: -d[1]):
        home = next((c for c in clusters if c[0] == cls and iou(c[2], box) >= threshold), None)
        if home is None:
            clusters.append([cls, [(conf, box)], box])
            continue
        home[1].append((conf, box))
        total = sum(c for c, _ in home[1])
        home[2] = tuple(sum(c * b[k] for c, b in home[1]) / total for k in range(4))
    out = []
    for cls, members, box in clusters:
        mean = sum(c for c, _ in members) / len(members)
        out.append((cls, mean * min(len(members), passes) / passes, box))
    return out


def glue(dets, threshold=GLUE_IOS):
    """Склейка видов: рамки одного класса, где меньшая перекрыта на `threshold`,
    заменяются охватывающей с наибольшей уверенностью."""
    kept = []
    for cls, conf, box in sorted(dets, key=lambda d: -d[1]):
        home = next((k for k in kept if k[0] == cls and ios(k[2], box) >= threshold), None)
        if home is None:
            kept.append([cls, conf, box])
            continue
        (ax, ay, aw, ah), (bx, by, bw, bh) = home[2], box
        x0, y0 = min(ax, bx), min(ay, by)
        home[2] = (x0, y0, max(ax + aw, bx + bw) - x0, max(ay + ah, by + bh) - y0)
    return [tuple(k) for k in kept]


def detect(params, width, height, side, infer):
    """Все проходы одной «Сети» по кадру → [(номер, уверенность, x, y, w, h)].

    `infer(jobs, scale)` — сеть: `jobs` — [(вид, отражён ли)], ответ — по списку
    рамок на каждый в координатах самого вырезка (отражённого, если отражён).
    Масштаб один на вызов, чтобы воркер гнал вырезки одной пачкой.
    """
    vs = views(params, width, height, side)
    var = variants(params)
    per_view = [[] for _ in vs]
    for scale in dict.fromkeys(s for _, s in var):
        jobs = [(i, flip) for i in range(len(vs)) for flip, s in var if s == scale]
        answers = infer([(vs[i], flip) for i, flip in jobs], scale)
        for (i, flip), found in zip(jobs, answers):
            x0, y0, x1, _ = vs[i]
            for cls, conf, x, y, w, h in found:
                if flip:
                    x = (x1 - x0) - x - w
                per_view[i].append((int(cls), float(conf), (x + x0, y + y0, w, h)))
    if len(var) > 1:
        per_view = [wbf(dets, len(var)) for dets in per_view]
    fused = [d for dets in per_view for d in dets]
    if len(vs) > 1:
        fused = glue(fused, _num(params.get("glue"), GLUE_IOS))
    return [(cls, conf, *box) for cls, conf, box in fused]


def run(doc, predict, order=None, segment=None, trace=None):
    """Прогнать один кадр. Возвращает обнаружения «Выхода»:
    [{"id", "cls": имя класса агента, "conf": float, "box": (x, y, w, h)}] и,
    после SAM, ещё `parts` — обводка кольцами точек и `sam` — оценка маски.

    `id` — «узел сети.номер»: по нему превью видит, что узел отсеял. `trace`,
    если передан, получает {узел: {"in": [...], "out": [...]}}."""
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
                {"id": f"{nid}.{k}", "cls": table[int(c)], "conf": float(conf), "box": (x, y, w, h)}
                for k, (c, conf, x, y, w, h) in enumerate(predict(node))
                if int(c) in table
            ]
            value[nid] = ins[0] + own
        elif kind == "merge":
            value[nid] = [d for branch in ins for d in branch]
        elif kind == "nms":
            params = node.get("params") or {}
            value[nid] = nms(ins[0], _num(params.get("iou"), NMS_IOU), bool(params.get("agnostic")))
        elif kind == "filter":
            value[nid] = filter_dets(ins[0], node.get("params") or {})
        elif kind == "sam":
            # Без `segment` — разведка: ей нужны где и что, а не контур, и SAM
            # на каждой рамке каждого кадра только тратил бы время.
            params = node.get("params") or {}
            value[nid] = ([outline(d, *segment(node, d["box"]), params) for d in ins[0]]
                          if segment else ins[0])
        else:
            result = value[nid] = ins[0]
        if trace is not None:
            trace[nid] = {"in": [d for branch in ins for d in branch], "out": value[nid]}
    return result


# --------------------------------------------------------------------------- #
# Ролик: какие кадры смотреть и как собрать разведку в участки
# --------------------------------------------------------------------------- #
VIDEO_STEP = 25
SCOUT_GAP_S = 2.0


def sampled(last_frame, step, skip=()):
    """Каждый `step`-й кадр от нуля до `last_frame` включительно, кроме `skip`."""
    step = max(1, int(step))
    skip = set(skip)
    return [f for f in range(0, int(last_frame) + 1, step) if f not in skip]


def segments(hits, step, gap_frames, last_frame):
    """Попадания разведки → участки по классам агента.

    `hits` — {кадр: {классы}} по проверенным кадрам. Два попадания одного
    класса — один участок, если пустоты между ними не больше `gap_frames`:
    объект мог на миг загородиться, а сеть — моргнуть. Края расширяются на
    полшага: участок покрывает момент, а не только проверенные кадры.
    Возвращает {класс: [[от, до, попаданий], ...]} — кадры включительно.
    """
    half = max(1, int(step)) // 2
    by_cls = {}
    for frame in sorted(hits):
        for cls in hits[frame]:
            by_cls.setdefault(cls, []).append(frame)
    out = {}
    for cls, frames in by_cls.items():
        spans = []
        for f in frames:
            if spans and f - spans[-1][1] - step <= gap_frames:
                spans[-1][1] = f
                spans[-1][2] += 1
            else:
                spans.append([f, f, 1])
        out[cls] = [[max(0, a - half), min(int(last_frame), b + half), n] for a, b, n in spans]
    return out


def scout_stats(frames):
    """Разведка ролика числами — для окна статистики.

    `frames` — как лежит в `video_scouts.frames`: {кадр: [[класс, уверенность,
    x, y, w, h], ...]} по каждому проверенному кадру, пустые тоже. Считается
    на сервере: у часового ролика тысячи кадров, и гнать их в браузер ради
    десятка чисел незачем.

    По классу — рамки, кадры с ним, сколько одновременно, уверенность
    (медиана, разброс, гистограмма по десятым — по ней ставят порог
    «Фильтра»), медианный размер (по нему решают про плитки) и счёт по
    каждому проверенному кадру для полосы «по времени». Классы — по числу
    рамок, при равенстве по имени.
    """
    checked = sorted(int(f) for f in frames)
    per_frame = [len(frames[str(f)]) for f in checked]
    by_cls = {}
    for i, f in enumerate(checked):
        for cls, conf, _x, _y, w, h in frames[str(f)]:
            row = by_cls.setdefault(cls, {"counts": [0] * len(checked), "conf": [], "w": [], "h": []})
            row["counts"][i] += 1
            row["conf"].append(float(conf))
            row["w"].append(w)
            row["h"].append(h)
    out = []
    for name, row in by_cls.items():
        confs = sorted(row["conf"])
        hist = [0] * 10
        for p in confs:
            hist[min(9, int(p * 10))] += 1
        out.append({
            "name": name,
            "boxes": len(confs),
            "frames": sum(1 for n in row["counts"] if n),
            "max": max(row["counts"]),
            "conf": {"median": round(statistics.median(confs), 3), "min": confs[0], "max": confs[-1],
                     "hist": hist},
            "size": [round(statistics.median(row["w"])), round(statistics.median(row["h"]))],
            "counts": row["counts"],
        })
    out.sort(key=lambda c: (-c["boxes"], c["name"]))
    top = max(per_frame, default=0)
    return {
        "checked": checked,
        "with_hits": sum(1 for n in per_frame if n),
        "boxes": sum(per_frame),
        "max": top,
        "max_at": checked[per_frame.index(top)] if top else None,
        "per_frame": per_frame,
        "classes": out,
    }
