"""Диспетчер видеокарт: кто держит память и кто ждёт.

Карта одна на всех, и делят её три контейнера — обучение, полуавтомат и (через
заказ признаков) подготовка данных. Общей памяти у них нет, а решать про
допуск они обязаны согласованно, поэтому состояние лежит в базе.

Три вещи, ради которых это написано именно так.

**Бронь — строка, а не счётчик.** Счётчик нельзя просрочить: процесс, убитый
посреди обучения, унёс бы память навсегда. У строки есть ``lease_until``, и
через срок аренды она возвращается сама. Тот же приём, что в ``video_queue``,
и там он уже доказал, что работает.

**Допуск считается чистой функцией.** ``fits`` не знает ни про базу, ни про
торч, и закрывается таблицей случаев без видеокарты вовсе. Всё остальное здесь
— это SQL вокруг неё.

**Ожидание всегда объяснено.** У брони есть ``reason``, готовый к показу
целиком: «свободно 2,1 ГБ из нужных 6,4». Молчаливое ожидание — худший ответ
из возможных: человек не знает, ждать ему или уменьшать батч, а это разные
действия.
"""
import os
import socket
import subprocess
from datetime import timedelta, timezone

from sqlalchemy import func, select

# Правила допуска зовут как gpu.fits и gpu.signature — снаружи диспетчер один,
# а то, что его считающее ядро лежит отдельно, знают только тесты.
from common.gpu_rules import (  # noqa: F401
    _gb, choose_row, fits, fresh_enough, ghosts_of, signature,
)
from common.models import (
    GpuDevice, GpuLease, GpuUsageHint, ModelCheck, TrainRun, utcnow,
)

# Аренда и её продление. Аренда вчетверо длиннее удара сердца: одна пропущенная
# отметка (заминка на томе, сборка мусора) не должна отнимать карту.
LEASE_SECONDS = int(os.environ.get("GPU_LEASE", "120"))
BEAT_EVERY = float(os.environ.get("GPU_BEAT", "30"))
# Брошенная очередь: вкладку закрыли, а бронь осталась стоять.
QUEUE_TTL = int(os.environ.get("GPU_QUEUE_TTL", "3600"))
# Сколько ждёт бронь, прежде чем начать придерживать место под себя. Без этого
# крупное обучение не стартует никогда: мелкие работы будут пролезать вперёд
# бесконечно, и каждая по отдельности будет права.
STARVE_SECONDS = int(os.environ.get("GPU_STARVE", "600"))

# Работы под потолком «сколько тяжёлых на карту». Обучение — да: два по памяти
# влезут, но станут вдвое медленнее каждое, и оба человека решат, что сервер
# сломался. Признаки и проверка ролика короткие, их пускаем по памяти.
HEAVY_KINDS = ("train",)

# Карта, которую воркер давно не перечислял, для допуска не существует.
# Без этого пересозданный контейнер оставлял в таблице призрака: 07.09.2026
# одна RTX 3060 значилась тремя, и диспетчер честно был готов пустить на неё
# три обучения. Экран железа призраков показывает — с давностью.
STALE_SECONDS = int(os.environ.get("GPU_STALE", "300"))

ACTIVE = ("queued", "held")


def host_name() -> str:
    return os.environ.get("GPU_HOST") or socket.gethostname()


def _aware(dt):
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


