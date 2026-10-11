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
from common.models import DataprepJob, GpuLease, TrainRun, TrainSet, utcnow
from common import prep_queue
from training_svc import agent_preview, agent_runner, embed, examples, trainer

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
# Карты перечислены хотя бы раз. До этого после перезапуска они выглядят молчащими,
# и обучение упало бы с «карты не отвечают», не дождавшись первой переклички.
_discovered = threading.Event()
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
            _discovered.set()
        _stop.wait(DISCOVER_EVERY)


def reap_orphans(db, fresh_start=False):
    """Закрыть обучения, которые никто не ведёт.

    Процесс обучения живёт внутри контейнера воркера и умирает вместе с ним
    при перезапуске; ран оставался «идёт» навсегда. На старте свои раны
    (``worker_id`` — это имя контейнера) закрываются сразу: вести их этому
    процессу нечем. Чужие и все прочие — по тишине дольше аренды брони.
    """
    now = utcnow()
    rows = db.execute(
        select(TrainRun).where(TrainRun.status.in_(trainer.LIVE_STATES))
    ).scalars().all()
    closed = 0
    for run in rows:
        stale = 0 if fresh_start and run.worker_id == me() else gpu.LEASE_SECONDS
        verdict = trainer.orphan_verdict(
            run.status, run.cancel_requested, trainer.beat_of(run), now, stale
        )
        if verdict is not None:
            log.warning("ран %s без исполнителя (%s) — %s", run.id, run.status, verdict)
            trainer.close_orphan(db, run, verdict, now)
            closed += 1
    return closed + agent_runner.reap_orphans(db, me(), fresh_start)


def reaper():
    while not _stop.is_set():
        db = SessionLocal()
        try:
            reap_orphans(db)
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
def waiting_runs(db):
    """Раны, которым пора идти, — все по очереди, а не один головной.

    Раньше брался только самый ранний: пока он ждал карту, следующие не
    становились даже в очередь диспетчера, и свободная вторая карта стояла."""
    return db.execute(
        select(TrainRun.id).where(TrainRun.status.in_(("queued", "waiting_gpu")))
        .order_by(TrainRun.queued_at)
    ).scalars().all()


def claim_run(db, run_id):
    """Взять ран, если его не держит другой воркер.

    Берём и ``queued``, и ``waiting_gpu``: второй уже пробовал взять карту и не
    смог, и пробовать снова должен он же, а не человек. Ждущий остаётся
    ждущим — иначе каждую секунду мигал бы «готовлю ↔ жду карту».
    """
    run = db.execute(
        select(TrainRun)
        .where(TrainRun.id == run_id, TrainRun.status.in_(("queued", "waiting_gpu")))
        .with_for_update(skip_locked=True)
    ).scalar_one_or_none()
    if run is None:
        db.rollback()
        return None
    if run.status == "queued":
        run.status = "preparing"
    run.worker_id = me()
    # Первый пульс: иначе ран, долго ждавший в очереди, сразу выглядит сиротой.
    run.lease_until = utcnow()
    db.commit()
    return run


def _fail(db, run, text):
    run.status = "error"
    run.error = text
    run.finished_at = utcnow()
    if run.gpu_lease_id:
        gpu.cancel(db, run.gpu_lease_id, text)
    db.commit()
    live.notify(db, "run", run.id, run.project_id, s="error")
    return False


