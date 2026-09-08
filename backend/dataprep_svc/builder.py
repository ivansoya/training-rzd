"""Сборка обучающего набора: из кадров проекта — в папку, которую читает YOLO.

Три вещи, которые здесь важнее остального.

**Деление считается до первой картинки.** Целиком, по исходным кадрам, и
ложится в базу. Иначе копии одного кадра разъедутся по обеим половинам, и
проверка начнёт мерить запоминание — а заметить это по метрикам нельзя, они
просто окажутся неправдоподобно хорошими.

**Неизменённый кадр кладётся жёсткой ссылкой.** Проверочная часть и проход без
аугментаций — это тот же файл, что уже лежит в проекте. Копия стоила бы
столько же места на ровном месте. Цена названа вслух: файлы проекта после
этого нельзя переписывать на месте — только создавать и удалять.

**Потерянное считается поимённо.** Кадр, у которого аугментация увела всю
разметку за край, в набор не идёт — и об этом пишется, на каком узле и сколько
раз. Молчаливая потеря трети набора находится через месяц по странным
метрикам, и найти её тогда уже нечем.
"""
import json
import os
import shutil
import time
from collections import Counter, defaultdict

from sqlalchemy import delete, select

from common import config, polygon as polylib, selection as sel_lib
from common.models import (
    AugGraphVersion, Project, TrainSet, TrainSetSplit, utcnow,
)
from common import prep_queue as queue
from dataprep_svc import albu, engine, samples
from dataprep_svc.graph import plan as planlib

# Как часто отмечаемся в очереди. Чаще — лишние записи на том и в базу; реже —
# полоса прогресса начинает выглядеть зависшей.
BEAT_EVERY = 2.0


class Cancelled(Exception):
    """Работу попросили снять."""


# --------------------------------------------------------------------------- #
# Образец из кадра проекта
# --------------------------------------------------------------------------- #
def sample_of(image, anns, export_id, want, read=True):
    """Кадр и его разметка в том виде, в каком их берёт исполнитель графа."""
    boxes, polys = [], []
    for ann in anns:
        cls = export_id.get(ann.class_id)
        if cls is None:
            continue
        kind = ann.ann_type or "bbox"
        geometry = ann.geometry or {}
        if want == "polygon":
            if kind != "polygon":
                continue   # бокс в сегментацию не идёт — см. common.selection
            parts = polylib.parts_of(geometry)
            if parts:
                polys.append((cls, parts))
            continue
        if kind == "polygon":
            geometry = polylib.bounds(polylib.parts_of(geometry)) or {}
        line = sel_lib.box_line(cls, geometry, image.width, image.height)
        if line is None:
            continue
        _, cx, cy, bw, bh = line.split()
        boxes.append((cls, float(cx), float(cy), float(bw), float(bh)))

    picture = None
    if read:
        picture = albu.imread_rgb(os.path.join(config.DATA_DIR, image.file_path))
    return engine.Sample(picture, boxes, polys)


def lines_of(sample, want, width, height):
    """Строки файла разметки для готового образца."""
    out = []
    if want == "polygon":
        for cls, parts in sample.polys:
            line = polylib.to_line(cls, {"parts": parts}, width, height)
            if line:
                out.append(line)
        return out
    for cls, cx, cy, bw, bh in sample.boxes:
        cx = min(max(cx, 0.0), 1.0)
        cy = min(max(cy, 0.0), 1.0)
        bw = min(max(bw, 0.0), 1.0)
        bh = min(max(bh, 0.0), 1.0)
        if bw <= 0 or bh <= 0:
            continue
        out.append(f"{cls} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n")
    return out


# --------------------------------------------------------------------------- #
# Файлы набора
# --------------------------------------------------------------------------- #
def data_yaml(project, classes, splits):
    """Ключ ``path`` намеренно не пишем: без него ultralytics считает пути от
    самого yaml, а с относительным ``path`` — от своей папки датасетов."""
    stamp = utcnow().strftime("%Y-%m-%d")
    lines = [
        f"# Магистраль ML · проект «{project.name}» · собрано {stamp}",
        "train: images/train",
        "val: images/val",
    ]
    lines.append(f"nc: {len(classes)}")
    lines.append("names:")
    for i, name in enumerate(classes):
        lines.append(f"  {i}: {json.dumps(name, ensure_ascii=False)}")
    return "\n".join(lines) + "\n"


def link_or_copy(src, dst):
    """Жёсткая ссылка, а если не вышло — копия. Возвращает (байт, ссылкой ли).

    Не вышло — это разные файловые системы или файловая система без ссылок.
    Том у нас один, поэтому в норме сюда не попадаем; но у разработчика на
    bind-mount попадём, и падать из-за этого набор не должен.
    """
    try:
        os.link(src, dst)
        return os.path.getsize(dst), True
    except OSError:
        shutil.copy2(src, dst)
        return os.path.getsize(dst), False