# --------------------------------------------------------------------------- #
# Перечисление карт
# --------------------------------------------------------------------------- #
def discover(db, host=None):
    """Записать карты, какими их видит этот процесс.

    Зовут только те, у кого есть torch и доступ к железу. HTTP-сервис карт не
    перечисляет: он читает таблицу, поэтому экран железа отвечает даже когда
    воркер лежит, и честно пишет, как давно карта отзывалась.

    Машина без карт — конфигурация, а не ошибка: список приходит пустым, и всё
    уезжает на процессор.
    """
    host = host or host_name()
    found = []
    try:
        import torch

        if torch.cuda.is_available():
            uuids = _smi_uuids()
            for i in range(torch.cuda.device_count()):
                props = torch.cuda.get_device_properties(i)
                found.append({
                    "index": i,
                    "name": props.name,
                    "total_mb": int(props.total_memory // (1024 * 1024)),
                    "uuid": str(getattr(props, "uuid", "") or "")
                    or (uuids[i] if i < len(uuids) else None),
                })
    except Exception:
        found = []

    ids = []
    for item in found:
        rows = db.execute(select(GpuDevice)).scalars().all()
        row = choose_row(rows, item, host)
        if row is None:
            row = GpuDevice(
                host=host,
                device_index=item["index"],
                uuid_str=item["uuid"],
                name=item["name"],
                total_mb=item["total_mb"],
            )
            db.add(row)
        else:
            # Потолки и бронь ставит человек — перезапуск контейнера их не
            # сбрасывает. Обновляем только то, что говорит железо.
            row.host = host
            row.device_index = item["index"]
            row.name = item["name"]
            row.total_mb = item["total_mb"]
            if item["uuid"]:
                row.uuid_str = item["uuid"]
        row.seen_at = utcnow()
        db.flush()
        ids.append(row.id)
        # Призраки той же карты — записи, оставшиеся от прежних имён
        # контейнера, — выключаются: брони на них ссылаются, удалять нельзя.
        for ghost in ghosts_of(rows, row, item):
            ghost.enabled = False
    db.commit()
    return ids


def _smi_uuids():
    """UUID карт от nvidia-smi по порядку индексов. torch 2.3 их не отдаёт."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [line.strip() for line in out.splitlines() if line.strip()]


# --------------------------------------------------------------------------- #
# Оценка расхода
# --------------------------------------------------------------------------- #
def estimate(db, kind, sig, fallback_mb):
    """Сколько просить. Возвращает (МБ, откуда взяли).

    Первый запуск каждой новой тройки идёт по прикидке, и она будет мимо.
    Замер по ходу превращает её в знание — со второго раза просим по факту.
    """
    hint = db.get(GpuUsageHint, (kind, sig))
    if hint is not None and hint.samples > 0:
        return int(hint.high_mb), "по опыту"
    return int(fallback_mb), "прикидка"


def remember(db, kind, sig, peak_mb):
    """Запомнить фактический расход.

    Растёт мгновенно, оседает медленно, и асимметрия нарочная: недооценка
    стоит нехватки памяти посреди трёхчасового обучения, переоценка — минут
    ожидания. Хвост дороже середины.
    """
    peak_mb = int(peak_mb or 0)
    if peak_mb <= 0:
        return
    hint = db.get(GpuUsageHint, (kind, sig))
    if hint is None:
        hint = GpuUsageHint(
            kind=kind, signature=sig, samples=0,
            high_mb=peak_mb, last_mb=peak_mb, updated_at=utcnow(),
        )
        db.add(hint)
    hint.samples += 1
    hint.last_mb = peak_mb
    hint.high_mb = max(peak_mb, int(round(hint.high_mb * 0.95)))
    hint.updated_at = utcnow()
    db.commit()


# --------------------------------------------------------------------------- #
# Бронь
# --------------------------------------------------------------------------- #
def request(db, *, holder, kind, want_mb, ref_id=None, project_id=None,
            user_id=None, priority=50, allow_cpu=False, title=None):
    """Попросить память. Возвращает бронь — выданную, стоящую или отказанную."""
    lease = GpuLease(
        holder=holder, kind=kind, ref_id=ref_id, project_id=project_id,
        user_id=user_id, want_mb=int(want_mb), queue_priority=priority,
        title=title, status="queued",
    )
    db.add(lease)
    db.commit()

    if not _any_device(db):
        # Карт нет вовсе. Для работы, которая умеет на процессоре, это не
        # отказ, а разрешение: диспетчер просто ничего не ограничивает.
        lease.status = "held" if allow_cpu else "denied"
        lease.granted_mb = 0
        lease.granted_at = utcnow() if allow_cpu else None
        lease.lease_until = (
            utcnow() + timedelta(seconds=LEASE_SECONDS) if allow_cpu else None
        )
        lease.reason = None if allow_cpu else "На сервере нет видеокарт."
        db.commit()
        return lease

    try_grant(db, lease.id)
    db.refresh(lease)
    return lease


def _fresh(row, now=None):
    """Карту перечисляли недавно — она есть."""
    return fresh_enough(_aware(row.seen_at), now or utcnow(), STALE_SECONDS)


def _any_device(db) -> bool:
    now = utcnow()
    return any(
        _fresh(row, now) for row in db.execute(
            select(GpuDevice).where(GpuDevice.enabled)
        ).scalars()
    )


def _load_state(db, lock=True, include_stale=False):
    """Карты плюс всё, что на них сейчас лежит.

    Блокируем все карты разом и всегда в порядке номера. Это не
    перестраховка: между подсчётом свободного и вставкой брони помещается
    чужая бронь, а одинаковый порядок исключает встречную блокировку двух
    процессов.
    """
    query = select(GpuDevice).where(GpuDevice.enabled).order_by(
        GpuDevice.device_index
    )
    if lock:
        query = query.with_for_update()
    devices = db.execute(query).scalars().all()
    now = utcnow()
    if not include_stale:
        devices = [d for d in devices if _fresh(d, now)]
    held, heavy = {}, {}
    for row in db.execute(
        select(GpuLease).where(GpuLease.status == "held")
    ).scalars():
        if row.device_id is None:
            continue
        if row.lease_until is not None and _aware(row.lease_until) < now:
            continue  # просрочена: её вернёт reap, место уже не считаем
        held[row.device_id] = held.get(row.device_id, 0) + row.granted_mb
        if row.kind in HEAVY_KINDS:
            heavy[row.device_id] = heavy.get(row.device_id, 0) + 1
    return devices, held, heavy


def _pledged(db, lease):
    """Память, придержанная под тех, кто ждёт дольше этой брони."""
    cutoff = utcnow() - timedelta(seconds=STARVE_SECONDS)
    rows = db.execute(
        select(GpuLease).where(
            GpuLease.status == "queued",
            GpuLease.id != lease.id,
            GpuLease.created_at <= cutoff,
            GpuLease.created_at < lease.created_at,
        )
    ).scalars().all()
    return sum(r.want_mb for r in rows)


def try_grant(db, lease_id) -> bool:
    """Выдать бронь, если влезает. False — осталась в очереди, причина записана."""
    lease = db.get(GpuLease, lease_id)
    if lease is None or lease.status != "queued":
        return False

    devices, held, heavy = _load_state(db)
    if not devices:
        db.commit()
        return False

    pledged = _pledged(db, lease)
    heavy_request = lease.kind in HEAVY_KINDS
    reasons = []
    for dev in devices:
        why = fits(
            total_mb=dev.total_mb,
            reserved_mb=dev.reserved_mb,
            sam2_mb=dev.sam2_reserve_mb,
            held_mb=held.get(dev.id, 0),
            pledged_mb=pledged,
            heavy=heavy.get(dev.id, 0),
            max_heavy=dev.max_heavy,
            want_mb=lease.want_mb,
            heavy_request=heavy_request,
        )
        if why is None:
            lease.device_id = dev.id
            lease.granted_mb = lease.want_mb
            lease.status = "held"
            lease.granted_at = utcnow()
            lease.lease_until = utcnow() + timedelta(seconds=LEASE_SECONDS)
            lease.reason = None
            db.commit()
            return True
        reasons.append(f"карта {dev.device_index}: {why}")

    lease.reason = "; ".join(reasons)[:200]
    db.commit()
    return False


def pump(db, limit=32) -> int:
    """Раздать освободившееся место очереди.

    Идём по очереди, но на неудаче не останавливаемся: мелкая работа должна
    уехать на свободную вторую карту, а не стоять за крупной, которая ждёт
    первую. От бесконечного обгона крупных защищает ``_pledged``.
    """
    queued = db.execute(
        select(GpuLease).where(GpuLease.status == "queued")
        .order_by(GpuLease.queue_priority, GpuLease.created_at)
        .limit(limit)
    ).scalars().all()
    granted = 0
    for lease in queued:
        if try_grant(db, lease.id):
            granted += 1
    return granted


def beat(db, lease_id, peak_mb=None):
    lease = db.get(GpuLease, lease_id)
    if lease is None or lease.status != "held":
        return
    lease.lease_until = utcnow() + timedelta(seconds=LEASE_SECONDS)
    if peak_mb is not None:
        lease.peak_mb = max(lease.peak_mb or 0, int(peak_mb))
    db.commit()


def release(db, lease_id, peak_mb=None):
    lease = db.get(GpuLease, lease_id)
    if lease is None or lease.status in ("released", "expired", "cancelled"):
        return
    if peak_mb is not None:
        lease.peak_mb = max(lease.peak_mb or 0, int(peak_mb))
    lease.status = "released"
    lease.released_at = utcnow()
    lease.lease_until = None
    db.commit()
    pump(db)


def cancel(db, lease_id, reason="Снято"):
    lease = db.get(GpuLease, lease_id)
    if lease is None or lease.status not in ACTIVE:
        return
    lease.status = "cancelled"
    lease.reason = reason[:200]
    lease.released_at = utcnow()
    lease.lease_until = None
    db.commit()
    pump(db)


def reap(db) -> int:
    """Вернуть память, которую держит призрак, и убрать брошенную очередь."""
    now = utcnow()
    freed = 0
    for lease in db.execute(
        select(GpuLease).where(GpuLease.status == "held")
    ).scalars():
        if lease.lease_until is not None and _aware(lease.lease_until) < now:
            lease.status = "expired"
            lease.released_at = now
            lease.reason = "Держатель не отозвался в срок."
            freed += 1
    stale = now - timedelta(seconds=QUEUE_TTL)
    for lease in db.execute(
        select(GpuLease).where(
            GpuLease.status == "queued", GpuLease.created_at < stale
        )
    ).scalars():
        lease.status = "cancelled"
        lease.reason = "Никто не ждёт эту работу."
        freed += 1
    if freed:
        db.commit()
        pump(db)
    return freed


# --------------------------------------------------------------------------- #
# Что видно снаружи
# --------------------------------------------------------------------------- #
def devices_view(db):
    devices, held, heavy = _load_state(db, lock=False, include_stale=True)
    out = []
    for dev in devices:
        used = held.get(dev.id, 0)
        rows = db.execute(
            select(GpuLease).where(
                GpuLease.device_id == dev.id, GpuLease.status == "held"
            ).order_by(GpuLease.granted_at)
        ).scalars().all()
        out.append({
            "id": str(dev.id),
            "host": dev.host,
            "index": dev.device_index,
            "name": dev.name,
            "total_mb": dev.total_mb,
            "reserved_mb": dev.reserved_mb,
            "sam2_reserve_mb": dev.sam2_reserve_mb,
            "max_heavy": dev.max_heavy,
            "held_mb": used,
            "free_mb": max(
                0, dev.total_mb - dev.reserved_mb - dev.sam2_reserve_mb - used
            ),
            "heavy": heavy.get(dev.id, 0),
            "seen_at": dev.seen_at.isoformat() if dev.seen_at else None,
            "holders": [
                {
                    "id": str(r.id),
                    "kind": r.kind,
                    "title": r.title,
                    "granted_mb": r.granted_mb,
                    "peak_mb": r.peak_mb,
                    "user_id": str(r.user_id) if r.user_id else None,
                }
                for r in rows
            ],
        })
    return out


def _earlier_than(lease):
    """«Раньше в очереди»: сперва приоритет, потом время постановки."""
    return (
        (GpuLease.queue_priority < lease.queue_priority)
        | (
            (GpuLease.queue_priority == lease.queue_priority)
            & (GpuLease.created_at < lease.created_at)
        )
    )


def position_of(db, lease_id):
    lease = db.get(GpuLease, lease_id)
    if lease is None or lease.status != "queued":
        return None
    ahead = db.execute(
        select(func.count(GpuLease.id)).where(
            GpuLease.status == "queued", _earlier_than(lease)
        )
    ).scalar()
    return int(ahead or 0) + 1


def queue_view(db, *, user_id=None, staff=False):
    """Очередь глазами человека.

    Свои строки видит каждый — иначе ожидание необъяснимо. Чужие подробности
    видит только обслуживание: кто именно занял карту, обычному человеку знать
    незачем, а вот «впереди двое» знать надо.
    """
    rows = db.execute(
        select(GpuLease).where(GpuLease.status == "queued")
        .order_by(GpuLease.queue_priority, GpuLease.created_at)
    ).scalars().all()
    now = utcnow()
    mine, everything = [], []
    for i, r in enumerate(rows, 1):
        item = {
            "id": str(r.id),
            "position": i,
            "kind": r.kind,
            "title": r.title,
            "want_mb": r.want_mb,
            "waiting_seconds": int((now - _aware(r.created_at)).total_seconds()),
            "reason": r.reason,
            "mine": bool(user_id and r.user_id == user_id),
            "user_id": str(r.user_id) if r.user_id else None,
        }
        everything.append(item)
        if item["mine"]:
            mine.append(item)
    return {
        "mine": mine,
        "ahead": (mine[0]["position"] - 1) if mine else 0,
        "total": len(rows),
        "queue": everything if staff else [],
    }


def set_limits(db, device_id, *, reserved_mb=None, max_heavy=None, enabled=None):
    dev = db.get(GpuDevice, device_id)
    if dev is None:
        return None
    if reserved_mb is not None:
        dev.reserved_mb = max(0, int(reserved_mb))
    if max_heavy is not None:
        dev.max_heavy = max(1, int(max_heavy))
    if enabled is not None:
        dev.enabled = bool(enabled)
    db.commit()
    pump(db)
    return dev


def kill(db, lease_id) -> bool:
    """Снять задачу с карты.

    Ничего не убивает сам: ставит флаг отмены тому, кто держит бронь, а
    процесс убивает уже его воркер. Стрелять по чужому pid из чужого
    контейнера нельзя, и делать вид, что можно, — тоже.
    """
    lease = db.get(GpuLease, lease_id)
    if lease is None or lease.ref_id is None:
        return False
    for model in (TrainRun, ModelCheck):
        row = db.get(model, lease.ref_id)
        if row is not None:
            row.cancel_requested = True
            db.commit()
            return True
    cancel(db, lease_id, "Снято обслуживанием")
    return True
