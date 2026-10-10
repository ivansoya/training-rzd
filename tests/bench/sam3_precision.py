"""Замер SAM 3: как сейчас (fp32 на карту → half), half ещё на процессоре, fp32 — эталон качества.

Узел SAM 3 агента с его образцами, кадры с эталоном. Меряет загрузку (время, пик, что держит),
пик и время на кадр, F1 по эталону и совпадение с fp32. Гонять в yolo-training-worker:
    docker cp tests/bench/sam3_precision.py yolo-training-worker:/tmp/s3.py
    docker exec -e PYTHONPATH=/app -e PROJECT=<код> -e AGENT=<id> yolo-training-worker python /tmp/s3.py
"""
import gc
import json
import os
import statistics
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(__file__))
from half_precision import agree, f1, frames  # noqa: E402

from common import agent_graph, config  # noqa: E402
from common.db import SessionLocal  # noqa: E402
from common.models import AugGraph, AugGraphVersion  # noqa: E402
from training_svc import agent_runner, examples  # noqa: E402

DEV = torch.device("cuda:0")
MB = 1 << 20
SIDES = [int(s) for s in os.environ.get("SIDES", "644,1008").split(",")]
VARIANTS = os.environ.get("VARIANTS", "now,cpu-half,fp32").split(",")
FP16_FILE = "/tmp/sam3-detector-fp16.pt"


def predictor(variant, side, weights=None):
    from ultralytics.models.sam import SAM3SemanticPredictor

    class CpuHalf(SAM3SemanticPredictor):
        # Модель ужимается до переноса на карту: fp32-копии на карте не бывает.
        def get_model(self):
            return super().get_model().half()

    cls = CpuHalf if variant in ("cpu-half", "fp16-file") or variant.startswith("int8") else SAM3SemanticPredictor
    return cls(overrides=dict(task="segment", mode="predict", model=weights or config.SAM3_WEIGHTS, save=False,
                              verbose=False, imgsz=side, quantize=None if variant == "fp32" else 16, device=DEV))


def int8(model, variant):
    """torchao (нет в образе — ставится во временный контейнер): веса int8 у линейных слоёв."""
    from torchao.quantization import Int8DynamicActivationInt8WeightConfig, Int8WeightOnlyConfig, quantize_

    quantize_(model, Int8WeightOnlyConfig() if variant == "int8-wo" else Int8DynamicActivationInt8WeightConfig())
    gc.collect()
    torch.cuda.empty_cache()


def fresh():
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize(DEV)
    torch.cuda.reset_peak_memory_stats(DEV)
    return torch.cuda.memory_allocated(DEV)


def run(variant, side, node, sets, classes, data):
    base = fresh()
    t = time.perf_counter()
    pred = predictor(variant, side, FP16_FILE if variant == "fp16-file" else None)
    pred.setup_model(None, verbose=False)
    if variant.startswith("int8"):
        int8(pred.model, variant)
    torch.cuda.synchronize(DEV)
    load_s = time.perf_counter() - t
    load_peak = torch.cuda.max_memory_allocated(DEV) - base
    held = torch.cuda.memory_allocated(DEV) - base
    dtype = str(next(pred.model.parameters()).dtype)
    node = {**node, "params": {**node["params"], "side": side}}
    model = agent_runner.load_text(node, DEV, sets, shared={side: pred})
    models = {node["id"]: model}
    rows = dict(agent_graph.text_rows(node))
    node_conf = agent_graph.num(node["params"].get("conf"), 0.4)
    out, times = [], []
    torch.cuda.reset_peak_memory_stats(DEV)
    for k, (path, name, _truth) in enumerate(data):
        predict, _ = agent_runner.frame_fns(path, name, models, {}, DEV)
        torch.cuda.synchronize(DEV)
        t = time.perf_counter()
        found = predict(node)
        torch.cuda.synchronize(DEV)
        if k:
            times.append(time.perf_counter() - t)
        dets = []
        for row, conf, x, y, w, h, *_ in found:
            r = rows[row]
            if conf >= agent_graph.num(r.get("conf"), node_conf):
                dets.append((classes.get(r.get("cls")), (x, y, w, h), conf, row))
        out.append(dets)
    work_peak = torch.cuda.max_memory_allocated(DEV) - base
    del models, model, pred
    fresh()
    return out, {"dtype": dtype, "load_s": round(load_s, 1), "load_peak_mb": round(load_peak / MB),
                 "held_mb": round(held / MB), "work_peak_mb": round(work_peak / MB),
                 "ms": round(1000 * statistics.median(times))}


def make_fp16_file():
    """Только веса детектора и в fp16: трекер картинкам не нужен."""
    if os.path.exists(FP16_FILE):
        return
    ckpt = torch.load(config.SAM3_WEIGHTS, map_location="cpu", weights_only=False)
    ckpt = ckpt.get("model", ckpt) if isinstance(ckpt, dict) else ckpt
    small = {k: (v.half() if torch.is_tensor(v) and v.is_floating_point() else v)
             for k, v in ckpt.items() if "detector" in k}
    torch.save({"model": small}, FP16_FILE)


def main():
    db = SessionLocal()
    graph = db.get(AugGraph, agent_runner._uuid(os.environ["AGENT"]))
    doc = agent_graph.prepare(db.get(AugGraphVersion, graph.head_version_id).doc)
    classes = {c["id"]: (c.get("ref") or {}).get("cls") for c in doc.get("classes") or []}
    sets = examples.rows_for(db, graph.owner_id, doc)
    data = frames(db)
    db.close()
    node = next(n for n in doc["nodes"] if n["type"] == "text" and agent_graph.text_model(n["params"]) == "sam3")
    print(f"кадров {len(data)}, узел «{agent_graph.title(node)}», наборов образцов {len(sets)}", flush=True)
    if "fp16-file" in VARIANTS:
        make_fp16_file()
        print(f"файл: {os.path.getsize(config.SAM3_WEIGHTS) / MB:.0f} МБ → fp16 детектор {os.path.getsize(FP16_FILE) / MB:.0f} МБ", flush=True)
    report = {}
    for side in SIDES:
        res, got = {}, {}
        for variant in VARIANTS:
            try:
                got[variant], m = run(variant, side, node, sets, classes, data)
            except Exception as e:  # noqa: BLE001 — вариант может не собраться, это тоже результат
                res[variant] = {"error": f"{type(e).__name__}: {e}"[:300]}
                fresh()
                continue
            res[variant] = {**m, **f1(got[variant], data)}
            print(f"  {side} {variant}: {json.dumps(res[variant], ensure_ascii=False)}", flush=True)
        ref = got.get("fp32")
        for variant in got:
            if ref is not None and variant != "fp32":
                res[variant]["agree_fp32"] = agree(ref, got[variant])
        report[side] = res
        print(json.dumps({side: res}, ensure_ascii=False, indent=1), flush=True)
    with open("/tmp/sam3_precision.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
