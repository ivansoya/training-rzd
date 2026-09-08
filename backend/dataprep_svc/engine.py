"""Исполнитель графа: один кадр входит, несколько образцов выходят.

Единица работы — **один исходный кадр**. Он обходит план в глубину, и образцы
выпадают из «Выходов» по одному; их тут же пишут на диск. В памяти
одновременно живут исходный кадр и до нескольких его производных, а не датасет.

Случайность привязана к кадру, а не к счётчику: полосы разбирают кадры как
придётся, и зерно, зависящее от порядка, дало бы на другой машине другие
картинки при том же числе.

Разделитель по долям заслуживает отдельного слова. Он не бросает жребий: место
образца в очереди берётся из его порядкового номера по последовательности
золотого сечения. Она раскладывает номера по отрезку так, что в отрезок длины
s из N номеров попадает s·N с точностью до единицы — то есть ветка «30 %» из
тысячи получает 300 кадров, а не «примерно триста», и получает их вперемешку,
а не первые триста подряд.
"""
from itertools import zip_longest

from dataprep_svc import albu, masks
from dataprep_svc.graph import plan as planlib
from dataprep_svc.graph import rng, schema

# Золотое сечение: классическая последовательность с малым расхождением.
PHI = 0.6180339887498949


class Sample:
    """Кадр и его разметка на любом участке графа.

    ``boxes`` — нормированные YOLO-рамки, ``polys`` — кольца в пикселях
    картинки. Оба вида везутся вместе: полигон всегда несёт и свою
    охватывающую рамку, потому что по ней стоит подпись класса и по ней же
    считает боксовая выгрузка.
    """

    __slots__ = ("image", "boxes", "polys", "sid", "ordinal", "ops")

    def __init__(self, image, boxes, polys, sid="", ordinal=0, ops=()):
        self.image = image
        self.boxes = list(boxes)
        self.polys = list(polys)
        self.sid = sid
        self.ordinal = ordinal
        self.ops = tuple(ops)

    def copy_with(self, image, boxes, polys, sid=None, ordinal=None, op=None):
        return Sample(
            image,
            boxes,
            polys,
            sid if sid is not None else self.sid,
            ordinal if ordinal is not None else self.ordinal,
            self.ops + ((op,) if op else ()),
        )

    @property
    def empty(self):
        return not self.boxes and not self.polys


def place(ordinal) -> float:
    """Место образца в очереди: число в [0, 1) с малым расхождением."""
    return (ordinal * PHI) % 1.0


class Compiled:
    """Готовый к исполнению план: узлы, порядок и провода."""

    __slots__ = ("nodes", "edges", "order", "by_id", "out_edges", "in_edges",
                 "min_visibility", "pipelines")

    def __init__(self, nodes, edges, order, min_visibility):
        self.nodes = nodes
        self.edges = edges
        self.order = order
        self.by_id = {n["id"]: n for n in nodes}
        self.out_edges, self.in_edges = {}, {}
        for e in edges:
            self.out_edges.setdefault((e["from"], e["out"]), []).append(e)
            self.in_edges.setdefault((e["to"], e["in"]), []).append(e)
        self.min_visibility = min_visibility
        self.pipelines = {}


def compile_graph(doc, load_version=None, *, min_visibility=0.15,
                  with_masks=False):
    """Разложить граф в план и заранее собрать все преобразования.

    Преобразования собираются один раз на сборку, а не на каждый кадр: сборка
    объекта albumentations стоит микросекунды против миллисекунд самой работы,
    но на сотне тысяч кадров и микросекунды складываются в минуты.
    """
    load_version = load_version or (lambda *_: None)
    nodes, edges = planlib.expand(doc, load_version)
    order = planlib.topo(nodes, edges)
    compiled = Compiled(nodes, edges, order, min_visibility)

    for node in nodes:
        ops = _ops_of(node)
        if not ops:
            continue
        compiled.pipelines[node["id"]] = albu.compose(
            ops, with_boxes=True, with_masks=with_masks,
            min_visibility=min_visibility,
        )
    return compiled


def _ops_of(node):
    """Список трансформов узла. У «Аугментации» один, у «Потока» цепочка."""
    params = node.get("params") or {}
    if node["type"] == "aug":
        if not params.get("op"):
            return []
        return [{
            "op": params["op"],
            "args": params.get("args") or {},
            "chance": params.get("chance", 1.0),
        }]
    if node["type"] == "flow":
        return [
            {
                "op": o.get("op"),
                "args": o.get("args") or {},
                "chance": o.get("chance", 1.0),
            }
            for o in (params.get("ops") or []) if o.get("op")
        ]
    return []


