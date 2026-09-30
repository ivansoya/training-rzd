"""Наборы образцов: выбор рамок, вырезка, средний вектор, полоса коллажа."""
import pytest

from common import agent_examples as ax


def test_выбор_сперва_с_разных_кадров_и_воспроизводим():
    frames = {"a": [(0, 0, 10, 10), (5, 5, 10, 10)], "b": [(1, 1, 9, 9)], "c": [(2, 2, 20, 20), (3, 3, 9, 9), (4, 4, 9, 9)]}
    got = ax.pick(frames, 4, seed=7)
    # первые три — по одной с каждого кадра
    assert sorted(f for f, _ in got[:3]) == ["a", "b", "c"]
    assert ax.pick(frames, 4, seed=7) == got
    # «добрать» — тот же выбор длиннее, без уже взятых
    more = ax.pick(frames, 6, seed=7)
    assert more[:4] == got and len(more) == 6
    assert len(ax.pick(frames, 100, seed=1)) == 6


def test_рамка_из_разметки_и_мелочь():
    assert ax.geometry_box("bbox", {"x": 1, "y": 2, "w": 3, "h": 40}) == (1, 2, 3, 40)
    assert ax.geometry_box("polygon", {"parts": [[[10, 10], [30, 12]], [[12, 50]]]}) == (10, 10, 20, 40)
    assert not ax.usable((0, 0, 7, 100)) and ax.usable((0, 0, 8, 8)) and not ax.usable(None)
    assert ax.uid("i1", (1, 2, 3, 4)) == ax.uid("i1", (1.0, 2.0, 3.0, 4.0)) != ax.uid("i2", (1, 2, 3, 4))


def test_вырезка_квадратом_с_окружением_в_кадре():
    assert ax.crop_rect((100, 100, 20, 40), 2.5, 1000, 1000) == (60, 70, 160, 170)
    # у края кадра — обрезана, мелочь — не меньше 64
    assert ax.crop_rect((0, 0, 10, 10), 2.5, 1000, 1000) == (0, 0, 37, 37)


def test_средний_вектор_нормирован():
    np = pytest.importorskip("numpy")
    v = ax.mean_vector([[3, 0], [0, 4]])
    assert np.isclose(np.linalg.norm(v), 1.0) and v[1] > v[0]


def test_полоса_коллажа_во_всю_ширину():
    height, places = ax.strip_layout([(448, 448), (224, 448), (100, 50)], 2688, count=2)
    # две клетки по 448 растянуты на 2688: масштаб 3
    assert height == 1344 and len(places) == 2
    assert places[0] == (0.0, 0.0, 3.0) and places[1] == (1344.0, 0.0, 3.0)
    assert len(ax.strip_layout([(10, 10)] * 12, 2688)[1]) == ax.COLLAGE_MAX
