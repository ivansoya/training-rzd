"""«Слияние сеткой»: по образцу с каждого входа — в один кадр.

Сетка — строки × столбцы, а не свободные прямоугольники: ячейки лежат плотно,
без дыр и без наложений. Дыра была бы чёрным полем, которое модель примет за
часть сцены, а наложение прятало бы размеченный объект под соседним кадром —
и разметка говорила бы о том, чего на картинке нет.

Вписывание своё у каждой ячейки. ``letterbox`` сохраняет пропорции и добивает
поля чёрным; ``stretch`` растягивает кадр на всю ячейку. Разметка в обоих
случаях едет вместе с картинкой и за ячейку не выходит — обрезать нечего.

Считающая часть (``cells``, ``fit_into``) не трогает картинок и закрыта
числами в ``tests/unit/test_mosaic.py``.
"""
from dataprep_svc import engine
from dataprep_svc.graph import schema


def cells(g):
    """Ячейки сетки в пикселях выходного кадра, по порядку строк:
    [(x0, y0, x1, y1)]. Границы округляются один раз, поэтому соседние
    ячейки сходятся без щели и без нахлёста."""
    def edges(shares, size):
        out, run = [0], 0.0
        for share in shares:
            run += share
            out.append(round(run * size))
        out[-1] = size
        return out

    xs = edges(g["col_w"], g["width"])
    ys = edges(g["row_h"], g["height"])
    return [
        (xs[c], ys[r], max(xs[c + 1], xs[c] + 1), max(ys[r + 1], ys[r] + 1))
        for r in range(g["rows"])
        for c in range(g["cols"])
    ]


def fit_into(w, h, cell, fit):
    """Куда лечь кадру ``w × h`` в ячейке: (x, y, ширина, высота) в пикселях."""
    x0, y0, x1, y1 = cell
    cw, ch = x1 - x0, y1 - y0
    if fit == "stretch":
        return x0, y0, cw, ch
    k = min(cw / w, ch / h)
    nw, nh = max(1, round(w * k)), max(1, round(h * k))
    return x0 + (cw - nw) // 2, y0 + (ch - nh) // 2, nw, nh


def compose(node, parts, index):
    """Один кадр сетки из образцов ``parts`` (по одному на вход).

    Родословная ведётся от первого входа: у сетки предков несколько, а путь
    образца в превью — одна линия. Номер копии ``.g<index>`` отличает сетки
    одного такта друг от друга в имени файла.
    """
    import cv2
    import numpy as np

    g = schema.grid(node)
    W, H = g["width"], g["height"]
    canvas = np.zeros((H, W, 3), dtype=np.uint8)
    boxes, polys = [], []
    for part, cell, fit in zip(parts, cells(g), g["fit"]):
        h, w = part.image.shape[:2]
        x, y, nw, nh = fit_into(w, h, cell, fit)
        canvas[y:y + nh, x:x + nw] = cv2.resize(
            part.image, (nw, nh), interpolation=cv2.INTER_AREA
        )
        kx, ky = nw / w, nh / h
        for cls, cx, cy, bw, bh in part.boxes:
            boxes.append((
                cls,
                (x + cx * nw) / W, (y + cy * nh) / H,
                bw * nw / W, bh * nh / H,
            ))
        for cls, rings in part.polys:
            polys.append((cls, [
                [[x + px * kx, y + py * ky] for px, py in ring] for ring in rings
            ]))

    first = parts[0]
    return engine.Sample(
        canvas, boxes, polys,
        sid=f"{first.sid}.g{index}",
        ordinal=first.ordinal,
        ops=first.ops + ("Mosaic",),
        prev=first,
        step={"node": node["id"], "cells": len(parts)},
    )
