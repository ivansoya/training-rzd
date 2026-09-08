"""Правила допуска к видеокарте — чистые, без базы и без торча.

Отдельный модуль, а не функция внутри диспетчера: политику допуска надо
проверять числами, а образ тестов не знает ни про SQLAlchemy, ни про torch.
Тот же приём, что с ``polygon.py`` и ``trackMath.ts``: считающее ядро живёт
отдельно от того, что ходит в базу.
"""
import hashlib
from datetime import timedelta, timezone


def _gb(mb) -> str:
    return f"{mb / 1024:.1f} ГБ".replace(".", ",")


def fits(*, total_mb, reserved_mb, sam2_mb, held_mb, pledged_mb,
         heavy, max_heavy, want_mb, heavy_request):
    """Влезает ли работа на карту.

    ``None`` — влезает. Иначе готовая к показу причина: по ней человек решает,
    ждать или уменьшать батч, а эти два ответа требуют разного.

    ``pledged_mb`` — память, придержанная под тех, кто ждёт дольше всех.
    """
    for_tasks = total_mb - reserved_mb - sam2_mb
    if want_mb > for_tasks:
        return (
            f"не поместится никогда: под задачи отдаётся {_gb(for_tasks)}, "
            f"а нужно {_gb(want_mb)}"
        )
    if heavy_request and heavy >= max_heavy:
        return f"уже идёт тяжёлых задач: {heavy} из {max_heavy}"
    free = for_tasks - held_mb - pledged_mb
    if want_mb > free:
        if pledged_mb and want_mb <= for_tasks - held_mb:
            return (
                f"свободно {_gb(free + pledged_mb)}, но {_gb(pledged_mb)} "
                "придержано под тех, кто ждёт дольше"
            )
        return f"свободно {_gb(max(free, 0))} из нужных {_gb(want_mb)}"
    return None


def signature(kind, **facts) -> str:
    """Отпечаток того, что определяет расход памяти.

    Модель, задача, размер входа и батч. Имя проекта и человека сюда не входят
    нарочно: замер одного обучения обязан помогать следующему такому же, чей бы
    он ни был.
    """
    body = "|".join(f"{k}={facts[k]}" for k in sorted(facts))
    return hashlib.sha1(f"{kind}|{body}".encode()).hexdigest()[:32]


# --------------------------------------------------------------------------- #
# Тождество карты: одна карта — одна запись, сколько бы раз ни пересоздавали
# контейнер. Тоже чистое: на вход — записи как объекты с полями, на выход —
# выбор. 07.09.2026 одна RTX 3060 значилась тремя записями, и диспетчер был
# готов пустить на неё три обучения.
# --------------------------------------------------------------------------- #
def _aware(dt):
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def choose_row(rows, item, host):
    """Какая запись — эта карта. Чистая функция, закрыта тестами.

    Порядок: по UUID; иначе по имени контейнера и номеру; иначе — запись той
    же модели с тем же номером, но без UUID, и из таких самая свежая: это
    та самая карта, увиденная из прежнего контейнера, и UUID ей дописывается.
    """
    if item.get("uuid"):
        for row in rows:
            if row.uuid_str == item["uuid"]:
                return row
    for row in rows:
        if row.host == host and row.device_index == item["index"]:
            return row
    legacy = [
        row for row in rows
        if not row.uuid_str
        and row.name == item["name"]
        and row.device_index == item["index"]
    ]
    if not legacy:
        return None
    return max(legacy, key=lambda r: (_aware(r.seen_at) is not None, _aware(r.seen_at)))


def ghosts_of(rows, chosen, item):
    """Записи той же карты, что уже не она: без UUID, та же модель и номер."""
    return [
        row for row in rows
        if row is not chosen
        and row.enabled
        and not row.uuid_str
        and row.name == item["name"]
        and row.device_index == item["index"]
    ]


def fresh_enough(seen_at, now, stale_seconds) -> bool:
    """Карту перечисляли недавно — она есть."""
    seen = _aware(seen_at)
    if seen is None:
        return False
    return now - seen <= timedelta(seconds=stale_seconds)


def touch(db, device_ids):
    if not device_ids:
        return
    for row in db.execute(
        select(GpuDevice).where(GpuDevice.id.in_(device_ids))
    ).scalars():
        row.seen_at = utcnow()
    db.commit()


def note_sam2(db, device_id, workers, per_worker_mb):
    """Постоянная бронь полуавтомата.

    Колонкой, а не строкой брони на сессию: сессии приходят и уходят десятками
    в час, а память процесс держит всё время, пока жив хоть один его воркер.
    """
    row = db.get(GpuDevice, device_id)
    if row is None:
        return
    row.sam2_reserve_mb = max(0, int(workers) * int(per_worker_mb))
    db.commit()


