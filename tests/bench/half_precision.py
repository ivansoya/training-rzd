"""Замер: fp32 против половинной точности у YOLOE и SAM2 — память, скорость, качество.

Запуск в контейнере training (там torch, ultralytics, sam2 и веса):
    docker cp tests/bench/half_precision.py yolo-training:/tmp/hp.py
    docker exec -e PYTHONPATH=/app -e PROJECT=<код> -e AGENT=<id> yolo-training python /tmp/hp.py

Кадры — с эталоном (данные проекта), подсказки SAM2 — рамки эталона.
Считает теми же функциями, что прогон: `frame_fns`, `agent_graph.detect`, `outline`.
Мимо диспетчера карт: запускать, когда на карте нет работ.
"""
import contextlib
import json
import os
import statistics
import sys
import time

import numpy as np
import torch
from PIL import Image as PilImage
from sqlalchemy import select

from common import agent_graph, config
from common.db import SessionLocal
from common.models import Annotation, AugGraph, AugGraphVersion, Image, Project
from training_svc import agent_runner

PROJECT = os.environ["PROJECT"]
AGENT = os.environ["AGENT"]
FRAMES = int(os.environ.get("FRAMES", "68"))
SAMS = os.environ.get("SAMS", "sam2.1_hiera_small,sam2.1_hiera_large").split(",")
IOU = 0.5
DEV = torch.device("cuda:0")
MB = 1 << 20


def iou(a, b):
    return agent_graph.iou(a, b)


def match(left, right, same=lambda a, b: True):
    """Жадное сопоставление рамок по IoU ≥ 0,5: [(i, j, iou)]."""
    pairs = sorted(((iou(a[1], b[1]), i, j) for i, a in enumerate(left) for j, b in enumerate(right)
                    if same(a, b)), reverse=True)
    used_l, used_r, out = set(), set(), []
    for v, i, j in pairs:
        if v < IOU or i in used_l or j in used_r:
            continue
        used_l.add(i), used_r.add(j)
        out.append((i, j, v))
    return out


def frames(db):
    project = db.execute(select(Project).where(Project.code == PROJECT)).scalar_one()
    images = db.execute(
        select(Image).where(Image.project_id == project.id, Image.dataset_id.isnot(None))
        .order_by(Image.id)).scalars().all()
    out = []
    for im in images:
        truth = []
        for a in db.execute(select(Annotation).where(Annotation.image_id == im.id, Annotation.pending.is_(False))).scalars():
            box = agent_graph.geometry_box(a.ann_type, a.geometry)
            if box:
                truth.append((str(a.class_id), tuple(box)))
        if truth:
            out.append((os.path.join(config.DATA_DIR, im.file_path), im.file_name, truth))
        if len(out) >= FRAMES:
            break
    return out


def sync():
    torch.cuda.synchronize(DEV)


def fresh():
    torch.cuda.empty_cache()
    sync()
    torch.cuda.reset_peak_memory_stats(DEV)
    return torch.cuda.memory_allocated(DEV)


# --------------------------------------------------------------------------- #
# YOLOE: узел «Сеть по тексту» агента как есть
# --------------------------------------------------------------------------- #
class Half:
    """Обёртка модели: прогон зовёт `.predict(...)`, а мы подмешиваем точность."""

    def __init__(self, model, extra):
        self.model, self.extra = model, extra

    def predict(self, *a, **k):
        return self.model.predict(*a, **self.extra, **k)


if os.environ.get("PATCH_MASKS"):
    # Обход ultralytics: в half протомаски float, а коэффициенты half — matmul падает.
    from ultralytics.utils import ops as _ops

    _process_mask = _ops.process_mask
    _ops.process_mask = lambda protos, masks_in, *a, **k: _process_mask(protos.float(), masks_in.float(), *a, **k)

# Как просить половинную точность у ultralytics: `half` устарел, `quantize=16` — новый.
YOLOE_MODES = {"fp32": None, "quantize16": {"quantize": 16}, "half": {"half": True}}


