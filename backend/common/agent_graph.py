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

«Сеть по тексту» — та же «Сеть», только классы заданы словами: строка
таблицы — «промт → класс агента», модель — встроенная YOLOE-26 или SAM 3.
Отдельный узел, а не режим «Сети» (решение владельца 24.09.2026): по графу
видно, где своя обученная сеть, а где открытый словарь, и строгая сверка
таблицы «Сети» с весами не обрастает исключениями. SAM 3 сразу дописывает
контур — прогонять после него ещё и «Уточнение SAM» значило бы платить дважды.
Строка таблицы бывает словом или набором образцов (`common.agent_examples`),
и у каждой свой порог: у образцов и слов разные шкалы уверенности.

Чистый модуль, без базы и torch: его читают и `dataprep` (проверка при
сохранении версии), и `training-worker` (прогон), а закрывается он числами.
Сеть сюда приходит функцией `predict(node) -> [(номер, уверенность, x, y, w, h)]`
(у SAM 3 седьмым — контур или None), SAM — `segment(node, box) -> (маски, оценки)`.
"""
import copy
import math
import statistics
import time

KINDS = ("frame", "net", "text", "merge", "nms", "filter", "sam", "output")
# Узлы, которые сами находят объекты: номер класса переводят в имя агента.
FINDERS = ("net", "text")
MAX_NODES = 100
MAX_INPUTS = 8
# Порог «NMS» по умолчанию. У РСМ yolo26n дубли перекрыты на 0,76–0,99, и
# 0,5–0,7 дали на 151 кадре одинаковый итог; 0,6 оставляет запас настоящим
# объектам, стоящим вплотную.
NMS_IOU = 0.6

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

# «Сеть по тексту». Размер n не даём: на редких словах он промахивается, а
# промты у нас как раз такие. Умолчание l — по замеру на «РСМ-2000 · тест»
# m и l равны, x не лучше, а 69 мс на кадр не жалко.
TEXT_MODELS = ("s", "m", "l", "x", "sam3")
TEXT_MODEL = "l"
# Шкалы уверенности у моделей разные: у SAM 3 при 0,25 людей он находит с
# точностью 0,81, при 0,4 — 0,92, а полнота почти та же (замер 24.09.2026).
TEXT_CONF = {"yoloe": 0.25, "sam3": 0.4}
# Вход YOLOE: кадры РСМ 2688×1520, на 640 мелочь пропадает.
TEXT_IMGSZ = 1280

# Пределы числовых параметров узлов: поле → (подпись в форме, от, до, целое).
# Одно место на сервер: `check` сверяет по нему версию и превью, форма
# (agentDoc.ts, LIMITS) повторяет те же числа. Без пределов сохранялись «Сеть»
# с уверенностью 7 и входом 0, а вход 1 с тайлами давал 6,4 млн видов на кадр.
# Число тайлов на кадр сверх того держит `MAX_PASSES`.
_CONF = ("Уверенность от", 0, 1, False)
_IMGSZ = ("Размер входа", 320, 4096, True)
_PASSES = {"tile": ("Тайл, px", 160, 4096, True),
           "overlap": ("Перекрытие тайлов", 0, 0.9, False),
           "glue": ("Склейка от, IoS", 0.05, 1, False)}
# Как у полуавтомата в редакторе таски: точек контура 8–200.
_CONTOUR = {"polygon_points": ("Точек до", 8, 200, True),
            "min_area": ("Кусок от, px²", 0, 1_000_000, True)}
LIMITS = {
    "net": {"conf": _CONF, "imgsz": _IMGSZ, **_PASSES},
    "text": {"conf": ("Порог узла", 0, 1, False), "imgsz": _IMGSZ, **_PASSES, **_CONTOUR},
    "merge": {"inputs": ("Входов", 2, MAX_INPUTS, True)},
    "nms": {"iou": ("IoU от", 0.05, 1, False)},
    "filter": {"min_side": ("Сторона от, px", 0, 100_000, True),
               "max_side": ("Сторона до, px", 1, 100_000, True)},
    "sam": {"score_min": ("Порог маски", 0, 1, False), **_CONTOUR},
}


class AgentGraphError(ValueError):
    """Ошибка формы. Текст показывается человеку целиком."""


def title(node):
    names = {"frame": "Кадр", "net": "Сеть", "text": "Сеть по тексту", "merge": "Объединение",
             "nms": "NMS", "filter": "Фильтр", "sam": "Уточнение SAM", "output": "Выход"}
    label = str((node.get("params") or {}).get("label") or "").strip()
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
    if kind in ("net", "text", "nms", "filter", "sam"):
        return ["in"], ["out"]
    if kind == "merge":
        return [f"i{i}" for i in range(inputs_count(node))], ["out"]
    if kind == "output":
        return ["in"], []
    raise AgentGraphError(f"Неизвестный узел: {kind!r}")


def is_examples(row):
    return row.get("kind") == "examples"


def _row_target(row):
    """Что ищет строка «Сети по тексту»: промт или id набора; пусто — ничего."""
    return str((row.get("set") if is_examples(row) else row.get("prompt")) or "").strip()


def net_classes(node):
    """Таблица сети: [(номер строки, имя класса агента)] — только включённые.
    У «Сети по тексту» строка без промта или без набора не считается: искать
    нечего."""
    params = node.get("params") or {}
    text = node.get("type") == "text"
    out = []
    for i, row in enumerate(params.get("prompts" if text else "classes") or []):
        if not isinstance(row, dict) or not row.get("on"):
            continue
        if text and not _row_target(row):
            continue
        name = str(row.get("agent") or "").strip()
        if name:
            out.append((i, name))
    return out


# SAM 3 держит на карте всё разом: ~150 МБ на промт сверх базы (замер: 1 промт —
# 3,2 ГБ, 20 — 6,2, 40 — 10,6). Строк больше 16 — превью уходит за карту.
SAM3_BASE_MB = 3000
SAM3_PER_PROMPT_MB = 150
SAM3_MAX_ROWS = 16
YOLOE_MB = 1500


def text_vram_mb(node) -> int:
    """Сколько видеопамяти просить под узел «Сети по тексту»."""
    if text_model(node.get("params")) != "sam3":
        return YOLOE_MB
    return SAM3_BASE_MB + SAM3_PER_PROMPT_MB * len(text_rows(node))


def text_rows(node):
    """[(номер строки, строка)] включённых строк «Сети по тексту» — в этом
    порядке классы и уходят в модель: её номер k — это `text_rows[k]`."""
    rows = (node.get("params") or {}).get("prompts") or []
    return [(i, rows[i]) for i, _ in net_classes(node)]


def text_prompts(node):
    """[(номер строки, промт)] только строк-слов."""
    return [(i, str(r.get("prompt")).strip()) for i, r in text_rows(node) if not is_examples(r)]


def text_sets(node):
    """[(номер строки, id набора)] только строк-образцов."""
    return [(i, str(r.get("set")).strip()) for i, r in text_rows(node) if is_examples(r)]


def row_conf(node, row):
    """Порог строки; пусто — порог узла."""
    own = num(row.get("conf"))
    return own if own is not None else text_conf(node.get("params"))


def min_conf(node):
    """С каким порогом гнать модель: дорезает каждую строку уже `run`."""
    return min([row_conf(node, r) for _, r in text_rows(node)] or [text_conf(node.get("params"))])


def text_model(params):
    model = (params or {}).get("model") or TEXT_MODEL
    return model if model in TEXT_MODELS else TEXT_MODEL


def text_conf(params):
    family = "sam3" if text_model(params) == "sam3" else "yoloe"
    return num((params or {}).get("conf"), TEXT_CONF[family])


# --------------------------------------------------------------------------- #
# Список классов агента
#
# С 06.10.2026 классы агента — свой список в документе (`classes`), а строки
# узлов и «Фильтра» ссылаются на класс по id: переименование класса не рвёт
# узлы. Класс бывает своим или ссылкой на класс проекта (`ref`): в том проекте
# он сопоставляется сам. Имена в списке уникальны без учёта регистра — по
# имени класс сопоставляется в чужом проекте и подписывается в разведке.
#
# Движок (прогон, NMS, «Фильтр», разведка) по-прежнему работает с именами:
# `prepare` раскладывает имя класса в строки, и всё ниже его не замечает.
# Документы до списка (`classes` нет) переводит `upgrade` — в той же раскладке
# цветов, что давал порядок появления, поэтому на холсте ничего не перекрасится.
# --------------------------------------------------------------------------- #
PALETTE = ("#5AB0FF", "#E28CFF", "#7EE0C3", "#FF9F5A", "#F5D76E", "#9ED36A",
           "#FF7AA8", "#B48CFF", "#6FD6FF", "#FFB3A1", "#C8C1FF", "#8FE3A8")
CLASS_NAME_MAX = 60


def _fold(name):
    return str(name or "").strip().casefold()


def _rows(node):
    params = node.get("params") or {}
    rows = params.get("prompts" if node.get("type") == "text" else "classes") or []
    return [r for r in rows if isinstance(r, dict)]


def upgrade(doc):
    """Документ без списка классов → со списком. Новый возвращается как есть."""
    if not isinstance(doc, dict) or isinstance(doc.get("classes"), list):
        return doc
    doc = copy.deepcopy(doc)
    nodes = [n for n in doc.get("nodes") or [] if isinstance(n, dict)]
    table, out = {}, []
    for node in nodes:
        if node.get("type") in FINDERS:
            for _, name in net_classes(node):
                if _fold(name) not in table:
                    table[_fold(name)] = {"id": f"c{len(out) + 1}", "name": name.strip(),
                                          "color": PALETTE[len(out) % len(PALETTE)]}
                    out.append(table[_fold(name)])
    for node in nodes:
        if node.get("type") in FINDERS:
            for row in _rows(node):
                hit = table.get(_fold(row.get("agent")))
                # Выключенная строка без своего класса хранит имя подсказкой:
                # включат — класс найдётся или заведётся по нему.
                if hit:
                    row["cls"] = hit["id"]
                    row.pop("agent", None)
        elif node.get("type") == "filter":
            params = node.get("params") or {}
            params["classes"] = [{**r, "cls": table[_fold(r.get("cls"))]["id"]} for r in _rows(node)
                                 if _fold(r.get("cls")) in table]
    doc["classes"] = out
    return doc


def prepare(doc):
    """Документ для проверки и прогона: `upgrade`, затем строкам узлов — имя
    класса (`agent`), строкам «Фильтра» — имя вместо id. Повторный вызов на
    готовом ничего не меняет."""
    doc = copy.deepcopy(upgrade(doc))
    if not isinstance(doc, dict) or doc.get("prepared"):
        return doc
    names = {c.get("id"): str(c.get("name") or "").strip()
             for c in doc.get("classes") or [] if isinstance(c, dict)}
    for node in doc.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        if node.get("type") in FINDERS:
            for row in _rows(node):
                row["agent"] = names.get(row.get("cls"), "")
        elif node.get("type") == "filter":
            for row in _rows(node):
                row["cls"] = names.get(row.get("cls"), "")
    doc["prepared"] = True
    return doc


def classes(doc):
    """Используемые классы агента в порядке списка: [{id, name, color, ref,
    sources: [(узел, номер строки)]}]. Класс без включённой строки сюда не
    попадает — разметки он не даст, и сопоставлять его незачем."""
    doc = prepare(doc)
    used = {}
    for node in doc.get("nodes") or []:
        if node.get("type") not in FINDERS:
            continue
        rows = (node.get("params") or {}).get("prompts" if node["type"] == "text" else "classes") or []
        for i, _ in net_classes(node):
            used.setdefault(rows[i].get("cls"), []).append((node["id"], i))
    return [{"id": c["id"], "name": c["name"], "color": c.get("color"), "ref": c.get("ref"),
             "sources": used[c["id"]]}
            for c in doc.get("classes") or [] if isinstance(c, dict) and c.get("id") in used]


def _check_classes(doc):
    """Список классов: id и имена уникальны, включённые строки ссылаются на
    существующий класс."""
    seen_id, seen_name = set(), {}
    for c in doc.get("classes") or []:
        if not isinstance(c, dict) or not str(c.get("id") or "").strip():
            raise AgentGraphError("У каждого класса агента должен быть свой номер.")
        name = str(c.get("name") or "").strip()
        if not name:
            raise AgentGraphError("У класса агента пустое имя.")
        if len(name) > CLASS_NAME_MAX:
            raise AgentGraphError(f"Имя класса агента длиннее {CLASS_NAME_MAX} символов — «{name[:24]}…».")
        if c["id"] in seen_id:
            raise AgentGraphError(f"Номер класса агента повторяется: {c['id']}.")
        if _fold(name) in seen_name:
            raise AgentGraphError(f"Класс агента «{name}» повторяется — имена различаются не только регистром.")
        seen_id.add(c["id"])
        seen_name[_fold(name)] = name
    for node in doc.get("nodes") or []:
        if node.get("type") not in FINDERS:
            continue
        text = node.get("type") == "text"
        for row in _rows(node):
            if row.get("on") and (not text or _row_target(row)) and row.get("cls") not in seen_id:
                raise AgentGraphError(f"{title(node)}: включена строка без класса агента.")


def check(doc, weights=None, sam3=None, examples=None, clamp=False, frame=None, inputs=None):
    """Проверить форму. `weights` — {id: число классов в весах} у владельца;
    без него файлы весов не сверяются (черновик, тесты). `sam3` — лежат ли
    веса SAM 3 на томе; None — не сверять. `examples` — {id набора: готов ли}
    у владельца; None — не сверять. `clamp` — числа вне `LIMITS` не отвергать,
    а зажимать в пределы (правит `doc` на месте): так запускаются версии,
    сохранённые до появления пределов. Документ со списком классов приходит
    уже через `prepare`. `frame` — (ширина, высота) самого
    большого кадра, на нём сверяется потолок проходов; `inputs` — {id весов:
    вход}, из него умолчание тайла у «Сети».

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
        # Числа — раньше проводов: «Входов 9» иначе всплыло бы как «вход i2
        # ни к чему не подключён» — правдой, но не про то.
        _check_numbers(node, clamp)
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
        if node["type"] == "text":
            _check_text(node, sam3, examples)
        if node["type"] in FINDERS and frame:
            w, h = frame
            net_in = (inputs or {}).get((node.get("params") or {}).get("weights"))
            n = passes(node, w, h, net_in)
            if n > MAX_PASSES:
                raise AgentGraphError(
                    f"{title(node)}: тайл {tile_side(node, net_in)} на кадре {w}×{h} — {n} проходов, "
                    f"больше {MAX_PASSES} нельзя.")
        if node["type"] == "sam":
            model = (node.get("params") or {}).get("model") or SAM_DEFAULTS["model"]
            if model not in SAM_MODELS:
                raise AgentGraphError(f"{title(node)}: неизвестная модель {model!r}.")

    if isinstance(doc.get("classes"), list):
        _check_classes(doc)
    order = _topo(nodes, taken_in)
    if order is None:
        raise AgentGraphError("Провода образуют кольцо.")
    if not classes(doc):
        raise AgentGraphError("У агента нет ни одного класса.")
    return order


