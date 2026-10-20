"""Лента перемоткой даёт те же кадры, что полный проход. Без базы и без сервера.

Раньше ради двадцати картинок ленты разжимался весь ролик — 50 с на
20-минутном 1080p, и шесть лент стояли в очереди впереди нарезки первого
ролика. Перемотка к опорному и разжатие до места — доли секунды, но цена
ошибки в ней другая: прыгнуть не туда и тихо взять соседний кадр. Поэтому
сверяем с полным проходом пиксель в пиксель, на ролике с B-кадрами и
опорным через 50 кадров — большинство моментов попадает в середину группы.
"""
from fractions import Fraction

import av
import pytest
from datasets_svc.video import extract_frames, frames_at
from PIL import Image

FRAMES = 400
RATE = 25
SIZE = (160, 96)


@pytest.fixture(scope="module")
def clip(tmp_path_factory):
    path = str(tmp_path_factory.mktemp("strip") / "gop50.mp4")
    with av.open(path, "w") as out:
        stream = out.add_stream("libx264", rate=Fraction(RATE))
        stream.width, stream.height = SIZE
        stream.pix_fmt = "yuv420p"
        stream.options = {"x264-params": "keyint=50:min-keyint=50:scenecut=0:bframes=3"}
        for i in range(FRAMES):
            # Каждый кадр свой: полосы ползут, и соседний кадр не совпадёт с нужным.
            img = Image.new("RGB", SIZE, (20, 20, 20))
            for x in range(0, SIZE[0], 9):
                img.paste(((x * 3 + i * 7) % 255, (i * 11) % 255, 90), (x, 0, x + 5, SIZE[1]))
            for packet in stream.encode(av.VideoFrame.from_image(img)):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    return path


def test_перемотка_берёт_те_же_кадры_что_полный_проход(clip):
    moments = [i * 800 for i in range(20)]  # шаг ленты на 16-секундном ролике
    numbers = [ms * RATE // 1000 for ms in moments]
    assert sum(n % 50 != 0 for n in numbers) >= 15, "моменты должны быть внутри групп, а не на опорных"

    full = {}
    extract_frames(clip, numbers, lambda n, _t, img: full.__setitem__(n, img.tobytes()))
    got = frames_at(clip, moments)

    assert len(got) == len(numbers)
    for n, img in zip(numbers, got):
        assert img.tobytes() == full[n], f"кадр {n}: перемотка взяла не тот"


def test_потолок_разжатия_отдаёт_кадр_раньше_а_не_ничего(clip):
    # Отрицательная проверка потолка: без него ролик почти без опорных
    # разжимался бы от начала на каждой из двадцати перемоток.
    got = frames_at(clip, [1400], limit=1)  # кадр 35, опорный — 0
    assert len(got) == 1
    full = {}
    extract_frames(clip, [0, 35], lambda n, _t, img: full.__setitem__(n, img.tobytes()))
    assert got[0].tobytes() == full[0]
