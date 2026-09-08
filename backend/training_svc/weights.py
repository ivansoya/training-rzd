"""Предобученные веса YOLO: один раз скачать, положить на том, проверить.

Встроенные модели теперь всегда предобученные. До 08.09.2026 бегун делал
``YOLO("yolo11n.yaml")`` — это сеть по описанию, со случайными весами, и
``pretrained: true`` в args.yaml при этом ничего не значил: ultralytics
подгружает веса только по пути, который кончается на ``.pt``. Стоэпоховое
обучение на 9 000 кадров с такого старта давало mAP50 0,64 и переобучалось
с десятой эпохи.

Веса живут на томе, в ``_weights/``, а не в образе и не в рабочей папке:
образ не пухнет, файл переживает пересборку, а ultralytics не тянет его
заново в каждую папку, откуда его позвали.

Качаем сами, а не через ultralytics: его загрузчик длину с сервером не
сверяет, и обрыв после первых килобайт лёг бы на том под настоящим именем —
ровно та беда, что уже случилась с DINOv2 (см. embed.py). Здесь длина
сверяется, файл пишется в ``.part`` с докачкой по ``Range`` и
переименовывается только после проверки.

Ручной путь, если сети нет: положить файл в ``yolo-data/_weights/<имя>``.
Текст ошибки это и говорит.
"""
import os
import urllib.error
import urllib.request

from common import config

WEIGHTS_DIR = os.path.join(config.DATA_DIR, "_weights")
# Релиз с весами. Один на все семейства: ultralytics 8.4 кладёт yolov8,
# yolo11 и yolo26 в один и тот же выпуск.
ASSETS_URL = os.environ.get(
    "YOLO_WEIGHTS_URL",
    "https://github.com/ultralytics/assets/releases/download/v8.4.0/",
)
CHUNK = 1 << 20
TIMEOUT = 60
# Меньше этого настоящих весов не бывает: даже yolo26n — пять мегабайт.
MIN_BYTES = 1 << 20


class WeightsUnavailable(RuntimeError):
    """Скачать не вышло и на томе файла нет."""


def path_of(name):
    return os.path.join(WEIGHTS_DIR, os.path.basename(name))


def is_cached(name):
    path = path_of(name)
    return os.path.isfile(path) and os.path.getsize(path) >= MIN_BYTES


def looks_like_checkpoint(path):
    """Файл .pt — это zip: первые два байта «PK». Страница-заглушка от
    прокси или обрезок начинаются иначе."""
    try:
        with open(path, "rb") as fh:
            return fh.read(2) == b"PK"
    except OSError:
        return False


def ensure(name, on_progress=None):
    """Путь к весам на томе; скачает, если их там нет.

    ``on_progress(have, total)`` зовётся по ходу — обучение в это время
    показывает «качаю веса», а не молчит.
    """
    name = os.path.basename(name)
    path = path_of(name)
    if is_cached(name):
        return path
    os.makedirs(WEIGHTS_DIR, exist_ok=True)
    part = path + ".part"
    url = ASSETS_URL + name
    try:
        _download(url, part, on_progress)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise WeightsUnavailable(
            f"Веса «{name}» не скачались ({exc}). Положите файл в "
            f"yolo-data/_weights/{name} и запустите обучение снова."
        ) from exc
    if os.path.getsize(part) < MIN_BYTES or not looks_like_checkpoint(part):
        os.remove(part)
        raise WeightsUnavailable(
            f"«{name}» пришёл не весами, а чем-то другим — сервер отдал не "
            f"тот файл. Положите настоящий файл в yolo-data/_weights/{name}."
        )
    os.replace(part, path)
    return path


def _download(url, part, on_progress):
    have = os.path.getsize(part) if os.path.isfile(part) else 0
    headers = {"User-Agent": "magistral-training/1.0"}
    if have:
        headers["Range"] = f"bytes={have}-"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        resumed = resp.status == 206 and have > 0
        length = resp.headers.get("Content-Length")
        total = int(length) + (have if resumed else 0) if length else None
        mode = "ab" if resumed else "wb"
        if not resumed:
            have = 0
        with open(part, mode) as fh:
            while True:
                chunk = resp.read(CHUNK)
                if not chunk:
                    break
                fh.write(chunk)
                have += len(chunk)
                if on_progress is not None:
                    on_progress(have, total)
    if total is not None and have != total:
        raise ValueError(f"скачано {have} из {total} байт")
