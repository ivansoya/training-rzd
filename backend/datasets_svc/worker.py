"""Воркер видео: отдельный процесс, который и делает всю тяжёлую работу.

Он поднимается своим контейнером на том же образе, что и сервис датасетов, и
это главное в нём. Перекодирование ролика — минуты счёта; пока оно шло внутри
gunicorn, оно занимало поток, который в это время не отвечал ни на список
тасок, ни на сохранение бокса. Здесь оно не может занять ничего чужого:
кончится CPU в контейнере воркера — API останется отзывчивым, только видео
будет готовиться дольше.

Пулов два, и они не смешиваются. Быстрый берёт то, чего ждёт живой человек:
таблицу кадров только что загруженного ролика и отдельный перегон, на который
разметчик смотрит прямо сейчас. Медленный берёт фоновую подготовку ступеней.
Будь пул один, все воркеры однажды оказались бы заняты копиями, и запрос
перегона встал бы за ними — то самое, ради чего всё это и переписывалось.

Падение воркера ничего не ломает: задача остаётся в базе с истёкшей арендой,
и её подберут — свои же при следующем круге или соседний контейнер.
"""
import logging
import os
import signal
import threading
import time

from common import config, db as dblib
from common.db import SessionLocal
from common.models import TaskVideo
from datasets_svc import video as videolib
from datasets_svc import video_chunks as chunklib
from datasets_svc import video_index
from datasets_svc import video_queue as queue

log = logging.getLogger("video-worker")

# Быстрых больше одного: пока один разбирает только что загруженный ролик,
# второй должен успевать отдавать перегоны тем, кто уже размечает.
FAST_WORKERS = int(os.environ.get("VIDEO_FAST_WORKERS", "2"))
# Медленный по умолчанию один. Две копии, идущие разом, готовятся ровно
# вдвое дольше каждая — выигрыша нет, а машина занята вся.
SLOW_WORKERS = int(os.environ.get("VIDEO_SLOW_WORKERS", "1"))
IDLE_SLEEP = float(os.environ.get("VIDEO_WORKER_IDLE", "0.5"))
REAP_EVERY = float(os.environ.get("VIDEO_WORKER_REAP", "30"))
# Отметка о ходе работы стоит записи в базу; чаще этого она не нужна никому.
BEAT_EVERY = 5.0

_stop = threading.Event()


def _abs(rel):
    return os.path.join(config.DATA_DIR, rel)


def _rel(path):
    return os.path.relpath(path, config.DATA_DIR)


class _Beat:
    """Отметка о ходе работы — не чаще, чем раз в несколько секунд."""

    def __init__(self, db, job, total):
        self.db, self.job, self.total, self.at = db, job, total, 0.0

    def __call__(self, processed, total=None):
        now = time.monotonic()
        if now - self.at < BEAT_EVERY:
            return
        self.at = now
        try:
            queue.beat(self.db, self.job, processed, total or self.total)
        except Exception:  # noqa: BLE001
            # Отметка — удобство, а не условие работы. Не смогли записать —
            # работа всё равно должна доделаться.
            log.warning("не удалось отметить ход задачи %s", self.job.id)


# --------------------------------------------------------------------------- #
# Работы
# --------------------------------------------------------------------------- #
def _do_index(db, job, video, path):
    """Таблица кадров, а следом — весь план подготовки ролика."""
    index = video_index.ensure(db, video, path)

    queue.enqueue(db, video.id, queue.KIND_STRIP)
    default = chunklib.default_for(index["height"])
    for quality in chunklib.ladder_for(index["height"]):
        # Ступень по умолчанию готовится первой: с неё ролик и откроют.
        priority = queue.PRIORITY[queue.KIND_VARIANT] + (0 if quality == default else 5)
        queue.enqueue(db, video.id, queue.KIND_VARIANT, quality=quality,
                      priority=priority, total=index["count"])
    if default == chunklib.SOURCE:
        # Ролик мельче самой малой ступени: копий не будет, перегоны режем
        # прямо из него — их всё равно немного.
        queue.enqueue(db, video.id, queue.KIND_CHUNKSET, quality=chunklib.SOURCE,
                      total=index["count"])
    return {"frames": index["count"]}


