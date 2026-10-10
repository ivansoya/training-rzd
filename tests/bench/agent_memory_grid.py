"""Сетка пиков видеопамяти под прикидки `common.agent_memory`: модель × вход × видов за вызов.

Запуск в yolo-training-worker (там карта), когда на ней нет работ — счётчик пика сбрасывается:
    docker cp tests/bench/agent_memory_grid.py yolo-training-worker:/tmp/grid.py
    docker exec -e PYTHONPATH=/app -e FRAME=<путь к кадру внутри data> yolo-training-worker python /tmp/grid.py

Кадры — вырезки настоящего кадра: память постобработки масок растёт с числом находок,
и на шуме она была бы ниже правды. Пишет /tmp/agent_memory_grid.json.
"""
import gc
import json
import os

import numpy as np
import torch
from PIL import Image as PilImage

from common import config
from training_svc import agent_runner

DEV = torch.device("cuda:0")
MB = 1 << 20
FRAME = os.path.join(config.DATA_DIR, os.environ["FRAME"])
WORDS = ["person", "wrench", "hammer", "nut", "bolt"]
NETS = os.environ.get("NETS", "yolo11n,yolo11s,yolov8s,yolo26s,yolo26s-seg,yolo26m-seg").split(",")


def peak(fn):
    """Пик сверх того, что было до вызова, МБ: загрузка модели и вычисление вместе."""
    # Модель прошлого случая освобождается сборщиком — до базы, иначе пик выходит в минус.
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize(DEV)
    base = torch.cuda.memory_allocated(DEV)
    torch.cuda.reset_peak_memory_stats(DEV)
    keep = fn()
    torch.cuda.synchronize(DEV)
    top = torch.cuda.max_memory_allocated(DEV) - base
    steady = torch.cuda.memory_allocated(DEV) - base
    del keep
    gc.collect()
    torch.cuda.empty_cache()
    return round(top / MB), round(steady / MB)


def views(pixels, side, n):
    h, w = pixels.shape[:2]
    out = []
    for i in range(n):
        x = (i * 397) % max(1, w - side)
        y = (i * 211) % max(1, h - side)
        out.append(np.ascontiguousarray(pixels[y:y + side, x:x + side]))
    return out


def yolo_case(make, side, n, conf, pixels):
    def run():
        model = make()
        model.predict(views(pixels, side, n), verbose=False, device=DEV, conf=conf, imgsz=side)
        return model
    return peak(run)


def yoloe(size):
    from ultralytics import YOLOE
    from ultralytics.nn.text_model import MobileCLIPTS

    model = YOLOE(os.path.join(agent_runner.YOLOE_DIR, f"yoloe-26{size}-seg.pt"))
    model.model.clip_model = MobileCLIPTS(torch.device("cpu"), weight=os.path.join(agent_runner.YOLOE_DIR, "mobileclip2_b.ts"))
    pe = model.model.get_text_pe(WORDS, cache_clip_model=True)[0].float()
    del model.model.clip_model
    model.set_classes(WORDS, pe[None])
    return model


def net(name):
    from ultralytics import YOLO
    return YOLO(os.path.join(config.DATA_DIR, "_weights", f"{name}.pt"))


def sam_case(name, w, h, pixels):
    frame = np.array(PilImage.fromarray(pixels).resize((w, h)))
    boxes = [(w * 0.1, h * 0.1, w * 0.3, h * 0.4), (w * 0.5, h * 0.3, w * 0.9, h * 0.9)]

    def run():
        predictor = agent_runner._load_sam(name, DEV)
        predictor.set_image(frame)
        for x0, y0, x1, y1 in boxes:
            predictor.predict(box=np.array([x0, y0, x1, y1], np.float32), multimask_output=True)
        return predictor
    return peak(run)


def main():
    with PilImage.open(FRAME) as img:
        pixels = np.array(img.convert("RGB"))
    print(f"кадр {pixels.shape[1]}×{pixels.shape[0]}", flush=True)
    rows = []

    def add(kind, model, side, n, got, file_mb=None):
        top, steady = got
        rows.append({"kind": kind, "model": model, "side": side, "views": n, "peak_mb": top, "steady_mb": steady, "file_mb": file_mb})
        print(f"{kind:6} {model:22} вход {side:5} видов {n}: пик {top:5} МБ, держит {steady:5} МБ", flush=True)

    for size in ("s", "m", "l", "x"):
        for side in (640, 1280):
            for n in (1, 8):
                add("yoloe", size, side, n, yolo_case(lambda: yoloe(size), side, n, 0.2, pixels))
    for name in NETS:
        path = os.path.join(config.DATA_DIR, "_weights", f"{name}.pt")
        if not os.path.exists(path):
            continue
        for side in (640, 1280):
            for n in (1, 8):
                add("net", name, side, n, yolo_case(lambda: net(name), side, n, 0.25, pixels), round(os.path.getsize(path) / MB, 1))
    for name in agent_runner.SAM_FILES:
        for w, h in ((1920, 1080), (2688, 1520), (3840, 2160)):
            add("sam2", name, f"{w}x{h}", 2, sam_case(name, w, h, pixels))

    with open("/tmp/agent_memory_grid.json", "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
