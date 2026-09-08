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
        written = 0
        with open(path, "ab") as fh:
            while True:
                buf = stream.read(1 << 20)
                if not buf:
                    break
                fh.write(buf)
                written += len(buf)
        total = have + written
        if total > int(upload["size"]):
            fh_size = int(upload["size"])
            raise UploadError(
                f"Прислано больше, чем объявлено: {total} > {fh_size}.", total, 413
            )
        return total


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
