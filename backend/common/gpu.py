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
from sqlalchemy.exc import IntegrityError

# Правила допуска зовут как gpu.fits и gpu.signature — снаружи диспетчер один,
# а то, что его считающее ядро лежит отдельно, знают только тесты.
import uuid

from common.gpu_rules import (  # noqa: F401
    _gb, choose_row, fits, for_tasks_mb, fresh_enough, ghosts_of, norm_uuid, pick_device, place, signature,
)
from common.models import (
    AgentRun, DataprepJob, GpuDevice, GpuLease, GpuUsageHint, ModelCheck, TrainRun, utcnow,
)

# Аренда и её продление. Аренда вчетверо длиннее удара сердца: одна пропущенная
# отметка (заминка на томе, сборка мусора) не должна отнимать карту. Ждущая бронь
# отмечается тем же пульсом: без отметок дольше аренды очередь брошена.
LEASE_SECONDS = int(os.environ.get("GPU_LEASE", "120"))
BEAT_EVERY = float(os.environ.get("GPU_BEAT", "30"))

# Работы под потолком «сколько тяжёлых на карту». Обучение — да: два по памяти
# влезут, но станут вдвое медленнее каждое, и оба человека решат, что сервер
# сломался. Признаки и проверка ролика короткие, их пускаем по памяти.
HEAVY_KINDS = ("train",)
# Кому выбирать наименее загруженную карту, а не плотную укладку: прогон агента
# под потолок тяжёлых не попадает, но считает долго и мешает соседу так же.
BUSY_KINDS = ("train", "agent")

