"""Таска из датасета: копии кадров и их сдача на место (решения 14.10.2026).

Кадр датасета уходит в таску копией: файл — жёсткой ссылкой, разметка и таги —
копией. Датасет не меняется до «Готово»; сдача кладёт правки копии на исходник
на месте (id, сплит и датасет прежние). Исходник, который правили в датасете
после взятия, сдача не трогает — то же правило, что у кадров роликов.
"""
import os
import shutil
import uuid

from sqlalchemy import delete, insert, select

from common import config, task_frames
from common.models import Annotation, Dataset, Image, ImageTag

SUBDIRS = ("images", "thumbs", "preview")
SHAPE_COLS = ("class_id", "ann_type", "geometry", "area", "iscrowd", "attributes", "source",
              "agent_version_id", "pending", "reviewed_by", "created_by")
# Решённые копии: размеченная и «Пусто» ложатся на место, брак убирает исходник
DECIDED = ("annotated", "empty", "deleted")


def _ids(raw):
    out = set()
    for v in raw or []:
        try:
            out.add(uuid.UUID(str(v)))
        except ValueError:
            continue
    return out


def _originals(db, project_id, image_ids):
    """Кадры датасетов проекта из присланных; чужое и не из датасета — мимо."""
    ids = _ids(image_ids)
    if not ids:
        return []
    return db.execute(select(Image).where(
        Image.id.in_(ids), Image.project_id == project_id, Image.dataset_id.isnot(None),
    )).scalars().all()


def _busy_view(busy):
    """[{task_id, name, n}] — сколько выбранных держит каждая живая таска."""
    by_task = {}
    for task_id, name in busy.values():
        row = by_task.setdefault(task_id, {"task_id": str(task_id), "name": name, "n": 0})
        row["n"] += 1
    return sorted(by_task.values(), key=lambda r: -r["n"])


def preview(db, project_id, image_ids):
    """Что уйдёт в таску: по датасетам и сколько пропустим из-за живых копий."""
    originals = _originals(db, project_id, image_ids)
    busy = task_frames.live_copies(db, [o.id for o in originals])
    counts = {}
    for o in originals:
        if o.id not in busy:
            counts[o.dataset_id] = counts.get(o.dataset_id, 0) + 1
    names = dict(db.execute(select(Dataset.id, Dataset.name).where(Dataset.id.in_(list(counts)))).all()) \
        if counts else {}
    return {
        "take": sum(counts.values()),
        "by_dataset": sorted(({"id": str(k), "name": names.get(k, ""), "n": n} for k, n in counts.items()),
                             key=lambda r: -r["n"]),
        "busy": _busy_view(busy),
    }


def _link(src, dst):
    """Жёсткая ссылка: место на томе не тратится. Другой том — копия файла."""
    try:
        os.link(src, dst)
    except FileExistsError:
        pass
    except OSError:
        shutil.copyfile(src, dst)


def _copy_shapes(db, pairs):
    """Разметка {откуда: куда} пачкой; номера рамок — новые, автор и проверка — прежние."""
    if not pairs:
        return
    rows = [
        {"id": uuid.uuid4(), "image_id": pairs[a.image_id], **{c: getattr(a, c) for c in SHAPE_COLS}}
        for a in db.execute(select(Annotation).where(Annotation.image_id.in_(list(pairs)))).scalars()
    ]
    if rows:
        db.execute(insert(Annotation), rows)


def _copy_tags(db, pairs):
    rows = [{"image_id": pairs[i], "tag_id": t} for i, t in db.execute(
        select(ImageTag.image_id, ImageTag.tag_id).where(ImageTag.image_id.in_(list(pairs)))).all()]
    if rows:
        db.execute(insert(ImageTag), rows)


