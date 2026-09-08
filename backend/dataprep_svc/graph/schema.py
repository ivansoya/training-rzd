"""Форма графа аугментаций: какие бывают узлы и какие у них гнёзда.

Ни базы, ни albumentations — только структура. Всё, что здесь проверяется,
человек увидит в редакторе до запуска, а не через час сборки.

Что течёт по проводу — поток образцов «кадр плюс его разметка». Это решение
объясняет весь набор узлов: «умножение» размножает поток, «слияние» его
складывает, «разделитель» делит, а «аугментация» применяется к каждому
образцу по отдельности. Число образцов на каждом проводе поэтому считается
заранее — см. ``plan.py``.
"""

# Узлы источника: с них поток начинается. В корневом графе это «Источник»,
# внутри графа-блока — «Вход», гнездо, через которое поток вливается снаружи.
SOURCES = ("source", "input")
SINKS = ("output",)

KINDS = (
    "source",      # обучающая часть набора
    "input",       # гнездо графа-блока
    "aug",         # один трансформ albumentations
    "flow",        # цепочка трансформов в одной карточке
    "multiply",    # тот же образец N раз, каждый со своим зерном
    "split_share", # образец уходит ровно в одну ветку, по долям
    "split_prob",  # то же, но жребием по весам
    "merge",       # несколько потоков в один
    "order",       # то же, но с объявленной очерёдностью веток
    "output",      # в обучающий набор
    "group",       # другой граф целиком, одним узлом
)

# Сколько веток бывает у разделителя и сколько входов у слияния. Потолок не
# из вредности: двадцать веток на экране уже не читаются, а считать их всё
# равно придётся все.
MAX_BRANCHES = 12
MAX_INPUTS = 12
# Во что превращается «умножение». Больше — почти наверняка описка, а стоит
# она часов сборки и десятков гигабайт.
MAX_TIMES = 64
MAX_NODES = 400
# Глубина вложенности графов-блоков.
MAX_GROUP_DEPTH = 8


class GraphError(ValueError):
    """Ошибка формы графа. Текст показывается человеку целиком, поэтому в нём
    имя узла, а не его номер в списке."""


def _int(params, key, default, low, high):
    try:
        value = int(params.get(key, default))
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


def branches(node) -> int:
    return _int(node.get("params") or {}, "branches", 2, 2, MAX_BRANCHES)


def inputs_count(node) -> int:
    return _int(node.get("params") or {}, "inputs", 2, 2, MAX_INPUTS)


def times(node) -> int:
    return _int(node.get("params") or {}, "times", 2, 1, MAX_TIMES)


def weights(node) -> list:
    """Доли или веса разделителя, приведённые к числу веток.

    Нулевая сумма — не ошибка ввода, а состояние «человек ещё не закончил»:
    отвечаем равными долями, чтобы редактор показывал осмысленные числа, а не
    нули или деление на ноль.
    """
    n = branches(node)
    params = node.get("params") or {}
    raw = params.get("shares") or params.get("weights") or []
    out = []
    for i in range(n):
        try:
            out.append(max(0.0, float(raw[i])))
        except (IndexError, TypeError, ValueError):
            out.append(1.0)
    return out if sum(out) > 0 else [1.0] * n


def ports(node, group_ports=None):
    """Имена входных и выходных гнёзд узла.

    ``group_ports`` — гнёзда вложенного графа, если узел его вставляет: их
    знает только тот, кто прочитал ту версию, а форма — нет.
    """
    kind = node.get("type")
    if kind in ("source", "input"):
        return [], ["out"]
    if kind == "output":
        return ["in"], []
    if kind in ("aug", "flow", "multiply"):
        return ["in"], ["out"]
    if kind in ("split_share", "split_prob"):
        return ["in"], [f"o{i}" for i in range(branches(node))]
    if kind in ("merge", "order"):
        return [f"i{i}" for i in range(inputs_count(node))], ["out"]
    if kind == "group":
        got = group_ports or {}
        ins = list(got.get("in") or ["in"])
        outs = list(got.get("out") or ["out"])
        return ins, outs
    raise GraphError(f"Неизвестный узел: {kind!r}")


def node_title(node) -> str:
    """Как назвать узел в сообщении об ошибке."""
    params = node.get("params") or {}
    label = params.get("label") or params.get("op")
    return f"«{label}»" if label else f"узел {node.get('id')}"