def _decimal(v):
    return f"{v:g}".replace(".", ",")


def _check_numbers(node, clamp=False):
    """Числа узла — в пределах `LIMITS`. Пусто — умолчание, это не ошибка.
    С `clamp` неверное зажимается в пределы, а нечисло сбрасывается в умолчание."""
    params = node.get("params") or {}
    for key, (label, lo, hi, whole) in LIMITS.get(node["type"], {}).items():
        raw = params.get(key)
        if raw is None or raw == "":
            continue
        value = None if isinstance(raw, bool) else num(raw)
        if value is None or not lo <= value <= hi or (whole and value != int(value)):
            if clamp:
                if value is None:
                    params.pop(key, None)
                else:
                    value = min(max(value, lo), hi)
                    params[key] = int(round(value)) if whole else value
                continue
            kind = "целое" if whole else "число"
            now = _decimal(value) if value is not None else repr(raw)
            raise AgentGraphError(f"{title(node)}: «{label}» — {kind} от {_decimal(lo)} до {_decimal(hi)}, "
                                  f"сейчас {now}.")
    if node["type"] == "filter":
        lo, hi = num(params.get("min_side")), num(params.get("max_side"))
        if lo is not None and hi is not None and lo > hi:
            if not clamp:
                raise AgentGraphError(f"{title(node)}: «Сторона от» больше, чем «Сторона до».")
            params["max_side"] = params["min_side"]
        for row in params.get("classes") or []:
            conf = num(row.get("conf"), 0) if isinstance(row, dict) else None
            if conf is None or not 0 <= conf <= 1:
                if not clamp:
                    raise AgentGraphError(f"{title(node)}: порог класса — число от 0 до 1.")
                if isinstance(row, dict):
                    row["conf"] = min(max(conf or 0, 0), 1)


