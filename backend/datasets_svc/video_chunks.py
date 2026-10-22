"""Ролик для браузера: таблицы кадров и пакетов, ступени качества, отрезки для Range.

Кадр не приезжает в браузер картинкой — браузер получает байты видео и
разжимает их сам. С 22.10.2026 «Исходное» — это сам оригинал: браузер
просит у него по Range объявленный сервером отрезок, вырезает кадры по
таблице пакетов и кормит ими декодер. Пережатых перегонов больше нет: копия
весила в 8-12 раз больше HEVC-оригинала, а готовилась 92 с на карте.

**Таблица кадров** — номер кадра это его место по времени показа, и так
считают все: редактор, сдача таски, агенты. **Таблица пакетов** — где в файле
лежит каждый кадр и сколько весит. Обе снимаются одним проходом демуксера.

**Номер кадра — объявление, а не вычисление.** Границы отрезков и какие кадры
внутри объявляет сервер; клиент ничего не делит на 120 и не считает из
времени. На дробной частоте (25.033 у первого реального ролика) две
арифметики разъезжаются, и в датасет уходит соседний кадр.

**Ступень качества — один файл**, тоже по Range, как у YouTube. Её битрейт не
выше оригинала: пережатие не сделает картинку лучше камеры, а раздувало
720p «Искры» до 14 Мбит/с против 2 у оригинала.

Модуль ничего не знает ни про базу, ни про Flask. Хранением занимаются
``video_index`` и ``video_queue``, порядком работ — ``worker``.
"""
import base64
import glob
import hashlib
import os
import shutil
import subprocess
import tempfile
import threading
from fractions import Fraction

from common.video_frames import open_video

# Отрезок не короче стольких кадров (~5 с на 25 к/с), у ступеней опорный ровно через столько.
SEGMENT_FRAMES = 120

# Лестница качества, как у видеосервисов: исходное и ступени вниз. Разметчик
# выбирает сам — на мелком объекте нужна вся резкость, на просмотре хватает
# малого. Ступени выше исходника бессмысленны и в список не попадают.
#
# Ниже 480p не спускаемся: на 360 разметчик перестаёт различать мелкие
# объекты, а весь смысл ступеней — чтобы он мог работать, а не чтобы экономить
# байты.
LADDER = [1080, 720, 480]
SOURCE = "src"
DEFAULT_QUALITY = "720"

# Оригинал легче этого открывается сразу в «Исходном»: ~10 % канала 88 Мбит/с на разметчика (22.10.2026).
SOURCE_DEFAULT_BPS = 8_000_000

# Пакеты, байты которых сверяем с файлом: первый и каждый такой.
_PROBE_EVERY = 500

# Копия ступени: опорный ровно через SEGMENT_FRAMES и без B-кадров —
# порядок разжатия равен порядку показа, и n-й пакет копии есть n-й кадр ролика.
_VARIANT_X264 = (
    f"keyint={SEGMENT_FRAMES}:min-keyint={SEGMENT_FRAMES}:scenecut=0:bframes=0"
)


# Чем меньше картинка, тем слабее жмём: на мелких ступенях артефакты видны
# сильнее, а весят они всё равно копейки.
def _crf(height):
    if height is None:
        return "20"
    if height >= 1080:
        return "22"
    if height >= 720:
        return "24"
    if height >= 480:
        return "26"
    return "28"


