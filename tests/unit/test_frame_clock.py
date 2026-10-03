"""Момент ↔ кадр: одно правило для нарезки, прикидки, сверки и закрытия."""
from common.video_frames import FrameClock, unpack_pts

TB = [1, 1000]  # pts в миллисекундах


def test_момент_это_последний_кадр_до_него_как_у_плеера():
    clock = FrameClock(pts=[0, 40, 80, 120], time_base=TB)
    assert clock.frame(0) == 0
    assert clock.frame(39) == 0      # плеер ещё показывает кадр 0
    assert clock.frame(40) == 1      # ровно на границе — уже кадр 1
    assert clock.frame(50) == 1


def test_разрыв_pts_не_сдвигает_номера():
    # Кадр 2 «пропал» из шкалы: номер — позиция в таблице, а не время × fps.
    clock = FrameClock(pts=[0, 40, 120, 160], time_base=TB)
    assert clock.frame(100) == 1
    assert clock.frame(130) == 2
    assert clock.ms(2) == 120


def test_ролик_не_с_нуля_и_момент_за_концом():
    clock = FrameClock(pts=[400, 440, 480], time_base=TB)
    assert clock.frame(0) == 0       # мс — от первого кадра
    assert clock.frame(85) == 2
    assert clock.frame(120) is None  # за последним кадром кадра нет


def test_без_таблицы_прикидка_по_частоте():
    clock = FrameClock(fps=25, count=10)
    assert not clock.exact
    assert clock.frame(39) == 0 and clock.frame(40) == 1
    assert clock.frame(400) is None


def test_таблица_из_хранимого_вида():
    assert unpack_pts({"v": 1, "first_pts": 5, "deltas": [2, 3]}) == [5, 7, 10]
    assert unpack_pts({"v": 2}) is None
