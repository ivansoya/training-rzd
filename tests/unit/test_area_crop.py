"""Случайный кусок кадра: доля стороны и порог видимости.

Проверяется то, ради чего узел и писался: объект, от которого в куске осталось
меньше порога, обязан исчезнуть из разметки. Ошибка здесь не видна ничем —
набор соберётся, обучение пойдёт, а модель будет учиться называть угол предмета
предметом.
"""
import numpy as np
import pytest

from dataprep_svc.ops import visible

A = pytest.importorskip("albumentations")
from dataprep_svc.ops import RandomAreaCrop  # noqa: E402


def box(x1, y1, x2, y2):
    return np.array([[x1, y1, x2, y2, 0.0]])


# --------------------------------------------------------------------------- #
# Доля видимого
# --------------------------------------------------------------------------- #
def test_целиком_внутри_видно_полностью():
    assert visible(box(0.2, 0.2, 0.4, 0.4))[0] == pytest.approx(1.0)


def test_половина_за_краем():
    """Ровно тот случай, которым задан порог по умолчанию."""
    assert visible(box(-0.1, 0.0, 0.1, 0.2))[0] == pytest.approx(0.5)


def test_четверть_в_углу():
    """За край ушло по половине каждой стороны — видна четверть площади."""
    assert visible(box(-0.1, -0.1, 0.1, 0.1))[0] == pytest.approx(0.25)


def test_целиком_снаружи_не_видно():
    assert visible(box(-0.4, 0.2, -0.2, 0.4))[0] == 0.0


def test_нулевая_площадь_не_видна():
    """Иначе делили бы на ноль, а в разметку попала бы строка без объекта."""
    assert visible(box(0.3, 0.3, 0.3, 0.5))[0] == 0.0


# --------------------------------------------------------------------------- #
# Кроп целиком
# --------------------------------------------------------------------------- #
def run(seed, *, scale=(0.5, 0.8), thr=0.5, boxes=None, labels=None):
    pipe = A.Compose(
        [RandomAreaCrop(scale=scale, min_visibility=thr, p=1)],
        bbox_params=A.BboxParams(
            format="yolo", label_fields=["class_labels"],
            min_visibility=0.0, clip=True,
        ),
    )
    pipe.set_random_seed(seed)
    return pipe(
        image=np.zeros((1520, 2688, 3), np.uint8),
        bboxes=boxes or [],
        class_labels=labels or [],
    )


def test_кусок_не_вылезает_за_кадр_и_держит_долю():
    """Окно целиком внутри кадра: чёрных полей быть не должно, модель приняла
    бы их за часть сцены. Доля общая на обе стороны — пропорции сохраняются."""
    for seed in range(25):
        out = run(seed)
        h, w = out["image"].shape[:2]
        assert 0 < h <= 1520 and 0 < w <= 2688
        assert 0.5 - 0.01 <= h / 1520 <= 0.8 + 0.01
        assert h / 1520 == pytest.approx(w / 2688, abs=0.01)


def test_объект_ниже_порога_выбывает_из_разметки():
    """Предмет в самом углу кадра почти наверняка обрежется — и тогда его в
    разметке быть не должно ни в одном из прогонов."""
    kept = 0
    for seed in range(25):
        out = run(seed, boxes=[[0.99, 0.99, 0.04, 0.04]], labels=["угол"])
        if out["class_labels"]:
            # Уцелел — значит кусок его накрыл целиком, иначе порог не сработал.
            kept += 1
    assert kept < 25


def test_объект_в_центре_переживает_обрезку():
    """Порог не должен выбрасывать то, что видно целиком."""
    out = run(3, boxes=[[0.5, 0.5, 0.04, 0.04]], labels=["центр"])
    assert out["class_labels"] == ["центр"]


def test_то_же_зерно_даёт_тот_же_кусок():
    """Обещание «пересобрать набор тем же зерном» держится и на своём узле."""
    first, second = run(11), run(11)
    assert first["image"].shape == second["image"].shape


# --------------------------------------------------------------------------- #
# Кроп заданного окна
# --------------------------------------------------------------------------- #
def crop(x, y, thr, boxes):
    from dataprep_svc.ops import FractionCrop

    pipe = A.Compose(
        [FractionCrop(x_range=x, y_range=y, min_visibility=thr, p=1)],
        bbox_params=A.BboxParams(
            format="yolo", label_fields=["class_labels"],
            min_visibility=0.0, clip=True,
        ),
    )
    return pipe(image=np.zeros((1000, 2000, 3), np.uint8), bboxes=boxes,
                class_labels=list(range(len(boxes))))


def test_кроп_режет_окно_долями():
    out = crop((0.25, 0.75), (0.1, 0.6), 0.5, [])
    assert out["image"].shape[:2] == (500, 1000)


def test_кроп_выбрасывает_объект_ниже_порога():
    # Окно x 0..0,5. Первый объект целиком внутри, у второго внутри половина,
    # у третьего четверть.
    boxes = [[0.2, 0.5, 0.1, 0.1], [0.5, 0.5, 0.2, 0.2], [0.55, 0.5, 0.2, 0.2]]
    kept = crop((0.0, 0.5), (0.0, 1.0), 0.4, boxes)["class_labels"]
    assert list(kept) == [0, 1]
    kept = crop((0.0, 0.5), (0.0, 1.0), 0.6, boxes)["class_labels"]
    assert list(kept) == [0]


def test_перепутанные_и_вылезшие_границы_не_ломают_кроп():
    from dataprep_svc.ops import window

    assert window((0.9, 0.1), (0.0, 0.0), 100, 50)[2] > window((0.9, 0.1), (0.0, 0.0), 100, 50)[0]
    out = crop((0.8, 0.2), (1.2, -0.3), 0.5, [])
    assert out["image"].shape[:2] == (1000, 1200)
