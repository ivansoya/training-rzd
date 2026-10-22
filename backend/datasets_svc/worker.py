"""Воркер видео: отдельный процесс, который и делает всю тяжёлую работу.

Он поднимается своим контейнером на том же образе, что и сервис датасетов, и
это главное в нём. Перекодирование ролика — минуты счёта; пока оно шло внутри
gunicorn, оно занимало поток, который в это время не отвечал ни на список
тасок, ни на сохранение бокса. Здесь оно не может занять ничего чужого:
кончится CPU в контейнере воркера — API останется отзывчивым, только видео
будет готовиться дольше.

Пулов два, и они не смешиваются. Быстрый берёт то, чего ждёт живой человек:
таблицы кадров и пакетов только что загруженного ролика — с ними оригинал уже
открывается. Медленный берёт фоновую подготовку ступеней. Будь пул один, все
воркеры однажды оказались бы заняты копиями, и таблица встала бы за ними.

Падение воркера ничего не ломает: задача остаётся в базе с истёкшей арендой,
и её подберут — свои же при следующем круге или соседний контейнер.
"""
import logging
import os
import shutil
import signal
import threading
import time

from common import alive, config, db as dblib, gpu
from sqlalchemy import select

from common.db import SessionLocal
from common.models import Task, TaskVideo
from datasets_svc import video as videolib
from datasets_svc import video_chunks as chunklib
from datasets_svc import video_index
from datasets_svc import video_queue as queue

log = logging.getLogger("video-worker")

# Быстрых больше одного: два ролика, загруженные разом, не ждут друг друга.
FAST_WORKERS = int(os.environ.get("VIDEO_FAST_WORKERS", "2"))
# Медленный по умолчанию один. Две копии, идущие разом, готовятся ровно
# вдвое дольше каждая — выигрыша нет, а машина занята вся.
SLOW_WORKERS = int(os.environ.get("VIDEO_SLOW_WORKERS", "1"))
IDLE_SLEEP = float(os.environ.get("VIDEO_WORKER_IDLE", "0.5"))
REAP_EVERY = float(os.environ.get("VIDEO_WORKER_REAP", "30"))
# Отметка о ходе работы стоит записи в базу; чаще этого она не нужна никому.
BEAT_EVERY = 5.0
# Бронь карты под копию: замер 20.10.2026 — 310-400 МиБ на 1080p и 2520×1080, запас под 2688×1520.
GPU_MB = int(os.environ.get("VIDEO_GPU_MB", "768"))

_stop = threading.Event()


def _abs(rel):
    return os.path.join(config.DATA_DIR, rel)


def _rel(path):
    return os.path.relpath(path, config.DATA_DIR)


class _Beat:
    """Отметка о ходе работы — не чаще, чем раз в несколько секунд."""

    def __init__(self, db, job, total, lease_id=None):
        self.db, self.job, self.total, self.at = db, job, total, 0.0
        # Бронь карты продлевается тем же ходом: без отметок аренда истекает посреди копии.
        self.lease_id, self.lease_at = lease_id, time.monotonic()

    def __call__(self, processed, total=None):
        now = time.monotonic()
        if now - self.at < BEAT_EVERY:
            return
        self.at = now
        job_id = self.job.id
        try:
            queue.beat(self.db, self.job, processed, total or self.total)
            if self.lease_id and now - self.lease_at >= gpu.BEAT_EVERY:
                self.lease_at = now
                gpu.beat(self.db, self.lease_id)
        except Exception:  # noqa: BLE001
            # Отметка — удобство, а не условие работы. Не смогли записать —
            # работа всё равно должна доделаться; сессию откатываем, иначе
            # следующий же запрос упал бы PendingRollbackError.
            self.db.rollback()
            log.warning("не удалось отметить ход задачи %s", job_id)


def _on_card(db, job, video, title, run):
    """Сделать работу на видеокарте, если карту дают сразу: ``run(номер карты, бронь)``.

    None — делай на процессоре. Карту не ждём (решение 20.10.2026): занята обучением или агентом —
    копия на процессоре за ~3,5 мин предсказуемее очереди, которая может стоять часами.
    """
    if not chunklib.gpu_ready() or not gpu.cards(db):
        return None
    project_id = db.execute(select(Task.project_id).where(Task.id == video.task_id)).scalar()
    lease = gpu.request(db, holder="video", kind="video", want_mb=GPU_MB, ref_id=job.id,
                        project_id=project_id, user_id=video.created_by, title=title)
    device = gpu.torch_index(db, lease) if lease.status == "held" else None
    if device is None:
        gpu.cancel(db, lease.id, "Карта занята — копия на процессоре")
        return None
    try:
        return run(device, lease.id)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        log.warning("на карте не вышло, делаю на процессоре: %s", exc)
        return None
    finally:
        gpu.release(db, lease.id)


