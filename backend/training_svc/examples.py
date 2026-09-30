"""Наборы образцов «Сети по тексту»: сборка в воркере, производные — в вебе.

Сборка — нить `training-worker` по образцу превью: веб кладёт строку
`agent_examples` со статусом queued, шлёт NOTIFY и ждёт; нить выбирает рамки,
режет вырезки и считает векторы YOLOE всех четырёх размеров. Считать надо
на карте, и веса YOLOE есть только в образе обучения — поэтому здесь.

«Убрать» и «переставить» карты не требуют: векторы хранятся по образцу, и
новый набор — это подмножество старого (`derive`, в вебе, сразу). «Добрать»
требует новых векторов — снова через очередь.

На полке: `<набор>/vectors.npz` — `uids` и по массиву (N, D) на размер;
`<набор>/<uid>.jpg` — вырезка ×ctx для коллажа SAM 3 и миниатюр.
"""
import logging
import os
import select as selectlib
import shutil
import time
import uuid
from datetime import timedelta

from sqlalchemy import select

from common import agent_examples as ax, agent_graph, config, gpu
from common.db import SessionLocal, engine
from common.models import (
    AgentExamples, Annotation, AugGraph, AugGraphVersion, Image, utcnow,
)

log = logging.getLogger("training.examples")

CHANNEL = "agent_examples"
SHELF = os.path.join(config.DATA_DIR, "_weights", "users")
# Векторы — по одной рамке за проход, четыре размера YOLOE по очереди: в
# памяти одна модель, ~1,5 ГБ.
VRAM_MB = 2000
# Набор, на который никто не ссылается, живёт сутки: человек мог собрать его
# и ещё не сохранить черновик.
KEEP = timedelta(days=1)
GC_EVERY = 3600


def folder(owner_id, set_id):
    return os.path.join(SHELF, str(owner_id), "examples", str(set_id))


def view(row):
    return {
        "id": str(row.id),
        "status": row.status,
        "error": row.error,
        "project": row.project_name,
        "class_name": row.class_name,
        "params": row.params,
        "parent_id": str(row.parent_id) if row.parent_id else None,
        "items": [{"uid": it["uid"], "file_name": it["file_name"], "side": round(min(it["box"][2:]))}
                  for it in row.items],
        "frames": len({it["image_id"] for it in row.items}),
        "created_at": row.created_at.isoformat(),
    }


def usable_boxes(db, project_id, class_id, datasets=None):
    """{кадр: [рамки]} — ручные рамки класса в датасетах проекта."""
    q = (select(Annotation.image_id, Annotation.ann_type, Annotation.geometry, Image.file_name)
         .join(Image, Image.id == Annotation.image_id)
         .where(Image.project_id == project_id, Image.dataset_id.isnot(None),
                Annotation.class_id == class_id, Annotation.source == "human"))
    if datasets:
        q = q.where(Image.dataset_id.in_(datasets))
    frames, names = {}, {}
    for image_id, ann_type, geometry, file_name in db.execute(q):
        box = ax.geometry_box(ann_type, geometry)
        if ax.usable(box):
            frames.setdefault(str(image_id), []).append(tuple(round(v, 1) for v in box))
            names[str(image_id)] = file_name
    return frames, names


# --------------------------------------------------------------------------- #
# Сборка (воркер)
# --------------------------------------------------------------------------- #
def _vectors(jobs, device):
    """Вектор каждого образца для YOLOE s/m/l/x: {размер: (N, D)}.

    По целому кадру и по одной рамке за проход: так вектор образца можно
    убрать из набора, не пересчитывая остальных. `jobs` — [(путь, рамка)]."""
    import cv2
    import numpy as np
    from ultralytics import YOLOE
    from ultralytics.models.yolo.yoloe import YOLOEVPSegPredictor

    from training_svc import agent_runner

    out = {}
    for size in ax.YOLOE_SIZES:
        model = YOLOE(os.path.join(agent_runner.YOLOE_DIR, f"yoloe-26{size}-seg.pt"))
        # Голова под образцы — один класс за проход; модель после этого для
        # поиска непригодна, поэтому своя на каждый размер и в мусор.
        model.model.model[-1].nc = 1
        model.model.names = ["object0"]
        pred = YOLOEVPSegPredictor(overrides={
            "task": "segment", "mode": "predict", "save": False, "verbose": False,
            "batch": 1, "device": device, "imgsz": agent_graph.TEXT_IMGSZ})
        pred.setup_model(model=model.model)
        vecs, cached = [], (None, None)
        for path, (x, y, w, h) in jobs:
            if cached[0] != path:
                cached = (path, cv2.imread(path))
            # pre_transform съедает рамки из prompts — ставим перед каждым проходом.
            pred.set_prompts({"bboxes": np.array([[x, y, x + w, y + h]], np.float32),
                              "cls": np.zeros(1, int)})
            vecs.append(pred.get_vpe(cached[1])[0, 0].float().cpu().numpy())
        out[size] = np.stack(vecs).astype(np.float32)
        del pred, model
    return out


