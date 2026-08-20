"""Таблица кадров ролика: хранение в базе и кэш в памяти процесса.

Раньше таблица лежала файлом рядом с роликом, и довод был верный: девяносто
тысяч чисел в строке БД не ищутся и не соединяются. Но читалась она на каждый
запрос перегона — файл с тома, разбор JSON, разворот дельт в полный список, —
и на часовом ролике это стоило десятков миллисекунд в потоке, который в это
время не отвечал никому другому.

Теперь хранение и чтение разведены. Хранит база: ролик и его таблица кадров
переезжают и удаляются вместе, а том перестаёт быть носителем состояния.
Читает кэш: развёрнутая таблица живёт в процессе и переживает любое число
запросов. Ключ кэша — отпечаток таблицы, поэтому подменённый ролик не может
получить чужие номера кадров: у него другой отпечаток и другая запись.
"""
import json
import os
import threading
from collections import OrderedDict

from datasets_svc import video_chunks as chunklib

# Сколько развёрнутых таблиц держим. Часовой ролик — это около 90 000 чисел,
# примерно 3-4 МБ в памяти; восьми хватает, чтобы бригада разметчиков ходила
# по своим роликам, не выбивая друг друга из кэша.
CACHE_SIZE = int(os.environ.get("VIDEO_INDEX_CACHE", "8"))

_cache = OrderedDict()
_guard = threading.Lock()


def _remember(key, index):
    with _guard:
        _cache[key] = index
        _cache.move_to_end(key)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)


def _recall(key):
    with _guard:
        index = _cache.get(key)
        if index is not None:
            _cache.move_to_end(key)
        return index


def forget(video_id):
    """Убрать из кэша всё про этот ролик — при удалении и при пересборке."""
    with _guard:
        for key in [k for k in _cache if k[0] == str(video_id)]:
            _cache.pop(key, None)


def _legacy_file(video_path):
    """Таблица роликов, загруженных до переезда в базу."""
    base, _ = os.path.splitext(video_path)
    path = base + "_index.json"
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def get(db, video, video_path=None):
    """Развёрнутая таблица кадров ролика или None, если её ещё не построили.

    Строить здесь нельзя: это минуты на большом файле, а вызывают отсюда
    обработчики запросов. Построение — работа воркера (``ensure``).
    """
    key = (str(video.id), video.index_version or "")
    if video.index_version:
        cached = _recall(key)
        if cached is not None:
            return cached

    payload = video.frame_index
    if payload is None and video_path:
        # Ролик из тех, что старше переезда: подбираем таблицу с тома и
        # переселяем в базу, чтобы больше к файлу не возвращаться.
        payload = _legacy_file(video_path)
        if payload is not None:
            video.frame_index = payload
            video.frame_count = int(payload.get("count") or 0) or video.frame_count
            video.index_version = payload.get("version") or video.index_version
            db.commit()
            key = (str(video.id), video.index_version or "")

    index = chunklib.unpack_index(payload)
    if index is None:
        return None
    _remember(key, index)
    return index


def store(db, video, index):
    """Записать таблицу и всё, что из неё следует, одной транзакцией."""
    video.frame_index = chunklib.pack_index(index)
    video.frame_count = index["count"]
    video.index_version = index["version"]
    db.commit()
    forget(video.id)
    _remember((str(video.id), index["version"]), index)
    return index


def ensure(db, video, video_path):
    """Таблица кадров: из базы, а если её там нет — построить и положить.

    Зовётся из воркера: демукс большого файла — это секунды, и в обработчике
    запроса им не место.
    """
    index = get(db, video, video_path)
    if index is not None:
        return index
    if not os.path.exists(video_path):
        raise chunklib.VideoError("Файл видео не найден.")
    return store(db, video, chunklib.build_index(video_path))
