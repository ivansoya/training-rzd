"""Синтетический ролик для тестов.

Держать видеофайл в репозитории не хочется: он бинарный, весит и живёт своей
жизнью. Генерируем при первом обращении — 3 секунды, 10 к/с, движущийся
прямоугольник. Движение нужно, чтобы «кадр 5» и «кадр 25» отличались не на
словах: по ним проверяется, что сервер отдаёт именно запрошенный кадр.
"""
import os

PATH = os.environ.get("TEST_SAMPLE_VIDEO", "/tmp/magistral-sample-30f.mp4")
WIDTH, HEIGHT, FPS, FRAMES = 320, 240, 10, 30

# Длинный ролик — для перегонов: в коротком все кадры умещаются в один, и
# проверять там нечего. 300 кадров при 120 в перегоне дают три штуки, включая
# неполный последний.
LONG_PATH = os.environ.get("TEST_SAMPLE_LONG", "/tmp/magistral-sample-300f.mp4")
LONG_FPS, LONG_FRAMES = 25, 300

# Номер кадра пишется на картинку двоичным кодом: девять крупных клеток,
# светлая — единица. Нарисованные цифры этого не умеют — их надо распознавать,
# а клетка переживает и перекодирование, и уменьшение вдвое, и читается
# сравнением одного пикселя с порогом.
MARK_BITS = 9
MARK_CELL = 30
MARK_TOP = 12


def _draw_mark(draw, frame_no):
    for bit in range(MARK_BITS):
        on = (frame_no >> (MARK_BITS - 1 - bit)) & 1
        x = 10 + bit * (MARK_CELL + 3)
        draw.rectangle(
            [x, MARK_TOP, x + MARK_CELL, MARK_TOP + MARK_CELL],
            fill=(240, 240, 240) if on else (12, 12, 12),
        )


def read_mark(img):
    """Прочитать номер кадра с картинки. Обратное к ``_draw_mark``.

    Берётся середина клетки: края мажет и перекодирование, и уменьшение, а
    середина держится. Порог по яркости, потому что точный цвет не переживает
    ни то, ни другое.
    """
    w, h = img.size
    kx, ky = w / WIDTH, h / HEIGHT
    rgb = img.convert("RGB")
    value = 0
    for bit in range(MARK_BITS):
        cx = (10 + bit * (MARK_CELL + 3) + MARK_CELL / 2) * kx
        cy = (MARK_TOP + MARK_CELL / 2) * ky
        r, g, b = rgb.getpixel((int(cx), int(cy)))
        value = (value << 1) | (1 if (r + g + b) / 3 > 128 else 0)
    return value


def ensure_long(path: str = LONG_PATH) -> str:
    """Ролик на 300 кадров с номером кадра на каждой картинке."""
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path

    import av
    from PIL import Image, ImageDraw

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".part"
    container = av.open(tmp, mode="w", format="mp4")
    stream = container.add_stream("mpeg4", rate=LONG_FPS)
    stream.width, stream.height = WIDTH, HEIGHT
    stream.pix_fmt = "yuv420p"

    for i in range(LONG_FRAMES):
        canvas = Image.new("RGB", (WIDTH, HEIGHT), (18, 22, 28))
        draw = ImageDraw.Draw(canvas)
        _draw_mark(draw, i)
        x = 10 + (i * 8) % (WIDTH - 70)
        draw.rectangle([x, 150, x + 60, 210], fill=(220, 90, 40))
        container.mux(stream.encode(av.VideoFrame.from_image(canvas)))
    container.mux(stream.encode())
    container.close()
    os.replace(tmp, path)
    return path


def ensure(path: str = PATH) -> str:
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path

    import av
    from PIL import Image, ImageDraw

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".part"
    # Формат называем явно: по расширению «.part» его не угадать, а писать
    # сразу в целевой файл нельзя — недописанный ролик подхватят как готовый.
    container = av.open(tmp, mode="w", format="mp4")
    stream = container.add_stream("mpeg4", rate=FPS)
    stream.width, stream.height = WIDTH, HEIGHT
    stream.pix_fmt = "yuv420p"

    for i in range(FRAMES):
        canvas = Image.new("RGB", (WIDTH, HEIGHT), (18, 22, 28))
        draw = ImageDraw.Draw(canvas)
        x = 10 + i * 8
        draw.rectangle([x, 90, x + 60, 150], fill=(220, 90, 40))
        # Номер кадра прямо на картинке: если сервер отдаст соседний, это
        # видно глазом на упавшем скриншоте, а не только по хэшу.
        draw.text((8, 8), f"frame {i}", fill=(235, 236, 239))
        container.mux(stream.encode(av.VideoFrame.from_image(canvas)))
    container.mux(stream.encode())
    container.close()
    os.replace(tmp, path)
    return path
