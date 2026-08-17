"""Перегоны: индекс кадров ролика и нарезка его на куски для браузера.

Раньше кадр приезжал в браузер картинкой: сервер декодировал JPEG и отдавал по
номеру. На ролике 2688×1520 один прогрев окна ±120 кадров стоил около 120 МБ —
вшестеро больше, чем весит весь ролик. Теперь клиент получает **перегон**:
кусок видео в 120 кадров, перекодированный в H.264, и разжимает его сам.

Две вещи делают это безопасным.

**Индекс.** При загрузке ролик проходится демуксером — читаются заголовки
пакетов, картинка не разжимается, на часовом видео это доли секунды. Отсюда
берётся точное число кадров (``stream.frames`` врёт или молчит), позиция
каждого кадра во времени и список опорных кадров, по которым перематывают.
Индекс живёт файлом рядом с роликом: девяносто тысяч чисел в строке БД никому
не нужны — они не ищутся, не соединяются и читаются только целиком.

**Номер кадра — не вычисление, а объявление.** Перегон отдаётся вместе с тем,
какие кадры в нём лежат. Клиент не считает номер ни из времени, ни из
арифметики по номеру перегона: i-й разжатый кадр есть ``frames[i]``, и точка.
Кадр приходит из индекса, и материализация потом достаёт из исходника кадр с
тем же номером. Иначе на дробной частоте (у первого же реального ролика она
25.033) две арифметики разъезжаются, и в датасет уходит соседний кадр.
"""
import hashlib
import json
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
# Замер на 2688×1520, перегон 120 кадров: исходное — 5.9 с и 2.7 МБ, половина
# стороны — 2.3 с и 0.76 МБ. Поэтому по умолчанию берётся ступень поменьше, а
# исходное готовится, только если его попросили.
LADDER = [1080, 720, 540, 360]
SOURCE = "src"
DEFAULT_QUALITY = "720"

# Чем меньше картинка, тем слабее жмём: на 360 артефакты видны сильнее, а
# весит она всё равно копейки.
def _crf(height):
    if height is None:
        return "20"
    if height >= 1080:
        return "22"
    if height >= 540:
        return "26"
    return "28"


def qualities(width, height):
    """Что можно предложить для этого ролика: исходное и ступени ниже него."""
    out = [{"id": SOURCE, "label": "Исходное", "height": height}]
    for step in LADDER:
        if height and step < height:
            out.append({"id": str(step), "label": f"{step}p", "height": step})
    return out


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


INDEX_SUFFIX = "_index.json"
CHUNKS_SUFFIX = "_chunks"


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

    return {
        "count": len(pts),
        "pts": pts,
        "keys": keys,
        "time_base": [time_base.numerator, time_base.denominator],
        "rate": [rate.numerator, rate.denominator],
        "width": width,
        "height": height,
    }


def index_path(video_path):
    base, _ = os.path.splitext(video_path)
    return base + INDEX_SUFFIX


def _version(index):
    """Отпечаток индекса. Клиент присылает его вместе с планом разметки, и
    сервер отказывается материализовать план, посчитанный по другой таблице
    кадров: разойтись они могут только если ролик подменили, но тогда вся
    разметка указывает не туда."""
    body = f"{index['count']}:{index['pts'][0]}:{index['pts'][-1]}:{index['rate']}"
    return hashlib.sha1(body.encode()).hexdigest()[:16]


def save_index(video_path, index):
    """Записать индекс рядом с роликом.

    ``pts`` хранится разностями: подряд идущие кадры отличаются на постоянный
    шаг, и дельты сжимаются в разы лучше абсолютных значений.
    """
    deltas = [index["pts"][i] - index["pts"][i - 1] for i in range(1, index["count"])]
    payload = {
        "v": 1,
        "version": _version(index),
        "count": index["count"],
        "first_pts": index["pts"][0],
        "deltas": deltas,
        "keys": index["keys"],
        "time_base": index["time_base"],
        "rate": index["rate"],
        "width": index["width"],
        "height": index["height"],
    }
    dest = index_path(video_path)
    tmp = dest + ".part"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    os.replace(tmp, dest)
    return payload["version"]


def load_index(video_path):
    """Прочитать индекс. Нет файла — None: вызывающий решает, строить ли заново."""
    path = index_path(video_path)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, ValueError):
        return None
    if payload.get("v") != 1:
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