PROMPT_MAX = 64


def _check_text(node, sam3, examples):
    params = node.get("params") or {}
    if params.get("model") not in (None, *TEXT_MODELS):
        raise AgentGraphError(f"{title(node)}: неизвестная модель {params.get('model')!r}.")
    if text_model(params) == "sam3" and sam3 is False:
        raise AgentGraphError(f"{title(node)}: нет весов SAM 3 на сервере.")
    if not text_rows(node):
        raise AgentGraphError(f"{title(node)}: не включена ни одна строка.")
    if text_model(params) == "sam3" and len(text_rows(node)) > SAM3_MAX_ROWS:
        raise AgentGraphError(
            f"{title(node)}: у SAM 3 не больше {SAM3_MAX_ROWS} строк — память растёт с каждой.")
    # Одно слово или один набор дважды — два класса модели на одно и то же:
    # они делили бы находки между собой. Синоним пишется другим словом.
    prompts = [p.lower() for _, p in text_prompts(node)]
    twice = next((p for p in prompts if prompts.count(p) > 1), None)
    if twice:
        raise AgentGraphError(f"{title(node)}: промт «{twice}» повторяется.")
    # Кодировщик текста молча обрезает длинное — лучше сказать сразу.
    long = next((p for p in prompts if len(p) > PROMPT_MAX), None)
    if long:
        raise AgentGraphError(
            f"{title(node)}: промт длиннее {PROMPT_MAX} символов — «{long[:24]}…».")
    sets = [s for _, s in text_sets(node)]
    if any(sets.count(s) > 1 for s in sets):
        raise AgentGraphError(f"{title(node)}: один набор образцов стоит в двух строках.")
    if examples is not None:
        for s in sets:
            if s not in examples:
                raise AgentGraphError(f"{title(node)}: набора образцов нет на вашей полке.")
            if not examples[s]:
                raise AgentGraphError(f"{title(node)}: набор образцов ещё не собран.")
    # Порог узла сверяет `_check_numbers`; здесь — пороги строк.
    for conf in [r.get("conf") for _, r in text_rows(node)]:
        value = num(conf, 0.5)
        if value is None or not 0 <= value <= 1:
            raise AgentGraphError(f"{title(node)}: уверенность — число от 0 до 1.")


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


