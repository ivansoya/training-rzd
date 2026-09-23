"""«Слияние сеткой»: ячейки, посадка кадра, перенос разметки и такты.

Ошибка здесь не видна ничем, кроме картинки: рамка, съехавшая на соседнюю
ячейку, учит модель находить объект там, где его нет, — а набор при этом
соберётся без единого предупреждения.
"""
import numpy as np
import pytest

pytest.importorskip("cv2")

from dataprep_svc import engine, feeds, mosaic  # noqa: E402
from dataprep_svc.graph import schema  # noqa: E402


def node(**params):
    return {"id": "m", "type": "mosaic", "params": params}


def e(a, b, out="out", into="in"):
    return {"from": a, "out": out, "to": b, "in": into}


def frame(w, h, colour, boxes=()):
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = colour
    return engine.Sample(img, list(boxes), [])


# --------------------------------------------------------------------------- #
# Геометрия
# --------------------------------------------------------------------------- #
def test_ячейки_лежат_плотно_без_щелей_и_нахлёста():
    g = schema.grid(node(rows=2, cols=3, col_w=[1, 2, 1], row_h=[3, 1],
                         width=1001, height=701))
    cells = mosaic.cells(g)
    assert len(cells) == 6
    # Соседи по строке сходятся в одной точке, последний упирается в край.
    for r in range(2):
        row = cells[r * 3:(r + 1) * 3]
        assert row[0][0] == 0 and row[-1][2] == 1001
        assert all(a[2] == b[0] for a, b in zip(row, row[1:]))
    assert cells[0][3] == cells[3][1] and cells[3][3] == 701
    # Доли: средний столбец вдвое шире крайних.
    assert cells[1][2] - cells[1][0] == pytest.approx(2 * (cells[0][2] - cells[0][0]), abs=1)


def test_доли_и_вписывание_приводятся_к_пределам():
    g = schema.grid(node(rows=9, cols=0, col_w=[0, -3], fit=["stretch", "мусор"]))
    assert (g["rows"], g["cols"]) == (schema.MAX_GRID, 1)
    assert g["col_w"] == [1.0]
    assert sum(g["row_h"]) == pytest.approx(1.0)
    assert g["fit"][0] == "stretch" and set(g["fit"][1:]) == {"letterbox"}


def test_леттербокс_держит_пропорции_а_растяжение_заполняет():
    cell = (100, 0, 300, 400)          # 200 × 400
    x, y, w, h = mosaic.fit_into(1920, 1080, cell, "letterbox")
    assert (x, w) == (100, 200) and h == round(1080 * 200 / 1920)
    assert y == (400 - h) // 2
    assert mosaic.fit_into(1920, 1080, cell, "stretch") == (100, 0, 200, 400)


def test_рамка_едет_вместе_с_кадром_в_свою_ячейку():
    n = node(rows=1, cols=2, width=800, height=400, fit=["stretch", "letterbox"])
    left = frame(100, 100, (255, 0, 0), [(0, 0.5, 0.5, 0.2, 0.2)])
    right = frame(200, 100, (0, 255, 0), [(1, 0.25, 0.5, 0.1, 0.4)])
    out = mosaic.compose(n, [left, right], 0)
    assert out.image.shape == (400, 800, 3)
    (c0, x0, y0, w0, h0), (c1, x1, y1, w1, h1) = out.boxes
    # Левая ячейка — 400×400, растянута: центр рамки в её середине.
    assert (c0, x0, y0) == (0, pytest.approx(0.25), pytest.approx(0.5))
    assert w0 == pytest.approx(0.1) and h0 == pytest.approx(0.2)
    # Правая — кадр 2:1 в ячейке 400×400: 400×200, по центру по высоте.
    assert x1 == pytest.approx((400 + 0.25 * 400) / 800)
    assert y1 == pytest.approx((100 + 0.5 * 200) / 400)
    # Под центром каждой рамки — пиксель своего кадра.
    assert tuple(out.image[int(y0 * 400), int(x0 * 800)]) == (255, 0, 0)
    assert tuple(out.image[int(y1 * 400), int(x1 * 800)]) == (0, 255, 0)
    # Поля леттербокса чёрные.
    assert tuple(out.image[10, 600]) == (0, 0, 0)


# --------------------------------------------------------------------------- #
# Такты
# --------------------------------------------------------------------------- #
TWO = {"nodes": [
    {"id": "day", "type": "source", "params": {"name": "День"}},
    {"id": "night", "type": "source", "params": {"name": "Ночь"}},
    {"id": "x", "type": "multiply", "params": {"times": 3}},
    {"id": "m", "type": "mosaic",
     "params": {"rows": 1, "cols": 2, "width": 200, "height": 100}},
    {"id": "o", "type": "output"},
], "edges": [
    e("day", "x"), e("x", "m", into="i0"), e("night", "m", into="i1"),
    e("m", "o"),
]}


def test_такт_кладёт_разные_источники_в_одну_сетку_по_короткому_входу():
    compiled = engine.compile_graph(TWO)
    day = frame(64, 64, (200, 200, 0), [(0, 0.5, 0.5, 0.5, 0.5)])
    night = frame(64, 64, (0, 0, 90), [(1, 0.5, 0.5, 0.5, 0.5)])
    made = engine.run_frame(compiled, None, 7, "a+b",
                            feed={"day": day, "night": night})
    # ×3 на одном входе, 1 на другом — одна сетка, лишнее отброшено.
    assert len(made) == 1
    item = made[0][1]
    assert tuple(item.image[50, 50]) == (200, 200, 0)
    assert tuple(item.image[50, 150]) == (0, 0, 90)
    assert sorted(b[0] for b in item.boxes) == [0, 1]
    assert item.sid == ".0.g0" and item.step == {"node": "m", "cells": 2}


def test_без_второго_источника_сетки_нет():
    compiled = engine.compile_graph(TWO)
    made = engine.run_frame(compiled, None, 7, "a",
                            feed={"day": frame(64, 64, (1, 1, 1))})
    assert made == []


def test_тактами_идут_только_графы_с_сеткой():
    """Остальные — по источнику, как до тактов: зерно кадра то же, и старый
    набор пересобирается в те же файлы."""
    with_mosaic = engine.compile_graph(TWO)
    plain = engine.compile_graph({"nodes": [
        {"id": "a", "type": "source"}, {"id": "b", "type": "source"},
        {"id": "o", "type": "output"},
    ], "edges": []})
    units = [
        {"part": "train", "position": 0, "graph_version_id": "v1",
         "source_node": "day"},
        {"part": "train", "position": 0, "graph_version_id": "v1",
         "source_node": "night"},
        {"part": "val", "position": 0, "graph_version_id": "v1",
         "source_node": "day"},
        {"part": "train", "position": 1, "graph_version_id": "v2",
         "source_node": "a"},
        {"part": "train", "position": 1, "graph_version_id": "v2",
         "source_node": "b"},
    ]
    work = feeds.work(units, {"v1": with_mosaic, "v2": plain})
    assert [len(g) for g in work] == [2, 1, 1, 1]
    assert {g[0]["part"] for g in work[:2]} == {"train", "val"}