def _do_strip(db, job, video, path):
    dest = os.path.join(
        os.path.dirname(path), f"{video.id}_strip.jpg"
    )
    if os.path.exists(dest):
        return {"skipped": True}
    videolib.make_strip(path, dest, video.duration_ms)
    return {"strip": os.path.exists(dest)}


def _do_variant(db, job, video, path):
    """Полная копия ступени. Из неё потом режутся перегоны — перекладыванием."""
    index = video_index.get(db, video, path)
    if index is None:
        raise chunklib.VideoError("Таблица кадров ещё не построена.")
    asset = queue.ensure_asset(db, video.id, job.quality)
    dest = chunklib.variant_path(path, job.quality)

    asset.file_status = "building"
    asset.error = None
    db.commit()

    made = chunklib.make_variant(
        path, index, job.quality, dest, progress=_Beat(db, job, index["count"])
    )
    asset.file_status = "ready"
    asset.file_path = _rel(made["path"])
    asset.width, asset.height = made["width"], made["height"]
    asset.size_bytes = made["size_bytes"]
    asset.chunks_total = chunklib.chunk_count(index["count"])
    db.commit()

    # Копия готова — сразу и нарезаем. «Когда выберут» тут не работает:
    # выбрать можно только готовую ступень, а готовой она станет только если
    # её нарезать. Раз копия уже сделана, нарезка из неё — перекладывание
    # пакетов, и стоит она недорого.
    queue.enqueue(db, video.id, queue.KIND_CHUNKSET, quality=job.quality,
                  total=index["count"])
    return {"quality": job.quality, "bytes": made["size_bytes"]}


def _source_for(db, video, path, quality):
    """Откуда резать перегоны этой ступени: из копии, если она готова.

    Возвращает ``(путь, позиционная ли нумерация)``. В копии кадры лежат
    подряд и считаются по порядку; в оригинале номер ищется в таблице времён.
    """
    if quality == chunklib.SOURCE:
        return path, False
    asset = queue.asset(db, video.id, quality)
    if asset and asset.file_status == "ready" and asset.file_path:
        variant = _abs(asset.file_path)
        if os.path.exists(variant):
            return variant, True
    return path, False


def _do_chunkset(db, job, video, path):
    """Все перегоны ступени. Из копии это перекладывание пакетов, и оно
    настолько дешевле перекодирования, что нарезать всё разом проще, чем
    заводить машинерию «по требованию»."""
    index = video_index.get(db, video, path)
    if index is None:
        raise chunklib.VideoError("Таблица кадров ещё не построена.")
    quality = job.quality or chunklib.default_for(index["height"])
    asset = queue.ensure_asset(db, video.id, quality)
    total = chunklib.chunk_count(index["count"])
    source, positional = _source_for(db, video, path, quality)

    asset.chunks_status = "building"
    asset.chunks_total = total
    asset.chunks_dir = _rel(chunklib.chunks_dir(path, quality))
    asset.error = None
    db.commit()

    def dest_for(chunk_no):
        return chunklib.chunk_path(path, chunk_no, quality)

    beat = _Beat(db, job, index["count"])
    made = 0
    if positional:
        try:
            made = chunklib.cut_from_variant(
                source, index["count"], dest_for, progress=beat
            )
            _check_first_chunk(dest_for(0), index["count"])
        except chunklib.VideoError as exc:
            # Копия не годится под перекладывание. Резать её перекодированием
            # можно, но это лечение симптома: следующий же перегон по
            # требованию упрётся в то же самое и снова будет стоить секунд.
            # Поэтому копию переделываем, а нарезку возвращаем в очередь —
            # она пойдёт следом за новой копией и уже переложится.
            log.warning("копия %s не разложилась перекладыванием: %s", quality, exc)
            _wipe_chunks(path, total, quality)
            if _rebuild_variant(db, video, path, quality, asset, index):
                raise chunklib.VideoError(
                    f"Копия {quality} переделывается: {exc}"
                ) from exc
            made = 0
    if not made:
        made = chunklib.cut_all(
            source, index, quality, dest_for,
            progress=beat, skip_existing=True, positional=positional,
        )

    ready = _count_ready(path, total, quality)
    asset.chunks_ready = ready
    asset.chunks_status = "ready" if ready >= total else "error"
    if ready < total:
        asset.error = f"Нарезано {ready} перегонов из {total}."
    db.commit()
    if ready < total:
        raise chunklib.VideoError(asset.error)

    freed = _drop_variant(db, path, asset)
    return {"quality": quality, "chunks": ready, "копия убрана": freed}


