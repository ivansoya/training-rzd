"""Нарезка видео на кадры по участкам.

Участок — это «с какой по какую секунду и с каким шагом»: на важном куске
плотно, на проходном редко. Внутри всё сводится к списку целевых моментов,
и контейнер проходится **один раз** — перемотка на каждый кадр у длинных
роликов работает непредсказуемо, а последовательное чтение всегда честно.

ffmpeg взят пакетом с собственными бинарниками, а не системный: apt-версия
потянула бы образ datasets_svc с 268 МБ примерно до шестисот.
"""
import os

from PIL import Image as PilImage

from common import config

# Потолок: столько кадров ещё осмысленно разметить руками, дальше человек
# просто утонет, а том забьётся.
MAX_FRAMES = 3000


class VideoError(Exception):
    pass


def probe(path):
    """Длительность, частота и размер кадра — для прикидки перед нарезкой."""
    try:
        import av
    except ImportError as exc:  # noqa: BLE001
        raise VideoError("Обработка видео недоступна на сервере.") from exc
    try:
        with av.open(path) as container:
            if not container.streams.video:
                raise VideoError("В файле нет видеодорожки.")
            stream = container.streams.video[0]
            fps = float(stream.average_rate) if stream.average_rate else None
            if stream.duration and stream.time_base:
                duration_ms = int(float(stream.duration * stream.time_base) * 1000)
            elif container.duration:
                duration_ms = int(container.duration / 1000)
            else:
                duration_ms = None
            return {
                "duration_ms": duration_ms,
                "fps": round(fps, 3) if fps else None,
                "width": stream.codec_context.width,
                "height": stream.codec_context.height,
            }
    except VideoError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise VideoError(f"Не удалось прочитать видео: {exc}") from exc


def plan(segments, duration_ms):
    """Список моментов в миллисекундах, которые попадут в кадры.

    Участки могут пересекаться — момент берётся один раз, иначе на стыке
    двух участков получились бы дубликаты одного и того же кадра.
    """
    moments = set()
    for seg in segments or []:
        start = max(0, int(seg.get("start_ms", 0)))
        end = int(seg.get("end_ms", duration_ms or 0))
        step = int(seg.get("step_ms", 1000))
        if step <= 0:
            raise VideoError("Шаг должен быть больше нуля.")
        if duration_ms:
            end = min(end, duration_ms)
        if end <= start:
            continue
        t = start
        while t < end:
            moments.add(t)
            t += step
            if len(moments) > MAX_FRAMES:
                raise VideoError(
                    f"При таком шаге выйдет больше {MAX_FRAMES} кадров. "
                    "Возьмите шаг покрупнее или укоротите участки."
                )
    return sorted(moments)


def estimate(segments, duration_ms, width, height):
    """Прикидка до запуска: сколько кадров и сколько места они займут."""
    try:
        moments = plan(segments, duration_ms)
    except VideoError as exc:
        return {"error": str(exc)}
    # Кадр 1920×1400 в JPEG качества 88 весит примерно 0,6 МБ; масштабируем
    # по площади, чтобы прикидка не врала на других разрешениях.
    area = (width or 1920) * (height or 1400)
    per_frame = 620_000 * area / (1920 * 1400)
    return {
        "frames": len(moments),
        "size_bytes": int(len(moments) * per_frame),
    }


def extract(video_path, moments, dest_dir, on_frame, progress=None):
    """Достаёт кадры в указанные моменты и отдаёт их через ``on_frame``.

    ``on_frame(index, time_ms, path)`` вызывается для каждого сохранённого
    кадра; имя файла придумывает вызывающий, потому что оно завязано на id
    записи в базе.
    """
    try:
        import av
    except ImportError as exc:  # noqa: BLE001
        raise VideoError("Обработка видео недоступна на сервере.") from exc

    os.makedirs(dest_dir, exist_ok=True)
    targets = list(moments)
    if not targets:
        return 0

    saved = 0
    cursor = 0
    with av.open(video_path) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        time_base = float(stream.time_base) if stream.time_base else 0.0
        for frame in container.decode(stream):
            if cursor >= len(targets):
                break
            pts = frame.pts
            if pts is None or not time_base:
                continue
            now_ms = int(pts * time_base * 1000)
            # Берём первый кадр, догнавший очередной момент, и сразу
            # проматываем все моменты, которые он перекрыл.
            if now_ms + 0.5 < targets[cursor]:
                continue
            time_ms = targets[cursor]
            while cursor < len(targets) and targets[cursor] <= now_ms:
                cursor += 1

            img = frame.to_image()
            on_frame(saved, time_ms, img)
            saved += 1
            if progress and saved % 10 == 0:
                progress(saved, len(targets))
    if progress:
        progress(saved, len(targets))
    return saved


# Кинолента под таймлайном: участок выбирают глазами, а не по числам.
STRIP_FRAMES = 20
STRIP_HEIGHT = 90


def make_strip(video_path, dest_path, duration_ms):
    """Склеивает STRIP_FRAMES кадров в одну широкую картинку.

    Одна полоса вместо двадцати файлов: браузеру это один запрос, а нам —
    один путь. Порядка 200 КБ на ролик.
    """
    if not duration_ms:
        return None
    step = max(1, duration_ms // STRIP_FRAMES)
    moments = [i * step for i in range(STRIP_FRAMES) if i * step < duration_ms]
    tiles = []

    def collect(_index, _time_ms, img):
        small = img.convert("RGB")
        w = max(1, int(small.width * STRIP_HEIGHT / small.height))
        tiles.append(small.resize((w, STRIP_HEIGHT), PilImage.LANCZOS))

    try:
        extract(video_path, moments, os.path.dirname(dest_path), collect)
    except Exception:  # noqa: BLE001
        return None
    if not tiles:
        return None
    total = sum(t.width for t in tiles)
    strip = PilImage.new("RGB", (total, STRIP_HEIGHT))
    x = 0
    for t in tiles:
        strip.paste(t, (x, 0))
        x += t.width
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    strip.save(dest_path, "JPEG", quality=72)
    return dest_path


def save_frame(img, base_dir, image_id):
    """Кладёт кадр в те же три размера, что и импортированные изображения."""
    for sub in ("images", "thumbs", "preview"):
        os.makedirs(os.path.join(base_dir, sub), exist_ok=True)
    rgb = img.convert("RGB")
    full = os.path.join(base_dir, "images", f"{image_id}.jpg")
    rgb.save(full, "JPEG", quality=88)

    thumb = rgb.copy()
    thumb.thumbnail((config.THUMB_MAX_SIDE, config.THUMB_MAX_SIDE), PilImage.LANCZOS)
    thumb.save(os.path.join(base_dir, "thumbs", f"{image_id}.jpg"),
               "JPEG", quality=config.THUMB_QUALITY)

    if max(rgb.size) > config.PREVIEW_MAX_SIDE:
        prev = rgb.copy()
        prev.thumbnail(
            (config.PREVIEW_MAX_SIDE, config.PREVIEW_MAX_SIDE), PilImage.LANCZOS
        )
        prev.save(os.path.join(base_dir, "preview", f"{image_id}.jpg"),
                  "JPEG", quality=config.PREVIEW_QUALITY)
    return full, rgb.size, os.path.getsize(full)