def yoloe(node, classes, data, half):
    base = fresh()
    model = agent_runner.load_text(node, DEV)
    sync()
    loaded = torch.cuda.memory_allocated(DEV) - base
    models = {node["id"]: Half(model, half) if half else model}
    rows = agent_graph.text_rows(node)
    by_row = dict(rows)
    node_conf = agent_graph.num((node.get("params") or {}).get("conf"), 0.25)
    out, times = [], []
    for k, (path, name, _truth) in enumerate(data):
        predict, _ = agent_runner.frame_fns(path, name, models, {}, DEV)
        sync()
        t = time.perf_counter()
        found = predict(node)
        sync()
        if k:  # первый кадр — прогрев (и перевод весов в half у ultralytics)
            times.append(time.perf_counter() - t)
        if k == 0:
            torch.cuda.reset_peak_memory_stats(DEV)
        dets = []
        for row, conf, x, y, w, h, *_rest in found:
            r = by_row[row]
            # Как `run`: строка дорезает своим порогом.
            if conf >= agent_graph.num(r.get("conf"), node_conf):
                dets.append((classes.get(r.get("cls")), (x, y, w, h), conf, row))
        out.append(dets)
    peak = torch.cuda.max_memory_allocated(DEV) - base
    steady = torch.cuda.memory_allocated(DEV) - base
    del models, model
    fresh()
    return out, {"loaded_mb": loaded / MB, "steady_mb": steady / MB, "peak_mb": peak / MB,
                 "ms": 1000 * statistics.median(times)}


def f1(found, data):
    tp = fp = fn = 0
    for dets, (_p, _n, truth) in zip(found, data):
        pairs = match(dets, truth, same=lambda a, b: a[0] == b[0])
        tp += len(pairs)
        fp += len(dets) - len(pairs)
        fn += len(truth) - len(pairs)
    return {"tp": tp, "fp": fp, "fn": fn, "f1": 2 * tp / max(1, 2 * tp + fp + fn)}


def agree(a, b):
    """Насколько вторые находки совпали с первыми: та же строка, IoU ≥ 0,5."""
    total = matched = 0
    ious, dconf = [], []
    for x, y in zip(a, b):
        pairs = match(x, y, same=lambda p, q: p[3] == q[3])
        total += max(len(x), len(y))
        matched += len(pairs)
        ious += [v for _, _, v in pairs]
        dconf += [abs(x[i][2] - y[j][2]) for i, j, _ in pairs]
    return {"same_share": matched / max(1, total), "n32": sum(map(len, a)), "n_half": sum(map(len, b)),
            "iou_median": statistics.median(ious) if ious else None, "iou_min": min(ious) if ious else None,
            "dconf_max": max(dconf) if dconf else None}


# --------------------------------------------------------------------------- #
# SAM2: «Уточнение SAM» и полуавтомат — рамка эталона в подсказку
# --------------------------------------------------------------------------- #
MODES = ("fp32", "autocast-bf16", "autocast-fp16", "weights-bf16")