# --------------------------------------------------------------------------- #
# Работы
# --------------------------------------------------------------------------- #
def _do_index(db, job, video, path):
    """Таблицы кадров и пакетов, а следом — весь план подготовки ролика."""
    full = chunklib.build_index(path)
    index = video_index.get(db, video, path)
    if index is None:
        index = video_index.store(db, video, full)
    elif index["version"] != full["version"]:
        # Номера кадров этого ролика уже в разметке — подменять таблицу нельзя.
        raise chunklib.UnrecoverableVideoError("Таблица кадров разошлась с файлом ролика.")

    queue.enqueue(db, video.id, queue.KIND_STRIP)
    if video.mode != "annotate":
        # Окно нарезки играет сам файл — ступени ему ни к чему.
        return {"frames": index["count"]}

    # «Исходное» — сам оригинал по Range; почему нельзя (если нельзя) — в error.
    src = queue.ensure_asset(db, video.id, chunklib.SOURCE)
    src.file_path, src.file_status, src.error = video.file_path, "ready", full["range_why"]
    src.width, src.height = full["width"], full["height"]
    src.size_bytes = os.path.getsize(path)
    src.frame_index = chunklib.pack_table(full)
    db.commit()
    _drop_chunks(path)

    for quality in chunklib.ladder_for(src.frame_index):
        # 720p первой: она и запасная для браузера без кодека оригинала.
        priority = queue.PRIORITY[queue.KIND_VARIANT] + (0 if quality == chunklib.DEFAULT_QUALITY else 5)
        queue.enqueue(db, video.id, queue.KIND_VARIANT, quality=quality,
                      priority=priority, total=index["count"])
    return {"frames": index["count"], "range": full["range_why"] or "да"}


def _drop_chunks(path):
    """Перегоны и копия «Исходного» прежней раскладки (до 22.10.2026)."""
    base, _ = os.path.splitext(path)
    shutil.rmtree(base + "_chunks", ignore_errors=True)
    try:
        os.remove(chunklib.variant_path(path, chunklib.SOURCE))
    except OSError:
        pass


def _do_strip(db, job, video, path):
    dest = os.path.join(
        os.path.dirname(path), f"{video.id}_strip.jpg"
    )
    if os.path.exists(dest):
        return {"skipped": True}
    videolib.make_strip(path, dest, video.duration_ms, video.fps)
    return {"strip": os.path.exists(dest)}


def _do_variant(db, job, video, path):
    """Файл ступени: битрейт не выше оригинала, таблица пакетов — для Range."""
    index = video_index.get(db, video, path)
    src = video_index.table(queue.asset(db, video.id, chunklib.SOURCE))
    if index is None or src is None:
        raise chunklib.VideoError("Таблица кадров ещё не построена.")
    asset = queue.ensure_asset(db, video.id, job.quality)
    dest = chunklib.variant_path(path, job.quality)

    asset.file_status = "building"
    asset.error = None
    db.commit()

    # Потолок — битрейт оригинала: пережатие не сделает картинку лучше камеры (решение 7, 22.10.2026).
    cap = src["bitrate"] or None
    made = _on_card(db, job, video, f"Копия ролика {job.quality}", lambda device, lease_id: chunklib.make_variant_gpu(
        path, index, job.quality, dest, device, progress=_Beat(db, job, index["count"], lease_id), maxrate=cap))
    on_card = made is not None
    if made is None:
        made = chunklib.make_variant(
            path, index, job.quality, dest, progress=_Beat(db, job, index["count"]), maxrate=cap
        )
    table = chunklib.build_index(made["path"])
    if table["count"] != index["count"] or table["range_why"]:
        raise chunklib.VideoError(
            f"Ступень {job.quality} не годится: {table['range_why'] or str(table['count']) + ' кадров'}."
        )
    asset.file_status = "ready"
    asset.file_path = _rel(made["path"])
    asset.width, asset.height = made["width"], made["height"]
    asset.size_bytes = made["size_bytes"]
    asset.frame_index = chunklib.pack_table(table)
    db.commit()
    return {"quality": job.quality, "Мбит/с": round(table["bitrate"] / 1e6, 2), "карта": on_card}


HANDLERS = {
    queue.KIND_INDEX: _do_index,
    queue.KIND_STRIP: _do_strip,
    queue.KIND_VARIANT: _do_variant,
}


# --------------------------------------------------------------------------- #
# Цикл
# --------------------------------------------------------------------------- #
def run_job(db, job):
    video = db.get(TaskVideo, job.video_id)
    if video is None:
        # Ролик удалили, пока задача стояла в очереди. Это не отказ.
        queue.finish(db, job)
        return
    path = _abs(video.file_path)
    if not os.path.exists(path):
        queue.finish(db, job, "Файл видео не найден.")
        return
    video_id = video.id
    result = HANDLERS[job.kind](db, job, video, path)
    # Ролик могли удалить, пока шла работа: то, что она успела написать, — сирота.
    if db.execute(select(TaskVideo.id).where(TaskVideo.id == video_id)).first() is None:
        _drop_leftovers(os.path.dirname(path), video_id)
        return
    queue.finish(db, job)
    log.info("готово: %s %s %s", job.kind, job.quality or "", result)