def build(db, row, device):
    """Собрать набор: выбрать рамки (или добрать к родителю), вырезки, векторы."""
    import cv2
    import numpy as np

    p = row.params
    if row.project_id is None or row.class_id is None:
        raise ValueError("Проекта или класса набора больше нет — брать образцы неоткуда.")
    frames, names = usable_boxes(db, row.project_id, row.class_id, p.get("datasets"))
    parent = db.get(AgentExamples, row.parent_id) if row.parent_id else None
    have = list(parent.items) if parent else []
    want = len(have) + int(p.get("add") or 0) if parent else int(p["n"])
    # Убранное человеком обратно не добираем: он его убрал нарочно.
    taken = {it["uid"] for it in have} | set(p.get("removed") or [])
    fresh = [(f, b) for f, b in ax.pick(frames, want + len(have), int(p["seed"]))
             if ax.uid(f, b) not in taken][:want - len(have)]
    if not fresh and not have:
        raise ValueError("В датасетах нет ручных рамок этого класса крупнее 8 px.")

    out_dir = folder(row.owner_id, row.id)
    os.makedirs(out_dir, exist_ok=True)
    paths = {str(i.id): os.path.join(config.DATA_DIR, i.file_path) for i in db.execute(
        select(Image).where(Image.id.in_([f for f, _ in fresh]))).scalars()} if fresh else {}
    items = []
    for image_id, box in fresh:
        im = cv2.imread(paths[image_id])
        x0, y0, x1, y1 = ax.crop_rect(box, p["ctx"], im.shape[1], im.shape[0])
        u = ax.uid(image_id, box)
        cv2.imwrite(os.path.join(out_dir, f"{u}.jpg"), im[y0:y1, x0:x1], [cv2.IMWRITE_JPEG_QUALITY, 92])
        items.append({"uid": u, "image_id": image_id, "file_name": names[image_id], "box": list(box),
                      "crop_box": [box[0] - x0, box[1] - y0, box[2], box[3]]})
    got = _vectors([(paths[f], b) for f, b in fresh], device) if fresh else {}
    if parent:
        old = np.load(os.path.join(config.DATA_DIR, parent.dir, "vectors.npz"))
        _link_crops(parent, out_dir, [it["uid"] for it in have])
        got = {s: np.concatenate([old[s], got[s]]) if fresh else old[s] for s in ax.YOLOE_SIZES}
        items = have + items
    np.savez(os.path.join(out_dir, "vectors.npz"), uids=np.array([it["uid"] for it in items]), **got)
    row.items = items
    row.status = "ready"


def _link_crops(parent, out_dir, uids):
    """Вырезки родителя — жёсткими ссылками: место на диске не тратится."""
    src = os.path.join(config.DATA_DIR, parent.dir)
    for u in uids:
        dst = os.path.join(out_dir, f"{u}.jpg")
        if not os.path.exists(dst):
            try:
                os.link(os.path.join(src, f"{u}.jpg"), dst)
            except OSError:
                shutil.copyfile(os.path.join(src, f"{u}.jpg"), dst)


# --------------------------------------------------------------------------- #
# Производный набор без карты (веб): убрать и переставить
# --------------------------------------------------------------------------- #
def derive(db, parent, order, user_id, collage=None):
    """Новый набор из образцов родителя в порядке `order` (их uid)."""
    import numpy as np

    by = {it["uid"]: it for it in parent.items}
    order = [u for u in dict.fromkeys(order) if u in by]
    if not order:
        raise ValueError("В наборе не осталось ни одного образца.")
    dropped = {it["uid"] for it in parent.items} - set(order)
    params = {**parent.params, "add": 0,
              "removed": sorted(set(parent.params.get("removed") or []) | dropped)}
    if collage is not None:
        params["collage"] = max(1, min(ax.COLLAGE_MAX, int(collage)))
    row = AgentExamples(
        owner_id=parent.owner_id, parent_id=parent.id, project_id=parent.project_id,
        project_name=parent.project_name, class_id=parent.class_id, class_name=parent.class_name,
        params=params, items=[by[u] for u in order], dir="", status="ready", created_by=user_id)
    db.add(row)
    db.flush()
    out_dir = folder(row.owner_id, row.id)
    os.makedirs(out_dir, exist_ok=True)
    _link_crops(parent, out_dir, order)
    old = np.load(os.path.join(config.DATA_DIR, parent.dir, "vectors.npz"))
    index = {u: k for k, u in enumerate(old["uids"].tolist())}
    pick = [index[u] for u in order]
    np.savez(os.path.join(out_dir, "vectors.npz"), uids=np.array(order),
             **{s: old[s][pick] for s in ax.YOLOE_SIZES})
    row.dir = os.path.relpath(out_dir, config.DATA_DIR)
    return row


