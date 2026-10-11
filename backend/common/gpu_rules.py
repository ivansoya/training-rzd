"""Правила допуска к видеокарте — чистые, без базы и без торча.

Отдельный модуль, а не функция внутри диспетчера: политику допуска надо
проверять числами, а образ тестов не знает ни про SQLAlchemy, ни про torch.
Тот же приём, что с ``polygon.py`` и ``trackMath.ts``: считающее ядро живёт
отдельно от того, что ходит в базу.
"""
import hashlib
import re
from datetime import timedelta, timezone


def _gb(mb) -> str:
    return f"{mb / 1024:.1f} ГБ".replace(".", ",")


def for_tasks_mb(total_mb, reserved_mb, sam2_mb) -> int:
    """Потолок карты: сколько она отдаёт под задачи в самом лучшем случае.

    Заявка больше этого числа не пройдёт никогда — очередь освобождает чужую
    память, а не поднимает потолок. Отдельной функцией, чтобы диспетчер судил
    о «никогда» ровно по той же формуле, что и допуск: разойдясь, они начали бы
    ставить в очередь то, что сами же и отвергают.
    """
    return total_mb - reserved_mb - sam2_mb


def fits(*, total_mb, reserved_mb, sam2_mb, held_mb,
         heavy, max_heavy, want_mb, heavy_request):
    """Влезает ли работа на карту.

    ``None`` — влезает. Иначе готовая к показу причина: по ней человек решает,
    ждать или уменьшать батч, а эти два ответа требуют разного.

    Ждущие места не придерживают (решение 11.10.2026): что влезает — идёт сразу,
    большая задача может ждать сколько угодно, выручает её человек.
    """
    for_tasks = for_tasks_mb(total_mb, reserved_mb, sam2_mb)
    if want_mb > for_tasks:
        return (
            f"не поместится никогда: под задачи отдаётся {_gb(for_tasks)}, "
            f"а нужно {_gb(want_mb)}"
        )
    if heavy_request and heavy >= max_heavy:
        return f"уже идёт тяжёлых задач: {heavy} из {max_heavy}"
    free = for_tasks - held_mb
    if want_mb > free:
        return f"свободно {_gb(max(free, 0))} из нужных {_gb(want_mb)}"
    return None


def pick_device(candidates, heavy_request):
    """Какую из подходящих карт отдать. ``candidates`` — [(id, свободно после
    выдачи, живых броней)], все уже прошли ``fits``.

    Тяжёлое (обучение, прогон агента) — на наименее загруженную: две тяжёлые
    работы на одной карте вдвое медленнее каждая. Лёгкое (превью, образцы,
    признаки) — туда, где после него останется меньше всего: большие дыры
    остаются под большие работы. Ничья — меньший номер в списке."""
    if not candidates:
        return None
    if heavy_request:
        key = lambda c: (c[2], -c[1])  # noqa: E731
    else:
        key = lambda c: c[1]  # noqa: E731
    return min(enumerate(candidates), key=lambda ic: (key(ic[1]), ic[0]))[1][0]


