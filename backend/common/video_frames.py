"""Кадры ролика по номерам — одно место на всю платформу.

Номер кадра — `round(pts · time_base · fps)`: так его считает закрытие
разметки ролика, и так же обязан считать агент разметки, который ставит рамки
на кадры ролика до закрытия. Разойдись они на единицу — рамка молча встала
бы на соседний кадр и уехала в датасет.

Живёт в `common`, потому что читают двое: `datasets` (закрытие, нарезка) и
`training-worker` (агент на ролике).
"""


class VideoError(Exception):
    pass


def extract_frames(path, frame_numbers, on_frame, progress=None):
    """Достаёт кадры по номерам за один проход контейнера.

    ``grab_frame`` хорош для одиночного кадра, но на сотне кадров он открыл бы
    файл сотню раз. Здесь декодер крутится один раз от начала до последнего
    нужного кадра, а вызывающему отдаются те номера, которые он просил.

    ``on_frame(frame_no, time_ms, img)`` вызывается по возрастанию номера.
    """
    try:
        import av
    except ImportError as exc:  # noqa: BLE001
        raise VideoError("Обработка видео недоступна на сервере.") from exc

    targets = sorted({int(n) for n in frame_numbers})
    if not targets:
        return 0

    saved = 0
    cursor = 0
    with av.open(path) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        rate = float(stream.average_rate) if stream.average_rate else 0.0
        time_base = float(stream.time_base) if stream.time_base else 0.0
        if not rate or not time_base:
            raise VideoError("В видео нет частоты кадров — покадровый доступ невозможен.")

        for frame in container.decode(stream):
            if cursor >= len(targets):
                break
            if frame.pts is None:
                continue
            index = int(round(frame.pts * time_base * rate))
            if index < targets[cursor]:
                continue
            # Кадр догнал цель — отдаём его и проматываем всё, что он перекрыл.
            wanted = targets[cursor]
            while cursor < len(targets) and targets[cursor] <= index:
                cursor += 1
            on_frame(wanted, int(round(wanted * 1000.0 / rate)), frame.to_image())
            saved += 1
            if progress and saved % 10 == 0:
                progress(saved, len(targets))
    if progress:
        progress(saved, len(targets))
    return saved
