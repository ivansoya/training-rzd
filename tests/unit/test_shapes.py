"""Фигура разметки на проводе: одна запись для бокса и для контура.

Полигон пересекает границу дважды — уходя в браузер и приходя обратно, — и
оба раза обязан нести свою охватывающую рамку: на неё смотрит всё, что умеет
только прямоугольники. Здесь это и проверяется.

Разбор строк архива сюда не входит: он живёт в `importer`, а тот тянет за
собой yaml и PIL, которых в наборе единиц нет и быть не должно. Проверяется он
там, где к формату можно подойти без зависимостей, — числом полей в
`test_polygon.py`, — и целиком на живом стеке в `tests/api/test_polygons.py`.
"""
import pytest

from common import shapes


def square(x, y, side):
    return [[x, y], [x + side, y], [x + side, y + side], [x, y + side]]


# --------------------------------------------------------------------------- #
# Провод
# --------------------------------------------------------------------------- #
def test_бокс_на_проводе_называет_себя():
    wire = shapes.to_wire("bbox", {"x": 1, "y": 2, "w": 3, "h": 4})
    assert wire == {"kind": "bbox", "x": 1, "y": 2, "w": 3, "h": 4}


def test_полигон_несёт_и_рамку():
    """Всё, что умеет только прямоугольники, обязано продолжать работать."""
    wire = shapes.to_wire("polygon", {"parts": [square(10, 20, 30)]})
    assert wire["kind"] == "polygon"
    assert (wire["x"], wire["y"], wire["w"], wire["h"]) == (10.0, 20.0, 30.0, 30.0)
    assert len(wire["parts"]) == 1


def test_рамка_полигона_охватывает_все_части():
    wire = shapes.to_wire("polygon", {"parts": [square(0, 0, 10), square(90, 0, 10)]})
    assert wire["w"] == 100.0


def test_битый_полигон_не_показывается():
    assert shapes.to_wire("polygon", {"parts": [[[0, 0], [1, 1]]]}) == {}


def test_старая_запись_без_типа_читается_боксом():
    assert shapes.to_wire(None, {"x": 0, "y": 0, "w": 5, "h": 5})["kind"] == "bbox"


# --------------------------------------------------------------------------- #
# Разбор запроса
# --------------------------------------------------------------------------- #
def test_бокс_из_запроса():
    kind, geometry, area = shapes.from_wire(
        {"kind": "bbox", "x": 0, "y": 0, "w": 10, "h": 20}, 100, 100
    )
    assert kind == "bbox"
    assert area == pytest.approx(200.0)


def test_запрос_без_kind_это_бокс():
    """Клиент, не знающий о полигонах, обязан продолжать работать."""
    kind, _, _ = shapes.from_wire({"x": 0, "y": 0, "w": 10, "h": 10}, 100, 100)
    assert kind == "bbox"


def test_полигон_из_запроса():
    kind, geometry, area = shapes.from_wire(
        {"kind": "polygon", "parts": [square(0, 0, 10)]}, 100, 100
    )
    assert kind == "polygon"
    assert geometry["parts"][0][0] == [0.0, 0.0]
    assert area == pytest.approx(100.0)


def test_площадь_двух_частей_складывается():
    _, _, area = shapes.from_wire(
        {"kind": "polygon", "parts": [square(0, 0, 10), square(50, 0, 20)]}, 100, 100
    )
    assert area == pytest.approx(500.0)


def test_полигон_подрезается_кадром():
    _, geometry, _ = shapes.from_wire(
        {"kind": "polygon", "parts": [[[-10, -10], [50, 0], [50, 50]]]}, 40, 40
    )
    assert geometry["parts"][0][0] == [0.0, 0.0]
    assert max(p[0] for p in geometry["parts"][0]) == 40.0


def test_промах_мышью_не_становится_разметкой():
    assert shapes.from_wire({"kind": "bbox", "x": 0, "y": 0, "w": 1, "h": 1}, 100, 100) is None
    assert shapes.from_wire({"kind": "polygon", "parts": []}, 100, 100) is None


def test_круг_через_провод():
    """Записали, прочитали, совпало — иначе правка съедала бы точки."""
    parts = [square(10, 20, 30), square(70, 20, 10)]
    wire = shapes.to_wire("polygon", {"parts": parts})
    kind, geometry, _ = shapes.from_wire(wire, 200, 200)
    assert kind == "polygon"
    assert geometry["parts"] == [[[float(x), float(y)] for x, y in ring] for ring in parts]
