"""Копия ступени на видеокарте: кадр в кадр с оригиналом и опорный на границе перегона.

Копию делает ffmpeg с NVENC (PyAV кодировщика карты не знает), и кадры его
не видны по одному, как в make_variant. Поэтому две проверки. Сверка готового
файла (_check_aligned) обязана отвергать копию без опорного на границе —
это без карты. А сама копия на карте обязана дать i-й кадр оригинала i-м
кадром копии на дробной частоте и с B-кадрами в исходнике — это там, где карта
есть (стенд с NVIDIA); в контейнере тестов без карты проверка пропускается.
"""
import subprocess
from fractions import Fraction

import av
import pytest
from datasets_svc.video_chunks import (
    SEGMENT_FRAMES, FFMPEG, VideoError, _check_aligned, _params, build_index, gpu_ready, make_variant_gpu,
)
from PIL import Image

FRAMES = 300
RATE = Fraction(25033, 1000)  # как у первого настоящего ролика
SIZE = (1280, 720)


def level(i):
    # Соседние кадры отличаются на 40 уровней — сжатие их не спутает.
    return (i * 40) % 240 + 8


def encode(path, keyint, bframes=3, frames=FRAMES):
    with av.open(path, "w") as out:
        stream = out.add_stream("libx264", rate=RATE)
        stream.width, stream.height = SIZE
        stream.pix_fmt = "yuv420p"
        stream.options = {"x264-params": f"keyint={keyint}:min-keyint={keyint}:scenecut=0:bframes={bframes}"}
        for i in range(frames):
            img = Image.new("RGB", SIZE, (level(i),) * 3)
            for packet in stream.encode(av.VideoFrame.from_image(img)):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)


def test_копия_без_опорного_на_границе_отвергается(tmp_path):
    bad = str(tmp_path / "gop50.mp4")
    encode(bad, keyint=50, bframes=0, frames=240)
    with pytest.raises(VideoError, match="нет опорного"):
        _check_aligned(bad, 240)


def test_копия_с_чужим_числом_кадров_отвергается(tmp_path):
    good = str(tmp_path / "gop120.mp4")
    encode(good, keyint=SEGMENT_FRAMES, bframes=0, frames=240)
    _check_aligned(good, 240)
    with pytest.raises(VideoError, match="кадров вместо"):
        _check_aligned(good, 241)


def nvenc_works():
    if not gpu_ready():
        return False
    probe = subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "nullsrc=s=256x256",
         "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-"], capture_output=True)
    return probe.returncode == 0


@pytest.mark.skipif(not nvenc_works(), reason="нет видеокарты с NVENC")
@pytest.mark.parametrize("quality", ["480", "720"])
def test_копия_на_карте_кадр_в_кадр(tmp_path, quality):
    src = str(tmp_path / "src.mp4")
    encode(src, keyint=50)
    index = build_index(src)
    made = make_variant_gpu(src, index, quality, str(tmp_path / "copy.mp4"))

    assert made["count"] == FRAMES
    assert (made["width"], made["height"]) == _params(quality, *SIZE)["size"]
    with av.open(src) as container:
        want = [f.to_ndarray(format="gray").mean() for f in container.decode(container.streams.video[0])]
    with av.open(made["path"]) as container:
        stream = container.streams.video[0]
        for i, frame in enumerate(container.decode(stream)):
            got = frame.to_ndarray(format="gray").mean()
            assert abs(got - want[i]) < 6, f"кадр {i} копии — не {i}-й кадр оригинала"
            # Время — номер кадра по частоте из таблицы, как у копии на процессоре.
            assert abs(float(frame.pts * stream.time_base) - i / RATE) < 1e-3
    assert i == FRAMES - 1