# Карта, которую воркер давно не перечислял, для допуска не существует.
# Без этого пересозданный контейнер оставлял в таблице призрака: 07.09.2026
# одна RTX 3060 значилась тремя, и диспетчер честно был готов пустить на неё
# три обучения. Экран железа призраков показывает — с давностью.
STALE_SECONDS = int(os.environ.get("GPU_STALE", "300"))
# Карта, которую видели за эту неделю, известна: выключена она или молчит — обучение
# падает с ошибкой, а не уходит на процессор (так voran считал на процессоре до 10.10.2026).
# Старше — призрак чужой машины из дампа, машина без карт снова считает процессором.
KNOWN_SECONDS = int(os.environ.get("GPU_FORGET", str(7 * 24 * 3600)))

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
        uuid_ = norm_uuid(item["uuid"])
        # Двойник той же карты (UUID с приставкой и без) уступает UUID и выключается:
        # уникальность не дала бы записать его выбранной, а включённая пара снова
        # раздавала бы одну карту дважды.
        for twin in rows:
            if twin is not row and uuid_ and norm_uuid(twin.uuid_str) == uuid_:
                twin.uuid_str = None
                twin.enabled = False
        db.flush()
        if row is None:
            row = GpuDevice(
                host=host,
                device_index=item["index"],
                uuid_str=uuid_,
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
            if uuid_:
                row.uuid_str = uuid_
        row.seen_at = utcnow()
        db.flush()
        ids.append(row.id)
        # Призраки той же карты — записи, оставшиеся от прежних имён
        # контейнера, — выключаются: брони на них ссылаются, удалять нельзя.
        for ghost in ghosts_of(rows, row, item):
            ghost.enabled = False
    db.commit()
    return ids


def note_sam2(db, device_uuid, mb) -> bool:
    """Постоянная бронь полуавтомата на карте: память его живых воркеров.

    Колонкой, а не бронью на сессию: сессии приходят и уходят десятками в час,
    а память держит процесс, пока он жив. Карта — по UUID; одна карта на
    стенде — она и есть.
    """
    rows = db.execute(select(GpuDevice).where(GpuDevice.enabled.is_(True))).scalars().all()
    want = norm_uuid(device_uuid)
    row = next((r for r in rows if want and norm_uuid(r.uuid_str) == want), None)
    if row is None and len(rows) == 1:
        row = rows[0]
    if row is None:
        return False
    row.sam2_reserve_mb = max(0, int(mb))
    db.commit()
    # Память освободилась — ждущие могли стать допустимыми.
    pump(db)
    return True


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
    try:
        db.commit()
    except IntegrityError:
        # Первый замер той же подписи записал сосед — дописываем в его строку.
        # Иначе падение здесь оставляло бронь держателя висеть до конца аренды.
        db.rollback()
        remember(db, kind, sig, peak_mb)


# --------------------------------------------------------------------------- #
# Бронь
# --------------------------------------------------------------------------- #
def request(db, *, holder, kind, want_mb, ref_id=None, project_id=None,
            user_id=None, priority=50, allow_cpu=False, title=None):
    """Попросить память. Возвращает бронь — выданную, стоящую или отказанную."""
    lease = GpuLease(
        holder=holder, kind=kind, ref_id=ref_id, project_id=project_id,
        user_id=user_id, want_mb=int(want_mb), queue_priority=priority,
        title=title, status="queued", lease_until=utcnow() + timedelta(seconds=LEASE_SECONDS),
    )
    db.add(lease)
    db.commit()

    if not _any_device(db):
        # Карт нет вовсе. Для работы, которая умеет на процессоре, это не
        # отказ, а разрешение: диспетчер просто ничего не ограничивает.
        # Карты есть, но выключены или молчат, — отказ: это поломка, а не машина без карт.
        known = known_devices(db)
        cpu = allow_cpu and not known
        lease.status = "held" if cpu else "denied"
        lease.granted_mb = 0
        lease.granted_at = utcnow() if cpu else None
        lease.lease_until = utcnow() + timedelta(seconds=LEASE_SECONDS) if cpu else None
        lease.reason = None if cpu else (
            "Видеокарты сервера выключены или не отвечают." if known else "На сервере нет видеокарт.")
        db.commit()
        return lease

    try_grant(db, lease.id)
    db.refresh(lease)
    return lease


def request_group(db, *, holder, kind, parts, spread, labels=None, ref_id=None,
                  project_id=None, user_id=None, priority=50, title=None):
    """Задача на нескольких картах: по броне на часть, выдаются все разом или ни одна.

    Возвращает первую часть — дальше с ней обращаются как с обычной бронью:
    пульс, отпуск и снятие действуют на всю группу. На процессоре такие задачи
    не идут: без карт группа сразу отказана."""
    if len(parts) == 1:
        lease = request(db, holder=holder, kind=kind, want_mb=parts[0], ref_id=ref_id, project_id=project_id,
                        user_id=user_id, priority=priority, allow_cpu=False, title=title)
        if labels:
            lease.label = labels[0][:80]
            db.commit()
        return lease
    group, now = uuid.uuid4(), utcnow()
    leases = [GpuLease(
        holder=holder, kind=kind, ref_id=ref_id, project_id=project_id, user_id=user_id,
        want_mb=int(want), queue_priority=priority, title=title, status="queued",
        group_id=group, part=i, spread=spread, label=(labels[i][:80] if labels else None), created_at=now,
        lease_until=now + timedelta(seconds=LEASE_SECONDS),
    ) for i, want in enumerate(parts)]
    db.add_all(leases)
    db.commit()
    if not _any_device(db):
        reason = ("Видеокарты сервера выключены или не отвечают." if known_devices(db)
                  else "На сервере нет видеокарт.")
        for lease in leases:
            lease.status, lease.reason = "denied", reason
        db.commit()
        return leases[0]
    try_grant(db, leases[0].id)
    db.refresh(leases[0])
    return leases[0]


def known_devices(db) -> bool:
    """Карты на этой машине есть, даже если сейчас выключены или молчат."""
    since = utcnow() - timedelta(seconds=KNOWN_SECONDS)
    return db.execute(select(GpuDevice.id).where(GpuDevice.seen_at >= since).limit(1)).first() is not None


def group_of(db, lease, lock=False):
    """Все брони задачи по порядку частей; у одиночной — она сама.
    `lock` — перечитать под замком строк: выдача видит отмену, сделанную после её чтения."""
    if lease.group_id is None and not lock:
        return [lease]
    key = GpuLease.id == lease.id if lease.group_id is None else GpuLease.group_id == lease.group_id
    query = select(GpuLease).where(key).order_by(GpuLease.part)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    return db.execute(query).scalars().all()


def capacity_mb(db) -> int:
    """Сколько памяти карта отдаёт под задачи в самом лучшем случае.

    Ноль — карт нет. Заявка больше этого числа не будет выдана никогда, сколько
    ни жди: очередь освобождает чужую память, а не поднимает потолок карты.
    Тому, кто просит больше, надо отвечать сразу, а не ставить в очередь.
    """
    devices, _held, _heavy, _busy = _load_state(db, lock=False)
    return max(
        (
            for_tasks_mb(d.total_mb, d.reserved_mb, d.sam2_reserve_mb)
            for d in devices
        ),
        default=0,
    )


def cards(db):
    """Живые карты без имён держателей — это видит каждый, кто собирает агента:
    вердикт «влезет ли» без потолка и свободного места не объяснить.
    [{id, index, name, cap_mb, free_mb}]."""
    devices, held, _heavy, _busy = _load_state(db, lock=False)
    return [{
        "id": str(d.id),
        "index": d.device_index,
        "name": d.name,
        "cap_mb": for_tasks_mb(d.total_mb, d.reserved_mb, d.sam2_reserve_mb),
        "free_mb": max(0, for_tasks_mb(d.total_mb, d.reserved_mb, d.sam2_reserve_mb) - held.get(d.id, 0)),
    } for d in devices]


def capacities(db) -> list[int]:
    """Потолки живых карт: влезет ли задача на нескольких картах в принципе."""
    devices, _held, _heavy, _busy = _load_state(db, lock=False)
    return [for_tasks_mb(d.total_mb, d.reserved_mb, d.sam2_reserve_mb) for d in devices]


def queued_count(db) -> int:
    """Сколько задач ждёт: группа — одна задача."""
    return int(db.execute(
        select(func.count(GpuLease.id)).where(
            GpuLease.status == "queued", (GpuLease.group_id.is_(None)) | (GpuLease.part == 0))
    ).scalar() or 0)


def group_indices(db, lease):
    """Номера карт для torch по частям задачи; у одиночной — один номер."""
    return [torch_index(db, part) for part in group_of(db, lease)]


def torch_index(db, lease):
    """Номер карты для torch в этом процессе; None — бронь без карты.

    Номер из таблицы годится, только если карту перечислял этот же хост: в
    чужом контейнере порядок может быть другим, там ищем по UUID. Порядок
    задаёт CUDA_DEVICE_ORDER=PCI_BUS_ID — один на все GPU-контейнеры."""
    if lease is None or lease.device_id is None:
        return None
    dev = db.get(GpuDevice, lease.device_id)
    if dev is None:
        return None
    if dev.host == host_name():
        return dev.device_index
    uuids = [norm_uuid(u) for u in _smi_uuids()]
    want = norm_uuid(dev.uuid_str)
    if want and want in uuids:
        return uuids.index(want)
    return dev.device_index


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
    held, heavy, busy = {}, {}, {}
    for row in db.execute(
        select(GpuLease).where(GpuLease.status == "held")
    ).scalars():
        if row.device_id is None:
            continue
        if row.lease_until is not None and _aware(row.lease_until) < now:
            continue  # просрочена: её вернёт reap, место уже не считаем
        held[row.device_id] = held.get(row.device_id, 0) + row.granted_mb
        busy[row.device_id] = busy.get(row.device_id, 0) + 1
        if row.kind in HEAVY_KINDS:
            heavy[row.device_id] = heavy.get(row.device_id, 0) + 1
    return devices, held, heavy, busy


def _cards(devices, held, heavy, busy):
    return [{
        "id": d.id, "index": d.device_index, "total": d.total_mb, "reserved": d.reserved_mb,
        "sam2": d.sam2_reserve_mb, "held": held.get(d.id, 0),
        "heavy": heavy.get(d.id, 0), "max_heavy": d.max_heavy, "busy": busy.get(d.id, 0),
    } for d in devices]


def try_grant(db, lease_id) -> bool:
    """Выдать задачу, если влезает: все её брони разом или ни одну.
    False — осталась в очереди, причина записана в каждую часть."""
    lease = db.get(GpuLease, lease_id)
    if lease is None or lease.status != "queued":
        return False

    devices, held, heavy, busy = _load_state(db)
    # Карты заперты — выдаёт один. Части читаем уже под замком: прочитанные до него
    # могли устареть, и две выдачи одной задачи посадили бы её на две карты.
    parts = group_of(db, lease, lock=True)
    now = utcnow()
    # Ждущий давно не отмечался — он брошен: выданное ему простояло бы до конца аренды.
    abandoned = parts[0].lease_until is not None and _aware(parts[0].lease_until) < now
    if not devices or abandoned or any(p.status != "queued" for p in parts):
        db.commit()
        return False

    cards = _cards(devices, held, heavy, busy)
    heavy_request = lease.kind in HEAVY_KINDS
    chosen, why = place([p.want_mb for p in parts], cards, spread=bool(lease.spread),
                        heavy_request=heavy_request, busy_kind=heavy_request or lease.kind in BUSY_KINDS)
    for part, device_id in zip(parts, chosen or [None] * len(parts)):
        if device_id is None:
            part.reason = why[:200]
            continue
        part.device_id = device_id
        part.granted_mb = part.want_mb
        part.status = "held"
        part.granted_at = now
        part.lease_until = now + timedelta(seconds=LEASE_SECONDS)
        part.reason = None
    db.commit()
    return chosen is not None


def pump(db, limit=32) -> int:
    """Раздать освободившееся место очереди.

    Идём по очереди, но на неудаче не останавливаемся: что влезает, идёт сразу,
    а не стоит за крупной задачей. Места под ждущих не придерживаем (решение
    11.10.2026): застрявшую крупную выручает человек на «Оборудовании».
    Задача на нескольких картах пробуется один раз — первой своей частью.
    """
    queued = db.execute(
        select(GpuLease).where(
            GpuLease.status == "queued", (GpuLease.group_id.is_(None)) | (GpuLease.part == 0))
        .order_by(GpuLease.queue_priority, GpuLease.created_at)
        .limit(limit)
    ).scalars().all()
    granted = 0
    for lease in queued:
        if try_grant(db, lease.id):
            granted += 1
    return granted


def beat(db, lease_id, peak_mb=None):
    """Продлить аренду — всей задаче: держатель один, и пульс у него один.
    Ждущий отмечается так же — иначе его сочтут брошенным."""
    lease = db.get(GpuLease, lease_id)
    if lease is None or lease.status not in ACTIVE:
        return
    until = utcnow() + timedelta(seconds=LEASE_SECONDS)
    for part in group_of(db, lease):
        if part.status in ACTIVE:
            part.lease_until = until
    if peak_mb is not None:
        lease.peak_mb = max(lease.peak_mb or 0, int(peak_mb))
    db.commit()


def release(db, lease_id, peak_mb=None):
    lease = db.get(GpuLease, lease_id)
    if lease is None or lease.status in ("released", "expired", "cancelled"):
        return
    if peak_mb is not None:
        lease.peak_mb = max(lease.peak_mb or 0, int(peak_mb))
    now = utcnow()
    for part in group_of(db, lease):
        if part.status in ACTIVE:
            part.status = "released"
            part.released_at = now
            part.lease_until = None
    db.commit()
    pump(db)


def cancel(db, lease_id, reason="Снято"):
    lease = db.get(GpuLease, lease_id)
    if lease is None or lease.status not in ACTIVE:
        return
    now = utcnow()
    for part in group_of(db, lease):
        if part.status in ACTIVE:
            part.status = "cancelled"
            part.reason = reason[:200]
            part.released_at = now
            part.lease_until = None
    db.commit()
    pump(db)


def reap(db) -> int:
    """Вернуть память, которую держит призрак, и убрать брошенную очередь.
    Часть задачи просрочена — держателя нет у всей задачи."""
    now = utcnow()
    freed = 0
    for lease in db.execute(
        select(GpuLease).where(GpuLease.status == "held")
    ).scalars().all():
        if lease.status == "held" and lease.lease_until is not None and _aware(lease.lease_until) < now:
            for part in group_of(db, lease):
                if part.status == "held":
                    part.status = "expired"
                    part.released_at = now
                    part.reason = "Держатель не отозвался в срок."
                    freed += 1
    # Брошенная очередь: ждущий не отмечался дольше аренды (воркер упал, работу бросили).
    # Не по возрасту: живой ждущий стоит сколько угодно, и «сколько ждёт» не сбрасывается.
    for lease in db.execute(
        select(GpuLease).where(
            GpuLease.status == "queued",
            GpuLease.lease_until.is_(None) | (GpuLease.lease_until < now),
        )
    ).scalars().all():
        lease.status = "cancelled"
        lease.reason = "Никто не ждёт эту работу."
        lease.released_at = now
        freed += 1
    if freed:
        db.commit()
        pump(db)
    return freed


# --------------------------------------------------------------------------- #
# Что видно снаружи
# --------------------------------------------------------------------------- #
def devices_view(db, holders=True):
    """Все карты, и выключенные: иначе выключенную негде включить обратно.
    `holders=False` — без держателей, для тех, у кого нет права на оборудование."""
    _live, held, heavy, _busy = _load_state(db, lock=False, include_stale=True)
    devices = db.execute(select(GpuDevice).order_by(GpuDevice.device_index)).scalars().all()
    index_of = {d.id: d.device_index for d in devices}
    # Задача на нескольких картах: у каждой её части — номера всех её карт.
    spans = {}
    if holders:
        for row in db.execute(select(GpuLease).where(
                GpuLease.status == "held", GpuLease.group_id.isnot(None))).scalars():
            spans.setdefault(row.group_id, []).append(index_of.get(row.device_id))
    now = utcnow()
    out = []
    for dev in devices:
        used = held.get(dev.id, 0)
        rows = db.execute(
            select(GpuLease).where(
                GpuLease.device_id == dev.id, GpuLease.status == "held"
            ).order_by(GpuLease.granted_at)
        ).scalars().all() if holders else []
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
            "enabled": bool(dev.enabled),
            "fresh": _fresh(dev, now),
            "cap_mb": for_tasks_mb(dev.total_mb, dev.reserved_mb, dev.sam2_reserve_mb),
            "holders": [
                {
                    "id": str(r.id),
                    "kind": r.kind,
                    "title": r.title,
                    "granted_mb": r.granted_mb,
                    "peak_mb": r.peak_mb,
                    "user_id": str(r.user_id) if r.user_id else None,
                    "project_id": str(r.project_id) if r.project_id else None,
                    "ref_id": str(r.ref_id) if r.ref_id else None,
                    "granted_at": r.granted_at.isoformat() if r.granted_at else None,
                    "label": r.label,
                    "cards": sorted(i for i in spans.get(r.group_id, []) if i is not None) if r.group_id else None,
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
            GpuLease.status == "queued", _earlier_than(lease),
            (GpuLease.group_id.is_(None)) | (GpuLease.part == 0),
        )
    ).scalar()
    return int(ahead or 0) + 1


def queue_view(db, *, user_id=None, staff=False):
    """Очередь глазами человека.

    Свои строки видит каждый — иначе ожидание необъяснимо. Чужие подробности
    видит только обслуживание: кто именно занял карту, обычному человеку знать
    незачем, а вот «впереди двое» знать надо. Задача на нескольких картах —
    одна строка с частями.
    """
    every = db.execute(
        select(GpuLease).where(GpuLease.status == "queued")
        .order_by(GpuLease.queue_priority, GpuLease.created_at, GpuLease.part)
    ).scalars().all()
    parts = {}
    for r in every:
        if r.group_id is not None:
            parts.setdefault(r.group_id, []).append(r.want_mb)
    rows = [r for r in every if r.group_id is None or r.part == 0]
    now = utcnow()
    mine, everything = [], []
    for i, r in enumerate(rows, 1):
        item = {
            "id": str(r.id),
            "position": i,
            "kind": r.kind,
            "title": r.title,
            "want_mb": sum(parts[r.group_id]) if r.group_id else r.want_mb,
            "parts": parts[r.group_id] if r.group_id else None,
            "waiting_seconds": int((now - _aware(r.created_at)).total_seconds()),
            "reason": r.reason,
            "mine": bool(user_id and r.user_id == user_id),
            "user_id": str(r.user_id) if r.user_id else None,
            "project_id": str(r.project_id) if r.project_id else None,
            "ref_id": str(r.ref_id) if r.ref_id else None,
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
    if lease is None:
        return False
    # Без прогона за бронью (превью, образцы) гасить некому — бронь просто отменяется.
    # Счёт признаков снимается своей работой: одна бронь гасла, а счёт шёл дальше мимо учёта.
    for model in (TrainRun, ModelCheck, AgentRun, DataprepJob) if lease.ref_id else ():
        row = db.get(model, lease.ref_id)
        if row is not None:
            row.cancel_requested = True
            db.commit()
            return True
    cancel(db, lease_id, "Снято обслуживанием")
    return True