def _drop_leftovers(folder, video_id):
    import glob
    import shutil

    for leftover in glob.glob(os.path.join(folder, f"{video_id}_*")):
        if os.path.isdir(leftover):
            shutil.rmtree(leftover, ignore_errors=True)
        else:
            try:
                os.remove(leftover)
            except OSError:
                pass


def _public(exc):
    """Что показать человеку: свои фразы — как есть, чужие (errno, пути) — общей."""
    if isinstance(exc, chunklib.VideoError):
        return str(exc)
    return "Не удалось обработать ролик. Подробности — в журнале видео-воркера."


def _mark_failed(db, job, exc):
    """Отметить ступень несостоявшейся, когда попытки кончились.

    Без этого ступень навсегда оставалась бы «готовится»: очередь про отказ
    знает, а страница смотрит на ступень — и показывала бы полосу, за которой
    уже ничего не происходит.
    """
    if job.kind != queue.KIND_VARIANT or not job.quality:
        return
    try:
        asset = queue.ensure_asset(db, job.video_id, job.quality)
        asset.file_status = "error"
        asset.error = str(exc)[:2000]
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        log.exception("не удалось отметить ступень %s несостоявшейся", job.quality)


def loop(kinds, name):
    """Один воркер: берёт задачу, делает, отчитывается. И так до остановки."""
    alive.loop()
    while not _stop.is_set():
        alive.stamp()
        db = SessionLocal()
        try:
            job = queue.claim(db, kinds)
            if job is None:
                db.close()
                _stop.wait(IDLE_SLEEP)
                continue
            log.info("%s взял %s %s", name, job.kind, job.quality or "")
            job_id = job.id
            try:
                run_job(db, job)
            except Exception as exc:  # noqa: BLE001
                # Сессия могла остаться в незавершённой транзакции: откат —
                # первым, до логирования, иначе падал уже сам обработчик.
                db.rollback()
                # Ни одна работа не должна валить воркер: он на то и отдельный,
                # чтобы битый ролик стоил битого ролика, а не всей очереди.
                log.exception("задача %s упала", job_id)
                job = db.get(queue.VideoJob, job_id)
                if job is None:
                    # Задачу унесло вместе с удалённым роликом — отмечать нечего.
                    continue
                if isinstance(exc, chunklib.UnrecoverableVideoError):
                    queue.finish(db, job, _public(exc))
                    queue.drop_siblings(db, job, _public(exc))
                    requeued = False
                else:
                    requeued = queue.release(db, job, _public(exc))
                if not requeued:
                    _mark_failed(db, job, _public(exc))
                log.warning(
                    "задача %s %s", job.id,
                    "вернулась в очередь" if requeued else "признана безнадёжной",
                )
        except Exception:  # noqa: BLE001
            log.exception("цикл воркера %s споткнулся", name)
            _stop.wait(2.0)
        finally:
            db.close()


def reaper():
    """Возвращает в очередь всё, чью аренду никто не продлил."""
    alive.loop()
    while not _stop.is_set():
        alive.stamp()
        _stop.wait(REAP_EVERY)
        if _stop.is_set():
            return
        db = SessionLocal()
        try:
            revived = queue.reap(db)
            if revived:
                log.warning("вернули в очередь %s осиротевших задач", revived)
        except Exception:  # noqa: BLE001
            log.exception("уборка просроченных задач не удалась")
        finally:
            db.close()


def main():
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    alive.start()
    config.ensure_dirs()
    dblib.wait_for_db()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: _stop.set())

    threads = [threading.Thread(target=reaper, name="reaper", daemon=True)]
    for i in range(FAST_WORKERS):
        threads.append(threading.Thread(
            target=loop, args=(queue.FAST_KINDS, f"быстрый-{i}"),
            name=f"fast-{i}", daemon=True,
        ))
    for i in range(SLOW_WORKERS):
        threads.append(threading.Thread(
            target=loop, args=(queue.SLOW_KINDS, f"медленный-{i}"),
            name=f"slow-{i}", daemon=True,
        ))
    for t in threads:
        t.start()
    log.info("воркер видео поднят: быстрых %s, медленных %s",
             FAST_WORKERS, SLOW_WORKERS)

    # Осиротевшие с прошлого запуска — сразу, не дожидаясь круга уборки.
    db = SessionLocal()
    try:
        queue.reap(db)
    finally:
        db.close()

    while not _stop.is_set():
        _stop.wait(1.0)
    log.info("воркер видео останавливается")


if __name__ == "__main__":
    main()