# Находка агента того же класса, что уже лежащая рамка, с таким перекрытием —
# тот же объект: класть её на проверку значило бы заставить человека удалять дубли.
KNOWN_IOU = 0.5


def geometry_box(ann_type, geometry):
    """(x, y, w, h) лежащей фигуры — рамки или охвата контура."""
    if ann_type == "polygon":
        from common import polygon

        b = polygon.bounds(polygon.parts_of(geometry))
    else:
        b = geometry
    if not b:
        return None
    return (float(b["x"]), float(b["y"]), float(b["w"]), float(b["h"]))


def drop_known(found, known, mapping, threshold=KNOWN_IOU):
    """Находки без тех, что повторяют уже лежащие на кадре рамки.

    `known` — [(id класса проекта, (x, y, w, h))], `mapping` — класс агента →
    id класса проекта. Сравнение в классах проекта: два класса агента могут
    лечь в один класс проекта, и тогда это тот же объект."""
    out = []
    for det in found:
        cid = mapping.get(det["cls"])
        box = tuple(det["box"])
        if cid and any(str(k) == str(cid) and iou(box, kb) >= threshold for k, kb in known):
            continue
        out.append(det)
    return out


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


def num(value, default=None):
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
    lo, hi = num(params.get("min_side")), num(params.get("max_side"))
    out = []
    for det in dets:
        row = rows.get(det["cls"])
        if row is not None and (not row.get("on", True) or det["conf"] < num(row.get("conf"), 0.0)):
            continue
        _, _, w, h = det["box"]
        if (lo is not None and min(w, h) < lo) or (hi is not None and max(w, h) > hi):
            continue
        out.append(det)
    return out