def take(db, task, user, image_ids):
    """Копии выбранных кадров в таску. Кадр с живой копией в другой таске пропускается.

    Возвращает итог и id созданных копий: упадёт коммит — вызывающий уберёт их файлы."""
    originals = _originals(db, task.project_id, image_ids)
    busy = task_frames.live_copies(db, [o.id for o in originals])
    fresh = [o for o in originals if o.id not in busy]
    base = config.image_base_dir(task.project_id, task.id)
    for sub in SUBDIRS:
        os.makedirs(os.path.join(base, sub), exist_ok=True)
    pairs, rows = {}, []
    for o in fresh:
        cid = uuid.uuid4()
        src = config.image_base_dir(o.project_id, o.task_id)
        for sub in SUBDIRS:
            path = os.path.join(src, sub, f"{o.id}.jpg")
            # Превью мелкого кадра нет: его отдаёт сам оригинал
            if sub == "images" or os.path.exists(path):
                _link(path, os.path.join(base, sub, f"{cid}.jpg"))
        rows.append({
            "id": cid, "project_id": o.project_id, "dataset_id": None, "task_id": task.id,
            "task_status": "new", "file_name": o.file_name,
            "file_path": os.path.relpath(os.path.join(base, "images", f"{cid}.jpg"), config.DATA_DIR),
            "split": o.split, "width": o.width, "height": o.height, "size_bytes": o.size_bytes,
            "origin_image_id": o.id, "created_by": user.id,
        })
        o.copy_rev = o.annotations_rev
        pairs[o.id] = cid
    if rows:
        db.execute(insert(Image), rows)
        _copy_shapes(db, pairs)
        _copy_tags(db, pairs)
    return {"added": len(rows), "busy": _busy_view(busy)}, list(pairs.values())


def hand_over(db, task, drop):
    """Решённые копии таски — на исходники. `drop(исходник)` убирает его из датасета
    (брак) и отдаёт файлы, которые стереть после коммита, или None.

    Нетронутые и отложенные копии исходник не трогают; копия с непроверенным агента
    ждёт, как и обычный кадр. Итог — числа для строки «Сдано: …»."""
    sums = {"placed": 0, "removed": 0, "edited": 0, "waiting": 0}
    files = []
    copies = db.execute(select(Image).where(
        Image.task_id == task.id, Image.origin_image_id.isnot(None), Image.task_status.in_(DECIDED),
    )).scalars().all()
    if not copies:
        return sums, files
    originals = {o.id: o for o in db.execute(
        select(Image).where(Image.id.in_([c.origin_image_id for c in copies])).with_for_update()
    ).scalars()}
    waiting = set(db.execute(select(Annotation.image_id).where(
        Annotation.image_id.in_([c.id for c in copies]), Annotation.pending.is_(True))).scalars())
    place = {}
    for c in copies:
        o = originals.get(c.origin_image_id)
        # Исходник уже не в датасете (удалили там или прошлой сдачей) — класть некуда
        if o is None or o.dataset_id is None:
            continue
        if o.copy_rev != o.annotations_rev:
            sums["edited"] += 1
        elif c.task_status == "deleted":
            got = drop(o)
            if got:
                files.append(got)
            sums["removed"] += 1
        elif c.id in waiting:
            sums["waiting"] += 1
        else:
            place[c.id] = o
    if place:
        targets = [o.id for o in place.values()]
        db.execute(delete(Annotation).where(Annotation.image_id.in_(targets)))
        db.execute(delete(ImageTag).where(ImageTag.image_id.in_(targets)))
        pairs = {cid: o.id for cid, o in place.items()}
        _copy_shapes(db, pairs)
        _copy_tags(db, pairs)
        status = {c.id: c.task_status for c in copies}
        for cid, o in place.items():
            o.task_status = status[cid]
            o.annotations_rev += 1
            o.copy_rev = o.annotations_rev
        sums["placed"] = len(place)
    return sums, files


def drop_files(project_id, task_id, image_ids):
    """Файлы копий, чья запись не состоялась."""
    base = config.image_base_dir(project_id, task_id)
    for iid in image_ids:
        for sub in SUBDIRS:
            try:
                os.remove(os.path.join(base, sub, f"{iid}.jpg"))
            except OSError:
                pass
