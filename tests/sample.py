"""Синтетический ролик для тестов.

Держать видеофайл в репозитории не хочется: он бинарный, весит и живёт своей
жизнью. Генерируем при первом обращении — 3 секунды, 10 к/с, движущийся
прямоугольник. Движение нужно, чтобы «кадр 5» и «кадр 25» отличались не на
словах: по ним проверяется, что сервер отдаёт именно запрошенный кадр.
"""
import os

PATH = os.environ.get("TEST_SAMPLE_VIDEO", "/tmp/magistral-sample-30f.mp4")
WIDTH, HEIGHT, FPS, FRAMES = 320, 240, 10, 30


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
