"""Очередь подготовки данных. Тот же уклад, что у очереди видео.

Приёмы здесь не выдуманы заново, и это нарочно: аренда с продлением, взятие
через ``FOR UPDATE SKIP LOCKED``, три попытки и память об отказе уже проверены
на нарезке роликов. Второй свод правил для той же задачи разошёлся бы с первым
на первой же правке.

Своя таблица, а не общая с видео: у той своя цель (ролик) и свой набор работ, и
сращивание потребовало бы ссылки, которую база всё равно не проверит.
"""
import os
from datetime import timedelta

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError

from common.models import DataprepJob, utcnow

KIND_BUILD = "build_set"
KIND_EMBED = "embed"
KIND_DELETE = "delete_set"

# Меньше число — раньше очередь. Признаки идут вперёд сборки: их ждёт человек,
# застрявший на шаге деления, а сборку он уже запустил и ушёл.
PRIORITY = {
    KIND_EMBED: 30,
    KIND_BUILD: 40,
    KIND_DELETE: 60,
}

# Работы, которым нужна видеокарта, берёт воркер обучения: torch стоит в одном
# образе, а не в двух.
CPU_KINDS = (KIND_BUILD, KIND_DELETE)
GPU_KINDS = (KIND_EMBED,)

MAX_ATTEMPTS = int(os.environ.get("DATAPREP_ATTEMPTS", "3"))
LEASE_SECONDS = int(os.environ.get("DATAPREP_LEASE", "180"))
COOLDOWN_SECONDS = int(os.environ.get("DATAPREP_COOLDOWN", "300"))

ACTIVE = ("queued", "running")


def find_active(db, kind, target_id):
    return db.execute(
        select(DataprepJob).where(
            DataprepJob.kind == kind,
            DataprepJob.target_id == target_id,
            DataprepJob.status.in_(ACTIVE),
        )
    ).scalar_one_or_none()


def last_failure(db, kind, target_id):
    """Последний отказ этой работы, если он ещё не остыл."""
    since = utcnow() - timedelta(seconds=COOLDOWN_SECONDS)
    return db.execute(
        select(DataprepJob).where(
            DataprepJob.kind == kind,
            DataprepJob.target_id == target_id,
            DataprepJob.status == "error",
            DataprepJob.finished_at >= since,
        ).order_by(DataprepJob.finished_at.desc()).limit(1)
    ).scalar_one_or_none()


def last_error(db, kind, target_id):
    """Последний отказ этой работы, сколько бы времени ни прошло.

    Экрану нужно и то, что было давно: полоса на нуле без слова о причине —
    это и есть «нажал, и ничего не происходит».
    """
    return db.execute(
        select(DataprepJob).where(
            DataprepJob.kind == kind,
            DataprepJob.target_id == target_id,
            DataprepJob.status == "error",
        ).order_by(DataprepJob.finished_at.desc()).limit(1)
    ).scalar_one_or_none()


def enqueue(db, *, project_id, kind, target_id, payload=None, total=0,
            user_id=None, priority=None, force=False):
    """Поставить работу. ``None`` — «недавно провалилась, повторять рано».

    Память об отказе тут не роскошь: битый кадр иначе заводил бы новую сборку
    на каждое обновление страницы. ``force`` её обходит — для явного «повторить»
    от человека: он уже прочитал причину и решил попробовать ещё раз.
    """
    active = find_active(db, kind, target_id)
    if active is not None:
        return active
    if not force and last_failure(db, kind, target_id) is not None:
        return None

    job = DataprepJob(
        project_id=project_id, kind=kind, target_id=target_id,
        payload=payload, total=int(total), created_by=user_id,
        priority=PRIORITY[kind] if priority is None else priority,
    )
    db.add(job)
    try:
        db.commit()
    except IntegrityError:
        # Такую же работу успели поставить между проверкой и вставкой —
        # уникальный индекс поймал повтор. Это гонка, а не ошибка.
        db.rollback()
        return find_active(db, kind, target_id)
    return job


def claim(db, kinds, worker_id):
    """Взять следующую работу. ``None`` — очередь этого пула пуста."""
    job = db.execute(
        select(DataprepJob)
        .where(DataprepJob.status == "queued", DataprepJob.kind.in_(kinds))
        .order_by(DataprepJob.priority, DataprepJob.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    ).scalar_one_or_none()
    if job is None:
        return None
    job.status = "running"
    job.attempts += 1
    job.worker_id = worker_id
    job.started_at = utcnow()
    job.lease_until = utcnow() + timedelta(seconds=LEASE_SECONDS)
    db.commit()
    return job


def beat(db, job, processed=None, total=None, stage=None, stage_text=None):
    """Продлить аренду и заодно отметить, куда дошли.

    Возвращает ``False``, если работу попросили снять: флаг читается тем же
    запросом, что и продление, — одна поездка в базу на пачку.
    """
    db.refresh(job)
    job.lease_until = utcnow() + timedelta(seconds=LEASE_SECONDS)
    if processed is not None:
        job.progress = int(processed)
    if total is not None:
        job.total = int(total)
    if stage is not None:
        job.stage = stage
    if stage_text is not None:
        job.stage_text = stage_text
    db.commit()
    return not job.cancel_requested


def finish(db, job, error=None, cancelled=False):
    job.status = "cancelled" if cancelled else ("error" if error else "done")
    job.error = str(error)[:2000] if error else None
    job.finished_at = utcnow()
    job.lease_until = None
    db.commit()


def release(db, job, error):
    """Вернуть работу в очередь после сбоя — или похоронить.

    Разница важная: перезапуск воркера не должен выглядеть как битый набор, а
    битый набор не должен выглядеть как перезапуск.
    """
    if job.attempts >= MAX_ATTEMPTS:
        finish(db, job, error)
        return False
    job.status = "queued"
    job.error = str(error)[:2000] if error else None
    job.lease_until = None
    job.started_at = None
    db.commit()
    return True


def reap(db) -> int:
    """Вернуть в очередь всё, чья аренда истекла.

    Так выглядит падение воркера снаружи: работа осталась в «running», но её
    никто не продлевает.
    """
    stale = db.execute(
        select(DataprepJob).where(
            DataprepJob.status == "running",
            or_(
                DataprepJob.lease_until.is_(None),
                DataprepJob.lease_until < utcnow(),
            ),
        )
    ).scalars().all()
    for job in stale:
        release(db, job, "Работа прервана: воркер не отозвался в срок.")
    return len(stale)


def cancel(db, job_id) -> bool:
    """Попросить снять работу.

    Флагом в базе, а не сигналом: воркер живёт в отдельном контейнере, и
    послать ему что-либо другое нечем.
    """
    job = db.get(DataprepJob, job_id)
    if job is None or job.status not in ACTIVE:
        return False
    job.cancel_requested = True
    if job.status == "queued":
        # Ещё не начали — снимаем сразу, ждать воркера незачем.
        finish(db, job, cancelled=True)
    else:
        db.commit()
    return True


def progress_of(db, kind, target_id):
    """Что сейчас делается с этой целью — для полосы на экране."""
    job = db.execute(
        select(DataprepJob).where(
            DataprepJob.kind == kind,
            DataprepJob.target_id == target_id,
            DataprepJob.status.in_(ACTIVE),
        ).order_by(DataprepJob.created_at.desc()).limit(1)
    ).scalar_one_or_none()
    if job is None:
        return None
    return {
        "id": str(job.id),
        "kind": job.kind,
        "status": job.status,
        "processed": job.progress,
        "total": job.total,
        "stage": job.stage,
        "stage_text": job.stage_text,
    }
