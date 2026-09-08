"""Просмотр собранного набора: отбор строк и разбор разметки.

Ни диска, ни базы — на вход строки манифеста и текст разметки. Ловится здесь
то, что иначе видно только глазами на странице: «выбрал два класса, а показало
кадры только с одним» и «контур нарисован рамкой».
"""
import pytest

from dataprep_svc.samples import boxes_of, classes_in, inside, pick


def rows():
    return [
        {"file": "images/train/a.jpg", "split": "train", "objects": 2, "classes": [0, 1]},
        {"file": "images/train/b.jpg", "split": "train", "objects": 1, "classes": [1]},
        {"file": "images/train/c.jpg", "split": "train", "objects": 0, "classes": []},
        {"file": "images/val/d.jpg", "split": "val", "objects": 3, "classes": [0]},
        {"file": "images/val/e.jpg", "split": "val", "objects": 1, "classes": [2]},
    ]


def names(page):
    return [r["file"].rsplit("/", 1)[-1] for r in page]


def test_без_отбора_видно_всё():
    total, page = pick(rows(), limit=10)
    assert total == 5
    assert names(page) == ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"]


def test_отбор_по_части_набора():
    total, page = pick(rows(), split="val", limit=10)
    assert total == 2
    assert names(page) == ["d.jpg", "e.jpg"]


def test_несколько_классов_это_хоть_один_из_них():
    total, page = pick(rows(), classes=[0, 2], limit=10)
    assert total == 3
    assert names(page) == ["a.jpg", "d.jpg", "e.jpg"]


def test_класс_и_часть_складываются():
    total, page = pick(rows(), split="train", classes=[1], limit=10)
    assert total == 2
    assert names(page) == ["a.jpg", "b.jpg"]


def test_кадры_без_разметки_отбираются_отдельно():
    total, page = pick(rows(), without=True, limit=10)
    assert total == 1
    assert names(page) == ["c.jpg"]


def test_счётчик_считает_отобранное_а_не_страницу():
    total, page = pick(rows(), split="train", offset=1, limit=1)
    assert total == 3
    assert names(page) == ["b.jpg"]


def test_страница_за_концом_пуста_но_счётчик_прежний():
    total, page = pick(rows(), offset=99, limit=10)
    assert total == 5 and page == []


PALETTE = {0: {"name": "вагон", "color": "#e21a1a"}, 1: {"name": "столб", "color": "#1f6feb"}}


def test_бокс_переводится_из_центра_в_угол():
    (box,) = boxes_of("0 0.5 0.5 0.4 0.2\n", PALETTE)
    assert box["kind"] == "bbox"
    assert (box["x"], box["y"], box["w"], box["h"]) == (0.3, 0.4, 0.4, 0.2)
    assert box["name"] == "вагон" and box["color"] == "#e21a1a"


def test_разметка_переводится_в_пиксели_кадра():
    """Слою превью нужно соотношение сторон, а не доли.

    С долями и квадратным кадром 1×1 он не мог обрезаться так же, как
    картинка под ``object-fit: cover``, и растягивал рамки тем сильнее, чем
    дальше кадр от формы плитки.
    """
    (box,) = boxes_of("0 0.5 0.5 0.4 0.2\n", PALETTE, 1920, 1080)
    assert (box["x"], box["y"]) == (576.0, 432.0)
    assert (box["w"], box["h"]) == (768.0, 216.0)


def test_контур_тоже_в_пикселях():
    (poly,) = boxes_of("1 0.1 0.1 0.5 0.2 0.3 0.7\n", PALETTE, 1000, 500)
    assert poly["parts"] == [[[100.0, 50.0], [500.0, 100.0], [300.0, 350.0]]]
    assert (poly["x"], poly["y"], poly["w"], poly["h"]) == (100.0, 50.0, 400.0, 300.0)


def test_контур_остаётся_контуром_и_получает_рамку():
    (poly,) = boxes_of("1 0.1 0.1 0.5 0.2 0.3 0.7\n", PALETTE)
    assert poly["kind"] == "polygon"
    assert poly["parts"] == [[[0.1, 0.1], [0.5, 0.2], [0.3, 0.7]]]
    # Рамка нужна слою превью, чтобы не считать её самому.
    assert (poly["x"], poly["y"]) == (0.1, 0.1)
    assert (round(poly["w"], 3), round(poly["h"], 3)) == (0.4, 0.6)


def test_незнакомый_класс_не_роняет_страницу():
    (box,) = boxes_of("7 0.5 0.5 0.2 0.2\n", PALETTE)
    assert box["name"] == "класс 7"


def test_битые_строки_пропускаются_а_целые_остаются():
    got = boxes_of("мусор\n0 0.5 0.5 0.2 0.2\n\n0 0.1\n", PALETTE)
    assert len(got) == 1


def test_классы_из_разметки_по_возрастанию_и_без_повторов():
    assert classes_in("3 0 0 0 0\n1 0 0 0 0\n3 0 0 0 0\n") == [1, 3]
    assert classes_in("") == []


@pytest.mark.parametrize("bad", ["../secret", "images/../../etc/passwd", "/etc/passwd"])
def test_путь_наружу_набора_отвергается(tmp_path, bad):
    assert inside(str(tmp_path), bad) is None


def test_путь_внутри_набора_разрешён(tmp_path):
    (tmp_path / "images").mkdir()
    (tmp_path / "images" / "a.jpg").write_bytes(b"x")
    assert inside(str(tmp_path), "images/a.jpg") is not None
