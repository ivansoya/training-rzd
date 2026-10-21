"""Тяжёлая работа воркера — в своём процессе под сторожем хода.

Нитью в общем процессе она роняла всех: 21.10.2026 взаимная блокировка PyAV в прогоне агента
остановила перекличку карт, уборку и остальные очереди. Процесс убивается целиком, и ОС сама
возвращает его видеопамять. Сторож смотрит на ход (кадр, байты весов, этап загрузки), а не на то,
что процесс жив: зависший в нативном коде процесс жив.
"""
import logging
import multiprocessing as mp
import os
import signal
import threading
import time
from contextlib import contextmanager

log = logging.getLogger("training.supervise")

# Решения 21.10.2026: порог — max(FLOOR, FACTOR × самый долгий шаг работы), на загрузке — LOAD.
FLOOR_S = float(os.environ.get("WATCH_FLOOR", "300"))
LOAD_S = float(os.environ.get("WATCH_LOAD", "600"))
FACTOR = float(os.environ.get("WATCH_FACTOR", "10"))

_spawn = mp.get_context("spawn")  # CUDA-контекст не переживает fork
LAST, SLOWEST, LOADING, BUSY = 0, 1, 2, 3
_mine = None     # ход этого процесса, если он ребёнок
_busy_lock = threading.Lock()
_children = set()


def stalled(now, last, slowest, loading, floor, load, factor):
    """Молчит ли работа дольше своего порога."""
    return now - last > (load if loading else max(floor, factor * slowest))


class Child:
    """Работа в своём процессе. `floor` — нижняя граница порога (тёплому превью — 60 с)."""

    def __init__(self, name, target, *args, floor=None):
        # Старт — как загрузка: импорт torch и модели идут до первого шага.
        self.ticks = _spawn.Array("d", [time.monotonic(), 0.0, 1.0, 0.0], lock=False)
        self.floor = FLOOR_S if floor is None else floor
        self._result, send = _spawn.Pipe(duplex=False)
        self.proc = _spawn.Process(target=_main, args=(target, args, self.ticks, send), name=name)
        self.proc.start()
        send.close()
        _children.add(self)
        log.info("%s: процесс %s", name, self.proc.pid)  # по этой строке py-spy и учения находят ребёнка

    def alive(self):
        return self.proc.is_alive()

    def stalled(self):
        t = self.ticks
        return stalled(time.monotonic(), t[LAST], t[SLOWEST], bool(t[LOADING]), self.floor, LOAD_S, FACTOR)

    def silent_s(self):
        return int(time.monotonic() - self.ticks[LAST])

    def kill(self):
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)  # группой: ребёнок в своей сессии
        except OSError:
            pass
        self.proc.join(10)

    def result(self):
        """Текст ошибки работы; None — кончилась сама или убита."""
        self.proc.join()
        _children.discard(self)
        try:
            return self._result.recv() if self._result.poll() else None
        except (EOFError, OSError):
            return None


def kill_all():
    """Остановка воркера: дети не переживают родителя."""
    for child in list(_children):
        child.kill()


def _main(target, args, ticks, send):
    global _mine
    os.setsid()
    _mine = ticks
    error = None
    try:
        target(*args)
    except BaseException as exc:  # noqa: BLE001 — текст родителю, трасса в журнал
        log.exception("работа %s упала", target.__name__)
        error = str(exc)[:500] or exc.__class__.__name__
    send.send(error)


# --------------------------------------------------------------------------- #
# В ребёнке: отметки хода. Вне ребёнка (тесты, старый путь) — ничего.
# --------------------------------------------------------------------------- #
def step():
    """Сделан шаг работы: кадр, пачка признаков."""
    t = _mine
    if t is None:
        return
    now = time.monotonic()
    if not t[LOADING]:
        t[SLOWEST] = max(t[SLOWEST], now - t[LAST])
    t[LAST], t[LOADING] = now, 0.0


def touch():
    """Ход без шага: байты весов, кадры декодера по пути к нужному."""
    if _mine is not None:
        _mine[LAST] = time.monotonic()


def ready():
    """Процесс поднялся: дальше порог шага, а не загрузки (тёплому превью — простой)."""
    if _mine is not None:
        _mine[LOADING] = 0.0
        touch()


def idle_tick():
    """Ход простоя тёплого процесса: цикл проснулся. Пока идёт запрос — не в счёт,
    иначе соседняя нить простоя прятала бы зависший запрос."""
    if _mine is not None and not _mine[BUSY]:
        touch()


@contextmanager
def busy():
    """Запрос в работе: от начала до конца — один шаг."""
    if _mine is None:
        yield
        return
    with _busy_lock:
        _mine[BUSY] += 1
        touch()
    try:
        yield
    finally:
        with _busy_lock:
            step()
            _mine[BUSY] -= 1


@contextmanager
def loading():
    """Загрузка моделей: порог свой; шаг после неё меряется от её конца, а не от начала."""
    if _mine is None:
        yield
        return
    _mine[LOADING] = 1.0
    touch()
    try:
        yield
    finally:
        _mine[LOADING] = 0.0
        touch()
