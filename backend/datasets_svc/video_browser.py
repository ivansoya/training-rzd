"""Индексированная MP4-копия для HTML video; исходник и его PTS/байтовые индексы неизменны."""
import hashlib
import json
import os
import struct
import subprocess
import tempfile
from fractions import Fraction

from common.video_frames import VideoError, open_video


def _paths(source):
    base = os.path.splitext(source)[0] + "_browser"
    return base + ".mp4", base + ".json"


def _stamp(path):
    stat = os.stat(path)
    return [stat.st_size, stat.st_mtime_ns]


def needs_remux(source):
    """У обычного MP4 полный moov стоит перед mdat; moof означает фрагменты."""
    size = os.path.getsize(source)
    seen_moov = False
    with open(source, "rb") as file:
        offset = 0
        while offset + 8 <= size:
            file.seek(offset)
            length, kind = struct.unpack(">I4s", file.read(8))
            if offset == 0 and kind != b"ftyp":
                return True
            if length == 1:
                raw = file.read(8)
                if len(raw) != 8:
                    raise VideoError("Повреждён заголовок видео.")
                length = struct.unpack(">Q", raw)[0]
            elif length == 0:
                length = size - offset
            if length < 8 or offset + length > size:
                raise VideoError("Повреждён контейнер видео.")
            if kind == b"moof":
                return True
            if kind == b"moov":
                seen_moov = True
            if kind == b"mdat" and not seen_moov:
                return True
            offset += length
    return not seen_moov


def playback_path(source):
    """Только полностью проверенная копия именно этого исходника; иначе исходник."""
    dest, marker = _paths(source)
    try:
        with open(marker, encoding="utf-8") as file:
            meta = json.load(file)
        if meta.get("v") == 1 and meta.get("source") == _stamp(source) and meta.get("output") == _stamp(dest):
            return dest
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return source


def _packets(source, heartbeat=None):
    """Хэш всех сжатых видеопакетов и точных временных меток, без декодирования."""
    digest = hashlib.sha256()
    count = 0
    with open_video(source) as container:
        stream = container.streams.video[0]
        time_base = Fraction(stream.time_base)
        scale = time_base.denominator
        for packet in container.demux(stream):
            if packet.pts is None:
                continue
            stamp = str(packet.pts * time_base).encode("ascii")
            digest.update(struct.pack(">QI", packet.size, len(stamp)))
            digest.update(stamp)
            digest.update(bytes(packet))
            count += 1
            if heartbeat and count % 250 == 0:
                heartbeat()
    if not count:
        raise VideoError("В видео нет кадров.")
    return count, digest.hexdigest(), scale


def prepare(source, heartbeat=None):
    """Stream-copy и атомарная публикация только после сверки всех пакетов/PTS."""
    ready = playback_path(source)
    if ready != source or not needs_remux(source):
        return ready
    stamp = _stamp(source)
    expected = _packets(source, heartbeat)
    dest, marker = _paths(source)
    fd, temporary = tempfile.mkstemp(prefix=os.path.basename(dest) + ".", suffix=".mp4", dir=os.path.dirname(source))
    os.close(fd)
    try:
        with subprocess.Popen([
            "ffmpeg", "-v", "error", "-nostdin", "-y", "-copyts", "-i", source,
            "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-copyinkf",
            "-video_track_timescale", str(expected[2]),
            "-avoid_negative_ts", "disabled", "-movie_timescale", str(expected[2]),
            "-movflags", "+faststart", temporary,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) as process:
            for _ in range(60):
                try:
                    process.communicate(timeout=5)
                    break
                except subprocess.TimeoutExpired:
                    if heartbeat:
                        heartbeat()
            else:
                process.kill()
                process.communicate()
                raise VideoError("Превышено время переупаковки видео.")
            if process.returncode:
                raise VideoError("Не удалось переупаковать видео для браузера.")
        actual = _packets(temporary, heartbeat)
        if actual[:2] != expected[:2] or needs_remux(temporary):
            raise VideoError("Переупаковка изменила кадры или их временные метки.")
        if _stamp(source) != stamp:
            raise VideoError("Исходник изменился во время переупаковки.")
        os.replace(temporary, dest)
        meta = {"v": 1, "source": stamp, "output": _stamp(dest), "frames": expected[0], "sha256": expected[1]}
        # Уникальный временный маркер: повторная работа другого процесса не оставит полузапись.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=os.path.dirname(source), delete=False) as file:
            marker_tmp = file.name
            json.dump(meta, file)
        try:
            os.replace(marker_tmp, marker)
        finally:
            if os.path.exists(marker_tmp):
                os.remove(marker_tmp)
        return dest
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
