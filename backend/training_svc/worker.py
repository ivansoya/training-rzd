"""Воркер обучения: всё, что просит видеокарту.

Три работы, и все три ходят к диспетчеру за бронью: обучение, счёт признаков
кадров и (позже) проверка модели на ролике. Карта одна на всех, и порядок к ней
решает диспетчер, а не тот, кто первым нажал кнопку.

Перечисление карт живёт здесь же. HTTP-сервис карт не видит и видеть не должен:
он читает таблицу, поэтому экран железа отвечает даже когда этот воркер лежит,
и честно пишет, как давно карта отзывалась.
"""
import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time

from sqlalchemy import select

from common import config, gpu, live
from common.db import SessionLocal, wait_for_db
from common.models import DataprepJob, TrainRun, TrainSet, utcnow
from common import prep_queue
from training_svc import embed, trainer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s training-worker %(levelname)s %(message)s",
)
log = logging.getLogger("training")

IDLE_SLEEP = float(os.environ.get("TRAIN_IDLE", "1.0"))
# Пауза после сорвавшейся работы с признаками. Без неё три попытки сгорали
# за одну секунду — на сетевой сбой это не похоже на «попробовать ещё раз».
PREP_RETRY_PAUSE = float(os.environ.get("PREP_RETRY_PAUSE", "20"))
REAP_EVERY = float(os.environ.get("TRAIN_REAP", "30"))
DISCOVER_EVERY = float(os.environ.get("GPU_DISCOVER", "60"))
RUNNER = os.path.join(os.path.dirname(__file__), "runner.py")

_stop = threading.Event()
_devices = []


def me():
    return socket.gethostname()


# --------------------------------------------------------------------------- #
# Карты
# --------------------------------------------------------------------------- #
def discover_loop():
    global _devices
    while not _stop.is_set():
        db = SessionLocal()
        try:
            _devices = gpu.discover(db)
            if not _devices:
                log.info("видеокарт нет — всё считает процессор")
        except Exception:
            log.exception("не удалось перечислить карты")
        finally:
            db.close()
        _stop.wait(DISCOVER_EVERY)


def reaper():
    while not _stop.is_set():
        db = SessionLocal()
        try:
            freed = gpu.reap(db)
            if freed:
                log.info("вернул памяти по просроченным броням: %s", freed)
            gpu.pump(db)
            prep_queue.reap(db)
        except Exception:
            log.exception("уборка не удалась")
        finally:
            db.close()
        _stop.wait(REAP_EVERY)