# --------------------------------------------------------------------------- #
# Применение аугментации к одному образцу
# --------------------------------------------------------------------------- #
def apply(compiled, node, sample, seed):
    """Прогнать образец через узел. ``None`` — от разметки ничего не осталось.

    Контуры едут масками: albumentations крутит их вместе с картинкой, а
    обратно кольца снимает ``masks.vectorize``. Сечение краем кадра и разрыв
    объекта на части обрабатываются сами собой — см. шапку ``masks.py``.
    """
    pipeline = compiled.pipelines.get(node["id"])
    if pipeline is None:
        return sample

    albu.seed_compose(pipeline, seed)
    h, w = sample.image.shape[:2]

    payload = {
        "image": sample.image,
        "bboxes": [b[1:] for b in sample.boxes],
        "class_labels": [b[0] for b in sample.boxes],
    }
    rings = []
    if sample.polys:
        cut = sample.polys[: masks.MAX_MASKS_PER_SAMPLE]
        rings = [masks.rasterize(parts, w, h) for _, parts in cut]
        payload["masks"] = rings

    done = pipeline(**payload)

    boxes = [
        (cls, *tuple(box))
        for cls, box in zip(done.get("class_labels", []), done.get("bboxes", []))
    ]
    polys = []
    if rings:
        for (cls, _), before, after in zip(
            sample.polys, rings, done.get("masks", [])
        ):
            if masks.visible_share(before, after) < compiled.min_visibility:
                continue
            parts = masks.vectorize(after)
            if parts:
                polys.append((cls, parts))

    return sample.copy_with(
        done["image"], boxes, polys, op=(node.get("params") or {}).get("op")
    )


# --------------------------------------------------------------------------- #
# Обход плана одним кадром
# --------------------------------------------------------------------------- #
def run_frame(compiled, sample, set_seed, image_id, *, on_drop=None):
    """Все образцы, которые даст этот кадр. Возвращает [(узел-выход, образец)].

    ``on_drop(node_id, reason)`` зовётся, когда образец потерял всю разметку и
    дальше не идёт. Молчаливая потеря трети набора — ровно то, что находят
    через месяц по странным метрикам, поэтому считать её надо поимённо.
    """
    frame = rng.frame_seed(set_seed, image_id)
    at_port = {}   # (node_id, port) -> [Sample]
    results = []

    for node_id in compiled.order:
        node = compiled.by_id[node_id]
        kind = node["type"]
        ins, outs = schema.ports(node)

        if kind in schema.SOURCES:
            at_port[(node_id, "out")] = [sample]
            continue

        arriving = []
        for name in ins:
            for e in compiled.in_edges.get((node_id, name), ()):
                arriving.extend(at_port.get((e["from"], e["out"]), ()))

        if kind == "output":
            for item in arriving:
                results.append((node_id, item))
            continue

        if kind == "multiply":
            times = schema.times(node)
            made = []
            for item in arriving:
                for k in range(times):
                    made.append(item.copy_with(
                        item.image, item.boxes, item.polys,
                        sid=f"{item.sid}.{k}",
                        ordinal=item.ordinal * times + k,
                    ))
            at_port[(node_id, "out")] = made
            continue

        if kind in ("split_share", "split_prob"):
            w = schema.weights(node)
            total = sum(w)
            buckets = {f"o{i}": [] for i in range(len(w))}
            for item in arriving:
                if kind == "split_share":
                    point = place(item.ordinal) * total
                else:
                    seed = rng.node_seed(frame, node_id, item.sid)
                    point = (seed % (1 << 32)) / float(1 << 32) * total
                running, chosen = 0.0, len(w) - 1
                for i, weight in enumerate(w):
                    running += weight
                    if point < running:
                        chosen = i
                        break
                buckets[f"o{chosen}"].append(item)
            for port, items in buckets.items():
                at_port[(node_id, port)] = items
            continue

        if kind == "order":
            # Строго ветка за веткой: сперва весь первый вход, потом второй.
            # Это и есть его единственное отличие от «Слияния» — на состав
            # набора оно не влияет, а на порядок записи файлов влияет.
            at_port[(node_id, "out")] = arriving
            continue

        if kind == "merge":
            # Вперемешку, по кругу. Разница с «Порядком» не косметическая:
            # сборку могут прервать, и тогда в наборе окажутся обе ветки, а не
            # одна целиком и от второй ничего.
            lanes = [
                at_port.get((e["from"], e["out"]), ())
                for name in ins
                for e in compiled.in_edges.get((node_id, name), ())
            ]
            mixed = []
            for row in zip_longest(*lanes):
                mixed.extend(item for item in row if item is not None)
            at_port[(node_id, "out")] = mixed
            continue

        made = []
        for item in arriving:
            seed = rng.node_seed(frame, node_id, item.sid)
            got = apply(compiled, node, item, seed)
            # Пустой образец — потеря только если на входе разметка была:
            # кадр-фон пуст по замыслу и идёт дальше как есть.
            if got is None or (got.empty and not item.empty):
                if on_drop is not None:
                    on_drop(node_id, "разметка не пережила преобразование")
                continue
            made.append(got)
        at_port[(node_id, "out")] = made

    return results