# --------------------------------------------------------------------------- #
# Для прогона: средний вектор и вырезки коллажа
# --------------------------------------------------------------------------- #
def mean_vector(row, size):
    import numpy as np

    return ax.mean_vector(np.load(os.path.join(config.DATA_DIR, row.dir, "vectors.npz"))[size])


def collage_crops(row):
    """[(вырезка BGR, рамка в вырезке)] — первые `collage` образцов."""
    import cv2

    count = int(row.params.get("collage") or 6)
    return [(cv2.imread(os.path.join(config.DATA_DIR, row.dir, f"{it['uid']}.jpg")), it["crop_box"])
            for it in row.items[:count]]


def rows_for(db, owner_id, doc):
    """{id набора: строка} для всех строк-образцов графа — только свои и готовые."""
    ids = {_uuid(s) for n in (doc or {}).get("nodes") or [] if n.get("type") == "text"
           for _, s in agent_graph.text_sets(n)} - {None}
    if not ids:
        return {}
    got = db.execute(select(AgentExamples).where(AgentExamples.id.in_(ids),
                                                 AgentExamples.owner_id == owner_id)).scalars()
    return {str(r.id): r for r in got}


def _uuid(value):
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


def readiness(db, owner_id, doc):
    """{id набора: готов ли} — для `agent_graph.check`."""
    return {k: r.status == "ready" for k, r in rows_for(db, owner_id, doc).items()}


# --------------------------------------------------------------------------- #
# Нить воркера
# --------------------------------------------------------------------------- #
def _take(db):
    row = db.execute(
        select(AgentExamples).where(AgentExamples.status == "queued")
        .order_by(AgentExamples.created_at).limit(1).with_for_update(skip_locked=True)
    ).scalar_one_or_none()
    return row


def _answer(db, row):
    lease = gpu.request(db, holder="training", kind="agent-examples", want_mb=VRAM_MB,
                        priority=20, allow_cpu=True, title="Образцы агента")
    if lease.status != "held":
        gpu.cancel(db, lease.id, "Образцы считаются на процессоре")
    device = 0 if lease.status == "held" and lease.device_id is not None else "cpu"
    try:
        row.dir = os.path.relpath(folder(row.owner_id, row.id), config.DATA_DIR)
        build(db, row, device)
    finally:
        if lease.status == "held":
            gpu.release(db, lease.id)
        from training_svc import agent_runner
        agent_runner._free()


def gc(db):
    """Убрать наборы, на которые не ссылается ни один агент, старше суток."""
    used = set()
    docs = [d for (d,) in db.execute(select(AugGraph.draft).where(AugGraph.kind == "agent"))]
    docs += [d for (d,) in db.execute(select(AugGraphVersion.doc).join(
        AugGraph, AugGraph.id == AugGraphVersion.graph_id).where(AugGraph.kind == "agent"))]
    for doc in docs:
        for node in (doc or {}).get("nodes") or []:
            if node.get("type") == "text":
                used.update(s for _, s in agent_graph.text_sets(node))
    stale = db.execute(select(AgentExamples).where(
        AgentExamples.created_at < utcnow() - KEEP, AgentExamples.status != "queued")).scalars().all()
    gone = 0
    for row in stale:
        if str(row.id) in used:
            continue
        if row.dir:
            shutil.rmtree(os.path.join(config.DATA_DIR, row.dir), ignore_errors=True)
        db.delete(row)
        gone += 1
    db.commit()
    if gone:
        log.info("убрано наборов образцов: %s", gone)


def loop(stop):
    """Нить воркера. `stop` — общее событие остановки."""
    conn = engine.raw_connection()
    conn.set_isolation_level(0)   # LISTEN вне транзакции
    conn.cursor().execute(f"LISTEN {CHANNEL}")
    last_gc = 0.0
    while not stop.is_set():
        selectlib.select([conn], [], [], 5)
        conn.poll()
        conn.notifies.clear()
        db = SessionLocal()
        try:
            while (row := _take(db)) is not None:
                try:
                    _answer(db, row)
                except Exception as exc:  # noqa: BLE001 — человеку нужен текст
                    log.exception("набор образцов не собран")
                    db.rollback()
                    row = db.get(AgentExamples, row.id)
                    row.status, row.error = "error", str(exc)[:500]
                db.commit()
            if time.monotonic() - last_gc > GC_EVERY:
                gc(db)
                last_gc = time.monotonic()
        except Exception:
            log.exception("нить образцов агента")
            db.rollback()
        finally:
            db.close()
