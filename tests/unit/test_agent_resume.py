"""Прогон агента после сбоя продолжает с курсора, а не с начала.

Решение 21.10.2026: убитый сторожем или перезапуском прогон встаёт в очередь
один раз и идёт с места остановки. Уборка рамок в конце ролика — по полному
плану: по остатку она стёрла бы рамки, написанные до сбоя.
"""
from common.agent_graph import frames_left, video_left

IDS = [("id-1", "a.jpg"), ("id-2", "b.jpg"), ("id-0", "b.jpg"), ("id-3", "c.jpg")]


def test_кадры_без_курсора_все():
    assert frames_left(IDS, None) == IDS


def test_кадры_после_курсора_по_имени_и_id():
    # Одинаковые имена в разных блоках различает id — курсор однозначен.
    assert frames_left(IDS, ["b.jpg", "id-0"]) == [("id-2", "b.jpg"), ("id-3", "c.jpg")]
    assert frames_left(IDS, ["c.jpg", "id-3"]) == []


def test_ролик_до_курсора_пропущен_на_курсоре_остаток_после_целиком():
    wanted = [0, 25, 50, 75]
    assert video_left([2, 50], 1, wanted) is None
    assert video_left([2, 50], 2, wanted) == [75]
    assert video_left([2, 50], 3, wanted) == wanted
    assert video_left([3, -1], 3, wanted) == wanted
    assert video_left(None, 0, wanted) == wanted


def test_уборка_по_остатку_стёрла_бы_рамки_до_сбоя():
    # Уборка удаляет рамки агента на кадрах вне плана. До сбоя записаны 0 и 25.
    wanted, written = [0, 25, 50, 75], {0, 25, 50, 75}
    rest = video_left([0, 25], 0, wanted)
    assert written - set(wanted) == set()          # по плану — ничего лишнего
    assert written - set(rest) == {0, 25}          # по остатку — стёрлись бы