def start_run(db, run) -> bool:
    """Завести обучение. ``False`` — процесса нет: ждём карту или ран снят."""
    # Человек мог нажать «Остановить», пока мы готовились: до запуска процесса
    # его просьбу читать некому, и без этой проверки мы бы завели обучение,
    # которое уже просили снять.
    if run.cancel_requested:
        run.status = "stopped"
        run.finished_at = utcnow()
        if run.gpu_lease_id:
            gpu.cancel(db, run.gpu_lease_id, "Снято автором")
        db.commit()
        live.notify(db, "run", run.id, run.project_id, s="stopped")
        return False

    tset = db.get(TrainSet, run.set_id)
    if tset is None or tset.status != "ready":
        run.status = "error"
        run.error = "Обучающий набор не готов."
        run.finished_at = utcnow()
        db.commit()
        return False

    params = run.params or {}
    imgsz, batch = params.get("imgsz", 640), params.get("batch", 16)
    gpus = max(1, int(params.get("gpus") or 1))
    want, source, sig = trainer.vram_want(db, run.base_model, run.task, imgsz, batch, gpus)
    problem = trainer.gpus_problem(batch, gpus)
    # Больше, чем карты отдают под задачи в принципе. Очередь такое не
    # рассосёт: она освобождает чужую память, а не поднимает потолок карты.
    # Раньше ран уходил в ожидание и возвращался сюда снова и снова.
    caps = gpu.capacities(db)
    roomy = sum(1 for cap in caps if cap >= want)
    if problem is None and caps and gpus == 1 and not roomy:
        problem = (f"Не поместится на карту: нужно {gpu._gb(want)}, а под задачи отдаётся "
                   f"{gpu._gb(max(caps))}. Уменьшите батч или размер входа.")
    elif problem is None and caps and roomy < gpus:
        problem = (f"Нужно карт: {gpus} по {gpu._gb(want)}, а таких на сервере {roomy}. "
                   "Уменьшите число карт, батч или размер входа.")
    if problem:
        return _fail(db, run, problem)

    # Бронь из очереди переиспользуем: новая каждую секунду обнуляла бы место в
    # очереди и «сколько ждёт». Выданную фоновой накачкой — просто берём.
    parts = [want] * gpus
    lease = db.get(GpuLease, run.gpu_lease_id) if run.gpu_lease_id else None
    same = lease is not None and [p.want_mb for p in gpu.group_of(db, lease)] == parts
    if lease is not None and lease.status == "queued" and same:
        gpu.beat(db, lease.id)
        gpu.try_grant(db, lease.id)
        db.refresh(lease)
    elif lease is None or lease.status != "held" or not same:
        if lease is not None and lease.status in gpu.ACTIVE:
            gpu.cancel(db, lease.id, "Новая попытка")
        title = f"Обучение «{run.name}»"
        if gpus > 1:
            lease = gpu.request_group(
                db, holder="training", kind="train", parts=parts, spread=True,
                labels=[f"батч {batch // gpus} на карту"] * gpus, ref_id=run.id,
                project_id=run.project_id, user_id=run.created_by, priority=40, title=title)
        else:
            lease = gpu.request(
                db, holder="training", kind="train", want_mb=want, ref_id=run.id,
                project_id=run.project_id, user_id=run.created_by, priority=40,
                allow_cpu=True, title=title)
    if lease.status == "denied":
        # Карты есть, но выключены или молчат: ждать некого (решение 10.10.2026).
        run.gpu_lease_id = lease.id
        return _fail(db, run, lease.reason or "Видеокарту не дали.")
    if lease.status != "held":
        changed = run.status != "waiting_gpu" or run.queue_reason != lease.reason
        run.status = "waiting_gpu"
        run.queue_reason = lease.reason
        run.gpu_lease_id = lease.id
        db.commit()
        if changed:
            live.notify(db, "run", run.id, run.project_id, s="waiting_gpu")
        return False

    run.gpu_lease_id = lease.id
    # Подпроцессу видны только карты брони. Одна карта внутри — cuda:0: строкой
    # «cuda:N» нельзя, ultralytics 8.4 переписывает CUDA_VISIBLE_DEVICES и всё
    # равно берёт cuda:0 — раньше любое обучение шло на первую карту. Несколько —
    # настоящими номерами «2,5»: тот же ultralytics кладёт строку в переменную для
    # дочерних процессов, и «0,1» посадило бы их на чужие карты.
    indices = gpu.group_indices(db, lease)
    visible = "" if None in indices else ",".join(str(i) for i in indices)
    env = {**os.environ, "CUDA_VISIBLE_DEVICES": visible, "MAG_RUN_ID": str(run.id)}
    run.device = "cpu" if not visible else ("cuda:0" if gpus == 1 else visible)
    run.queue_reason = None
    # Из ожидания — в «готовлю» до запуска: ждущий цикл взял бы ран снова и завёл второй процесс.
    waited = run.status == "waiting_gpu"
    run.status = "preparing"
    db.commit()
    if waited:
        live.notify(db, "run", run.id, run.project_id, s="preparing")
    log.info("ран %s: просим %s МБ (%s), карты %s",
             run.id, want, source, visible or "процессор")

    proc = subprocess.Popen(
        [sys.executable, RUNNER, "--run-id", str(run.id)],
        start_new_session=True, env=env,
    )
    run.pid = proc.pid
    db.commit()
    threading.Thread(
        target=watch_run, args=(str(run.id), proc, str(lease.id), sig),
        daemon=True,
    ).start()
    return True


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
                trainer.adopt_weights(run)
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
    _discovered.wait()
    while not _stop.is_set():
        started = False
        db = SessionLocal()
        try:
            for run_id in waiting_runs(db):
                # Сбой одного рана не должен стопорить остальных.
                try:
                    run = claim_run(db, run_id)
                    if run is not None and start_run(db, run):
                        started = True
                except Exception:
                    log.exception("не удалось запустить обучение %s", run_id)
                    db.rollback()
        except Exception:
            log.exception("не удалось прочитать очередь обучений")
        finally:
            db.close()
        # Никто не завёлся — все ждут карту. Ждать в темпе простоя: без паузы цикл
        # перебирал бы ждущих сотни раз в секунду.
        if not started:
            _stop.wait(IDLE_SLEEP)


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
    # Карта занята — ждём в очереди, как все задачи, а не жжём попытки (решение 11.10.2026).
    while lease.status == "queued" and not _stop.is_set():
        if not prep_queue.beat(db, job, stage="gpu",
                               stage_text=f"Ждёт карту: {lease.reason or 'карта занята'}"[:160]):
            break
        _stop.wait(IDLE_SLEEP)
        gpu.beat(db, lease.id)
        gpu.try_grant(db, lease.id)
        db.refresh(lease)
    if lease.status != "held":
        # Сняли или отказали: брошенную бронь накачка выдала бы никому.
        gpu.cancel(db, lease.id, "Признаки больше не ждут")
        raise RuntimeError("Счёт признаков сняли." if job.cancel_requested
                           else lease.reason or "Видеокарту не дали.")

    index = gpu.torch_index(db, lease)
    device = "cpu"
    if index is not None:
        import torch

        # Карта брони этой нити; объектом, а не строкой — см. agent_runner._device.
        torch.cuda.set_device(index)
        device = torch.device(f"cuda:{index}")
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