def _drop_variant(db, path, asset):
    """Убрать копию ступени: перегоны нарезаны, и она своё отслужила.

    Копия и её перегоны — это одни и те же байты дважды: перегон вырезается из
    копии перекладыванием пакетов, а не пересжатием. На двадцатиминутном
    ролике 1080p это 256 МБ, лежащих зря.

    Копия нужна ровно двум вещам, и обе уже не про неё. Нарезка всей ступени —
    закончилась. Кадр для полуавтомата — берётся из готового перегона, а не из
    копии. Остаётся починка одиночного перегона, если файл потеряется: она
    пойдёт перекодированием из оригинала, десять секунд на перегон, и случай
    этот редкий.

    ``file_status`` не трогаем: он про то, удалась ли копия, а не про то, лежит
    ли она сейчас. Есть ли файл — говорит ``file_path``, его и снимаем; на него
    и смотрит ``_source_for``.
    """
    if asset.quality == chunklib.SOURCE or not asset.file_path:
        return 0
    variant = _abs(asset.file_path)
    try:
        freed = os.path.getsize(variant)
        os.remove(variant)
    except OSError:
        freed = 0
    asset.file_path = None
    asset.size_bytes = None
    db.commit()
    if freed:
        log.info("копия %s убрана, освобождено %s МБ",
                 asset.quality, round(freed / 1024 / 1024))
    return freed


def _do_chunk(db, job, video, path):
    """Один перегон — тот, которого ждёт живой разметчик."""
    index = video_index.get(db, video, path)
    if index is None:
        raise chunklib.VideoError("Таблица кадров ещё не построена.")
    quality = job.quality or chunklib.default_for(index["height"])
    dest = chunklib.chunk_path(path, job.chunk_no, quality)
    if os.path.exists(dest):
        return {"skipped": True}
    source, positional = _source_for(db, video, path, quality)

    if positional:
        try:
            def dest_for(_no):
                return dest

            if chunklib.cut_from_variant(
                source, index["count"], dest_for, only=job.chunk_no
            ):
                # На этот перегон смотрит человек: лучше проверить лишний раз,
                # чем показать ему кашу вместо кадра.
                first, last = chunklib.chunk_bounds(job.chunk_no, index["count"])
                got = chunklib.frame_count_of(dest)
                if got != last - first + 1:
                    raise chunklib.VideoError(
                        f"Переложенный перегон читается как {got} кадров "
                        f"вместо {last - first + 1}."
                    )
                _bump_ready(db, video.id, quality)
                return {"chunk": job.chunk_no, "remuxed": True}
        except chunklib.VideoError as exc:
            log.warning("перегон %s не переложился: %s", job.chunk_no, exc)
            try:
                os.remove(dest)
            except OSError:
                pass

    chunklib.cut_chunk(source, index, job.chunk_no, quality, dest,
                       positional=positional)
    _bump_ready(db, video.id, quality)
    return {"chunk": job.chunk_no}


