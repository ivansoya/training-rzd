"""Скачивание больших весов: длина с сервера, докачка, таймаут и проверка формата.

Вынесено из `training_svc/embed.py`, когда тем же путём пошли веса SAM2: их
`urlretrieve` висел без таймаута, писал в общий `.part` и принимал любой
непустой обрезок. Только стандартная библиотека — образ полуавтомата её и так
несёт.
"""
import fcntl
import logging
import os
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

log = logging.getLogger(__name__)
CHUNK = 1 << 20


def expected_size(url, *, timeout=40, opener=urlopen):
    """Длина файла на сервере. ``None`` — сервер не ответил."""
    try:
        with opener(Request(url, method="HEAD", headers={"User-Agent": "magistral"}),
                    timeout=timeout) as r:
            length = r.headers.get("Content-Length")
            return int(length) if length else None
    except (HTTPError, URLError, OSError, ValueError):
        return None


def fetch(url, part, expected, check, *, on_progress=None, attempts=6, stall_limit=2,
          timeout=40, opener=urlopen, sleep=time.sleep):
    """Скачать в ``part`` с докачкой. ``None`` — источник не отдал файл.

    ``check(path)`` — формат на месте: длина сошлась, а внутри не то — с нуля.
    """
    last = None
    stalls = 0
    for attempt in range(1, attempts + 1):
        have = os.path.getsize(part) if os.path.exists(part) else 0
        if have > expected:
            os.remove(part)
            have = 0
        before = have
        try:
            if have < expected:
                headers = {"User-Agent": "magistral"}
                if have:
                    headers["Range"] = f"bytes={have}-"
                if on_progress is not None:
                    on_progress(have, expected)
                with opener(Request(url, headers=headers), timeout=timeout) as r:
                    # Сервер мог не понять Range и прислать всё с начала.
                    mode = "ab" if (have and r.status == 206) else "wb"
                    if mode == "wb":
                        have = 0
                    with open(part, mode) as fh:
                        while True:
                            buf = r.read(CHUNK)
                            if not buf:
                                break
                            fh.write(buf)
                            have += len(buf)
                            if on_progress is not None:
                                on_progress(have, expected)
            if have == expected and check(part):
                return part
            last = f"получено {have} байт из {expected}"
            if have == expected:
                os.remove(part)
                have = 0
        except (HTTPError, URLError, OSError) as exc:
            last = str(exc)
        stalls = stalls + 1 if have <= before else 0
        log.warning("веса %s, попытка %d/%d не удалась: %s", url, attempt, attempts, last)
        if stalls >= stall_limit:
            log.warning("источник %s не отдаёт ни байта — дальше не ждём", url)
            break
        sleep(min(30, 2 ** attempt))
    return None


def ensure_file(url, path, check, **kw):
    """Целый файл по пути ``path``: уже скачанный годится, иначе качаем.

    Под замком: два процесса, разом взявшиеся за одни веса, писали бы в один
    ``.part`` вперемешку. Второй дождётся первого и возьмёт готовое.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # Целый файл берём без сети: у обрезка нет конца zip, check его отвергнет.
        if os.path.isfile(path) and check(path):
            return path
        expected = expected_size(url, timeout=kw.get("timeout", 40),
                                 opener=kw.get("opener", urlopen))
        if expected is None:
            raise RuntimeError(f"Источник весов не отвечает: {url}")
        if os.path.exists(path):
            log.warning("веса %s битые (%d байт, ждали %d) — качаю заново",
                        path, os.path.getsize(path), expected)
            os.remove(path)
        got = fetch(url, path + ".part", expected, check, **kw)
        if got is None:
            raise RuntimeError(f"Веса не скачались: {url}. Подробности — в журнале сервиса.")
        os.replace(got, path)
        return path
