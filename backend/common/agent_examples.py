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
  в вызов, находки ниже полосы — в кадре;
* замер 07.10 (РСМ-2000, Варан КЗТ): отступ «авто» лучше постоянного ×2,5,
  12 образцов вторым рядом — как два прохода за время одного.

Чистый модуль: numpy и cv2 только внутри функций, базы нет.
"""
import hashlib
import random

MIN_SIDE = 8
# Старое поле «В коллаже SAM 3» (до 8): API его ещё принимает, но коллаж теперь берёт все образцы.
COLLAGE_MAX = 8
# Ряд коллажа — 6 клеток во всю ширину вида; 7–12 — второй ряд, если под кадром есть место.
ROW = 6
# Отступ «авто»: предмет в клетке — примерно своего размера в кадре, в пределах ×2…×5
# (замер 1008: при ×1,5 крупным не хватало окружения, узкий грейфер −0,19).
AUTO_MIN, AUTO_MAX = 2.0, 5.0
# Один предмет на соседних кадрах ролика: рамки того же ролика с таким перекрытием.
SAME_IOU = 0.5
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


def square(box, side, width, height):
    """Квадрат стороной `side` вокруг рамки, у края сдвинут внутрь кадра.
    Больше кадра — режется по кадру. → (x0, y0, x1, y1) целыми."""
    x, y, w, h = box
    sw, sh = int(round(min(float(side), width))), int(round(min(float(side), height)))
    x0 = int(round(min(max(0.0, x + w / 2 - sw / 2), width - sw)))
    y0 = int(round(min(max(0.0, y + h / 2 - sh / 2), height - sh)))
    return x0, y0, x0 + sw, y0 + sh


def crop_rect(box, ctx, width, height):
    """Вырезка со стороной `ctx` × большая сторона рамки."""
    return square(box, float(ctx) * max(box[2], box[3]), width, height)


def auto_ctx(long_side, view_w):
    """Отступ «авто»: вырезка ≈ клетке ряда, тогда предмет в коллаже — как в кадре."""
    return min(AUTO_MAX, max(AUTO_MIN, view_w / (ROW * max(1.0, float(long_side)))))


def auto_rect(box, view_w, width, height):
    """Вырезка «авто» для вида шириной `view_w` (кадр или тайл)."""
    long = max(box[2], box[3])
    return square(box, auto_ctx(long, view_w) * long, width, height)


def collage_passes(n, view_w, view_h):
    """Номера образцов по проходам: по 6 в ряд, второй ряд — в тот же проход,
    если с ним коллаж не выше ширины вида (кадр не ужимается)."""
    per = ROW * (2 if view_h + 2 * view_w / ROW <= view_w else 1)
    return [list(range(at, min(n, at + per))) for at in range(0, n, per)]


def collage_strip(crops, chunk, view_w):
    """Ряды вырезок над кадром шириной `view_w` для одного прохода: `crops` — [(вырезка BGR,
    рамка в вырезке)], `chunk` — их номера. → (полоса, рамки образцов в ней [x1, y1, x2, y2])."""
    import cv2
    import numpy as np

    cell = view_w / ROW
    top = round(cell * -(-len(chunk) // ROW))
    strip = np.zeros((top, view_w, 3), np.uint8)
    boxes = []
    for j, at in enumerate(chunk):
        img, (bx, by, bw, bh) = crops[at]
        sc = cell / max(img.shape[:2])
        fit = cv2.resize(img, (max(1, round(img.shape[1] * sc)), max(1, round(img.shape[0] * sc))))
        x0, y0 = round(j % ROW * cell), round(j // ROW * cell)
        part = fit[:top - y0, :view_w - x0]
        strip[y0:y0 + part.shape[0], x0:x0 + part.shape[1]] = part
        boxes.append([x0 + bx * sc, y0 + by * sc, x0 + (bx + bw) * sc, y0 + (by + bh) * sc])
    return strip, boxes


def model_square(image, side, grow=False):
    """Квадрат входа SAM 3: картинка ужата до `side` по большей стороне (`grow` — и растянута),
    поля справа и снизу чёрные, координаты от них не меняются. → (квадрат, масштаб)."""
    import cv2
    import numpy as np

    k = side / max(image.shape[:2])
    if not grow:
        k = min(1.0, k)
    if k != 1:
        image = cv2.resize(image, (round(image.shape[1] * k), round(image.shape[0] * k)), interpolation=cv2.INTER_AREA)
    square = np.zeros((side, side, 3), np.uint8)
    square[:image.shape[0], :image.shape[1]] = image[:side, :side]
    return square, k


def in_rows(y1, y2):
    """Находка в рядах образцов: середина рамки выше кадра (y — от верха кадра).
    Образец у нижнего края клетки SAM 3 находит с хвостом в кадр — это не находка."""
    return y1 + y2 <= 0


def same_object_groups(items, threshold=SAME_IOU):
    """Похожие рамки: тот же ролик и перекрытие ≥ `threshold` — один предмет на
    соседних кадрах. `items` — [(ролик или None, (x, y, w, h))] → номер группы каждой."""
    reps, out = [], []
    for video, box in items:
        hit = next((g for g, (v, b) in enumerate(reps) if video is not None and v == video
                    and _iou(b, box) >= threshold), None)
        if hit is None:
            reps.append((video, box))
            hit = len(reps) - 1
        out.append(hit)
    return out


def _iou(a, b):
    ix = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    union = a[2] * a[3] + b[2] * b[3] - ix * iy
    return ix * iy / union if union > 0 else 0.0


def mean_vector(vectors):
    """Средний вектор набора, нормированный, как у самой YOLOE."""
    import numpy as np

    v = np.asarray(vectors, dtype=np.float32).mean(axis=0)
    norm = float(np.linalg.norm(v))
    return v / norm if norm > 0 else v
