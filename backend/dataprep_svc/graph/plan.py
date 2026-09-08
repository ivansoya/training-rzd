"""Из графа — в план: развернуть блоки, разложить по порядку, посчитать поток.

Главное, что отсюда получает человек, — **число образцов на каждом проводе, до
запуска**. Оно и отвечает на вопрос «во что превратятся мои 1040 кадров»,
который иначе выясняется через час сборки и сорок гигабайт.

Тот же счёт делает браузер (``frontend/src/components/aug/counts.ts``), чтобы
числа появлялись без запроса к серверу. Это осознанный дубль — такой же, как
``trackMath.ts`` и ``video_tracks.py``. Расхождение выглядело бы как «показал
одно, собрал другое», поэтому у обоих один набор образцов:
``tests/fixtures/graphs``.
"""
from dataprep_svc.graph import schema
from dataprep_svc.graph.schema import GraphError

# Узлы, которые ничего не делают с потоком: гнёзда развёрнутого блока и
# «Поток» без единого трансформа.
IDENTITY = ("flow",)


def edge_key(edge) -> str:
    """Имя провода. Совпадает с тем, что считает браузер."""
    return f"{edge['from']}:{edge['out']}->{edge['to']}:{edge['in']}"


# --------------------------------------------------------------------------- #
# Разворачивание блоков
# --------------------------------------------------------------------------- #
def port_names(doc):
    """Гнёзда графа, когда его вставляют блоком.

    Порядок — по подписи узла, а не по положению на холсте: подпись человек
    видит и меняет осознанно, а координаты меняются от случайного движения
    мышью, и гнёзда блока переставлялись бы сами собой.
    """
    def label(node, default):
        return ((node.get("params") or {}).get("name")
                or (node.get("params") or {}).get("label")
                or default)

    ins = sorted(
        ((label(n, n["id"]), n["id"]) for n in doc.get("nodes", [])
         if n.get("type") == "input"),
    )
    outs = sorted(
        ((label(n, n["id"]), n["id"]) for n in doc.get("nodes", [])
         if n.get("type") == "output"),
    )
    return {"in": [name for name, _ in ins], "out": [name for name, _ in outs]}


def group_ports_for(doc, load_version):
    """Гнёзда каждого узла-блока: имя узла → его вход и выход.

    Форма графа сама этого знать не может — гнёзда блока объявлены во
    вложенной версии, а её ещё надо прочитать. Поэтому проверка формы просит
    их отдельным доводом.
    """
    out = {}
    for node in doc.get("nodes", []):
        if node.get("type") != "group":
            continue
        params = node.get("params") or {}
        inner = load_version(params.get("graph_id"), params.get("version_id"))
        if inner is not None:
            out[node["id"]] = port_names(inner)
    return out


def _boundary(doc):
    """Внутренние узлы блока, отвечающие его гнёздам, в том же порядке."""
    names = port_names(doc)
    def pick(kind, wanted):
        found = {}
        for node in doc.get("nodes", []):
            if node.get("type") != kind:
                continue
            params = node.get("params") or {}
            key = params.get("name") or params.get("label") or node["id"]
            found[key] = node["id"]
        return [found[name] for name in wanted]

    return pick("input", names["in"]), pick("output", names["out"])


def expand(doc, load_version, depth=0):
    """Граф со вставленными блоками. Возвращает (узлы, связи).

    Гнёзда развёрнутого блока становятся пустыми узлами «Поток»: они ничего не
    делают с потоком, а провода снаружи и внутри сходятся на них без особого
    случая в счёте.
    """
    if depth > schema.MAX_GROUP_DEPTH:
        raise GraphError(
            f"Блоки вложены глубже {schema.MAX_GROUP_DEPTH} — дальше не идём."
        )

    nodes = [dict(n) for n in doc.get("nodes", [])]
    edges = [dict(e) for e in doc.get("edges", [])]
    groups = [n for n in nodes if n.get("type") == "group"]
    if not groups:
        return nodes, edges

    for node in groups:
        params = node.get("params") or {}
        inner = load_version(params.get("graph_id"), params.get("version_id"))
        if inner is None:
            raise GraphError(
                f"{schema.node_title(node)}: вложенный граф не найден."
            )
        inner_nodes, inner_edges = expand(inner, load_version, depth + 1)
        prefix = f"{node['id']}/"
        rename = {n["id"]: prefix + n["id"] for n in inner_nodes}

        in_ids, out_ids = _boundary(inner)
        in_ids = [rename[i] for i in in_ids]
        out_ids = [rename[i] for i in out_ids]

        for n in inner_nodes:
            n["id"] = rename[n["id"]]
            if n["type"] in ("input", "output"):
                # Гнездо блока: снаружи в него входит провод, внутри выходит.
                n["type"] = "flow"
                n["params"] = dict(n.get("params") or {}, ops=[])
        for e in inner_edges:
            e["from"] = rename[e["from"]]
            e["to"] = rename[e["to"]]

        names = port_names(inner)
        in_by_port = dict(zip(names["in"], in_ids))
        out_by_port = dict(zip(names["out"], out_ids))
        # Гнёзда блока могли быть подписаны как «in»/«out» по умолчанию —
        # редактор рисует их именно так, когда подписи нет.
        if len(names["in"]) == 1:
            in_by_port.setdefault("in", in_ids[0])
        if len(names["out"]) == 1:
            out_by_port.setdefault("out", out_ids[0])

        for e in edges:
            if e["to"] == node["id"]:
                target = in_by_port.get(e["in"])
                if target is None:
                    raise GraphError(
                        f"{schema.node_title(node)}: нет гнезда {e['in']!r}."
                    )
                e["to"], e["in"] = target, "in"
            if e["from"] == node["id"]:
                source = out_by_port.get(e["out"])
                if source is None:
                    raise GraphError(
                        f"{schema.node_title(node)}: нет гнезда {e['out']!r}."
                    )
                e["from"], e["out"] = source, "out"

        nodes = [n for n in nodes if n["id"] != node["id"]] + inner_nodes
        edges = edges + inner_edges

    return nodes, edges