def ensure_index(video_path):
    """Индекс ролика: с диска, а если его там нет — построить и положить."""
    index = load_index(video_path)
    if index is not None:
        return index
    built = build_index(video_path)
    built["version"] = save_index(video_path, built)
    return built


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
# Где лежат перегоны
# --------------------------------------------------------------------------- #
def chunks_dir(video_path, quality=DEFAULT_QUALITY):
    base, _ = os.path.splitext(video_path)
    return os.path.join(base + CHUNKS_SUFFIX, quality)


def chunk_path(video_path, chunk_no, quality=DEFAULT_QUALITY):
    return os.path.join(chunks_dir(video_path, quality), f"{int(chunk_no)}.mp4")


class _Writer:
    """Один перегон в записи: контейнер, кодек и счётчик кадров."""

    def __init__(self, av, dest, rate, size, params, gop):
        self.dest = dest
        # Имя черновика своё у каждого пишущего. Один и тот же перегон могут
        # резать одновременно двое: фоновая нарезка после загрузки и запрос
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
        self.stream.options = {
            "crf": params["crf"],
            "preset": params["preset"],
            # Перегон целиком — одна группа кадров: опорный только первый,
            # остальные ссылочные. Внутрь перегона никто не перематывает, он
            # разжимается целиком.
            "g": str(gop),
        }

    def add(self, frame):
        out_frame = frame.reformat(
            width=self.stream.width, height=self.stream.height, format="yuv420p"
        )
        out_frame.pts = self.written
        out_frame.time_base = self.stream.codec_context.time_base
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
        if os.path.exists(self.tmp):
            os.remove(self.tmp)


# --------------------------------------------------------------------------- #
# Нарезка
# --------------------------------------------------------------------------- #
def cut_all(video_path, index, quality=DEFAULT_QUALITY, progress=None, skip_existing=False):
    """Нарезать ролик на перегоны целиком, одним проходом декодера.

    Перегоны готовятся сразу после загрузки, фоновой задачей: разметчик потом
    не ждёт нигде и никогда, а диск это стоит меньше самого ролика. Проход
    один, потому что подряд идущие кадры декодируются на порядок дешевле, чем
    добытые по одному с перемоткой.
    """
    av = _av()
    params = _params(quality, index["width"], index["height"])
    size = params["size"]
    rate = Fraction(*index["rate"])
    total = index["count"]
    by_pts = {pts: no for no, pts in enumerate(index["pts"])}

    writer = None
    current = -1
    made = 0
    try:
        with av.open(video_path) as src:
            istream = src.streams.video[0]
            istream.thread_type = "AUTO"
            for frame in src.decode(istream):
                if frame.pts is None:
                    continue
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
                    dest = chunk_path(video_path, chunk_no, quality)
                    if skip_existing and os.path.exists(dest):
                        # Этот перегон уже нарезан — например, его успели
                        # попросить. Декодировать всё равно надо (кадры идут
                        # потоком), а перекодировать заново незачем.
                        writer = None
                        continue
                    first, last = chunk_bounds(chunk_no, total)
                    writer = _Writer(
                        av, chunk_path(video_path, chunk_no, quality),
                        rate, size, params, last - first + 1,
                    )
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


def cut_chunk(video_path, index, chunk_no, quality=DEFAULT_QUALITY):
    """Один перегон — для «резкости» и для починки, если файл потерялся.

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
    dest = chunk_path(video_path, chunk_no, quality)

    wanted = {index["pts"][n] for n in range(first, last + 1)}
    stop_pts = index["pts"][last]
    writer = _Writer(av, dest, rate, size, params, want)
    try:
        with av.open(video_path) as src:
            istream = src.streams.video[0]
            istream.thread_type = "AUTO"
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
    except Exception as exc:  # noqa: BLE001
        writer.abort()
        raise VideoError(f"Не удалось нарезать перегон: {exc}") from exc

    if written != want:
        if os.path.exists(dest):
            os.remove(dest)
        raise VideoError(
            f"В перегоне {chunk_no} оказалось {written} кадров вместо {want}."
        )
    return {"first": first, "count": want, "path": dest}


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


def ready_count(video_path, total_chunks, quality=DEFAULT_QUALITY):
    """Сколько перегонов этой ступени уже лежит на диске."""
    return sum(
        1 for n in range(total_chunks)
        if os.path.exists(chunk_path(video_path, n, quality))
    )
