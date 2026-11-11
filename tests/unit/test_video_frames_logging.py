"""Журнал PyAV выключен на время декодирования: иначе закрытие ролика виснет.

torchvision при импорте ставит журнал PyAV на ERROR. Тогда поток декодера в
av_log ждёт GIL, а close() держит GIL и ждёт поток — агент на ролике дошёл до
последнего кадра и встал вместе со всем training-worker (06.10.2026).
"""
import os
import subprocess
import sys
import textwrap

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


def test_журнал_включили_посреди_ролика_к_закрытию_выключен():
    # Свежий воркер грузит модель (и torchvision) на первом кадре — уже после открытия (voran, 21.10.2026).
    def on_frame(n, _ms, _img):
        av.logging.set_level(av.logging.ERROR)

    extract_frames(sample.ensure(), [3, 7], on_frame)
    assert av.logging.get_level() is None


def test_hevc_после_разведки_закрывается_и_переходит_к_следующему_ролику(tmp_path):
    from PIL import Image, ImageDraw

    path = str(tmp_path / "scout-hevc.mp4")
    av.logging.set_level(None)
    with av.open(path, "w") as container:
        stream = container.add_stream("libx265", rate=25)
        stream.width, stream.height, stream.pix_fmt = 320, 240, "yuv420p"
        stream.options = {"x265-params": "log-level=error:pools=none:frame-threads=1"}
        for n in range(60):
            picture = Image.new("RGB", (320, 240), (18, 22, 28))
            ImageDraw.Draw(picture).rectangle([n * 3, 90, n * 3 + 60, 150], fill=(220, 90, 40))
            container.mux(stream.encode(av.VideoFrame.from_image(picture)))
        container.mux(stream.encode())

    # Отдельный процесс: регрессия блокирует GIL внутри avcodec_close и не ловится потоком с таймаутом.
    script = textwrap.dedent("""
        import faulthandler, sys, time
        import av.logging
        from common.video_frames import extract_frames
        faulthandler.dump_traceback_later(5, repeat=True)
        sys.setswitchinterval(0.1)
        for _ in range(20):
            seen = []
            def on_frame(n, ms, picture):
                av.logging.set_level(av.logging.ERROR)
                until = time.monotonic() + 0.01
                while time.monotonic() < until:
                    pass
                seen.append(n)
            extract_frames(sys.argv[1], [0, 25], on_frame)
            assert seen == [0, 25], seen
        print("advanced through 20 videos")
    """)
    result = subprocess.run([sys.executable, "-c", script, path], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert "advanced through 20 videos" in result.stdout
