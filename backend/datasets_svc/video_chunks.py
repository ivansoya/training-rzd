"""Перегоны: индекс кадров ролика, ступени качества и нарезка на куски.

Раньше кадр приезжал в браузер картинкой: сервер декодировал JPEG и отдавал по
номеру. На ролике 2688×1520 один прогрев окна ±120 кадров стоил около 120 МБ —
вшестеро больше, чем весит весь ролик. Теперь клиент получает **перегон**:
кусок видео в 120 кадров, перекодированный в H.264, и разжимает его сам.

Три вещи делают это безопасным и дешёвым.

**Индекс.** При загрузке ролик проходится демуксером — читаются заголовки
пакетов, картинка не разжимается, на часовом видео это доли секунды. Отсюда
берётся точное число кадров (``stream.frames`` врёт или молчит), позиция
каждого кадра во времени и список опорных кадров, по которым перематывают.

**Номер кадра — не вычисление, а объявление.** Перегон отдаётся вместе с тем,
какие кадры в нём лежат. Клиент не считает номер ни из времени, ни из
арифметики по номеру перегона: i-й разжатый кадр есть ``frames[i]``, и точка.
Кадр приходит из индекса, и материализация потом достаёт из исходника кадр с
тем же номером. Иначе на дробной частоте (у первого же реального ролика она
25.033) две арифметики разъезжаются, и в датасет уходит соседний кадр.

**Ступень качества — это файл, а не режим кодирования.** Из оригинала фоном
делаются полные копии 1080p, 720p и 480p, и опорный кадр в копии стоит ровно
на границе каждого перегона. Тогда перегон вырезается из копии
перекладыванием пакетов — без разжатия и сжатия заново, за миллисекунды.
Перекодировать приходится только «Исходное», и только когда его попросили.

Модуль ничего не знает ни про базу, ни про Flask: на вход пути и словари, на
выход пути и словари. Хранением занимаются ``video_index`` и ``video_queue``,
а порядком работ — ``worker``.
"""
import hashlib
import os
import threading
from fractions import Fraction

# Кадров в перегоне. На 25 к/с это около пяти секунд: прыжок в произвольное
# место стоит одной загрузки, а держать перегон разжатым всё равно нельзя —
# 120 кадров 2688×1520 это 735 МБ, поэтому клиент разжимает окно вокруг курсора.
CHUNK_FRAMES = 120

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