# --------------------------------------------------------------------------- #
# Порядок обхода
# --------------------------------------------------------------------------- #
def topo(nodes, edges):
    """Узлы в порядке, в котором их можно считать.

    Кольцо на этом месте — уже не ошибка человека, а наша: форму проверили
    раньше. Но блоки могли завести кольцо через вложение, поэтому проверяем
    ещё раз здесь.
    """
    incoming = {n["id"]: 0 for n in nodes}
    outgoing = {n["id"]: [] for n in nodes}
    for e in edges:
        outgoing[e["from"]].append(e["to"])
        incoming[e["to"]] += 1

    # Порядок среди равных — по номеру узла: план обязан быть одинаковым от
    # запуска к запуску, иначе «пересобрать так же» перестаёт работать.
    ready = sorted(i for i, c in incoming.items() if c == 0)
    order = []
    while ready:
        node_id = ready.pop(0)
        order.append(node_id)
        fresh = []
        for nxt in outgoing[node_id]:
            incoming[nxt] -= 1
            if incoming[nxt] == 0:
                fresh.append(nxt)
        for nxt in sorted(fresh):
            ready.append(nxt)
        ready.sort()

    if len(order) != len(nodes):
        cycle = schema.find_cycle(nodes, edges)
        by_id = {n["id"]: n for n in nodes}
        names = " → ".join(schema.node_title(by_id[i]) for i in cycle or [])
        raise GraphError(f"Провода образуют кольцо: {names}.")
    return order


# --------------------------------------------------------------------------- #
# Счёт потока
# --------------------------------------------------------------------------- #
def counts(doc, base=1.0, load_version=None):
    """Сколько образцов пройдёт по каждому проводу и сколько выйдет всего.

    Числа дробные нарочно: у вероятностного разделителя 1000 × 0,3 — это
    ожидание, а не обещание, и редактор пишет «≈ 300». Округлять здесь значило
    бы врать точностью, которой нет.
    """
    load_version = load_version or (lambda *_: None)
    nodes, edges = expand(doc, load_version)
    by_id = {n["id"]: n for n in nodes}
    order = topo(nodes, edges)

    out_edges = {}
    in_edges = {}
    for e in edges:
        out_edges.setdefault((e["from"], e["out"]), []).append(e)
        in_edges.setdefault((e["to"], e["in"]), []).append(e)

    per_edge = {}
    total_out = 0.0

    def incoming_sum(node):
        ins, _ = schema.ports(node)
        got = 0.0
        for name in ins:
            for e in in_edges.get((node["id"], name), ()):
                got += per_edge.get(edge_key(e), 0.0)
        return got

    for node_id in order:
        node = by_id[node_id]
        kind = node["type"]

        if kind in schema.SOURCES:
            produced = {"out": float(base)}
        elif kind == "output":
            total_out += incoming_sum(node)
            continue
        elif kind == "multiply":
            produced = {"out": incoming_sum(node) * schema.times(node)}
        elif kind in ("split_share", "split_prob"):
            # Оба делят поток: каждый образец уходит ровно в одну ветку, и
            # сумма по веткам равна входу. Разница между ними не в числах, а в
            # том, кто выбирает ветку — доля или жребий.
            got = incoming_sum(node)
            w = schema.weights(node)
            total = sum(w)
            produced = {
                f"o{i}": got * w[i] / total for i in range(len(w))
            }
        else:
            # aug, flow, merge, order — поток не меняется, только собирается.
            produced = {"out": incoming_sum(node)}

        for port, value in produced.items():
            for e in out_edges.get((node_id, port), ()):
                per_edge[edge_key(e)] = value

    # Образцы, которые никуда не пришли: неподключённое гнездо блока или
    # оборванная ветка. Их надо назвать, а не потерять молча.
    dropped = 0.0
    for node in nodes:
        _, outs = schema.ports(node)
        if node["type"] == "output":
            continue
        for port in outs:
            if not out_edges.get((node["id"], port)):
                # Гнездо ни к чему не ведёт: сюда пришедшее пропадает.
                dropped += _produced_at(node, port, in_edges, per_edge)

    return {
        "edges": per_edge,
        "outputs": round(total_out, 4),
        "dropped": round(dropped, 4),
        "multiplier": round(total_out / base, 4) if base else 0.0,
        "nodes": len(nodes),
    }


def _produced_at(node, port, in_edges, per_edge):
    """Сколько образцов выходит из этого гнезда — для подсчёта потерянного."""
    ins, _ = schema.ports(node)
    got = sum(
        per_edge.get(edge_key(e), 0.0)
        for name in ins
        for e in in_edges.get((node["id"], name), ())
    )
    kind = node["type"]
    if kind in schema.SOURCES:
        return 0.0   # источник без провода — это ошибка формы, не потеря
    if kind == "multiply":
        return got * schema.times(node)
    if kind in ("split_share", "split_prob"):
        w = schema.weights(node)
        idx = int(port[1:]) if port.startswith("o") else 0
        return got * w[idx] / sum(w)
    return got