# --------------------------------------------------------------------------- #
# Обучение
# --------------------------------------------------------------------------- #
def claim_run(db):
    """Взять ран, которому пора идти.

    Берём и ``queued``, и ``waiting_gpu``: второй уже пробовал взять карту и не
    смог, и пробовать снова должен он же, а не человек.
    """
    run = db.execute(
        select(TrainRun)
        .where(TrainRun.status.in_(("queued", "waiting_gpu")))
        .order_by(TrainRun.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    ).scalar_one_or_none()
    if run is None:
        return None
    run.status = "preparing"
    run.worker_id = me()
    db.commit()
    return run


def start_run(db, run):
    tset = db.get(TrainSet, run.set_id)
    if tset is None or tset.status != "ready":
        run.status = "error"
        run.error = "Обучающий набор не готов."
        run.finished_at = utcnow()
        db.commit()
        return

    params = run.params or {}
    sig = gpu.signature(
        "train", model=run.base_model, task=run.task,
        imgsz=params.get("imgsz", 640), batch=params.get("batch", 16),
    )
    want, source = gpu.estimate(
        db, "train", sig,
        trainer.estimate_vram(
            run.base_model, run.task,
            params.get("imgsz", 640), params.get("batch", 16),
        ),
    )
    lease = gpu.request(
        db, holder="training", kind="train", want_mb=want, ref_id=run.id,
        project_id=run.project_id, user_id=run.created_by, priority=40,
        allow_cpu=True, title=f"Обучение «{run.name}»",
    )
    if lease.status != "held":
        run.status = "waiting_gpu"
        run.queue_reason = lease.reason
        run.gpu_lease_id = lease.id
        db.commit()
        live.notify(db, "run", run.id, run.project_id, s="waiting_gpu")
        return

    run.gpu_lease_id = lease.id
    run.device = "cpu" if lease.device_id is None else "cuda:0"
    run.queue_reason = None
    db.commit()
    log.info("ран %s: просим %s МБ (%s), устройство %s",
             run.id, want, source, run.device)

    proc = subprocess.Popen(
        [sys.executable, RUNNER, "--run-id", str(run.id)],
        start_new_session=True,
    )
    run.pid = proc.pid
    db.commit()
    threading.Thread(
        target=watch_run, args=(str(run.id), proc, str(lease.id), sig),
        daemon=True,
    ).start()


def watch_run(run_id, proc, lease_id, sig):
    """Следить за процессом обучения: продлевать бронь и снимать по просьбе."""
    while proc.poll() is None and not _stop.is_set():
        db = SessionLocal()
        try:
            run = db.get(TrainRun, run_id)
            if run is None:
                break
            gpu.beat(db, lease_id, run.peak_vram_mb)
            run.lease_until = utcnow()
            db.commit()
            if run.cancel_requested and run.status != "stopping":
                run.status = "stopping"
                db.commit()
                _terminate(proc)
        except Exception:
            log.exception("не удалось продлить бронь рана %s", run_id)
        finally:
            db.close()
        time.sleep(gpu.BEAT_EVERY / 2)

    db = SessionLocal()
    try:
        run = db.get(TrainRun, run_id)
        if run is not None:
            if run.status in ("running", "preparing", "stopping"):
                # Процесс кончился, а статус не проставлен — значит его убили
                # снаружи или он умер молча.
                run.status = "stopped" if run.cancel_requested else "error"
                if run.status == "error":
                    run.error = "Процесс обучения завершился неожиданно."
                run.finished_at = utcnow()
                db.commit()
            if run.peak_vram_mb:
                gpu.remember(db, "train", sig, run.peak_vram_mb)
            live.notify(db, "run", run.id, run.project_id, s=run.status)
        gpu.release(db, lease_id)
    except Exception:
        log.exception("не удалось закрыть ран %s", run_id)
    finally:
        db.close()


def _terminate(proc, hard_after=10):
    """Снять обучение вместе со всей его группой процессов.

    Группой, а не одним pid: ultralytics поднимает загрузчики данных, и
    осиротевшие процессы держали бы и память, и карту.
    """
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        proc.terminate()
    deadline = time.time() + hard_after
    while proc.poll() is None and time.time() < deadline:
        time.sleep(0.3)
    if proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            proc.kill()


def runs_loop():
    while not _stop.is_set():
        db = SessionLocal()
        try:
            run = claim_run(db)
            if run is None:
                db.close()
                _stop.wait(IDLE_SLEEP)
                continue
            start_run(db, run)
        except Exception:
            log.exception("не удалось запустить обучение")
        finally:
            db.close()


# --------------------------------------------------------------------------- #
# Признаки кадров
# --------------------------------------------------------------------------- #
def do_embed(db, job):
    from common.models import Image
    from common import similarity

    ids = [i for i in (job.payload or {}).get("images", [])]
    if not ids:
        return
    rows = db.execute(select(Image).where(Image.id.in_(ids))).scalars().all()
    if not rows:
        return

    lease = gpu.request(
        db, holder="dataprep", kind="embed", want_mb=embed.VRAM_MB,
        ref_id=job.id, project_id=job.project_id, user_id=job.created_by,
        priority=30, allow_cpu=True, title="Признаки кадров",
    )
    if lease.status != "held":
        # Карта занята — работа возвращается в очередь и придёт снова.
        raise RuntimeError(lease.reason or "Видеокарта занята.")

    device = "cpu" if lease.device_id is None else "cuda:0"
    try:
        paths = [os.path.join(config.DATA_DIR, r.file_path) for r in rows]

        def tick(done, total):
            gpu.beat(db, lease.id)
            if not prep_queue.beat(
                db, job, processed=done, total=total,
                stage="embed", stage_text="Считаю признаки кадров",
            ):
                raise RuntimeError("Счёт признаков сняли.")

        # Пока модель грузится, полоса стоит на нуле — человек должен видеть,
        # что она стоит на скачивании весов, а не на его кадрах. Подпись
        # меняет загрузчик, а продлевает аренду отдельный поток: скачивание
        # может висеть минутами без единого байта, и без пульса бронь карты
        # истекала бы прямо под работающей работой.
        stage_text = ["Загружаю модель DINOv2"]

        def fetching(have, total):
            stage_text[0] = (
                f"Скачиваю веса DINOv2: {have >> 20} из {max(1, total) >> 20} МБ"
            )

        prep_queue.beat(db, job, processed=0, total=len(paths),
                        stage="load", stage_text=stage_text[0])
        with _pulse(lease.id, job.id, stage_text):
            vectors = embed.vectors_for(
                paths, device, on_progress=tick, on_download=fetching
            )
        similarity.save_vectors(db, list(zip([r.id for r in rows], vectors)))
        live.notify(db, "prep", job.id, job.project_id, s="done")
    finally:
        gpu.release(db, lease.id)


class _pulse:
    """Пульс на время загрузки модели: своя сессия, своя нить, раз в 20 с."""

    def __init__(self, lease_id, job_id, text):
        self.lease_id, self.job_id, self.text = lease_id, job_id, text
        self.stop = threading.Event()

    def _run(self):
        while not self.stop.wait(20):
            db = SessionLocal()
            try:
                gpu.beat(db, self.lease_id)
                job = db.get(DataprepJob, self.job_id)
                if job is not None:
                    prep_queue.beat(db, job, stage="weights"
                                    if "Скачиваю" in self.text[0] else "load",
                                    stage_text=self.text[0])
            except Exception:
                log.exception("пульс загрузки модели")
            finally:
                db.close()

    def __enter__(self):
        threading.Thread(target=self._run, name="model-pulse", daemon=True).start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        return False


def prep_loop():
    while not _stop.is_set():
        db = SessionLocal()
        job = None
        try:
            job = prep_queue.claim(db, prep_queue.GPU_KINDS, me())
            if job is None:
                db.close()
                _stop.wait(IDLE_SLEEP)
                continue
            do_embed(db, job)
            prep_queue.finish(db, job)
        except Exception as exc:  # noqa: BLE001
            log.exception("работа с признаками не удалась")
            if job is not None:
                try:
                    prep_queue.release(db, job, exc)
                except Exception:
                    log.exception("не удалось вернуть работу в очередь")
                _stop.wait(PREP_RETRY_PAUSE)
        finally:
            db.close()


# --------------------------------------------------------------------------- #
def main():
    wait_for_db()
    config.ensure_dirs()

    def bye(*_):
        log.info("остановка")
        _stop.set()

    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGINT, bye)

    threads = [
        threading.Thread(target=discover_loop, name="gpu-discover", daemon=True),
        threading.Thread(target=reaper, name="reaper", daemon=True),
        threading.Thread(target=runs_loop, name="runs", daemon=True),
        threading.Thread(target=prep_loop, name="embed", daemon=True),
    ]
    for t in threads:
        t.start()
    log.info("готов")
    while not _stop.is_set():
        time.sleep(0.5)


if __name__ == "__main__":
    main()