def outline(det, masks, scores, params, whole=False):
    """Обнаружение после SAM: с обводкой и рамкой по маске — или как было.

    Выбор маски, чистка и обводка — те же, что у полуавтомата
    (`common.contours`). Своё здесь только обрезка по рамке с запасом и
    решение «SAM не справился». `whole` — маску не резать, а брать куски,
    задевшие рамку с запасом, целиком: так у SAM 3, чья маска точнее его рамки."""
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
    if whole:
        clipped = contours.touching(mask, (x0, y0, x1, y1))
    else:
        clipped = np.zeros_like(mask)
        clipped[y0:y1, x0:x1] = mask[y0:y1, x0:x1]
    clipped = contours.clean_mask(clipped, int(p["min_area"]), bool(p["fill_holes"]))
    if clipped.sum() < MASK_MIN_SHARE * w * h:
        return det
    parts = contours.polygons_from_mask(clipped, int(p["polygon_points"]))
    if not parts:
        return det
    return {**det, "box": contours.mask_bounds(clipped), "parts": parts, "sam": round(score, 3)}


def text_outline(box, mask, conf, params, k):
    """Контур SAM 3 для обнаружения → {box, parts, sam} в пикселях кадра или None.

    SAM 3 смотрит на кадр, ужатый в `k` раз (маски ultralytics растягивает до
    входа, и на полном кадре с сотней масок это десятки гигабайт), поэтому
    рамка приходит в пикселях кадра, а маска — ужатой. Чистка та же, что у
    «Уточнения SAM»; оценку маски SAM 3 не даёт отдельно от уверенности, а
    уверенность уже прошла порог узла — поэтому порог маски здесь нулевой.

    Рамка SAM 3 недотягивает до своей же маски справа и снизу на ~5 px входа
    (замер 07.10.2026: 22 находки из 22, маска сходится с ручным SAM2), поэтому
    маска по рамке не режется, а рамкой становятся её границы."""
    small = {"box": tuple(v * k for v in box)}
    got = outline(small, [mask], [conf], {**(params or {}), "score_min": 0, "detail": "auto"},
                  whole=True)
    if "parts" not in got:
        return None
    x, y, w, h = got["box"]
    return {"box": (x / k, y / k, w / k, h / k), "sam": got["sam"],
            "parts": [[[px / k, py / k] for px, py in ring] for ring in got["parts"]]}