def _rebuild_variant(db, video, path, quality, asset, index):
    """Выбросить негодную копию ступени и заказать новую.

    Нужно ровно один раз в жизни ролика: копии, сделанные до того, как кадрам
    перестали навязывать тип из исходника, опорных на границах перегонов не
    имеют. Чинится переделкой, а не вечным перекодированием при каждом
    обращении. Повторов бояться нечего — число попыток у задачи ограничено.
    """
    if quality == chunklib.SOURCE:
        return False
    try:
        os.remove(chunklib.variant_path(path, quality))
    except OSError:
        pass
    asset.file_status = "pending"
    asset.file_path = None
    asset.chunks_status = "pending"
    asset.chunks_ready = 0
    db.commit()
    queue.enqueue(db, video.id, queue.KIND_VARIANT, quality=quality,
                  total=index["count"])
    return True


def _check_first_chunk(path, total):
    """Убедиться, что переложенный перегон вообще читается.

    Счётчик пакетов при перекладывании сходится по построению — а вот
    контейнер может выйти таким, что его не откроет никто. Проверяем один
    перегон: если сломано, сломано одинаково во всех.
    """
    want = chunklib.chunk_bounds(0, total)[1] + 1
    got = chunklib.frame_count_of(path)
    if got != want:
        raise chunklib.VideoError(
            f"Переложенный перегон читается как {got} кадров вместо {want}."
        )


def _wipe_chunks(path, total, quality):
    """Убрать перегоны ступени — перед тем как нарезать их иначе."""
    for n in range(total):
        try:
            os.remove(chunklib.chunk_path(path, n, quality))
        except OSError:
            pass


def _count_ready(path, total, quality):
    return sum(
        1 for n in range(total)
        if os.path.exists(chunklib.chunk_path(path, n, quality))
    )


def _bump_ready(db, video_id, quality):
    asset = queue.asset(db, video_id, quality)
    if asset is not None and asset.chunks_status != "ready":
        asset.chunks_ready = asset.chunks_ready + 1
        db.commit()


HANDLERS = {
    queue.KIND_INDEX: _do_index,
    queue.KIND_STRIP: _do_strip,
    queue.KIND_VARIANT: _do_variant,
    queue.KIND_CHUNKSET: _do_chunkset,
    queue.KIND_CHUNK: _do_chunk,
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
    result = HANDLERS[job.kind](db, job, video, path)
    queue.finish(db, job)
    log.info("готово: %s %s %s", job.kind, job.quality or "", result)


def _mark_failed(db, job, exc):
    """Отметить ступень несостоявшейся, когда попытки кончились.

    Без этого ступень навсегда оставалась бы «готовится»: очередь про отказ
    знает, а страница смотрит на ступень — и показывала бы полосу, за которой
    уже ничего не происходит.
    """
    if job.kind not in (queue.KIND_VARIANT, queue.KIND_CHUNKSET) or not job.quality:
        return
    try:
        asset = queue.ensure_asset(db, job.video_id, job.quality)
        if job.kind == queue.KIND_VARIANT:
            asset.file_status = "error"
        else:
            asset.chunks_status = "error"
        asset.error = str(exc)[:2000]
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        log.exception("не удалось отметить ступень %s несостоявшейся", job.quality)


def loop(kinds, name):
    """Один воркер: берёт задачу, делает, отчитывается. И так до остановки."""
    while not _stop.is_set():
        db = SessionLocal()
        try:
            job = queue.claim(db, kinds)
            if job is None:
                db.close()
                _stop.wait(IDLE_SLEEP)
                continue
            log.info("%s взял %s %s %s", name, job.kind, job.quality or "",
                     job.chunk_no if job.chunk_no >= 0 else "")
            try:
                run_job(db, job)
            except Exception as exc:  # noqa: BLE001
                # Ни одна работа не должна валить воркер: он на то и отдельный,
                # чтобы битый ролик стоил битого ролика, а не всей очереди.
                log.exception("задача %s упала", job.id)
                # Сессия могла остаться в незавершённой транзакции — тогда
                # отметка об отказе не записалась бы, и задача висела бы
                # «в работе» до истечения аренды.
                db.rollback()
                requeued = queue.release(db, job, exc)
                if not requeued:
                    _mark_failed(db, job, exc)
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
    while not _stop.is_set():
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
