"""Сторож циклов воркера: отметки живых циклов и проверка для healthcheck контейнера.

Docker поднимает вышедший процесс, а зависший — нет: 21.10.2026 training-worker на voran час стоял на
взаимной блокировке. Проверка идёт отдельным процессом и от GIL воркера не зависит: молчит цикл —
`kill -9`, контейнер выходит, `restart` поднимает его заново (нужен `init: true` — PID 1 изнутри не убить).
"""
import os
import signal
import sys
import threading
import time

DIR = os.environ.get("ALIVE_DIR", "/tmp/alive")
# Минуты, а не секунды: долгие фазы работ и так продлевают аренду очереди чаще (120–180 с).
STALE_S = float(os.environ.get("ALIVE_STALE", "300"))
_loops = set()


def start():
    """Старые отметки — от прежнего запуска: `restart` сохраняет файлы контейнера."""
    os.makedirs(DIR, exist_ok=True)
    for name in os.listdir(DIR):
        os.remove(os.path.join(DIR, name))
    with open(os.path.join(DIR, "pid"), "w") as f:
        f.write(str(os.getpid()))


def loop():
    """Текущая нить — цикл под сторожем."""
    _loops.add(threading.current_thread().name)
    stamp()


def stamp():
    """Отметка хода. Из чужой нити (пульс загрузки моделей) — ничего: она держала бы живым мёртвый цикл."""
    name = threading.current_thread().name
    if name not in _loops:
        return
    path = os.path.join(DIR, name + ".beat")
    try:
        with open(path, "a"):
            os.utime(path)
    except OSError:
        pass


def stale(stamps, now, limit):
    """Циклы, чья отметка старше порога."""
    return sorted(name for name, at in stamps.items() if now - at > limit)


def check():
    try:
        names = [n for n in os.listdir(DIR) if n.endswith(".beat")]
    except FileNotFoundError:
        return 0  # воркер ещё не стартовал
    stamps = {}
    for name in names:
        try:
            stamps[name[:-5]] = os.path.getmtime(os.path.join(DIR, name))
        except FileNotFoundError:
            pass
    dead = stale(stamps, time.time(), STALE_S)
    if not dead:
        return 0
    print("молчат циклы:", ", ".join(dead))
    try:
        with open(os.path.join(DIR, "pid")) as f:
            os.kill(int(f.read()), signal.SIGKILL)
    except (OSError, ValueError):
        pass
    return 1


if __name__ == "__main__":
    sys.exit(check())