def place(parts, cards, *, spread, heavy_request, busy_kind):
    """Куда лечь частям одной задачи — всем разом или никуда.

    ``parts`` — [МБ] по частям; ``cards`` — живые карты по номеру, словари
    {id, index, total, reserved, sam2, held, heavy, max_heavy, busy}.
    ``spread`` — каждая часть на своей карте (обучение на нескольких картах);
    иначе части ложатся плотно и на как можно меньше карт (агент по блокам).
    Возвращает ([id карты по частям], None) или (None, причина для человека).
    Одиночная бронь — та же задача из одной части: правило выбора у них одно."""
    if not cards:
        return None, "карт нет"
    held = {c["id"]: c["held"] for c in cards}
    heavy = {c["id"]: c["heavy"] for c in cards}
    busy = {c["id"]: c["busy"] for c in cards}
    used, chosen = [], [None] * len(parts)
    # Крупные части первыми: мелкие потом найдут место в щелях.
    for i in sorted(range(len(parts)), key=lambda k: -parts[k]):
        want, ok, reasons = parts[i], [], []
        for c in cards:
            if spread and c["id"] in used:
                continue
            why = fits(total_mb=c["total"], reserved_mb=c["reserved"], sam2_mb=c["sam2"],
                       held_mb=held[c["id"]], heavy=heavy[c["id"]],
                       max_heavy=c["max_heavy"], want_mb=want, heavy_request=heavy_request)
            if why is None:
                free = for_tasks_mb(c["total"], c["reserved"], c["sam2"]) - held[c["id"]]
                ok.append((c["id"], free - want, busy[c["id"]]))
            else:
                reasons.append(f"карта {c['index']}: {why}")
        if not ok:
            if len(parts) == 1:
                return None, "; ".join(reasons)
            need = " и ".join(_gb(p) for p in sorted(parts, reverse=True))
            return None, f"нужно {len(parts)} карты сразу ({need}), для {_gb(want)} места нет — " + "; ".join(reasons)
        # Плотно — сперва карты, уже занятые этой задачей: так она займёт меньше карт.
        pool = [o for o in ok if o[0] in used] if not spread else []
        dev = pick_device(pool or ok, busy_kind)
        chosen[i] = dev
        held[dev] += want
        busy[dev] += 1
        heavy[dev] += 1 if heavy_request else 0
        if dev not in used:
            used.append(dev)
    return chosen, None


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


def norm_uuid(value):
    """UUID карты без приставки и в нижнем регистре — или None.

    torch 2.7 отдаёт «0cc67fd8-…», nvidia-smi и torch 2.3 — «GPU-0cc67fd8-…»: без
    этого после обновления torch карта не узнавала свою запись, подхватывала
    выключенного призрака, и живая карта оказывалась выключенной (voran до
    10.10.2026, локальный стенд — 11.10). Текст ошибки NVML вместо UUID
    («Failed to initialize NVML: …») — не UUID, а его отсутствие."""
    text = str(value or "").strip().lower()
    if text.startswith("gpu-"):
        text = text[4:]
    return text if text and re.fullmatch(r"[0-9a-z-]+", text) else None


def choose_row(rows, item, host):
    """Какая запись — эта карта. Чистая функция, закрыта тестами.

    Порядок: по UUID; иначе по имени контейнера и номеру; иначе — запись той
    же модели с тем же номером, но без UUID, и из таких самая свежая: это
    та самая карта, увиденная из прежнего контейнера, и UUID ей дописывается.
    Двойников по UUID (с приставкой и без) выбирается включённый: у него
    настройки человека.
    """
    want = norm_uuid(item.get("uuid"))
    if want:
        same = [row for row in rows if norm_uuid(row.uuid_str) == want]
        if same:
            return max(same, key=lambda r: (bool(r.enabled), _aware(r.seen_at) is not None, _aware(r.seen_at)))
    for row in rows:
        if row.host == host and row.device_index == item["index"]:
            return row
    legacy = [
        row for row in rows
        if not norm_uuid(row.uuid_str)
        and row.name == item["name"]
        and row.device_index == item["index"]
    ]
    if not legacy:
        return None
    return max(legacy, key=lambda r: (_aware(r.seen_at) is not None, _aware(r.seen_at)))


def ghosts_of(rows, chosen, item):
    """Записи той же карты, что уже не она: без UUID той же модели и номера —
    или с тем же UUID в другом написании."""
    want = norm_uuid(item.get("uuid"))
    return [
        row for row in rows
        if row is not chosen
        and row.enabled
        and ((not norm_uuid(row.uuid_str) and row.name == item["name"] and row.device_index == item["index"])
             or (want and norm_uuid(row.uuid_str) == want))
    ]


def fresh_enough(seen_at, now, stale_seconds) -> bool:
    """Карту перечисляли недавно — она есть."""
    seen = _aware(seen_at)
    if seen is None:
        return False
    return now - seen <= timedelta(seconds=stale_seconds)



