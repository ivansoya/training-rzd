"""Сторож хода работы в своём процессе: замолчал — снять, шагает — не трогать.

21.10.2026 прогон агента повис на закрытии ролика (PyAV/GIL) нитью общего
процесса и остановил весь training-worker. Теперь работа — свой процесс, а
сторож смотрит на ход: зависший в нативном коде процесс жив, но не шагает.
"""
import os
import signal
import time

from training_svc import supervise


def test_порог_числами():
    st = supervise.stalled
    # Шаги по 2 с: порог — нижняя граница 300 с.
    assert not st(1299, 1000, 2, False, 300, 600, 10)
    assert st(1301, 1000, 2, False, 300, 600, 10)
    # Медленный шаг 60 с поднимает порог до 600: медленный прогон на процессоре не снимается ложно.
    assert not st(1590, 1000, 60, False, 300, 600, 10)
    assert st(1601, 1000, 60, False, 300, 600, 10)
    # Загрузка моделей — свой порог.
    assert not st(1590, 1000, 0, True, 300, 600, 10)
    # Тёплое превью: нижняя граница 60 с.
    assert st(1061, 1000, 1, False, 60, 600, 10)


def _steps_then_freeze(n):
    for _ in range(n):
        supervise.step()
        time.sleep(0.05)
    os.kill(os.getpid(), signal.SIGSTOP)  # как взаимная блокировка: процесс жив, хода нет


def _steady(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        supervise.step()
        time.sleep(0.2)


def _fails():
    raise RuntimeError("весов нет на полке")


def _wait(child, timeout=20):
    end = time.monotonic() + timeout
    while child.alive() and not child.stalled() and time.monotonic() < end:
        time.sleep(0.05)


def test_замолчавший_ребёнок_снят(monkeypatch):
    monkeypatch.setattr(supervise, "LOAD_S", 10.0)  # старт процесса — не зависание
    child = supervise.Child("t-freeze", _steps_then_freeze, 3, floor=1.0)
    _wait(child)
    assert child.alive() and child.stalled()
    assert child.ticks[supervise.SLOWEST] > 0, "встал до первых шагов — проверка не о том"
    child.kill()
    assert child.result() is None
    assert child.proc.exitcode == -signal.SIGKILL


def test_шагающий_ребёнок_не_снят(monkeypatch):
    monkeypatch.setattr(supervise, "LOAD_S", 10.0)
    child = supervise.Child("t-steady", _steady, 3.0, floor=1.0)
    seen = False
    while child.alive():
        seen = seen or child.stalled()
        time.sleep(0.05)
    assert not seen
    assert child.result() is None and child.proc.exitcode == 0


def test_текст_ошибки_доходит_до_родителя():
    child = supervise.Child("t-fail", _fails)
    assert child.result() == "весов нет на полке"
