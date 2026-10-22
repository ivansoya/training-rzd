"""Таблица пакетов на настоящих файлах: годится ли оригинал для Range и сходятся ли байты.

Браузер вырезает кадр из байтов файла по смещению и размеру из таблицы. Если
смещение указывает не на данные кадра (так в mkv/avi), декодер получит мусор.
Поэтому проверяется главное: раз сервер сказал «можно», байты по таблице —
ровно те, что отдаёт демуксер, у каждого пакета.
"""
import shutil
import subprocess

import av
import numpy as np
import pytest
from PIL import Image

from datasets_svc.video_chunks import _Writer, _params, build_index, segments, unpack_table, pack_table

SIZE = (320, 240)
FRAMES = 200


def paint(i):
    img = Image.new("RGB", SIZE, (18, 22, 28))
    for x in range(0, SIZE[0], 7):
        shade = (x * 3 + i * 11) % 255
        img.paste((shade, (shade * 5) % 255, (i * 3) % 255), (x, 0, x + 4, SIZE[1]))
    return img


def encode(path, codec="libx264", options=None, audio=False):
    with av.open(str(path), "w") as out:
        stream = out.add_stream(codec, rate=25)
        stream.width, stream.height = SIZE
        stream.pix_fmt = "yuv420p"
        if options:
            stream.options = options
        sound = out.add_stream("aac", rate=48000) if audio else None
        for i in range(FRAMES):
            for packet in stream.encode(av.VideoFrame.from_image(paint(i))):
                out.mux(packet)
            if sound is not None:
                tone = av.AudioFrame.from_ndarray(np.zeros((1, 1024), dtype=np.float32), format="fltp", layout="mono")
                tone.sample_rate, tone.pts = 48000, i * 1024
                for packet in sound.encode(tone):
                    out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
        if sound is not None:
            for packet in sound.encode(None):
                out.mux(packet)
    return str(path)


def same_bytes(path, index):
    """Каждый пакет демуксера лежит в файле ровно там, где говорит таблица."""
    with open(path, "rb") as fh, av.open(path) as container:
        packets = [p for p in container.demux(container.streams.video[0]) if p.size]
        assert len(packets) == index["count"]
        for n, packet in enumerate(packets):
            fh.seek(index["pos"][n])
            assert fh.read(index["sizes"][n]) == bytes(packet), f"пакет {n}"


NO_B = {"x264-params": "keyint=50:min-keyint=50:scenecut=0:bframes=0"}


def test_h264_без_b_кадров_идёт_по_range_и_байты_сходятся(tmp_path):
    path = encode(tmp_path / "plain.mp4", options=NO_B)
    index = build_index(path)
    assert index["range_why"] is None
    assert index["codec_string"].startswith("avc1.")
    same_bytes(path, index)
    assert [s["first"] for s in segments(index)] == [0, 150]


def test_звук_вперемешку_не_мешает_байты_сходятся(tmp_path):
    """Камеры H.264 пишут aac между кадрами — зазоры в таблице его и пропускают."""
    path = encode(tmp_path / "sound.mp4", options=NO_B, audio=True)
    index = build_index(path)
    assert index["range_why"] is None
    same_bytes(path, index)
    back = unpack_table(pack_table(index))
    assert back["pos"] == index["pos"]
    assert any(g for g in pack_table(index)["gaps"][1:]), "звук должен лечь зазорами"


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="нет ffmpeg")
def test_b_кадры_только_ступени(tmp_path):
    # PyAV-шный libx264 здесь B-кадров не ставит ни при каких настройках — берём ffmpeg.
    path = str(tmp_path / "bframes.mp4")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                    "-i", "testsrc=size=320x240:rate=25", "-frames:v", "100", "-c:v", "libx264",
                    "-bf", "3", path], check=True)
    assert build_index(path)["range_why"] == "B-кадры"


def test_кодек_не_для_браузера_только_ступени(tmp_path):
    path = encode(tmp_path / "mpeg4.mp4", codec="mpeg4")
    assert build_index(path)["range_why"] == "кодек mpeg4"


@pytest.mark.parametrize("ext", ["mkv", "mov"])
def test_другой_контейнер_или_годится_целиком_или_не_идёт(tmp_path, ext):
    """mov устроен как mp4; mkv — как выйдет. Главное: «можно» значит байты сходятся."""
    path = encode(tmp_path / f"plain.{ext}", options=NO_B)
    index = build_index(path)
    if index["range_why"] is None:
        same_bytes(path, index)
    if ext == "mov":
        assert index["range_why"] is None


def test_потолок_битрейта_держит_копию_на_процессоре(tmp_path):
    """Решение 7 (22.10.2026): ступень не тяжелее оригинала — crf внутри потолка."""
    dest = str(tmp_path / "capped.mp4")
    params = {**_params("240", *SIZE), "crf": "10", "maxrate": 200_000}
    writer = _Writer(av, dest, 25, params["size"], params, 120)
    for i in range(FRAMES):
        writer.add(av.VideoFrame.from_image(paint(i)))
    writer.finish()
    bitrate = build_index(dest)["bitrate"]
    assert bitrate < 200_000 * 1.15, f"{bitrate} бит/с при потолке 200 000"
