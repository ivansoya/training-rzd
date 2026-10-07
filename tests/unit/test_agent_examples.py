"""Наборы образцов: выбор рамок, вырезка, отступ «авто», проходы коллажа, средний вектор."""
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
    # у края кадра квадрат сдвигается внутрь, мелочь не раздувается до 64
    assert ax.crop_rect((0, 0, 10, 10), 2.5, 1000, 1000) == (0, 0, 25, 25)
    assert ax.crop_rect((990, 990, 10, 10), 2.5, 1000, 1000) == (975, 975, 1000, 1000)
    # больше кадра — режется по кадру
    assert ax.square((0, 0, 900, 900), 2000, 1000, 800) == (0, 0, 1000, 800)


def test_отступ_авто_под_размер_в_кадре():
    # кадр РСМ 2688: клетка ряда 448 px; гайка упирается в ×5, человек — в ×2
    assert ax.auto_ctx(30, 2688) == 5.0
    assert ax.auto_ctx(141, 2688) == pytest.approx(2688 / (6 * 141))
    assert ax.auto_ctx(479, 2688) == 2.0
    x0, y0, x1, y1 = ax.auto_rect((1451, 922, 45, 141), 2688, 2688, 1520)
    assert x1 - x0 == y1 - y0 == 448


def test_проходы_коллажа_вторым_рядом_или_ещё_проходом():
    # широкий кадр: второй ряд влезает в пустое поле — 12 за проход
    assert ax.collage_passes(13, 2688, 1520) == [list(range(12)), [12]]
    # тайл-квадрат: второй ряд ужал бы кадр — по 6
    assert ax.collage_passes(13, 1008, 1008) == [list(range(6)), list(range(6, 12)), [12]]
    assert ax.collage_passes(0, 2688, 1520) == []


def test_образец_с_хвостом_в_кадр_не_находка():
    # замер 1008: сам образец у нижнего края клетки находился полоской 179×2 на верху кадра
    assert ax.in_rows(-60, 2)
    assert ax.in_rows(-60, -1)
    assert not ax.in_rows(-2, 40)
    assert not ax.in_rows(0, 5)


def test_один_предмет_на_соседних_кадрах_ролика():
    items = [("v1", (10, 10, 20, 20)), ("v1", (11, 10, 20, 20)), ("v2", (10, 10, 20, 20)),
             (None, (10, 10, 20, 20)), (None, (10, 10, 20, 20)), ("v1", (200, 10, 20, 20))]
    # без ролика каждая рамка сама по себе: соседство кадров неизвестно
    assert ax.same_object_groups(items) == [0, 0, 1, 2, 3, 4]


def test_средний_вектор_нормирован():
    np = pytest.importorskip("numpy")
    v = ax.mean_vector([[3, 0], [0, 4]])
    assert np.isclose(np.linalg.norm(v), 1.0) and v[1] > v[0]


def test_коллаж_ряды_над_кадром_и_квадрат_входа():
    np = pytest.importorskip("numpy")
    pytest.importorskip("cv2")
    crops = [(np.full((100, 100, 3), k, np.uint8), [25, 25, 50, 50]) for k in range(8)]
    # 8 образцов на виде 600: клетка 100, два ряда — полоса 200, рамки в клетках
    strip, boxes = ax.collage_strip(crops, list(range(8)), 600)
    assert strip.shape == (200, 600, 3) and len(boxes) == 8
    assert boxes[0] == [25, 25, 75, 75] and boxes[6] == [25, 125, 75, 175]
    assert strip[150, 150, 0] == 7
    # вход 1008: широкая картинка ужата по большей стороне, поля снизу чёрные
    sq, k = ax.model_square(np.ones((500, 2016, 3), np.uint8), 1008)
    assert sq.shape == (1008, 1008, 3) and k == 0.5 and sq[300, 10, 0] == 0
    # мелкий тайл без `grow` не растягивается
    assert ax.model_square(np.ones((300, 300, 3), np.uint8), 644)[1] == 1.0