def check(doc, *, root=True, group_ports=None):
    """Проверить форму графа. Бросает ``GraphError`` с готовым текстом.

    Проверяется здесь то, что можно проверить, не читая ни одной картинки:
    известные типы узлов, сведённые гнёзда, отсутствие колец, единственный
    источник. Всё это человек видит в редакторе, а не узнаёт через час.
    """
    if not isinstance(doc, dict):
        raise GraphError("Граф должен быть объектом.")
    nodes = doc.get("nodes")
    edges = doc.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise GraphError("В графе должны быть списки узлов и связей.")
    if len(nodes) > MAX_NODES:
        raise GraphError(
            f"В графе {len(nodes)} узлов — больше {MAX_NODES} не считаем."
        )

    by_id = {}
    for node in nodes:
        if not isinstance(node, dict) or not node.get("id"):
            raise GraphError("У каждого узла должен быть свой номер.")
        if node["id"] in by_id:
            raise GraphError(f"Номер узла повторяется: {node['id']}.")
        if node.get("type") not in KINDS:
            raise GraphError(
                f"{node_title(node)}: неизвестный тип {node.get('type')!r}."
            )
        by_id[node["id"]] = node

    sources = [n for n in nodes if n["type"] == "source"]
    entries = [n for n in nodes if n["type"] == "input"]
    outputs = [n for n in nodes if n["type"] == "output"]

    if root:
        if len(sources) != 1:
            raise GraphError(
                "В графе должен быть ровно один «Источник»: "
                f"сейчас их {len(sources)}."
            )
        if entries:
            raise GraphError(
                "Узел «Вход» бывает только у графа-блока — у того, который "
                "вставляют в другой граф."
            )
    elif not entries:
        raise GraphError("У графа-блока должен быть хотя бы один «Вход».")
    if not outputs:
        raise GraphError("В графе нет ни одного «Выхода» — собирать нечего.")

    # У входного гнезда ровно один провод: два потока, слитые молча, — это
    # «слияние», и оно обязано быть видимым узлом.
    #
    # А из выходного проводов может идти сколько угодно, и это не размножение
    # потока в смысле «Умножения»: один и тот же образец уходит в обе стороны,
    # как в любом нодовом редакторе. Числа на проводах при этом сходятся —
    # просто сумма на выходах больше, чем на входе, и это видно.
    taken_in, taken_out = {}, {}
    for edge in edges:
        for side in ("from", "to"):
            if edge.get(side) not in by_id:
                raise GraphError(f"Связь ведёт в никуда: {edge}.")
        src, dst = by_id[edge["from"]], by_id[edge["to"]]
        _, src_outs = ports(src, (group_ports or {}).get(src["id"]))
        dst_ins, _ = ports(dst, (group_ports or {}).get(dst["id"]))
        if edge.get("out") not in src_outs:
            raise GraphError(
                f"{node_title(src)}: нет выходного гнезда {edge.get('out')!r}."
            )
        if edge.get("in") not in dst_ins:
            raise GraphError(
                f"{node_title(dst)}: нет входного гнезда {edge.get('in')!r}."
            )
        key_out = (edge["from"], edge["out"])
        key_in = (edge["to"], edge["in"])
        if key_in in taken_in:
            raise GraphError(
                f"{node_title(dst)}: в одно гнездо приходят два провода."
            )
        taken_out.setdefault(key_out, []).append(edge)
        taken_in[key_in] = edge

    for node in nodes:
        ins, outs = ports(node, (group_ports or {}).get(node["id"]))
        for name in ins:
            if (node["id"], name) not in taken_in:
                raise GraphError(
                    f"{node_title(node)}: вход {name!r} ни к чему не подключён."
                )
        if node["type"] in SINKS:
            continue
        if outs and not any((node["id"], o) in taken_out for o in outs):
            raise GraphError(
                f"{node_title(node)}: выход никуда не ведёт, "
                "поток здесь обрывается."
            )

    cycle = find_cycle(nodes, edges)
    if cycle:
        names = " → ".join(node_title(by_id[i]) for i in cycle)
        raise GraphError(f"Провода образуют кольцо: {names}.")
    return by_id


def find_cycle(nodes, edges):
    """Кольцо в графе, если оно есть, — списком номеров узлов.

    Возвращаем именно путь, а не «да/нет»: сообщение «где-то кольцо» на графе
    из шестидесяти узлов бесполезно.
    """
    outgoing = {}
    for edge in edges:
        outgoing.setdefault(edge["from"], []).append(edge["to"])

    WHITE, GREY, BLACK = 0, 1, 2
    colour = {n["id"]: WHITE for n in nodes}
    path = []

    def walk(node_id):
        colour[node_id] = GREY
        path.append(node_id)
        for nxt in outgoing.get(node_id, ()):
            if colour.get(nxt) == GREY:
                return path[path.index(nxt):] + [nxt]
            if colour.get(nxt) == WHITE:
                found = walk(nxt)
                if found:
                    return found
        path.pop()
        colour[node_id] = BLACK
        return None

    for node in nodes:
        if colour[node["id"]] == WHITE:
            found = walk(node["id"])
            if found:
                return found
    return None
