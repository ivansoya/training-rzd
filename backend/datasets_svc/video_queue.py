"""Очередь тяжёлой работы над роликом.

Раньше нарезку заводил ``threading.Thread`` прямо в обработчике запроса. Это
стоило трёх бед сразу. Она делила восемь потоков gunicorn со всем остальным
API, поэтому пятеро разметчиков, открывших холодный ролик, останавливали
проект целиком — вместе со списком тасок и сохранением боксов. Она не
переживала перезапуск: ролик, застигнутый рестартом, оставался недорезанным
навсегда. И она ничего не помнила об отказе, поэтому битый ролик заводил новую
нарезку на каждое движение разметчика по таймлайну.

Очередь лежит в базе. Её видят все процессы разом, она переживает рестарт, а
упавшая работа не повторяется, пока не остынет. Задачу берут через
``FOR UPDATE SKIP LOCKED``: воркеры не ждут друг друга и не берут одно и то же.

Порядок работ — это не украшение, а обещание разметчику. Первым идёт то, без
чего ролик не открыть, потом то, чего человек ждёт прямо сейчас, и только
потом фоновая подготовка ступеней. Иначе перегон, на который смотрит живой
человек, встал бы в очередь за четырёхминутным перекодированием чужого ролика.
"""
import os
from datetime import timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError

from common.models import VideoAsset, VideoJob, utcnow

KIND_INDEX = "index"
KIND_STRIP = "strip"
KIND_VARIANT = "variant"
KIND_CHUNKSET = "chunkset"
KIND_CHUNK = "chunk"

# Меньше число — раньше очередь. Значения с зазором: между ступенью по
# умолчанию и остальными есть место, и добавить работу посередине можно, не
# перенумеровывая всё.
PRIORITY = {
    KIND_INDEX: 10,     # без таблицы кадров ролик не открывается вовсе
    KIND_CHUNK: 20,     # перегон, на который прямо сейчас смотрит человек
    KIND_STRIP: 25,     # кинолента под таймлайном
    KIND_VARIANT: 30,   # полная копия ступени
    KIND_CHUNKSET: 40,  # все перегоны ступени
}

# Быстрые работы — секунды, и их кто-то ждёт. Медленные — минуты, и их никто
# не ждёт. Пулы разделены жёстко: будь он общий, все воркеры однажды оказались
# бы заняты копиями, и живой запрос перегона встал бы за ними.
FAST_KINDS = (KIND_INDEX, KIND_CHUNK)
SLOW_KINDS = (KIND_STRIP, KIND_VARIANT, KIND_CHUNKSET)

# Три попытки: первая могла попасть на перезапуск, вторая — на нехватку места.
# Третья означает, что дело в самом ролике.
MAX_ATTEMPTS = int(os.environ.get("VIDEO_JOB_ATTEMPTS", "3"))
# Срок аренды. Воркер продлевает его, пока работает; просроченная задача
# возвращается в очередь — так падение воркера посреди нарезки не оставляет
# её в «running» навсегда.
LEASE_SECONDS = int(os.environ.get("VIDEO_JOB_LEASE", "120"))
# Сколько задача помнит свой отказ. Ровно эта память и отличает «не смогли» от
# «долбим до последнего»: без неё сломанный ролик сам себя ддосит.
COOLDOWN_SECONDS = int(os.environ.get("VIDEO_JOB_COOLDOWN", "300"))

ACTIVE = ("queued", "running")


def _target(query, video_id, kind, quality, chunk_no):
    return query.where(
        VideoJob.video_id == video_id,
        VideoJob.kind == kind,
        VideoJob.quality == quality,
        VideoJob.chunk_no == chunk_no,
    )


def find_active(db, video_id, kind, quality="", chunk_no=-1):
    return db.execute(
        _target(select(VideoJob), video_id, kind, quality, chunk_no)
        .where(VideoJob.status.in_(ACTIVE))
    ).scalar_one_or_none()


def last_failure(db, video_id, kind, quality="", chunk_no=-1):
    """Последний отказ этой работы, если он ещё не остыл."""
    since = utcnow() - timedelta(seconds=COOLDOWN_SECONDS)
    return db.execute(
        _target(select(VideoJob), video_id, kind, quality, chunk_no)
        .where(VideoJob.status == "error", VideoJob.finished_at >= since)
        .order_by(VideoJob.finished_at.desc())
        .limit(1)
    ).scalar_one_or_none()


