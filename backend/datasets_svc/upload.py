"""Кусочная загрузка архива импорта.

Одним запросом архив на 16 ГБ не довозится надёжно: werkzeug сперва целиком
складывает тело в свой временный файл, потом ``file.save`` копирует его на
том — и всё это время у браузера «100 %» и ни байта ответа. Любая прокладка
между ними (в деве — прокси vite) за эти минуты успевает решить, что сервер
умер, и отдаёт 500, хотя на сервере всё дописалось. 07.09.2026 nginx записал
на такую загрузку ``499``: клиент ушёл, не дождавшись.

Здесь архив идёт кусками по 16 МБ прямо в конечный файл на томе: каждый
запрос короткий, сорвавшийся кусок шлётся заново, а последний шаг —
переименование — мгновенный. Состояние загрузки лежит в ``_import.json``
рядом с остальным мастером, поэтому тот же файл, выбранный заново после
обрыва, продолжается с места разрыва, а не с нуля.
"""
import os
import threading
import uuid

from common import config

CHUNK_BYTES = int(os.environ.get("IMPORT_CHUNK_BYTES", str(16 << 20)))
# Сколько места оставлять на диске сверх любой загрузки: том общий с Postgres,
# и забитый до нуля диск роняет базу всем, а не только загрузившему.
DISK_RESERVE = int(float(os.environ.get("DISK_RESERVE_GB", "10")) * (1 << 30))


def room_error(size):
    """Текст отказа, если загрузка размером ``size`` не влезет; иначе None."""
    import shutil

    from common.config import DATA_DIR, HOST_STAT_PATH

    where = HOST_STAT_PATH if HOST_STAT_PATH and os.path.isdir(HOST_STAT_PATH) else DATA_DIR
    free = shutil.disk_usage(where).free - DISK_RESERVE
    if size and size > free:
        gb = lambda n: f"{max(n, 0) / (1 << 30):.1f} ГБ".replace(".", ",")  # noqa: E731
        return f"Не хватит места: файл {gb(size)}, а свободно {gb(free)} с учётом запаса."
    return None
_lock = threading.Lock()


class UploadError(Exception):
    """Ошибка кусочной загрузки; ``received`` — сколько байт лежит на самом деле."""

    def __init__(self, message, received=None, status=409):
        super().__init__(message)
        self.received = received
        self.status = status


def _dir():
    path = os.path.join(config.TMP_DIR, "uploads")
    os.makedirs(path, exist_ok=True)
    return path


def part_path(upload_id):
    return os.path.join(_dir(), f"{upload_id}.zip.part")


def _size(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return None


def begin(previous, name, size):
    """Начать загрузку — или продолжить прежнюю.

    Продолжается та же: имя и размер совпали, и её ``.part`` ещё на месте.
    Иначе прежний обрывок выбрасывается: два полуархива никому не нужны.
    """
    old = (previous or {}).get("upload") if previous else None
    if old:
        have = _size(part_path(old["id"]))
        if (
            have is not None
            and old.get("name") == name
            and int(old.get("size", -1)) == int(size)
            and have <= int(size)
        ):
            return {**old, "received": have}
        discard(old)

    upload_id = uuid.uuid4().hex
    with open(part_path(upload_id), "wb"):
        pass
    return {"id": upload_id, "name": name, "size": int(size), "received": 0}


def receive(upload, offset, stream):
    """Дописать кусок с позиции ``offset``. Возвращает новую длину файла.

    Позиция сверяется с файлом, а не с записью: запись могла отстать, если
    сервис упал между записью байтов и сохранением состояния. Кусок с уже
    записанной позиции — повтор после потерянного ответа, его молча
    пропускаем; кусок с позиции дальше конца — дыра, её не бывает при честной
    последовательной отправке, и это ошибка клиента.
    """
    path = part_path(upload["id"])
    with _lock:
        have = _size(path)
        if have is None:
            raise UploadError("Файл загрузки потерян — начните заново.", 0, 410)
        if offset > have:
            raise UploadError(
                f"Пропущен кусок: на сервере {have} байт, прислан с {offset}.",
                have,
            )
        if offset < have:
            # Уже есть. Тело всё равно надо прочитать до конца, иначе
            # соединение останется с недочитанным запросом.
            while stream.read(1 << 20):
                pass
            return have
        # Не больше куска и не дальше объявленного конца: раньше лишнее
        # сперва ложилось на диск и только потом отвергалось.
        limit = min(CHUNK_BYTES, int(upload["size"]) - have)
        written = 0
        with open(path, "ab") as fh:
            while True:
                buf = stream.read(min(1 << 20, limit - written + 1))
                if not buf:
                    break
                if written + len(buf) > limit:
                    fh.write(buf[: limit - written])
                    written = limit
                    raise UploadError(
                        f"Кусок больше допустимого ({limit} байт).", have + written, 413
                    )
                fh.write(buf)
                written += len(buf)
        return have + written


def finish(upload):
    """Собранный архив под конечным именем. Проверяет, что дошло всё."""
    path = part_path(upload["id"])
    have = _size(path)
    if have is None:
        raise UploadError("Файл загрузки потерян — начните заново.", 0, 410)
    if have != int(upload["size"]):
        raise UploadError(
            f"Архив не дошёл целиком: {have} из {upload['size']} байт.", have
        )
    final = os.path.join(config.TMP_DIR, f"{upload['id']}.zip")
    os.replace(path, final)
    return final


def discard(upload):
    if not upload:
        return
    try:
        os.remove(part_path(upload["id"]))
    except OSError:
        pass