# Сколько прогонов агентов идёт разом, решает память карт — диспетчер. Раньше это
# решали две нити на любой сервер: на восьми картах шли два прогона. Потолок —
# страховка оперативной памяти контейнера: каждый прогон держит свои модели.
AGENT_MAX = max(1, int(os.environ.get("AGENT_MAX", "8")))


def agents_loop():
    """Очередь прогонов агентов: каждый ждущий пробует взять карту по очереди,
    кому дали — уходит в свою нить. Прогон по тысяче кадров не держит ни
    обучение, ни счёт признаков: у каждого своя очередь к карте."""
    _discovered.wait()
    while not _stop.is_set():
        started = False
        db = SessionLocal()
        try:
            for run_id in agent_runner.candidates(db):
                if agent_runner.running() >= AGENT_MAX:
                    break
                ctx = None
                try:
                    run = agent_runner.claim(db, run_id, me())
                    if run is not None:
                        ctx = agent_runner.prepare(db, run)
                except Exception:
                    log.exception("прогон агента %s не завёлся", run_id)
                    db.rollback()
                if ctx is None:
                    agent_runner.release(run_id)
                    continue
                threading.Thread(target=_agent_run, args=(run_id, ctx),
                                 name=f"agent-{str(run_id)[:8]}", daemon=True).start()
                started = True
        except Exception:
            log.exception("не удалось прочитать очередь агентов")
        finally:
            db.close()
        # Никто не завёлся — ждём в темпе простоя, иначе цикл перебирал бы
        # ждущие прогоны сотни раз в секунду.
        if not started:
            _stop.wait(IDLE_SLEEP)


def _agent_run(run_id, ctx):
    db = SessionLocal()
    try:
        agent_runner.run_held(db, run_id, ctx)
    except Exception:
        log.exception("прогон агента %s не удался", run_id)
    finally:
        agent_runner.release(run_id)
        db.close()


def prep_loop():
    _discovered.wait()
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
                    db.rollback()
                    db.refresh(job)
                    if job.cancel_requested:
                        # Сняли («Снять» на «Оборудовании») — новая попытка была бы против воли.
                        prep_queue.finish(db, job, cancelled=True)
                    else:
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
    db = SessionLocal()
    try:
        reap_orphans(db, fresh_start=True)
    except Exception:
        log.exception("не удалось закрыть осиротевшие обучения")
    finally:
        db.close()

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
        threading.Thread(target=agents_loop, name="agents", daemon=True),
        threading.Thread(target=agent_preview.loop, args=(_stop,), name="agent-preview", daemon=True),
        threading.Thread(target=examples.loop, args=(_stop,), name="agent-examples", daemon=True),
    ]
    for t in threads:
        t.start()
    log.info("готов")
    while not _stop.is_set():
        time.sleep(0.5)


if __name__ == "__main__":
    main()