def sample_name(image_id, sid, ext):
    """Имя файла образца.

    По номеру кадра, а не по его имени: имена в базе повторяются (это уже
    известно выгрузке), а номер уникален по построению и связывает файл с
    кадром без отдельной карты. Приставка у аугментированного — из его же
    пути в графе, поэтому повторная сборка тем же зерном даёт те же имена.
    """
    if not sid:
        return f"{image_id}{ext}"
    tag = sid.strip(".").replace(".", "-")
    return f"{image_id}-{tag}{ext}"


# --------------------------------------------------------------------------- #
# Сборка
# --------------------------------------------------------------------------- #
def load_version_doc(db):
    def loader(graph_id, version_id):
        row = db.get(AugGraphVersion, version_id) if version_id else None
        return row.doc if row is not None else None
    return loader


def build(db, job, *, on_beat=None):
    """Собрать набор. Бросает ``Cancelled``, если работу попросили снять."""
    tset = db.get(TrainSet, job.target_id)
    if tset is None:
        raise ValueError("Набор не найден — собирать нечего.")
    project = db.get(Project, tset.project_id)

    tset.status = "building"
    tset.error = None
    db.commit()

    sel = sel_lib.parse(tset.spec)
    sel["seed"] = tset.seed
    want = tset.kind

    picked = sel_lib.gather(db, project, sel)
    cluster_of = _clusters(db, tset, picked) if sel["split_mode"] == "smart" \
        else None
    split_of, ratio, warnings = sel_lib.assign(
        picked, sel, cluster_of=cluster_of
    )

    # Деление — в базу, до первой картинки.
    db.execute(delete(TrainSetSplit).where(TrainSetSplit.set_id == tset.id))
    for img in picked.images:
        db.add(TrainSetSplit(
            set_id=tset.id, image_id=img.id,
            split=split_of.get(img.id, "train"),
            group_key=(cluster_of or {}).get(img.id) or picked.rarest_of.get(img.id),
        ))
    db.commit()

    root = config.trainset_dir(tset.project_id, tset.id)
    if os.path.isdir(root):
        shutil.rmtree(root, ignore_errors=True)
    for split in ("train", "val"):
        os.makedirs(os.path.join(root, "images", split), exist_ok=True)
        os.makedirs(os.path.join(root, "labels", split), exist_ok=True)

    loader = load_version_doc(db)
    graphs = {}
    for split, version_id in (
        ("train", tset.graph_version_id), ("val", tset.val_graph_version_id)
    ):
        if version_id is None:
            continue
        row = db.get(AugGraphVersion, version_id)
        if row is None:
            raise ValueError(f"Граф для части «{split}» не найден.")
        graphs[split] = engine.compile_graph(
            row.doc, loader,
            min_visibility=float(tset.spec.get("min_visibility", 0.15)),
            with_masks=(want == "polygon"),
        )

    order = sorted(picked.images, key=lambda i: str(i.id))
    total_expected = _expected(order, split_of, graphs)

    counts = Counter()
    per_class = defaultdict(Counter)
    dropped_at = Counter()
    size_bytes = 0
    linked_bytes = 0
    manifest_path = config.trainset_manifest(tset.project_id, tset.id)
    last_beat = 0.0

    with open(manifest_path, "w", encoding="utf-8") as manifest:
        for rank, image in enumerate(order):
            if time.monotonic() - last_beat > BEAT_EVERY:
                alive = queue.beat(
                    db, job, processed=counts["samples"], total=total_expected,
                    stage="render", stage_text="Складываю кадры",
                )
                if on_beat is not None:
                    on_beat(counts["samples"], total_expected)
                if not alive:
                    raise Cancelled()
                last_beat = time.monotonic()

            split = split_of.get(image.id, "train")
            anns = picked.anns.get(image.id, [])
            compiled = graphs.get(split)
            src = os.path.join(config.DATA_DIR, image.file_path)
            ext = os.path.splitext(image.file_path)[1] or ".jpg"

            if compiled is None:
                # Кадр без аугментаций: тот же файл, ссылкой.
                base = sample_of(image, anns, picked.export_id, want, read=False)
                lines = lines_of(base, want, image.width, image.height)
                # Пустая разметка — это фон, и он идёт в набор: отбор уже
                # решил, что этот кадр здесь нужен (см. common.selection).
                if not lines:
                    counts["background"] += 1
                name = sample_name(image.id, "", ext)
                dst = os.path.join(root, "images", split, name)
                written, linked = link_or_copy(src, dst)
                size_bytes += 0 if linked else written
                linked_bytes += written if linked else 0
                _write_label(root, split, name, lines)
                _note(manifest, image, split, name, lines, linked, "", ())
                counts["samples"] += 1
                counts[split] += 1
                counts["annotations"] += len(lines)
                _tally(per_class, lines, split)
                continue

            base = sample_of(image, anns, picked.export_id, want)
            base.ordinal = rank
            made = engine.run_frame(
                compiled, base, tset.seed, str(image.id),
                on_drop=lambda node_id, _why: dropped_at.update([node_id]),
            )
            for _out_node, item in made:
                h, w = item.image.shape[:2]
                lines = lines_of(item, want, w, h)
                if not lines:
                    # Потерял разметку по дороге — потеря, и она считается.
                    # Не имел её с самого начала — фон, и он нужен.
                    if not base.empty:
                        dropped_at.update(["выход"])
                        continue
                    counts["background"] += 1
                name = sample_name(image.id, item.sid, ext)
                dst = os.path.join(root, "images", split, name)
                size_bytes += albu.imwrite_rgb(dst, item.image)
                _write_label(root, split, name, lines)
                _note(manifest, image, split, name, lines, False,
                      item.sid, item.ops)
                counts["samples"] += 1
                counts[split] += 1
                counts["annotations"] += len(lines)
                _tally(per_class, lines, split)

    names = [c.name for c in picked.classes]
    with open(os.path.join(root, "data.yaml"), "w", encoding="utf-8") as fh:
        fh.write(data_yaml(project, names, counts))

    if dropped_at:
        by_node = ", ".join(
            f"{node}: {n}" for node, n in dropped_at.most_common(5)
        )
        warnings.append(
            f"Кадров, потерявших всю разметку: {sum(dropped_at.values())} "
            f"({by_node}). В набор они не пошли."
        )
    if not counts["val"]:
        warnings.append("Проверочная часть пуста — качество измерить будет нечем.")
    if not counts["train"]:
        warnings.append("Обучающая часть пуста.")
    # Класс без проверочных кадров — только словами, деление не трогаем.
    warnings.extend(sel_lib.coverage_warnings(
        (name, per_class[i]["train"], per_class[i]["val"])
        for i, name in enumerate(names)
    ))

    report = {
        "warnings": warnings,
        "dropped": dict(dropped_at),
        "val_ratio": round(ratio, 4),
        "classes": [
            {
                "export_id": i, "name": name,
                "train": per_class[i]["train"], "val": per_class[i]["val"],
                "annotations": per_class[i]["annotations"],
            }
            for i, name in enumerate(names)
        ],
    }
    with open(config.trainset_report(tset.project_id, tset.id), "w",
              encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)

    tset.status = "ready"
    tset.dir_path = os.path.relpath(root, config.DATA_DIR)
    tset.size_bytes = size_bytes
    tset.hardlinked_bytes = linked_bytes
    tset.built_at = utcnow()
    tset.val_ratio = round(ratio, 4)
    tset.counts = {
        "samples": counts["samples"],
        "train": counts["train"],
        "val": counts["val"],
        "annotations": counts["annotations"],
        "background": counts["background"],
        "source_images": len(picked.images),
        "classes": len(names),
        "warnings": len(warnings),
    }
    db.commit()
    return tset


