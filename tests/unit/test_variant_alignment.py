"""Опорные кадры копии стоят на границах перегонов. Без базы и без сервера.

Это регрессия на самую дорогую ошибку конвейера. Кадр, декодированный из
исходника, помнит, чем он там был, и libx264 верит этому буквально: кадр,
бывший опорным в оригинале, становится опорным и в копии — поверх любого
keyint. У первого же реального ролика опорные стояли через 50 кадров, копия
унаследовала их все, и ни одна граница перегона на опорный не попала.

Видно это было не сразу. Перегоны всё равно получались правильные — просто
каждый резался перекодированием по десять секунд вместо перекладывания
пакетов за миллисекунды. Переключение качества на двадцатиминутном ролике
превращалось в бесконечную полосу.

Поэтому проверка идёт от картинки, а не от настроек: кодируем через тот самый
``_Writer``, кормим его кадрами с чужим типом — и смотрим, где в готовом файле
опорные.
"""
import os

import av
import pytest
from datasets_svc.video_chunks import (
    CHUNK_FRAMES,
    _VARIANT_X264,
    _Writer,
    _params,
)
from PIL import Image

FRAMES = 400
SIZE = (320, 240)
RATE = 25


def paint(i):
    """Кадр, который сжимается по-разному: сплошная заливка не даст
    кодировщику повода ни для чего, и опыт выродится."""
    img = Image.new("RGB", SIZE, (18, 22, 28))
    for x in range(0, SIZE[0], 7):
        shade = (x + i * 5) % 255
        img.paste((shade, (shade * 3) % 255, 60), (x, 0, x + 4, SIZE[1]))
    return img


def keyframes(path):
    with av.open(path) as container:
        stream = container.streams.video[0]
        keys, n = [], 0
        for packet in container.demux(stream):
            if packet.pts is None:
                continue
            if packet.is_keyframe:
                keys.append(n)
            n += 1
    return n, keys


def make(tmp_path, pict_type):
    """Копия ступени из кадров, которым заранее навязан тип."""
    dest = str(tmp_path / "variant.mp4")
    params = _params("480", *SIZE)
    writer = _Writer(av, dest, RATE, params["size"], params, CHUNK_FRAMES,
                     x264=_VARIANT_X264)
    for i in range(FRAMES):
        frame = av.VideoFrame.from_image(paint(i))
        # Так выглядит кадр, пришедший из исходника с опорными через 50.
        frame.pict_type = pict_type(i)
        writer.add(frame)
    writer.finish()
    return dest


def test_опорные_стоят_ровно_на_границах_перегонов(tmp_path):
    path = make(tmp_path, lambda i: "I" if i % 50 == 0 else "P")
    total, keys = keyframes(path)
    assert total == FRAMES
    assert keys == list(range(0, FRAMES, CHUNK_FRAMES)), (
        "копия унаследовала опорные кадры исходника — перегоны из неё "
        "придётся перекодировать, а не перекладывать"
    )


def test_чужой_тип_кадра_не_добавляет_опорных(tmp_path):
    """Даже если исходник опорный на каждом десятом — в копии их только на
    границах перегонов."""
    path = make(tmp_path, lambda i: "I" if i % 10 == 0 else "P")
    _total, keys = keyframes(path)
    assert keys == list(range(0, FRAMES, CHUNK_FRAMES))


def test_без_навязанного_типа_ничего_не_ломается(tmp_path):
    path = make(tmp_path, lambda _i: "NONE")
    total, keys = keyframes(path)
    assert total == FRAMES
    assert keys == list(range(0, FRAMES, CHUNK_FRAMES))


@pytest.mark.parametrize("count", [1, CHUNK_FRAMES - 1, CHUNK_FRAMES])
def test_короткая_копия_остаётся_одним_перегоном(tmp_path, count):
    dest = str(tmp_path / f"short-{count}.mp4")
    params = _params("480", *SIZE)
    writer = _Writer(av, dest, RATE, params["size"], params, CHUNK_FRAMES,
                     x264=_VARIANT_X264)
    for i in range(count):
        frame = av.VideoFrame.from_image(paint(i))
        frame.pict_type = "I"
        writer.add(frame)
    writer.finish()
    total, keys = keyframes(dest)
    assert total == count
    assert keys == [0]
    os.remove(dest)