def sam(name, mode, data):
    base = fresh()
    predictor = agent_runner._load_sam(name, DEV)
    if mode == "weights-bf16":
        predictor.model.to(torch.bfloat16)
    sync()
    loaded = torch.cuda.memory_allocated(DEV) - base
    dtype = {"autocast-bf16": torch.bfloat16, "autocast-fp16": torch.float16,
             "weights-bf16": torch.bfloat16}.get(mode)
    ctx = (lambda: torch.autocast("cuda", dtype=dtype)) if dtype else contextlib.nullcontext
    params = dict(agent_graph.SAM_DEFAULTS)
    out, enc, dec, feat = [], [], [], 0
    for k, (path, _name, truth) in enumerate(data):
        with PilImage.open(path) as img:
            pixels = np.array(img.convert("RGB"))
        with torch.inference_mode(), ctx():
            sync()
            t = time.perf_counter()
            predictor.set_image(pixels)
            sync()
            if k:
                enc.append(time.perf_counter() - t)
            if k == 0:
                torch.cuda.reset_peak_memory_stats(DEV)
                # Кэш полуавтомата держит эти признаки на каждый кадр.
                f = predictor._features
                feat = sum(v.numel() * v.element_size() for v in [f["image_embed"], *f["high_res_feats"]])
            frame = []
            for _cls, box in truth:
                x, y, w, h = box
                t = time.perf_counter()
                masks, scores, _ = predictor.predict(box=np.array([x, y, x + w, y + h], np.float32), multimask_output=True)
                sync()
                dec.append(time.perf_counter() - t)
                det = agent_graph.outline({"box": box, "conf": 1.0}, masks.astype(np.float32) > 0, scores.astype(np.float32), params)
                frame.append(det)
        out.append(frame)
    peak = torch.cuda.max_memory_allocated(DEV) - base
    del predictor
    fresh()
    return out, {"loaded_mb": loaded / MB, "peak_mb": peak / MB, "features_mb": feat / MB,
                 "encode_ms": 1000 * statistics.median(enc), "decode_ms": 1000 * statistics.median(dec)}


def sam_agree(a, b):
    """Итог «Уточнения» против fp32: рамка по маске и решение «SAM не справился»."""
    ious, flips, kept = [], 0, 0
    for fa, fb in zip(a, b):
        for x, y in zip(fa, fb):
            if ("parts" in x) != ("parts" in y):
                flips += 1
                continue
            if "parts" in x:
                kept += 1
                ious.append(iou(x["box"], y["box"]))
    ious.sort()
    return {"refined": kept, "flips": flips, "box_iou_median": statistics.median(ious) if ious else None,
            "box_iou_p05": ious[len(ious) // 20] if ious else None, "box_iou_min": ious[0] if ious else None,
            "under_0_9": sum(v < 0.9 for v in ious)}


def main():
    db = SessionLocal()
    graph = db.get(AugGraph, agent_runner._uuid(AGENT))
    doc = agent_graph.prepare(db.get(AugGraphVersion, graph.head_version_id).doc)
    classes = {c["id"]: (c.get("ref") or {}).get("cls") for c in doc.get("classes") or []}
    data = frames(db)
    db.close()
    boxes = sum(len(t) for *_x, t in data)
    print(f"кадров {len(data)}, рамок эталона {boxes}, карта {torch.cuda.get_device_name(DEV)}", flush=True)
    report = {"frames": len(data), "boxes": boxes}

    for node in doc["nodes"]:
        if node.get("type") != "text" or agent_graph.text_model(node.get("params") or {}) == "sam3":
            continue
        res, ref = {}, None
        for mode, extra in YOLOE_MODES.items():
            try:
                got, m = yoloe(node, classes, data, extra)
            except Exception as e:  # noqa: BLE001
                res[mode] = {"error": f"{type(e).__name__}: {e}"[:300]}
                fresh()
                continue
            ref = got if mode == "fp32" else ref
            res[mode] = {**m, **f1(got, data), **({} if mode == "fp32" else {"agree": agree(ref, got)})}
        report["yoloe"] = res
        print(json.dumps({"yoloe": report["yoloe"]}, ensure_ascii=False, indent=1), flush=True)

    report["sam2"] = {}
    for name in SAMS:
        if name not in agent_runner.SAM_FILES:
            continue
        ref, res = None, {}
        for mode in MODES:
            try:
                got, m = sam(name, mode, data)
            except Exception as e:  # noqa: BLE001 — вариант может не собраться, это тоже результат
                res[mode] = {"error": f"{type(e).__name__}: {e}"[:300]}
                fresh()
                continue
            ref = got if mode == "fp32" else ref
            res[mode] = {**m, **({} if mode == "fp32" else sam_agree(ref, got))}
        report["sam2"][name] = res
        print(json.dumps({name: res}, ensure_ascii=False, indent=1), flush=True)

    with open("/tmp/half_precision.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.exit(main())