# --------------------------------------------------------------------------- #
# Тайлинг узлов «Сеть» и «Сеть по тексту»
#
# Тайл — квадрат кадра со стороной `tile`, и сеть видит его на своём входе:
# тайл меньше входа растягивается — лупа для мелочи, — больше ужимается.
# Целый кадр — отдельный проход (выключается галочкой): крупный объект тайл
# режет, и его половинки нашлись бы двумя обрывками.
#
# Виды (кадр и тайлы) видят объект по-разному — целиком и обрывками, у обрывка
# с целым IoU мал, и NMS его не погасит; поэтому склейка по доле перекрытия
# меньшей рамки в охватывающую, как GREEDYNMM у SAHI. Контур склеенного
# объекта (SAM 3) берётся у вида, где объект не обрезан краем тайла, а нет
# такого — куски масок объединяются.
# --------------------------------------------------------------------------- #
TILE_OVERLAP = 0.2
GLUE_IOS = 0.5
# Вырезки идут в сеть пачками: пик памяти не зависит от числа тайлов.
TILE_BATCH = 8
# Потолок проходов на кадр: тайл 160 на кадре 2688×1520 — уже 228.
MAX_PASSES = 100
# Вход SAM 3 — по нему же умолчание тайла: слова видят тайл один к одному.
SAM3_SIDE = 644
# Рамка ближе этого к внутреннему краю тайла — объект обрезан.
CUT_PX = 2


def tiles(width, height, side, overlap=TILE_OVERLAP):
    """Тайлы (x0, y0, x1, y1). Кадр не больше тайла — тайлов нет."""
    if width <= side and height <= side:
        return []

    def starts(length):
        if length <= side:
            return [0]
        n = math.ceil((length - side) / (side * (1 - overlap))) + 1
        return [round(i * (length - side) / (n - 1)) for i in range(n)]

    return [(x, y, min(width, x + side), min(height, y + side))
            for y in starts(height) for x in starts(width)]