# Копия ступени пишется так, чтобы опорный кадр стоял ровно на границе каждого
# перегона, а B-кадров не было вовсе. Первое даёт нарезку перекладыванием
# пакетов; второе делает порядок разжатия равным порядку показа, и n-й пакет
# копии — это ровно n-й кадр ролика, без разбора таблицы времён.
_VARIANT_X264 = (
    f"keyint={CHUNK_FRAMES}:min-keyint={CHUNK_FRAMES}:scenecut=0:bframes=0"
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


def qualities(width, height):
    """Что можно предложить для этого ролика: исходное и ступени ниже него."""
    out = [{"id": SOURCE, "label": "Исходное", "height": height}]
    for step in LADDER:
        if height and step < height:
            out.append({"id": str(step), "label": f"{step}p", "height": step})
    return out


def ladder_for(height):
    """Ступени, которые имеет смысл готовить фоном. Исходного среди них нет:
    оно и есть оригинал, копировать его незачем."""
    return [str(step) for step in LADDER if height and step < height]


def known(quality, height):
    return any(q["id"] == quality for q in qualities(None, height))


def default_for(height):
    """Ступень по умолчанию. На маленьком ролике её может не быть вовсе —
    тогда исходное и есть самое малое, что мы умеем."""
    return DEFAULT_QUALITY if known(DEFAULT_QUALITY, height) else SOURCE


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


CHUNKS_SUFFIX = "_chunks"
VARIANT_PREFIX = "_v"


class VideoError(Exception):
    pass


def _av():
    try:
        import av
    except ImportError as exc:  # noqa: BLE001
        raise VideoError("Обработка видео недоступна на сервере.") from exc
    return av


# --------------------------------------------------------------------------- #
# Индекс
# --------------------------------------------------------------------------- #
def build_index(path):
    """Пройти ролик демуксером и составить таблицу кадров.

    Демуксинг — не декодирование: читаются только заголовки пакетов, поэтому
    полный проход по часовому видео стоит доли секунды, а не минуты. Взамен
    получаем то, чего не даёт ни один быстрый способ: точное число кадров.

    Пакеты приходят в порядке декодирования, а нумеруем мы в порядке показа —
    при B-кадрах это разные порядки, поэтому сортируем по ``pts``.
    """
    av = _av()
    try:
        with av.open(path) as container:
            if not container.streams.video:
                raise VideoError("В файле нет видеодорожки.")
            stream = container.streams.video[0]
            time_base = stream.time_base
            rate = stream.average_rate
            width = stream.codec_context.width
            height = stream.codec_context.height
            if not time_base or not rate:
                raise VideoError(
                    "В видео нет частоты кадров — размечать его покадрово нельзя."
                )

            marks = []
            for packet in container.demux(stream):
                # Демукс завершается пустым пакетом-флашем: у него нет времени
                # и он не кадр.
                stamp = packet.pts if packet.pts is not None else packet.dts
                if stamp is None:
                    continue
                marks.append((int(stamp), bool(packet.is_keyframe)))
    except VideoError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise VideoError(f"Не удалось прочитать видео: {exc}") from exc

    if not marks:
        raise VideoError("В видео не нашлось ни одного кадра.")

    marks.sort(key=lambda m: m[0])
    pts = [m[0] for m in marks]
    keys = [i for i, m in enumerate(marks) if m[1]]
    # Опорный кадр в начале обязан быть: перемотка ищет ближайший слева, и без
    # нулевого ей некуда встать.
    if not keys or keys[0] != 0:
        keys.insert(0, 0)

    index = {
        "count": len(pts),
        "pts": pts,
        "keys": keys,
        "time_base": [time_base.numerator, time_base.denominator],
        "rate": [rate.numerator, rate.denominator],
        "width": width,
        "height": height,
    }
    index["version"] = _version(index)
    return index


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


# --------------------------------------------------------------------------- #
# Границы перегонов
# --------------------------------------------------------------------------- #
def chunk_count(frame_count):
    return max(1, (int(frame_count) + CHUNK_FRAMES - 1) // CHUNK_FRAMES)


def chunk_bounds(chunk_no, frame_count):
    """Первый и последний кадр перегона включительно."""
    first = int(chunk_no) * CHUNK_FRAMES
    if first >= frame_count:
        raise VideoError("Такого перегона в ролике нет.")
    return first, min(first + CHUNK_FRAMES, int(frame_count)) - 1


def chunk_of(frame_no):
    return max(0, int(frame_no)) // CHUNK_FRAMES


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
def chunks_dir(video_path, quality=DEFAULT_QUALITY):
    base, _ = os.path.splitext(video_path)
    return os.path.join(base + CHUNKS_SUFFIX, quality)


def chunk_path(video_path, chunk_no, quality=DEFAULT_QUALITY):
    return os.path.join(chunks_dir(video_path, quality), f"{int(chunk_no)}.mp4")


def variant_path(video_path, quality):
    """Полная копия ступени рядом с оригиналом."""
    base, _ = os.path.splitext(video_path)
    return f"{base}{VARIANT_PREFIX}{quality}.mp4"


def leftovers(video_path):
    """Всё, что ролик за собой оставил, кроме себя самого.

    Нужен уборке: перегоны и копии переживали удаление ролика и оставались на
    томе навсегда, а весят они больше исходника.
    """
    base, _ = os.path.splitext(video_path)
    dirs = [base + CHUNKS_SUFFIX, f"{base}_frames"]
    files = [
        f"{base}_strip.jpg",
        # Индекс лежал файлом до переезда в базу; у старых роликов он ещё тут.
        base + "_index.json",
    ]
    files += [variant_path(video_path, str(step)) for step in LADDER]
    return dirs, sorted(set(files))


# --------------------------------------------------------------------------- #
# Запись
# --------------------------------------------------------------------------- #
class _Writer:
    """Один перегон или одна копия в записи: контейнер, кодек и счётчик кадров."""

    def __init__(self, av, dest, rate, size, params, gop, x264=None):
        # Частота приводится к дроби: время кодека задаётся как 1/rate, и на
        # обычном числе это выходит float, который PyAV не принимает. В бою
        # сюда всегда приходит Fraction из индекса, но падать на целом числе
        # из-за этого незачем.
        rate = Fraction(rate)
        self.dest = dest
        # Имя черновика своё у каждого пишущего. Один и тот же перегон могут
        # резать одновременно двое: фоновая нарезка ступени и запрос
        # редактора, добравшегося до этого места раньше неё. С общим именем
        # два кодировщика писали бы в один файл, и на выходе получался бы
        # мусор — перемежающиеся куски двух видео.
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
            # Перегон целиком — одна группа кадров: опорный только первый,
            # остальные ссылочные. Внутрь перегона никто не перематывает, он
            # разжимается целиком.
            "g": str(gop),
        }
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
        # любого keyint. У первого же реального ролика опорные стояли через
        # 50 кадров, копия наследовала их все, границы перегонов не совпадали
        # с опорными — и вместо перекладывания пакетов за миллисекунды каждый
        # перегон резался перекодированием по десять секунд.
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


class _Remuxer:
    """Перегон, собранный перекладыванием пакетов копии — без кодирования."""

    def __init__(self, av, dest, template):
        self.dest = dest
        self.tmp = f"{dest}.{os.getpid()}.{threading.get_ident()}.part"
        self.written = 0
        self.base_pts = None
        self.base_dts = None
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        self.out = av.open(
            self.tmp, "w", format="mp4", options={"movflags": "+faststart"}
        )
        try:
            self.stream = self.out.add_stream_from_template(template)
        except AttributeError:  # PyAV до 12-й
            self.stream = self.out.add_stream(template=template)

    def add(self, packet):
        # Время перегона начинается с нуля: браузер получает самостоятельный
        # файл, а не кусок с чужими метками.
        if self.base_pts is None:
            self.base_pts = packet.pts
            self.base_dts = packet.dts if packet.dts is not None else packet.pts
        packet.pts = packet.pts - self.base_pts
        if packet.dts is not None:
            packet.dts = packet.dts - self.base_dts
        packet.stream = self.stream
        self.out.mux(packet)
        self.written += 1

    def finish(self):
        self.out.close()
        os.replace(self.tmp, self.dest)
        return self.written

    abort = _Writer.abort


def _packets(container, stream):
    """Пакеты дорожки без завершающего флаша.

    Пакет без времени показа — это флаш демуксера, а не кадр: считать его
    кадром значило бы сдвинуть нумерацию на единицу в самом конце ролика.
    """
    for packet in container.demux(stream):
        if packet.pts is None:
            continue
        yield packet


def grab_in(path, local_no):
    """Кадр по порядку внутри готового файла — обычно внутри перегона.

    Перегон это 120 кадров одной группой, поэтому «достать пятый» стоит
    разжатия шести. Из двадцатиминутного исходника тот же кадр стоил бы
    перемотки и декодирования от ближайшего опорного, а их там негусто.
    """
    av = _av()
    try:
        with av.open(path) as container:
            if not container.streams.video:
                raise VideoError("В файле нет видеодорожки.")
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            seen = 0
            for frame in container.decode(stream):
                if frame.pts is None:
                    continue
                if seen == local_no:
                    return frame.to_image()
                seen += 1
    except VideoError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise VideoError(f"Не удалось прочитать кадр: {exc}") from exc
    raise VideoError(f"В файле нет кадра {local_no}.")


def grab_at(video_path, index, frame_no):
    """Кадр источника по номеру — в разрешении источника и ровно тот самый.

    Адрес берётся из таблицы кадров: у кадра есть своя метка времени, и её
    сравнивают на равенство. Обратный пересчёт номера во время (``no / rate``)
    на дробной частоте 25.033 уводит на соседний кадр, а для полуавтомата это
    значит обводку по чужой картинке — незаметную глазу и потому особенно
    обидную.

    Стоимость — перемотка на ближайший опорный кадр слева и проход вперёд.
    Опорные в исходнике стоят как поставил его кодировщик: на боевом ролике
    (1920×1080, 20 минут) они идут через 50 кадров, и кадр обходится в 57-91 мс
    — вровень с вырезкой из готового перегона. Дорого выйдет там, где опорные
    редки, и это единственное, ради чего стоит держать перегоны ступени `src`.
    """
    av = _av()
    frame_no = max(0, int(frame_no))
    pts = index.get("pts") or []
    if frame_no >= len(pts):
        raise VideoError(f"В ролике нет кадра {frame_no}.")
    want = pts[frame_no]
    try:
        with av.open(video_path) as container:
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
        raise VideoError(f"Не удалось прочитать кадр: {exc}") from exc
    raise VideoError(f"Кадр {frame_no} в ролике не найден.")


def frame_count_of(path):
    """Сколько кадров в готовом файле. Считаем пакеты: разжимать незачем."""
    av = _av()
    try:
        with av.open(path) as container:
            if not container.streams.video:
                return 0
            stream = container.streams.video[0]
            return sum(1 for _ in _packets(container, stream))
    except Exception:  # noqa: BLE001
        return 0


# --------------------------------------------------------------------------- #
# Копия ступени
# --------------------------------------------------------------------------- #
def make_variant(video_path, index, quality, dest_path, progress=None):
    """Полная копия ролика в ступени качества.

    Кадры переписываются один в один: i-й кадр копии — это i-й кадр
    оригинала. Это не удобство, а условие: весь проект адресует кадры
    номерами, и копия, потерявшая или продублировавшая хоть один, увела бы
    разметку на соседний. Поэтому расхождение здесь — исключение, а не
    предупреждение в лог.
    """
    av = _av()
    if quality == SOURCE:
        raise VideoError("У исходного качества копии нет — это сам ролик.")
    params = _params(quality, index["width"], index["height"])
    rate = Fraction(*index["rate"])
    total = index["count"]
    by_pts = {pts: no for no, pts in enumerate(index["pts"])}

    writer = None
    try:
        writer = _Writer(
            av, dest_path, rate, params["size"], params,
            CHUNK_FRAMES, x264=_VARIANT_X264,
        )
        with av.open(video_path) as src:
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
                if progress and expected % CHUNK_FRAMES == 0:
                    progress(expected, total)
        if expected != total:
            raise VideoError(
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
        raise VideoError(f"Не удалось сделать копию {quality}: {exc}") from exc

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
# Нарезка перекладыванием: из готовой копии
# --------------------------------------------------------------------------- #
def _close_chunk(writer, chunk_no, total):
    """Дописать перегон и сверить, сколько в него легло.

    Перекладывание пакетов дешевле перекодирования на порядок, и именно
    поэтому его надо проверять: ошибка здесь не падает, а тихо отдаёт перегон
    не с тем числом кадров — то есть бокс на чужом кадре.
    """
    first, last = chunk_bounds(chunk_no, total)
    want = last - first + 1
    written = writer.written
    if written != want:
        writer.abort()
        raise VideoError(
            f"В перегоне {chunk_no} оказалось {written} кадров вместо {want}."
        )
    writer.finish()


def cut_from_variant(variant_path_, total, dest_for, only=None, progress=None):
    """Разложить копию на перегоны, перекладывая пакеты.

    Копия писалась с опорным кадром на границе каждого перегона и без
    B-кадров, поэтому n-й пакет — это ровно n-й кадр, а граница перегона — это
    точка, с которой файл можно начать. Разжимать и сжимать заново нечего.

    Выравнивание проверяется, а не предполагается: не оказалось опорного кадра
    на границе — отказываемся, и вызывающий доделает перекодированием. Молча
    отдать перегон, который браузер не сможет начать с начала, нельзя.
    """
    av = _av()
    made = 0
    writer = None
    current = -1
    try:
        with av.open(variant_path_) as src:
            istream = src.streams.video[0]
            for n, packet in enumerate(_packets(src, istream)):
                chunk_no = n // CHUNK_FRAMES
                if only is not None and chunk_no > only:
                    break
                if chunk_no != current:
                    if writer is not None:
                        _close_chunk(writer, current, total)
                        made += 1
                        writer = None
                    current = chunk_no
                    if only is not None and chunk_no != only:
                        continue
                    if not packet.is_keyframe:
                        raise VideoError(
                            f"Копия не выровнена: на кадре {n} нет опорного."
                        )
                    writer = _Remuxer(av, dest_for(chunk_no), istream)
                if writer is not None:
                    writer.add(packet)
                if progress and n and n % CHUNK_FRAMES == 0:
                    progress(n, total)
            if writer is not None:
                _close_chunk(writer, current, total)
                made += 1
                writer = None
    except VideoError:
        if writer is not None:
            writer.abort()
        raise
    except Exception as exc:  # noqa: BLE001
        if writer is not None:
            writer.abort()
        raise VideoError(f"Не удалось разложить копию на перегоны: {exc}") from exc

    if progress:
        progress(total, total)
    return made


# --------------------------------------------------------------------------- #
# Нарезка перекодированием: из оригинала или из копии
# --------------------------------------------------------------------------- #
def cut_all(video_path, index, quality, dest_for, progress=None,
            skip_existing=False, positional=False):
    """Нарезать ролик на перегоны целиком, одним проходом декодера.

    Путь для «Исходного» и запасной для всего остального: перекладывание
    пакетов дешевле на порядок, но оно требует выровненной копии, а её может
    не оказаться.

    ``positional`` — кадры считаются по порядку, а не ищутся в таблице времён.
    Так режут копию: она писалась нами и заведомо содержит все кадры подряд.
    """
    av = _av()
    params = _params(quality, index["width"], index["height"])
    size = params["size"]
    rate = Fraction(*index["rate"])
    total = index["count"]
    by_pts = None if positional else {pts: no for no, pts in enumerate(index["pts"])}

    writer = None
    current = -1
    made = 0
    seen = 0
    try:
        with av.open(video_path) as src:
            istream = src.streams.video[0]
            istream.thread_type = "AUTO"
            for frame in src.decode(istream):
                if frame.pts is None:
                    continue
                if by_pts is None:
                    frame_no = seen
                    seen += 1
                else:
                    frame_no = by_pts.get(frame.pts)
                    if frame_no is None:
                        # Кадра нет в индексе — значит индекс от другого файла.
                        continue
                chunk_no = frame_no // CHUNK_FRAMES
                if chunk_no != current:
                    if writer is not None:
                        writer.finish()
                        made += 1
                    current = chunk_no
                    dest = dest_for(chunk_no)
                    if skip_existing and os.path.exists(dest):
                        # Этот перегон уже нарезан — например, его успели
                        # попросить. Декодировать всё равно надо (кадры идут
                        # потоком), а перекодировать заново незачем.
                        writer = None
                        continue
                    first, last = chunk_bounds(chunk_no, total)
                    writer = _Writer(av, dest, rate, size, params, last - first + 1)
                if writer is not None:
                    writer.add(frame)
                if progress and frame_no % CHUNK_FRAMES == 0:
                    progress(frame_no, total)
            if writer is not None:
                writer.finish()
                writer = None
                made += 1
    except Exception as exc:  # noqa: BLE001
        if writer is not None:
            writer.abort()
        raise VideoError(f"Не удалось нарезать ролик на перегоны: {exc}") from exc

    if progress:
        progress(total, total)
    return made


def cut_chunk(video_path, index, chunk_no, quality, dest, positional=False):
    """Один перегон перекодированием — для «Исходного» и для починки.

    Декодер перематывается на ближайший опорный кадр слева и крутится вперёд:
    кадры до начала перегона нужны, чтобы восстановить ссылочные, но в перегон
    не идут.
    """
    av = _av()
    params = _params(quality, index["width"], index["height"])
    size = params["size"]
    rate = Fraction(*index["rate"])
    first, last = chunk_bounds(chunk_no, index["count"])
    want = last - first + 1

    writer = None
    try:
        writer = _Writer(av, dest, rate, size, params, want)
        with av.open(video_path) as src:
            istream = src.streams.video[0]
            istream.thread_type = "AUTO"
            if positional:
                # Копия наша, кадры в ней подряд: перематываем на начало и
                # считаем. Опорные в копии стоят на границах перегонов, так
                # что перемотка всё равно попала бы туда же.
                seen = 0
                for frame in src.decode(istream):
                    if frame.pts is None:
                        continue
                    if seen > last:
                        break
                    if seen >= first:
                        writer.add(frame)
                    seen += 1
            else:
                wanted = {index["pts"][n] for n in range(first, last + 1)}
                stop_pts = index["pts"][last]
                try:
                    src.seek(
                        int(index["pts"][_seek_key(index, first)]),
                        stream=istream, backward=True, any_frame=False,
                    )
                except Exception:  # noqa: BLE001
                    src.seek(0)
                for frame in src.decode(istream):
                    if frame.pts is None:
                        continue
                    if frame.pts in wanted:
                        writer.add(frame)
                    if frame.pts >= stop_pts:
                        break
        written = writer.finish()
        writer = None
    except VideoError:
        if writer is not None:
            writer.abort()
        raise
    except Exception as exc:  # noqa: BLE001
        if writer is not None:
            writer.abort()
        raise VideoError(f"Не удалось нарезать перегон: {exc}") from exc

    if written != want:
        try:
            os.remove(dest)
        except OSError:
            pass
        raise VideoError(
            f"В перегоне {chunk_no} оказалось {written} кадров вместо {want}."
        )
    return {"first": first, "count": want, "path": dest}


# --------------------------------------------------------------------------- #
# Манифест
# --------------------------------------------------------------------------- #
def manifest(index):
    """То, что клиент получает при открытии ролика.

    Перечень перегонов отдаётся явно, а не правилом «номер × 120»: клиент не
    должен вычислять номера кадров вообще, ни здесь, ни при разжатии.
    """
    total = index["count"]
    chunks = []
    for n in range(chunk_count(total)):
        first, last = chunk_bounds(n, total)
        chunks.append({"n": n, "first": first, "count": last - first + 1})
    return {
        "version": index["version"],
        "qualities": qualities(index["width"], index["height"]),
        "default_quality": default_for(index["height"]),
        "frame_count": total,
        "width": index["width"],
        "height": index["height"],
        "rate": index["rate"],
        "chunk_frames": CHUNK_FRAMES,
        "chunks": chunks,
    }


def frame_ms(index, frame_no):
    """Время кадра в миллисекундах — из его позиции в индексе, не из fps."""
    time_base = Fraction(*index["time_base"])
    offset = index["pts"][frame_no] - index["pts"][0]
    return int(round(float(offset * time_base) * 1000))
