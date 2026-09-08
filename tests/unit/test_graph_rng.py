"""Зёрна: воспроизводимость сборки закрывается числами.

Обещание «пересобрать набор тем же зерном и получить те же файлы» держится
целиком на этом модуле. Если оно сломается, никто этого не заметит — картинки
просто станут другими, и объяснить разницу будет нечем.
"""
from dataprep_svc.graph.rng import frame_seed, node_seed, pick_branch


def test_зерно_кадра_не_зависит_от_порядка():
    """Полосы разбирают кадры как придётся; зерно обязано зависеть только от
    кадра, иначе повтор на другой машине даст другие картинки."""
    a = frame_seed(777, "img-0001")
    b = frame_seed(777, "img-0001")
    assert a == b
    assert frame_seed(777, "img-0002") != a


def test_другое_зерно_набора_меняет_всё():
    assert frame_seed(1, "img-0001") != frame_seed(2, "img-0001")


def test_каждая_копия_умножения_своя():
    """Иначе ×3 дал бы три одинаковые картинки, и умножение потеряло бы смысл."""
    base = frame_seed(5, "img-0001")
    seeds = {node_seed(base, "aug1", i) for i in range(3)}
    assert len(seeds) == 3


def test_один_блок_вставленный_дважды_крутит_по_разному():
    """Путь узла в развёрнутом плане входит в зерно: две копии блока обязаны
    дать разные картинки."""
    base = frame_seed(5, "img-0001")
    assert node_seed(base, "g1/aug1", 0) != node_seed(base, "g2/aug1", 0)


def test_выбор_ветки_повторяем():
    base = frame_seed(9, "img-0042")
    seed = node_seed(base, "prob", 0)
    assert pick_branch(seed, [65, 35]) == pick_branch(seed, [65, 35])


def test_доли_соблюдаются_на_большом_числе_кадров():
    """Жребий честный: на тысяче кадров ветка 65/35 набирает свою долю с
    точностью до нескольких процентов."""
    hits = [0, 0]
    for i in range(2000):
        seed = node_seed(frame_seed(3, f"img-{i:05d}"), "prob", 0)
        hits[pick_branch(seed, [65, 35])] += 1
    share = hits[0] / sum(hits)
    assert 0.61 < share < 0.69


def test_нулевые_веса_не_роняют():
    """Человек ещё не закончил вводить веса — это не повод падать."""
    assert pick_branch(123456789, [0, 0]) == 0


def test_ветка_с_нулевым_весом_не_выбирается():
    for i in range(200):
        seed = node_seed(frame_seed(1, f"img-{i}"), "p", 0)
        assert pick_branch(seed, [1, 0]) == 0