def tile_side(node, net_imgsz=None):
    """Сторона тайла узла. Пусто — вход сети: у «Сети» её размер входа или
    вход весов, у YOLOE — свой вход, у SAM 3 — его неизменный 644."""
    params = node.get("params") or {}
    own = num(params.get("tile"))
    if own:
        return int(own)
    if node.get("type") == "text":
        if text_model(params) == "sam3":
            return SAM3_SIDE
        return int(num(params.get("imgsz"), TEXT_IMGSZ))
    return int(num(params.get("imgsz"), net_imgsz or 640))


def views(params, width, height, tile):
    """Виды кадра: целый первым (если не выключен), затем тайлы. Кадр влезает
    в тайл — один целый, что бы ни стояло в галочке."""
    whole = [(0, 0, width, height)]
    if not params.get("tiles"):
        return whole
    overlap = max(0.0, min(0.9, num(params.get("overlap"), TILE_OVERLAP)))
    cut = tiles(width, height, tile, overlap)
    if not cut:
        return whole
    return (whole if params.get("whole") is not False else []) + cut


def passes(node, width, height, net_imgsz=None):
    """Сколько видов узел гонит через сеть на кадре такого размера."""
    return len(views(node.get("params") or {}, width, height, tile_side(node, net_imgsz)))


