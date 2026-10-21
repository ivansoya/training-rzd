"""Сторож циклов: молчащий цикл — `kill -9` воркеру, живой — не трогать.

Docker поднимает вышедший процесс, а зависший — нет: 21.10.2026 training-worker
на voran час стоял на взаимной блокировке, и никто его не снял.
"""
import os
import subprocess
import threading
import time

import pytest

from common import alive


@pytest.fixture
def box(tmp_path, monkeypatch):
    monkeypatch.setattr(alive, "DIR", str(tmp_path))
    monkeypatch.setattr(alive, "STALE_S", 300)
    victim = subprocess.Popen(["sleep", "60"])
    (tmp_path / "pid").write_text(str(victim.pid))
    yield tmp_path, victim
    victim.kill()
    victim.wait()


def _beat(folder, name, age):
    path = folder / f"{name}.beat"
    path.touch()
    at = time.time() - age
    os.utime(path, (at, at))


def test_свежие_отметки_воркер_не_трогают(box):
    folder, victim = box
    _beat(folder, "reaper", 10)
    _beat(folder, "agents", 290)
    assert alive.check() == 0
    assert victim.poll() is None


def test_молчащий_цикл_убивает_воркер(box):
    folder, victim = box
    _beat(folder, "reaper", 10)
    _beat(folder, "agent-preview", 301)
    assert alive.check() == 1
    assert victim.wait(5) == -9


def test_до_старта_проверять_нечего(tmp_path, monkeypatch):
    monkeypatch.setattr(alive, "DIR", str(tmp_path / "нет"))
    assert alive.check() == 0


def test_отметка_только_из_нити_цикла(tmp_path, monkeypatch):
    # Пульс загрузки моделей — своя нить: её отметка держала бы живым мёртвый цикл.
    monkeypatch.setattr(alive, "DIR", str(tmp_path))

    def pulse():
        alive.stamp()

    def loop():
        alive.loop()

    for target, name in ((pulse, "model-pulse"), (loop, "runs")):
        t = threading.Thread(target=target, name=name)
        t.start()
        t.join()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["runs.beat"]


def test_старт_стирает_отметки_прошлого_запуска(tmp_path, monkeypatch):
    # restart сохраняет файлы контейнера: старая отметка убила бы новый процесс на первой проверке.
    monkeypatch.setattr(alive, "DIR", str(tmp_path))
    _beat(tmp_path, "reaper", 3600)
    alive.start()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["pid"]
    assert alive.check() == 0
