"""Воркер подготовки данных: сборка наборов и уборка за ними.

Отдельный процесс, а не поток внутри сервиса, по той же причине, по которой
нарезка видео однажды переехала из gunicorn в свой контейнер: сборка набора
занимает ядро на минуты, а тем же пулом обслуживаются списки, превью и
сохранение графов. Пятеро, запустивших сборку разом, останавливали бы раздел
всем — включая тех, кто ничего не собирает.

Признаки кадров этот воркер не считает: они просят видеокарту, а torch стоит
в образе обучения. Их берёт оттуда воркер обучения — очередь одна, наборы
работ разные.
"""
import logging
import os
import shutil
import signal
import socket
import threading
import time

from common import config, live
from common.db import SessionLocal, wait_for_db
from common.models import TrainSet
from common import prep_queue as queue
from dataprep_svc import builder

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s dataprep-worker %(levelname)s %(message)s",
)
log = logging.getLogger("dataprep")

WORKERS = int(os.environ.get("DATAPREP_WORKERS", "1"))
IDLE_SLEEP = float(os.environ.get("DATAPREP_IDLE", "1.0"))
REAP_EVERY = float(os.environ.get("DATAPREP_REAP", "30"))

_stop = threading.Event()


def worker_id(n):
    return f"{socket.gethostname()}#{n}"


def handle(db, job):
    """Одна работа. Исключение наверх — очередь решит, повторять ли."""
    if job.kind == queue.KIND_BUILD:
        builder.build(db, job)
        return
    if job.kind == queue.KIND_DELETE:
        _delete_set(db, job)
        return
    raise ValueError(f"Эту работу берёт не этот воркер: {job.kind}")


def _delete_set(db, job):
    """Убрать набор с тома и из базы — с отметками по ходу.

    Папку сносим до строки: строка без папки — это просто пустой список, а
    папка без строки — гигабайты, о которых никто не помнит. Но строка
    обязана быть в состоянии «deleting» с самого начала (его ставит ручка):
    так экран видит правду и пока идёт уборка, и если она сорвётся.

    Отмечаемся по числу файлов. Раньше уборка шла молча, аренда работы
    истекала на большом наборе, и уборщик очереди ставил ту же работу
    заново поверх идущей — отсюда «то удаляется, то нет».
    """
    tset = db.get(TrainSet, job.target_id)
    if tset is None:
        return
    if tset.status != "deleting":
        tset.status = "deleting"
        db.commit()
    root = config.trainset_dir(tset.project_id, tset.id)

    files = []
    for base, _dirs, names in os.walk(root):
        files.extend(os.path.join(base, n) for n in names)
    total = len(files)
    queue.beat(db, job, processed=0, total=total, stage="delete",
               stage_text="Убираю файлы набора")
    last = time.monotonic()
    for n, path in enumerate(files, 1):
        try:
            os.remove(path)
        except OSError:
            pass
        if time.monotonic() - last > 2.0:
            queue.beat(db, job, processed=n, total=total)
            last = time.monotonic()
    shutil.rmtree(root, ignore_errors=True)
    queue.beat(db, job, processed=total, total=total, stage="row",
               stage_text="Убираю запись")
    # Обучения на этом наборе остаются — у них set_id станет пустым (SET
    # NULL), веса и метрики никуда не денутся.
    db.delete(tset)
    db.commit()
    live.notify(db, "prep", job.id, job.project_id, s="done")


def loop(n, kinds):
    me = worker_id(n)
    log.info("полоса %s взяла %s", me, ", ".join(kinds))
    while not _stop.is_set():
        db = SessionLocal()
        job = None
        try:
            job = queue.claim(db, kinds, me)
            if job is None:
                db.close()
                _stop.wait(IDLE_SLEEP)
                continue
            log.info("%s: %s %s", me, job.kind, job.target_id)
            handle(db, job)
            queue.finish(db, job)
        except builder.Cancelled:
            queue.finish(db, job, cancelled=True)
            log.info("%s: снято по просьбе", me)
        except Exception as exc:  # noqa: BLE001 — падение одной работы не
            # должно ронять полосу: следующая может быть исправной.
            log.exception("%s: работа не удалась", me)
            if job is not None:
                try:
                    # Сессия после сбоя в flush требует отката, иначе любой
                    # следующий запрос по ней падает PendingRollbackError —
                    # и работа не возвращалась в очередь, а зависала.
                    db.rollback()
                    again = queue.release(db, job, exc)
                    if not again:
                        _mark_broken(db, job, exc)
                except Exception:
                    log.exception("не удалось вернуть работу в очередь")
        finally:
            db.close()


def _mark_broken(db, job, exc):
    """Работа кончилась совсем — сказать об этом тому, кто её ждёт.

    И у сборки, и у удаления итог один: набор в «error» с причиной. Для
    удаления это честнее, чем вечное «удаляется»: человек видит, что не
    вышло, и может попросить снова.
    """
    tset = db.get(TrainSet, job.target_id)
    if tset is None:
        return
    text = str(exc)[:1900]
    tset.status = "error"
    tset.error = (
        f"Удалить не вышло: {text}" if job.kind == queue.KIND_DELETE else text
    )
    db.commit()
    live.notify(db, "prep", job.id, job.project_id, s="error")


def reaper():
    while not _stop.is_set():
        db = SessionLocal()
        try:
            freed = queue.reap(db)
            if freed:
                log.info("вернул в очередь просроченных работ: %s", freed)
        except Exception:
            log.exception("уборка очереди не удалась")
        finally:
            db.close()
        _stop.wait(REAP_EVERY)


def main():
    wait_for_db()
    config.ensure_dirs()

    def bye(*_):
        log.info("остановка")
        _stop.set()

    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGINT, bye)

    threads = [threading.Thread(target=reaper, name="reaper", daemon=True)]
    for n in range(WORKERS):
        threads.append(threading.Thread(
            target=loop, args=(n, queue.CPU_KINDS),
            name=f"prep-{n}", daemon=True,
        ))
    for t in threads:
        t.start()
    log.info("готов: полос %s", WORKERS)
    while not _stop.is_set():
        time.sleep(0.5)


if __name__ == "__main__":
    main()