def _write_label(root, split, name, lines):
    stem = os.path.splitext(name)[0]
    path = os.path.join(root, "labels", split, f"{stem}.txt")
    with open(path, "w", encoding="utf-8") as fh:
        fh.writelines(lines)


def _note(manifest, image, split, name, lines, linked, sid, ops):
    manifest.write(json.dumps({
        "image_id": str(image.id),
        "split": split,
        "file": f"images/{split}/{name}",
        "objects": len(lines),
        # `classes` пишем сразу: без них отбор по классу при просмотре
        # набора означал бы открыть сто тысяч файлов разметки. Разбор
        # строки тот же, что в `_tally`, и стоит он ничего — строки
        # уже в руках.
        "classes": samples.classes_in("".join(lines)),
        "hardlink": bool(linked),
        "sid": sid,
        "ops": [o for o in ops if o],
    }, ensure_ascii=False) + "\n")


def _tally(per_class, lines, split):
    for line in lines:
        try:
            cls = int(line.split(maxsplit=1)[0])
        except (ValueError, IndexError):
            continue
        per_class[cls][split] += 1
        per_class[cls]["annotations"] += 1


def _expected(order, split_of, graphs):
    """Сколько образцов ждём — для полосы прогресса.

    Считается по тому же плану, что показывает редактор: если полоса и итог
    разойдутся, виноват будет счёт, а не сборка.
    """
    total = 0.0
    for image in order:
        split = split_of.get(image.id, "train")
        compiled = graphs.get(split)
        if compiled is None:
            total += 1
            continue
        total += _multiplier(compiled)
    return int(round(total))


_MULT_CACHE = {}


def _multiplier(compiled):
    key = id(compiled)
    if key not in _MULT_CACHE:
        doc = {"nodes": compiled.nodes, "edges": compiled.edges}
        _MULT_CACHE[key] = planlib.counts(doc, 1.0)["multiplier"]
    return _MULT_CACHE[key]


def _clusters(db, tset, picked):
    """Группы похожих кадров для умного деления.

    Считать их здесь нечем: вектора кадров даёт видеокарта, и заказывает их
    отдельная работа очереди. Если векторов ещё нет — возвращаем пусто, и
    деление честно скажет об этом в предупреждениях.
    """
    from common import similarity

    return similarity.clusters_for(db, [i.id for i in picked.images], tset.seed)