def ladder_for(src):
    """Ступени, которые готовим фоном, по таблице оригинала.

    Ниже 480 ступеней нет; если и оригинал по Range не отдать — одна копия в
    рост, иначе такой ролик не открыть вовсе.
    """
    height = src.get("height")
    steps = [str(step) for step in LADDER if height and step < height]
    if not steps and src.get("range_why") and height:
        steps = [str(height // 2 * 2)]
    return steps


def qualities(src):
    """Что можно предложить: исходное и ступени ниже него."""
    out = [{"id": SOURCE, "label": "Исходное", "height": src.get("height")}]
    out += [{"id": q, "label": f"{q}p", "height": int(q)} for q in ladder_for(src)]
    return out


def known(quality, src):
    return quality == SOURCE or quality in ladder_for(src)


def default_for(src):
    """С чего открывать: лёгкий оригинал — сам по себе, тяжёлый — 720p (решение 11, 22.10.2026).
    Разжимает ли оригинал браузер, сервер не знает: это решает клиент."""
    if not src.get("range_why") and (src.get("bitrate") or 0) <= SOURCE_DEFAULT_BPS:
        return SOURCE
    steps = ladder_for(src)
    if DEFAULT_QUALITY in steps:
        return DEFAULT_QUALITY
    return steps[0] if steps else SOURCE


def _params(quality, width, height):
    """Размер и сжатие для ступени. Обе стороны чётные: yuv420p делит цветность
    пополам, и нечётная сторона кодировщику не годится."""
    if quality == SOURCE or not height:
        target = height
    else:
        target = min(int(quality), height)
    scale = 1.0 if not height else target / height
    w = max(2, int(round(width * scale)) // 2 * 2)
    h = max(2, int(round(height * scale)) // 2 * 2)
    return {"size": (w, h), "crf": _crf(target), "preset": "veryfast"}


VARIANT_PREFIX = "_v"


class VideoError(Exception):
    pass


class UnrecoverableVideoError(VideoError):
    """Дело в самом файле: повтор даст то же самое. Без попыток и без
    остальных ступеней — раньше битый ролик занимал медленный воркер на
    девять заходов (3 попытки × 3 ступени)."""


def _is_bad_data(exc):
    try:
        import av.error
        return isinstance(exc, av.error.InvalidDataError)
    except Exception:  # noqa: BLE001
        return False


def _av():
    try:
        import av
    except ImportError as exc:  # noqa: BLE001
        raise VideoError("Обработка видео недоступна на сервере.") from exc
    return av


# --------------------------------------------------------------------------- #
# Таблицы кадров и пакетов
# --------------------------------------------------------------------------- #
def build_index(path):
    """Пройти ролик демуксером: таблица кадров и таблица пакетов.

    Демуксинг — не декодирование: картинка не разжимается. Взамен получаем
    то, чего не даёт ни один быстрый способ: точное число кадров, а заодно
    где лежит в файле каждый кадр.

    Пакеты приходят в порядке разжатия, а нумеруем мы в порядке показа — при
    B-кадрах это разные порядки, поэтому сортируем по ``pts``.
    """
    av = _av()
    try:
        with open_video(path) as container:
            if not container.streams.video:
                raise VideoError("В файле нет видеодорожки.")
            stream = container.streams.video[0]
            time_base = stream.time_base
            rate = stream.average_rate
            ctx = stream.codec_context
            width, height = ctx.width, ctx.height
            codec, tag = ctx.name, ctx.codec_tag
            extradata = bytes(ctx.extradata or b"")
            if not time_base or not rate:
                raise VideoError(
                    "В видео нет частоты кадров — размечать его покадрово нельзя."
                )

            packets = []  # порядок разжатия: (pts, опорный, смещение в файле, размер)
            probes = {}   # номер пакета → его байты, сверить с файлом
            for packet in container.demux(stream):
                # Демукс завершается пустым пакетом-флашем: у него нет времени
                # и он не кадр.
                stamp = packet.pts if packet.pts is not None else packet.dts
                if stamp is None:
                    continue
                if len(packets) % _PROBE_EVERY == 0:
                    probes[len(packets)] = bytes(packet)
                packets.append((int(stamp), bool(packet.is_keyframe), packet.pos, packet.size))
    except VideoError:
        raise
    except Exception as exc:  # noqa: BLE001
        # Как в videolib.probe: текст библиотеки несёт путь на томе и коды
        # ошибок — на карточку ролика он не годится.
        raise VideoError("Файл не читается как видео.") from exc

    if not packets:
        raise VideoError("В видео не нашлось ни одного кадра.")

    order = sorted(range(len(packets)), key=lambda i: packets[i][0])
    pts = [packets[i][0] for i in order]
    keys = [n for n, i in enumerate(order) if packets[i][1]]
    # Опорный кадр в начале обязан быть: перемотка ищет ближайший слева, и без
    # нулевого ей некуда встать.
    if not keys or keys[0] != 0:
        keys.insert(0, 0)
    sizes = [p[3] for p in packets]
    seconds = len(pts) * rate.denominator / rate.numerator

    index = {
        "count": len(pts),
        "pts": pts,
        "keys": keys,
        "time_base": [time_base.numerator, time_base.denominator],
        "rate": [rate.numerator, rate.denominator],
        "width": width,
        "height": height,
        # Дальше — для Range. Номер пакета здесь — в порядке разжатия.
        "codec": codec,
        "codec_string": codec_string(codec, tag, extradata),
        "extradata": extradata,
        "sizes": sizes,
        "pos": [p[2] for p in packets],
        "bitrate": int(sum(sizes) * 8 / seconds) if seconds else 0,
    }
    index["version"] = _version(index)
    index["range_why"] = _range_why(path, index, packets, order, probes)
    return index


def codec_string(codec, tag, extradata):
    """Строка кодека для VideoDecoder браузера (RFC 6381) из описания потока.

    None — не H.264/HEVC или описание не в виде avcC/hvcC (mkv/ts кладут его
    иначе): такой оригинал по Range не отдаём.
    """
    if len(extradata) < 4 or extradata[0] != 1:
        return None
    if codec == "h264":
        prefix = tag if tag in ("avc1", "avc3") else "avc1"
        return f"{prefix}.{extradata[1]:02x}{extradata[2]:02x}{extradata[3]:02x}"
    if codec == "hevc" and len(extradata) >= 13:
        b = extradata
        prefix = tag if tag in ("hvc1", "hev1") else "hvc1"
        space = ["", "A", "B", "C"][b[1] >> 6]
        tier = "H" if b[1] & 0x20 else "L"
        # Флаги совместимости пишутся в обратном порядке бит (ISO/IEC 14496-15, E.3).
        compat = int(f"{int.from_bytes(b[2:6], 'big'):032b}"[::-1], 2)
        flags = list(b[6:12])
        while flags and flags[-1] == 0:
            flags.pop()
        tail = "".join(f".{f:X}" for f in flags)
        return f"{prefix}.{space}{b[1] & 0x1F}.{compat:X}.{tier}{b[12]}{tail}"
    return None


def _range_why(path, index, packets, order, probes):
    """Почему оригинал нельзя отдавать по Range; None — можно.

    Тогда работают только ступени (решения 5 и 6, 22.10.2026). Байты сверяем
    выборочно: в mkv/avi смещение пакета указывает на заголовок блока, а не на
    данные кадра, и браузер получил бы мусор.
    """
    if index["codec_string"] is None:
        return f"кодек {index['codec']}"
    if any(i != n for n, i in enumerate(order)):
        return "B-кадры"
    if not packets[0][1]:
        return "нет опорного в начале"
    if any(p[2] is None or p[2] < 0 for p in packets):
        return "контейнер без смещений"
    try:
        with open(path, "rb") as fh:
            for n, data in probes.items():
                fh.seek(packets[n][2])
                if fh.read(packets[n][3]) != data:
                    return "контейнер не годится"
    except OSError:
        return "файл не читается"
    return None


def _version(index):
    """Отпечаток индекса. Клиент присылает его вместе с планом разметки, и
    сервер отказывается материализовать план, посчитанный по другой таблице
    кадров: разойтись они могут только если ролик подменили, но тогда вся
    разметка указывает не туда."""
    body = f"{index['count']}:{index['pts'][0]}:{index['pts'][-1]}:{index['rate']}"
    return hashlib.sha1(body.encode()).hexdigest()[:16]


def pack_index(index):
    """Ужать таблицу кадров для хранения.

    ``pts`` хранится разностями: подряд идущие кадры отличаются на постоянный
    шаг, и дельты сжимаются в разы лучше абсолютных значений.
    """
    deltas = [index["pts"][i] - index["pts"][i - 1] for i in range(1, index["count"])]
    return {
        "v": 1,
        "version": index["version"],
        "count": index["count"],
        "first_pts": index["pts"][0],
        "deltas": deltas,
        "keys": index["keys"],
        "time_base": index["time_base"],
        "rate": index["rate"],
        "width": index["width"],
        "height": index["height"],
    }


def unpack_index(payload):
    """Развернуть хранимую таблицу обратно. Чужая версия формата — None:
    вызывающий решает, строить ли заново."""
    if not payload or payload.get("v") != 1:
        return None
    pts = [int(payload["first_pts"])]
    for d in payload["deltas"]:
        pts.append(pts[-1] + int(d))
    return {
        "version": payload["version"],
        "count": int(payload["count"]),
        "pts": pts,
        "keys": [int(k) for k in payload["keys"]],
        "time_base": payload["time_base"],
        "rate": payload["rate"],
        "width": payload.get("width"),
        "height": payload.get("height"),
    }


def pack_table(index):
    """Таблица пакетов файла ступени (или оригинала) для хранения.

    Смещения хранятся зазорами между пакетами: у файла без звука это нули, у
    камер со звуком — его куски. Если по Range файл не отдать, пакеты не нужны.
    """
    ok = not index["range_why"]
    pos, sizes = index["pos"], index["sizes"]
    return {
        "v": 1,
        "version": index["version"],
        "count": index["count"],
        "keys": index["keys"],
        "sizes": sizes if ok else None,
        "gaps": ([pos[0]] + [pos[i] - pos[i - 1] - sizes[i - 1] for i in range(1, len(pos))]) if ok else None,
        "codec": index["codec"],
        "codec_string": index["codec_string"],
        "extradata": base64.b64encode(index["extradata"]).decode(),
        "bitrate": index["bitrate"],
        "width": index["width"],
        "height": index["height"],
        "range_why": index["range_why"],
    }


def unpack_table(payload):
    """Развернуть таблицу пакетов: смещения и отрезки считаются здесь один раз."""
    if not payload or payload.get("v") != 1:
        return None
    table = dict(payload)
    if payload.get("sizes") is not None:
        pos, at = [], 0
        for size, gap in zip(payload["sizes"], payload["gaps"]):
            at += gap
            pos.append(at)
            at += size
        table["pos"] = pos
        table["segments"] = segments(table)
        table["by_start"] = {s["start"]: s for s in table["segments"]}
    return table


def segments(table):
    """Отрезки для Range: целые группы кадров от опорного, не короче SEGMENT_FRAMES.

    Короче одной группы отрезок не бывает: разжимать можно только с опорного.
    Номер кадра здесь — номер пакета: по Range отдаём только файлы без B-кадров.
    """
    total, keys = table["count"], table["keys"]
    pos, sizes = table["pos"], table["sizes"]
    out, first = [], 0
    for edge in keys[1:] + [total]:
        if edge - first >= SEGMENT_FRAMES or edge == total:
            last = edge - 1
            out.append({
                "n": len(out), "first": first, "count": edge - first,
                "start": pos[first], "end": pos[last] + sizes[last] - 1,
            })
            first = edge
    return out


def _seek_key(index, frame_no):
    """Опорный кадр на этом месте или левее — отсюда декодер поедет вперёд."""
    best = 0
    for k in index["keys"]:
        if k <= frame_no:
            best = k
        else:
            break
    return best


# --------------------------------------------------------------------------- #
# Где что лежит
# --------------------------------------------------------------------------- #
def variant_path(video_path, quality):
    """Файл ступени рядом с оригиналом."""
    base, _ = os.path.splitext(video_path)
    return f"{base}{VARIANT_PREFIX}{quality}.mp4"


def leftovers(video_path):
    """Всё, что ролик за собой оставил, кроме себя самого.

    Нужен уборке: ступени переживали удаление ролика и оставались на томе
    навсегда, а весили больше исходника.
    """
    base, _ = os.path.splitext(video_path)
    # «_chunks» — перегоны прежней раскладки (до 22.10.2026), у неоткрытых с тех пор роликов.
    dirs = [base + "_chunks", f"{base}_frames"]
    files = [
        f"{base}_strip.jpg",
        # Индекс лежал файлом до переезда в базу; у старых роликов он ещё тут.
        base + "_index.json",
    ]
    files += glob.glob(glob.escape(base + VARIANT_PREFIX) + "*.mp4")
    return dirs, sorted(set(files))


# --------------------------------------------------------------------------- #
# Запись
# --------------------------------------------------------------------------- #
class _Writer:
    """Копия ступени в записи: контейнер, кодек и счётчик кадров."""

    def __init__(self, av, dest, rate, size, params, gop, x264=None):
        # Частота приводится к дроби: время кодека задаётся как 1/rate, и на
        # обычном числе это выходит float, который PyAV не принимает. В бою
        # сюда всегда приходит Fraction из индекса, но падать на целом числе
        # из-за этого незачем.
        rate = Fraction(rate)
        self.dest = dest
        # Имя черновика своё у каждого пишущего: два кодировщика в один файл дают мусор.
        self.tmp = f"{dest}.{os.getpid()}.{threading.get_ident()}.part"
        self.written = 0
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        self.out = av.open(
            self.tmp, "w", format="mp4", options={"movflags": "+faststart"}
        )
        self.stream = self.out.add_stream("libx264", rate=rate)
        self.stream.width, self.stream.height = size
        self.stream.pix_fmt = "yuv420p"
        # Время ставится кодеку, а не дорожке: время дорожки выбирает сам
        # мультиплексор при записи заголовка, и подмена его вручную роняет
        # запись пакетов с «неверным аргументом».
        self.stream.codec_context.time_base = 1 / rate
        options = {
            "crf": params["crf"],
            "preset": params["preset"],
            "g": str(gop),
        }
        if params.get("maxrate"):
            # Качество crf, но не тяжелее оригинала (решение 7, 22.10.2026).
            options["maxrate"] = str(params["maxrate"])
            options["bufsize"] = str(2 * params["maxrate"])
        if x264:
            options["x264-params"] = x264
        self.stream.options = options

    def add(self, frame):
        out_frame = frame.reformat(
            width=self.stream.width, height=self.stream.height, format="yuv420p"
        )
        out_frame.pts = self.written
        out_frame.time_base = self.stream.codec_context.time_base
        # Тип кадра сбрасываем — и это не мелочь, а условие всей схемы.
        # Кадр, декодированный из исходника, помнит, чем он был там. Опорному
        # кадру libx264 верит буквально и делает опорным и в копии, поверх
        # любого keyint: копия наследовала опорные исходника через 50 кадров.
        out_frame.pict_type = "NONE"
        for packet in self.stream.encode(out_frame):
            self.out.mux(packet)
        self.written += 1

    def finish(self):
        for packet in self.stream.encode(None):
            self.out.mux(packet)
        self.out.close()
        os.replace(self.tmp, self.dest)
        return self.written

    def abort(self):
        try:
            self.out.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            if os.path.exists(self.tmp):
                os.remove(self.tmp)
        except OSError:
            pass


def _packets(container, stream):
    """Пакеты дорожки без завершающего флаша.

    Пакет без времени показа — это флаш демуксера, а не кадр: считать его
    кадром значило бы сдвинуть нумерацию на единицу в самом конце ролика.
    """
    for packet in container.demux(stream):
        if packet.pts is None:
            continue
        yield packet


def grab_at(video_path, index, frame_no):
    """Кадр источника по номеру — в разрешении источника и ровно тот самый.

    Адрес берётся из таблицы кадров: у кадра есть своя метка времени, и её
    сравнивают на равенство. Обратный пересчёт номера во время (``no / rate``)
    на дробной частоте 25.033 уводит на соседний кадр, а для полуавтомата это
    значит обводку по чужой картинке — незаметную глазу и потому особенно
    обидную.

    Стоимость — перемотка на ближайший опорный кадр слева и проход вперёд.
    На боевом ролике (1920×1080, 20 минут, опорные через 50) кадр обходится в
    57-91 мс.
    """
    av = _av()
    frame_no = max(0, int(frame_no))
    pts = index.get("pts") or []
    if frame_no >= len(pts):
        raise VideoError(f"В ролике нет кадра {frame_no}.")
    want = pts[frame_no]
    try:
        with open_video(video_path) as container:
            if not container.streams.video:
                raise VideoError("В файле нет видеодорожки.")
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            try:
                container.seek(
                    int(pts[_seek_key(index, frame_no)]),
                    stream=stream, backward=True, any_frame=False,
                )
            except Exception:  # noqa: BLE001
                container.seek(0)
            for frame in container.decode(stream):
                if frame.pts is None:
                    continue
                if frame.pts == want:
                    return frame.to_image()
                if frame.pts > want:
                    break
    except VideoError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise VideoError("Не удалось прочитать кадр.") from exc
    raise VideoError(f"Кадр {frame_no} в ролике не найден.")


# --------------------------------------------------------------------------- #
# Копия ступени
# --------------------------------------------------------------------------- #
def make_variant(video_path, index, quality, dest_path, progress=None, maxrate=None):
    """Полная копия ролика в ступени качества.

    Кадры переписываются один в один: i-й кадр копии — это i-й кадр
    оригинала. Это не удобство, а условие: весь проект адресует кадры
    номерами, и копия, потерявшая или продублировавшая хоть один, увела бы
    разметку на соседний. Поэтому расхождение здесь — исключение, а не
    предупреждение в лог.
    """
    av = _av()
    params = {**_params(quality, index["width"], index["height"]), "maxrate": maxrate}
    rate = Fraction(*index["rate"])
    total = index["count"]
    by_pts = {pts: no for no, pts in enumerate(index["pts"])}

    writer = None
    try:
        writer = _Writer(
            av, dest_path, rate, params["size"], params,
            SEGMENT_FRAMES, x264=_VARIANT_X264,
        )
        with open_video(video_path) as src:
            istream = src.streams.video[0]
            istream.thread_type = "AUTO"
            expected = 0
            for frame in src.decode(istream):
                if frame.pts is None:
                    continue
                frame_no = by_pts.get(frame.pts)
                if frame_no is None:
                    # Кадра нет в индексе — значит индекс от другого файла.
                    continue
                if frame_no != expected:
                    raise VideoError(
                        f"Кадры пришли не по порядку: ждали {expected}, "
                        f"пришёл {frame_no}."
                    )
                writer.add(frame)
                expected += 1
                if progress and expected % SEGMENT_FRAMES == 0:
                    progress(expected, total)
        if expected != total:
            raise UnrecoverableVideoError(
                f"В копии {quality} оказалось {expected} кадров вместо {total}."
            )
        written = writer.finish()
        writer = None
    except VideoError:
        if writer is not None:
            writer.abort()
        raise
    except Exception as exc:  # noqa: BLE001
        if writer is not None:
            writer.abort()
        kind = UnrecoverableVideoError if _is_bad_data(exc) else VideoError
        raise kind(f"Не удалось сделать копию {quality}.") from exc

    if progress:
        progress(total, total)
    return {
        "path": dest_path,
        "count": written,
        "width": params["size"][0],
        "height": params["size"][1],
        "size_bytes": os.path.getsize(dest_path),
    }


# --------------------------------------------------------------------------- #
# Копия на видеокарте
# --------------------------------------------------------------------------- #
# PyAV кодировщика карты не знает — здесь системный ffmpeg (пакет Debian, в нём NVENC и scale_cuda).
FFMPEG = os.environ.get("VIDEO_FFMPEG", "ffmpeg")


def _cq(height, maxrate=None):
    """Качество NVENC — выше, чем у libx264 с _crf, ценой +11-17 % места (замер на voran, 20.10.2026,
    SSIM к оригиналу): 720 на всём 20-минутном ролике — 0,962 против 0,954 (1789 МБ против 1535);
    по 3000 кадров 1080 — 0,978 против 0,976, 480 — 0,939 против 0,933. cq 23 уже хуже x264 (0,950).

    Тяжёлому оригиналу (монтаж 20-26 Мбит/с) — cq 26 (решение 22.10.2026): потолок там не режет, и cq 21
    давал ступени втрое тяжелее x264. 858f67b8, 720p: 1692 → 989 МБ, SSIM лёгкой/тяжёлой минуты 0,978/0,971 → 0,973/0,956.
    """
    if maxrate and maxrate > SOURCE_DEFAULT_BPS:
        return "26"
    return "21" if height >= 720 else "22"


def gpu_ready():
    return shutil.which(FFMPEG) is not None


def _check_aligned(path, total):
    """Копия выровнена: кадров ровно total, опорный через каждые SEGMENT_FRAMES.

    Кадры ffmpeg не видны по одному, как в make_variant, — поэтому сверяем готовый файл.
    Потерянный или лишний кадр увёл бы разметку на соседний, и молча его отдать нельзя.
    """
    av = _av()
    count = 0
    with open_video(path) as container:
        stream = container.streams.video[0]
        for n, packet in enumerate(_packets(container, stream)):
            if n % SEGMENT_FRAMES == 0 and not packet.is_keyframe:
                raise VideoError(f"Копия на карте не выровнена: на кадре {n} нет опорного.")
            count += 1
    if count != total:
        raise VideoError(f"В копии на карте {count} кадров вместо {total}.")


def make_variant_gpu(video_path, index, quality, dest_path, device=0, progress=None, maxrate=None):
    """То же, что make_variant, но разжатие, масштаб и сжатие — на видеокарте. Впятеро быстрее
    (копия 720 двадцатиминутного 1080p — ~40 с против 208) и почти без процессора.

    Любой сбой — VideoError, и вызывающий делает работу по-старому, на процессоре.
    """
    params = _params(quality, index["width"], index["height"])
    w, h = params["size"]
    num, den = index["rate"]
    total = index["count"]
    tmp = f"{dest_path}.{os.getpid()}.{threading.get_ident()}.part"
    # Без явного потолка vbr упирался в свой и держал сходство на 0,957 при любом cq;
    # с 22.10.2026 потолок — битрейт оригинала (решение 7).
    cap = int(maxrate) if maxrate else 60_000_000
    cmd = [
        FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-hwaccel_device", str(device),
        "-i", video_path, "-map", "0:v:0",
        # Время кадра — номер по частоте из таблицы, как у _Writer; passthrough не теряет и не множит кадры.
        "-vf", f"scale_cuda={w}:{h}:format=yuv420p,setpts=N*{den}/{num}/TB",
        "-fps_mode", "passthrough", "-enc_time_base", f"{den}/{num}",
        "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", _cq(h, maxrate), "-b:v", "0",
        "-maxrate", str(cap), "-bufsize", str(2 * cap), "-spatial-aq", "1", "-temporal-aq", "1",
        # Опорный ровно через SEGMENT_FRAMES и без B-кадров — как _VARIANT_X264.
        "-g", str(SEGMENT_FRAMES), "-bf", "0", "-forced-idr", "1", "-no-scenecut", "1", "-strict_gop", "1",
        "-movflags", "+faststart", "-f", "mp4", "-progress", "pipe:1", "-nostats", tmp,
    ]
    # Ошибки — в файл, а не в трубу: битый ролик пишет их на каждый кадр, и полная труба повесила бы ffmpeg.
    with tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True)
        try:
            for line in proc.stdout:
                if progress and line.startswith("frame=") and line[6:].strip().isdigit():
                    progress(int(line[6:]), total)
            if proc.wait() != 0:
                err.seek(0)
                raise VideoError(f"ffmpeg на карте: {err.read().decode(errors='replace').strip()[-300:]}")
            _check_aligned(tmp, total)
            os.replace(tmp, dest_path)
        except BaseException:
            proc.kill()
            proc.wait()
            if os.path.exists(tmp):
                os.remove(tmp)
            raise
    if progress:
        progress(total, total)
    return {"path": dest_path, "count": total, "width": w, "height": h,
            "size_bytes": os.path.getsize(dest_path)}


# --------------------------------------------------------------------------- #
# Манифест
# --------------------------------------------------------------------------- #
def manifest(index):
    """То, что клиент получает при открытии ролика. Отрезки — в таблице каждой ступени."""
    return {
        "version": index["version"],
        "frame_count": index["count"],
        "width": index["width"],
        "height": index["height"],
        "rate": index["rate"],
    }


def frame_ms(index, frame_no):
    """Время кадра в миллисекундах — из его позиции в индексе, не из fps."""
    time_base = Fraction(*index["time_base"])
    offset = index["pts"][frame_no] - index["pts"][0]
    return int(round(float(offset * time_base) * 1000))
