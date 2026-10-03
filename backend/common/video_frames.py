"""Кадры ролика по номерам — одно место на всю платформу.

Номер кадра — его позиция в таблице кадров ролика (индекс `video_index`:
отсортированные pts пакетов). По ней же отвечают `/frame`, перегоны и
таймлайн. Раньше закрытие разметки и агент считали `round(pts·tb·fps)`, и на
ролике с разрывом pts в проект уходил соседний кадр, а бокс терялся молча.

Момент времени в кадр переводит `FrameClock`: «последний кадр с pts ≤ t» — то
же правило, что у плеера в браузере. Нарезка по участкам, прикидка и сверка
плана с уже нарезанным ходят через него же.

Живёт в `common`, потому что читают двое: `datasets` (закрытие, нарезка) и
`training-worker` (агент на ролике).
"""
from bisect import bisect_right
from contextlib import contextmanager


class VideoError(Exception):
    pass


@contextmanager
def open_video(path):
    """`av.open`, который закрывает и кодек.

    Без этого каждое декодирование с `thread_type="AUTO"` оставляло 16 живых
    потоков с буферами кадров до прохода сборщика: у воркера видео — сотни
    потоков и гигабайты памяти, которые glibc системе не возвращает.
    """
    import av

    container = av.open(path)
    try:
        yield container
    finally:
        for stream in container.streams.video:
            try:
                stream.codec_context.close()
            except Exception:  # noqa: BLE001
                pass
        container.close()


def unpack_pts(payload):
    """pts кадров из хранимой таблицы (`TaskVideo.frame_index`) или None."""
    if not payload or payload.get("v") != 1:
        return None
    pts = [int(payload["first_pts"])]
    for d in payload["deltas"]:
        pts.append(pts[-1] + int(d))
    return pts


class FrameClock:
    """Момент (мс от первого кадра) ↔ номер кадра.

    С таблицей кадров — точно; без неё (ролик под нарезку, таблицу ещё не
    построили) — по частоте, и тогда это прикидка.
    """

    def __init__(self, *, pts=None, time_base=None, fps=None, count=None):
        self.pts = pts or None
        tb = time_base
        if isinstance(tb, (list, tuple)):
            tb = tb[0] / tb[1] if tb[1] else None
        self.tb = float(tb) if tb else None
        self.fps = float(fps) if fps else None
        self.count = len(self.pts) if self.pts else count

    @classmethod
    def of(cls, payload, fps=None, count=None):
        pts = unpack_pts(payload)
        if pts and payload.get("time_base"):
            return cls(pts=pts, time_base=payload["time_base"])
        return cls(fps=fps, count=count)

    @property
    def exact(self):
        return bool(self.pts and self.tb)

    def frame(self, ms):
        """Кадр, который плеер показывает в момент ms; None — за концом ролика."""
        if ms is None or ms < 0:
            return None
        if self.exact:
            t = self.pts[0] + ms / 1000.0 / self.tb
            # Полмиллисекунды допуска: момент «40 мс» — это кадр на 40,0 мс.
            i = bisect_right(self.pts, t + 0.0005 / self.tb) - 1
            if i < 0:
                return 0
            if i == len(self.pts) - 1:
                last = (self.pts[-1] - self.pts[-2]) if len(self.pts) > 1 else 0
                if t >= self.pts[-1] + max(last, 1):
                    return None
            return i
        if not self.fps:
            return None
        n = int(ms * self.fps / 1000.0 + 1e-6)
        if self.count is not None and n >= self.count:
            return None
        return n

    def ms(self, frame_no):
        """Начало кадра в мс от первого кадра."""
        if self.exact and 0 <= frame_no < len(self.pts):
            return int(round((self.pts[frame_no] - self.pts[0]) * self.tb * 1000))
        if self.fps:
            return int(round(frame_no * 1000.0 / self.fps))
        return None


def extract_frames(path, frame_numbers, on_frame, progress=None, pts=None):
    """Достаёт кадры по номерам за один проход контейнера.

    ``pts`` — таблица кадров ролика: номер кадра берётся по ней. Без таблицы
    номер — порядок кадра в декодере (тот же, если в файле нет битых пакетов).

    ``on_frame(frame_no, time_ms, img)`` вызывается по возрастанию номера;
    ``time_ms`` — от первого кадра ролика.
    """
    try:
        import av
    except ImportError as exc:  # noqa: BLE001
        raise VideoError("Обработка видео недоступна на сервере.") from exc

    targets = {int(n) for n in frame_numbers}
    if not targets:
        return 0
    last = max(targets)
    by_pts = {p: i for i, p in enumerate(pts)} if pts else None

    saved = 0
    ordinal = -1
    first = pts[0] if pts else None
    with open_video(path) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        time_base = float(stream.time_base) if stream.time_base else 0.0
        if not time_base:
            raise VideoError("В видео нет шкалы времени — покадровый доступ невозможен.")

        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            ordinal += 1
            if first is None:
                first = frame.pts
            number = by_pts.get(frame.pts) if by_pts is not None else ordinal
            if number is None:
                continue
            if number > last:
                break
            if number not in targets:
                continue
            time_ms = int(round((frame.pts - first) * time_base * 1000))
            on_frame(number, time_ms, frame.to_image())
            saved += 1
            if progress and saved % 10 == 0:
                progress(saved, len(targets))
    if progress:
        progress(saved, len(targets))
    return saved
