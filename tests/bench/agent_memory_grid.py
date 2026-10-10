"""Сетка пиков видеопамяти под прикидки `common.agent_memory`: модель × вход × видов за вызов.

Запуск в yolo-training-worker (там карта), когда на ней нет работ — счётчик пика сбрасывается:
    docker cp tests/bench/agent_memory_grid.py yolo-training-worker:/tmp/grid.py
    docker exec -e PYTHONPATH=/app -e FRAME=<путь к кадру внутри data> yolo-training-worker python /tmp/grid.py
`KINDS` — какие случаи мерить (yoloe, yoloe-half, net, sam2, sam3), по умолчанию все.

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
KINDS = os.environ.get("KINDS", "yoloe,yoloe-half,net,sam2,sam3").split(",")
# Слова SAM 3 — порции 1…16, рамки-образцы — один, ряд и два ряда коллажа.
SAM3_WORDS = ["person", "wrench", "hammer", "nut", "bolt", "rail", "sleeper", "wheel",
              "cable", "bucket", "helmet", "vest", "ladder", "box", "pipe", "tool"]
SAM3_BOXES = (1, 6, 12)


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


def yolo_case(make, side, n, conf, pixels, **extra):
    def run():
        model = make()
        model.predict(views(pixels, side, n), verbose=False, device=DEV, conf=conf, imgsz=side, **extra)
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


def sam3_cases(add, pixels):
    """SAM 3 как в прогоне: загрузка (с тумблером сервера и без) и вызовы по словам и по образцам.
    Пик вызова — сверх того, что было до загрузки: в нём и сама модель."""
    from ultralytics.models.sam import SAM3SemanticPredictor

    from common import agent_examples as ax

    class CpuHalf(SAM3SemanticPredictor):
        def get_model(self):
            return super().get_model().half()

    h, w = pixels.shape[:2]
    cell = w // ax.ROW
    crops = [(np.ascontiguousarray(pixels[:cell, i * cell:(i + 1) * cell]), (cell * 0.2, cell * 0.2, cell * 0.6, cell * 0.6))
             for i in range(ax.ROW)] * 2
    for cpu_half in (True, False):
        for side in (644, 1008):
            gc.collect()
            torch.cuda.empty_cache()
            torch.cuda.synchronize(DEV)
            base = torch.cuda.memory_allocated(DEV)
            torch.cuda.reset_peak_memory_stats(DEV)
            cls = CpuHalf if cpu_half else SAM3SemanticPredictor
            pred = cls(overrides=dict(task="segment", mode="predict", model=config.SAM3_WEIGHTS, save=False,
                                      verbose=False, imgsz=side, quantize=16, device=DEV))
            pred.setup_model(None, verbose=False)
            torch.cuda.synchronize(DEV)
            tag = f"sam3{'-cpuhalf' if cpu_half else ''}"
            load = round((torch.cuda.max_memory_allocated(DEV) - base) / MB)
            add(tag, "load", side, 0, (load, round((torch.cuda.memory_allocated(DEV) - base) / MB)))

            def call(fn):
                torch.cuda.synchronize(DEV)
                torch.cuda.reset_peak_memory_stats(DEV)
                fn()
                torch.cuda.synchronize(DEV)
                return (round((torch.cuda.max_memory_allocated(DEV) - base) / MB),
                        round((torch.cuda.memory_allocated(DEV) - base) / MB))

            small, _k = ax.model_square(pixels, side)
            for n in (1, 2, 4, 8, 16):
                def words(n=n):
                    pred.set_image(small)
                    pred(text=SAM3_WORDS[:n])
                add(tag, "words", side, n, call(words))
            for n in SAM3_BOXES:
                def boxes(n=n):
                    strip, got = ax.collage_strip(crops, list(range(n)), w)
                    square, k = ax.model_square(np.vstack([strip, pixels]), side)
                    pred.set_image(square)
                    pred(bboxes=np.array(got, np.float32) * k, labels=np.ones(len(got)))
                add(tag, "boxes", side, n, call(boxes))
            del pred
            gc.collect()
            torch.cuda.empty_cache()


def main():
    with PilImage.open(FRAME) as img:
        pixels = np.array(img.convert("RGB"))
    print(f"кадр {pixels.shape[1]}×{pixels.shape[0]}", flush=True)
    rows = []

    def add(kind, model, side, n, got, file_mb=None):
        top, steady = got
        rows.append({"kind": kind, "model": model, "side": side, "views": n, "peak_mb": top, "steady_mb": steady, "file_mb": file_mb})
        print(f"{kind:6} {model:22} вход {side:5} видов {n}: пик {top:5} МБ, держит {steady:5} МБ", flush=True)

    if "yoloe-half" in KINDS:
        # Обход ultralytics, как в прогоне: протомаски float, коэффициенты half.
        from ultralytics.utils import ops
        process_mask = ops.process_mask
        ops.process_mask = lambda protos, masks_in, *a, **k: process_mask(protos.float(), masks_in.float(), *a, **k)
    for kind, extra in (("yoloe", {}), ("yoloe-half", {"quantize": 16})):
        if kind not in KINDS:
            continue
        for size in ("s", "m", "l", "x"):
            for side in (640, 1280):
                for n in (1, 8):
                    add(kind, size, side, n, yolo_case(lambda: yoloe(size), side, n, 0.2, pixels, **extra))
    for name in NETS if "net" in KINDS else ():
        path = os.path.join(config.DATA_DIR, "_weights", f"{name}.pt")
        if not os.path.exists(path):
            continue
        for side in (640, 1280):
            for n in (1, 8):
                add("net", name, side, n, yolo_case(lambda: net(name), side, n, 0.25, pixels), round(os.path.getsize(path) / MB, 1))
    for name in agent_runner.SAM_FILES if "sam2" in KINDS else ():
        for w, h in ((1920, 1080), (2688, 1520), (3840, 2160)):
            add("sam2", name, f"{w}x{h}", 2, sam_case(name, w, h, pixels))
    if "sam3" in KINDS:
        sam3_cases(add, pixels)

    with open("/tmp/agent_memory_grid.json", "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