def enqueue(db, video_id, kind, quality="", chunk_no=-1, priority=None, total=0):
    """Поставить работу в очередь.

    Возвращает задачу — новую или уже стоящую. ``None`` значит «эта работа
    недавно провалилась и повторять её рано»: вызывающий покажет человеку
    причину вместо того, чтобы бесконечно просить одно и то же.
    """
    active = find_active(db, video_id, kind, quality, chunk_no)
    if active is not None:
        return active
    failed = last_failure(db, video_id, kind, quality, chunk_no)
    if failed is not None:
        return None

    job = VideoJob(
        video_id=video_id,
        kind=kind,
        quality=quality,
        chunk_no=chunk_no,
        priority=PRIORITY[kind] if priority is None else priority,
        total=total,
    )
    db.add(job)
    try:
        db.commit()
    except IntegrityError:
        # Такую же работу успели поставить между проверкой и вставкой —
        # уникальный индекс поймал повтор. Это не ошибка, а гонка, и правильный
        # ответ на неё — чужая задача.
        db.rollback()
        return find_active(db, video_id, kind, quality, chunk_no)
    return job


def claim(db, kinds):
    """Взять следующую работу. ``None`` — очередь этого пула пуста.

    ``SKIP LOCKED`` пропускает строки, которые уже держит другой воркер:
    иначе второй воркер ждал бы первого, вместо того чтобы взять следующую.
    """
    job = db.execute(
        select(VideoJob)
        .where(VideoJob.status == "queued", VideoJob.kind.in_(kinds))
        .order_by(VideoJob.priority, VideoJob.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    ).scalar_one_or_none()
    if job is None:
        return None
    job.status = "running"
    job.attempts += 1
    job.started_at = utcnow()
    job.lease_until = utcnow() + timedelta(seconds=LEASE_SECONDS)
    db.commit()
    return job


def beat(db, job, processed=None, total=None):
    """Продлить аренду и заодно отметить, куда дошли."""
    job.lease_until = utcnow() + timedelta(seconds=LEASE_SECONDS)
    if processed is not None:
        job.progress = int(processed)
    if total is not None:
        job.total = int(total)
    db.commit()


def finish(db, job, error=None):
    job.status = "error" if error else "done"
    job.error = str(error)[:2000] if error else None
    job.finished_at = utcnow()
    job.lease_until = None
    db.commit()


def release(db, job, error):
    """Вернуть задачу в очередь после сбоя — или похоронить, если попыток
    больше нет. Разница важная: перезапуск воркера не должен выглядеть как
    битый ролик, а битый ролик не должен выглядеть как перезапуск."""
    if job.attempts >= MAX_ATTEMPTS:
        finish(db, job, error)
        return False
    job.status = "queued"
    job.error = str(error)[:2000] if error else None
    job.lease_until = None
    job.started_at = None
    db.commit()
    return True


def reap(db):
    """Вернуть в очередь всё, чья аренда истекла.

    Так выглядит падение воркера снаружи: задача осталась в «running», но её
    никто не продлевает. Через срок аренды она снова чья-то.
    """
    stale = db.execute(
        select(VideoJob).where(
            VideoJob.status == "running",
            or_(VideoJob.lease_until.is_(None), VideoJob.lease_until < utcnow()),
        )
    ).scalars().all()
    for job in stale:
        release(db, job, "Работа прервана: воркер не отозвался в срок.")
    return len(stale)


# --------------------------------------------------------------------------- #
# Что видно снаружи
# --------------------------------------------------------------------------- #
def assets(db, video_id):
    return db.execute(
        select(VideoAsset).where(VideoAsset.video_id == video_id)
    ).scalars().all()


def asset(db, video_id, quality):
    return db.execute(
        select(VideoAsset).where(
            VideoAsset.video_id == video_id, VideoAsset.quality == quality
        )
    ).scalar_one_or_none()


def ensure_asset(db, video_id, quality):
    """Строка ступени; заводится при первом обращении к качеству."""
    row = asset(db, video_id, quality)
    if row is not None:
        return row
    row = VideoAsset(video_id=video_id, quality=quality)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return asset(db, video_id, quality)
    return row


def progress_of(db, video_id, kinds=None):
    """Что сейчас делается с роликом — для полосы «готовлю видео».

    Берётся самая срочная незаконченная работа: человеку нужен один понятный
    ответ, а не список из шести строк.
    """
    query = select(VideoJob).where(
        VideoJob.video_id == video_id, VideoJob.status.in_(ACTIVE)
    )
    if kinds:
        query = query.where(VideoJob.kind.in_(kinds))
    job = db.execute(
        query.order_by(VideoJob.priority, VideoJob.created_at).limit(1)
    ).scalar_one_or_none()
    if job is None:
        return None
    return {
        "kind": job.kind,
        "quality": job.quality or None,
        "status": job.status,
        "processed": job.progress,
        "total": job.total,
    }


def pending_count(db, video_id=None):
    query = select(func.count(VideoJob.id)).where(VideoJob.status.in_(ACTIVE))
    if video_id is not None:
        query = query.where(VideoJob.video_id == video_id)
    return int(db.execute(query).scalar() or 0)
