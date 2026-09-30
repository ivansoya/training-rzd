"""Наборы образцов «Сети по тексту»: какие рамки брать, как резать, как сводить.

Решения владельца (25.09.2026) и замеры на «РСМ-2000 · тест», на которых они
держатся:

* образцы — ручные рамки класса из датасетов проекта; меньшая сторона от
  8 px, мельче модели запоминать нечего;
* выбор случайный, но сперва по одной рамке с разных кадров: 32 рамки с
  одного кадра — это один и тот же ракурс 32 раза;
* YOLOE: вектор образца считается по **целому** кадру. По растянутой вырезке
  векторы проваливались (инструмент 0,57 → 0,02): модель помнит масштаб;
* SAM 3 образцы с другого кадра не принимает ни в ultralytics, ни в коде
  Meta — поэтому коллаж (FSS-SAM3): полоса вырезок над кадром, рамки-образцы
  в вызов, находки ниже полосы — в кадре.

Чистый модуль: numpy и cv2 только внутри функций, базы нет.
"""
import hashlib
import random

MIN_SIDE = 8
# Полоса коллажа: столько вырезок по стороне T в ширину — как в замере (6 × 448).
COLLAGE_MAX = 8
STRIP_SIDE = 448
YOLOE_SIZES = ("s", "m", "l", "x")


def geometry_box(ann_type, geometry):
    """Рамка (x, y, w, h) ручной разметки; у полигона — охватывающая."""
    if ann_type == "bbox":
        return (float(geometry["x"]), float(geometry["y"]), float(geometry["w"]), float(geometry["h"]))
    if ann_type == "polygon":
        pts = [p for part in geometry.get("parts") or [] for p in part]
        if not pts:
            return None
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        return (float(min(xs)), float(min(ys)), float(max(xs) - min(xs)), float(max(ys) - min(ys)))
    return None


def usable(box):
    return box is not None and min(box[2], box[3]) >= MIN_SIDE


def uid(image_id, box):
    """Имя образца: кадр плюс рамка. Одно и то же при пересборке — это и
    позволяет «добрать», не взяв уже взятое."""
    raw = f"{image_id}:{','.join(f'{v:.1f}' for v in box)}"
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def pick(frames, n, seed):
    """Выбор образцов: {кадр: [рамки]} → [(кадр, рамка)] длиной до n.

    Кадры перемешиваются зерном, дальше «по кругу»: по первой рамке с каждого
    кадра, потом по второй. Одно зерно — один и тот же выбор, и «добрать k» —
    это просто `pick(..., len(было) + k, seed)` без уже взятых."""
    order = sorted(frames)
    random.Random(seed).shuffle(order)
    boxes = {f: sorted(frames[f]) for f in order}
    out, depth = [], 0
    while len(out) < n and any(len(boxes[f]) > depth for f in order):
        for f in order:
            if len(boxes[f]) > depth and len(out) < n:
                out.append((f, boxes[f][depth]))
        depth += 1
    return out


def crop_rect(box, ctx, width, height):
    """Квадрат вырезки вокруг рамки: сторона `ctx` × большая сторона, не
    меньше 64 px, обрезан краями кадра. → (x0, y0, x1, y1) целыми."""
    x, y, w, h = box
    side = max(64.0, float(ctx) * max(w, h))
    cx, cy = x + w / 2, y + h / 2
    x0, y0 = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
    x1, y1 = int(min(width, round(cx + side / 2))), int(min(height, round(cy + side / 2)))
    return x0, y0, x1, y1


def mean_vector(vectors):
    """Средний вектор набора, нормированный, как у самой YOLOE."""
    import numpy as np

    v = np.asarray(vectors, dtype=np.float32).mean(axis=0)
    norm = float(np.linalg.norm(v))
    return v / norm if norm > 0 else v


def strip_layout(sizes, width, count=None):
    """Раскладка полосы коллажа над кадром ширины `width`.

    `sizes` — [(w, h)] вырезок по порядку, берутся первые `count` (не больше
    COLLAGE_MAX). Каждая вписывается в клетку T×T, полоса T·k растягивается
    на ширину кадра. → (высота полосы, [(x, y, масштаб)] для каждой вырезки)."""
    k = max(1, min(COLLAGE_MAX, count or len(sizes), len(sizes)))
    scale = width / (STRIP_SIDE * k)
    places = []
    for j, (w, h) in enumerate(sizes[:k]):
        fit = STRIP_SIDE / max(w, h)
        places.append((j * STRIP_SIDE * scale, 0.0, fit * scale))
    return round(STRIP_SIDE * scale), places
