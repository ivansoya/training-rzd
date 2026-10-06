"""Журнал PyAV выключен на время декодирования: иначе закрытие ролика виснет.

torchvision при импорте ставит журнал PyAV на ERROR. Тогда поток декодера в
av_log ждёт GIL, а close() держит GIL и ждёт поток — агент на ролике дошёл до
последнего кадра и встал вместе со всем training-worker (06.10.2026).
"""
import os
import sys

import pytest

av = pytest.importorskip("av")
import av.logging  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import sample  # noqa: E402

from common.video_frames import extract_frames  # noqa: E402


def test_открытие_ролика_выключает_журнал_pyav():
    av.logging.set_level(av.logging.ERROR)  # как после import torchvision
    got = []
    extract_frames(sample.ensure(), [3], lambda n, _ms, _img: got.append(n))
    assert got == [3]
    assert av.logging.get_level() is None