def ios(a, b):
    """Пересечение к площади меньшей рамки: обрывок внутри целой — 1."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    small = min(aw * ah, bw * bh)
    return ix * iy / small if small > 0 else 0.0


def is_cut(box, view, width, height):
    """Упирается ли рамка во внутренний край тайла — край кадра не в счёт."""
    x, y, w, h = box
    x0, y0, x1, y1 = view
    return ((x0 > 0 and x <= x0 + CUT_PX) or (y0 > 0 and y <= y0 + CUT_PX)
            or (x1 < width and x + w >= x1 - CUT_PX) or (y1 < height and y + h >= y1 - CUT_PX))


def _shift(shape, dx, dy):
    """Контур вырезка {box, parts, sam} → в пиксели кадра."""
    if not shape:
        return None
    x, y, w, h = shape["box"]
    return {**shape, "box": (x + dx, y + dy, w, h),
            "parts": [[[px + dx, py + dy] for px, py in ring] for ring in shape["parts"]]}


def _union(shapes, points):
    """Куски контура одного объекта из разных тайлов — одним контуром."""
    import cv2
    import numpy as np

    from common import contours

    rings = [np.array(ring, np.float64) for s in shapes for ring in s["parts"] if len(ring) >= 3]
    if not rings:
        return shapes[0]
    lo = np.floor(np.min([r.min(axis=0) for r in rings], axis=0))
    hi = np.ceil(np.max([r.max(axis=0) for r in rings], axis=0))
    mask = np.zeros((int(hi[1] - lo[1]) + 1, int(hi[0] - lo[0]) + 1), np.uint8)
    cv2.fillPoly(mask, [np.round(r - lo).astype(np.int32) for r in rings], 1)
    parts = contours.polygons_from_mask(mask, points)
    if not parts:
        return shapes[0]
    dx, dy = float(lo[0]), float(lo[1])
    x, y, w, h = contours.mask_bounds(mask)
    return {"box": (x + dx, y + dy, w, h), "sam": max(s.get("sam", 0) for s in shapes),
            "parts": [[[px + dx, py + dy] for px, py in ring] for ring in parts]}


def glue(dets, threshold=GLUE_IOS, points=SAM_DEFAULTS["polygon_points"]):
    """Склейка видов: рамки одного класса, где меньшая перекрыта на `threshold`,
    заменяются охватывающей с наибольшей уверенностью. `dets` —
    [(cls, conf, box, контур или None, обрезан ли)] → [(cls, conf, box, контур)]."""
    kept = []   # [cls, conf, box, [члены]]
    for det in sorted(dets, key=lambda d: -d[1]):
        cls, conf, box = det[:3]
        home = next((k for k in kept if k[0] == cls and ios(k[2], box) >= threshold), None)
        if home is None:
            kept.append([cls, conf, box, [det]])
            continue
        (ax, ay, aw, ah), (bx, by, bw, bh) = home[2], box
        x0, y0 = min(ax, bx), min(ay, by)
        home[2] = (x0, y0, max(ax + aw, bx + bw) - x0, max(ay + ah, by + bh) - y0)
        home[3].append(det)
    out = []
    for cls, conf, box, members in kept:
        shaped = [m for m in members if m[3]]
        whole = [m for m in shaped if not m[4]]
        shape = (whole[0][3] if whole else _union([m[3] for m in shaped], points) if len(shaped) > 1
                 else shaped[0][3] if shaped else None)
        out.append((cls, conf, box, shape))
    return out


def detect(params, width, height, tile, infer):
    """Все проходы узла по кадру → [(номер, уверенность, x, y, w, h, контур)].

    `infer(views)` — сеть: на каждый вид (x0, y0, x1, y1) список рамок
    (номер, уверенность, x, y, w, h[, контур]) в координатах вырезка. Видов
    в одном вызове не больше `TILE_BATCH`.
    """
    vs = views(params, width, height, tile)
    found = []
    for at in range(0, len(vs), TILE_BATCH):
        chunk = vs[at:at + TILE_BATCH]
        for view, dets in zip(chunk, infer(chunk)):
            x0, y0 = view[:2]
            for cls, conf, x, y, w, h, *shape in dets:
                box = (x + x0, y + y0, w, h)
                found.append((int(cls), float(conf), box, _shift(shape[0] if shape else None, x0, y0),
                              is_cut(box, view, width, height)))
    if len(vs) > 1:
        points = int(num(params.get("polygon_points"), SAM_DEFAULTS["polygon_points"]))
        return [(cls, conf, *box, shape) for cls, conf, box, shape in
                glue(found, num(params.get("glue"), GLUE_IOS), points)]
    return [(cls, conf, *box, shape) for cls, conf, box, shape, _ in found]


def run(doc, predict, order=None, segment=None, trace=None):
    """Прогнать один кадр. Возвращает обнаружения «Выхода»:
    [{"id", "cls": имя класса агента, "conf": float, "box": (x, y, w, h)}] и,
    после SAM, ещё `parts` — обводка кольцами точек и `sam` — оценка маски.

    `id` — «узел сети.номер»: по нему превью видит, что узел отсеял. `trace`,
    если передан, получает {узел: {"in": [...], "out": [...], "ms": время узла}}."""
    by_id = {n["id"]: n for n in doc["nodes"]}
    order = order or check(doc)
    feeds = {(e["to"], e["in"]): e["from"] for e in doc["edges"]}
    value = {}
    result = []
    for nid in order:
        node = by_id[nid]
        started = time.monotonic()
        ins = [value[feeds[(nid, name)]] for name in ports(node)[0]]
        kind = node["type"]
        if kind == "frame":
            value[nid] = []
        elif kind in FINDERS:
            table = dict(net_classes(node))
            rows = (node.get("params") or {}).get("prompts") or []
            own = []
            for k, (c, conf, x, y, w, h, *shape) in enumerate(predict(node)):
                if int(c) not in table:
                    continue
                # Модель шла с самым низким порогом строк — дорезаем по своему.
                if kind == "text" and conf < row_conf(node, rows[int(c)]):
                    continue
                det = {"id": f"{nid}.{k}", "cls": table[int(c)], "conf": float(conf), "box": (x, y, w, h)}
                # Контур SAM 3 — {box, parts, sam}; разведке он не нужен.
                if shape and shape[0] and segment:
                    det.update(shape[0])
                own.append(det)
            value[nid] = ins[0] + own
        elif kind == "merge":
            value[nid] = [d for branch in ins for d in branch]
        elif kind == "nms":
            params = node.get("params") or {}
            value[nid] = nms(ins[0], num(params.get("iou"), NMS_IOU), bool(params.get("agnostic")))
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
            trace[nid] = {"in": [d for branch in ins for d in branch], "out": value[nid],
                          "ms": round((time.monotonic() - started) * 1000, 1)}
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
    «Фильтра»), медианный размер (по нему решают про тайлинг) и счёт по
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
