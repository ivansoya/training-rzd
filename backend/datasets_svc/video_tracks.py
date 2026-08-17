"""Треки на видео: где объект находится на кадре, которого никто не размечал.

Разметчик ставит ключевые кадры — положения, заданные рукой. Всё между ними
считается здесь. Этот модуль не знает ни про базу, ни про Flask: на вход
простые словари, на выход простые словари. Так интерполяцию и план выгрузки
можно проверить тестами, не поднимая ни контейнера, ни ролика.

Кадр — единица адресации. Время (миллисекунды) считается из кадра и частоты,
а не наоборот: обратный пересчёт на дробном fps уводит на соседний кадр, и
разметка перестаёт совпадать с картинкой.

Заслонённость — отрезки у трека, а не флаг у ключа. Разметчик тянет её мышью
за края, и края обязаны быть собственной сущностью: если бы концом отрезка
служил соседний ключ, то, потянув за него, человек заодно двигал бы положение
объекта — жест делал бы не то, что обещает.
"""

# Больше этого числа кадров из одного трека не выгружаем. Потолок тот же по
# смыслу, что у нарезки: дальше человек тонет, а том забивается.
MAX_TRACK_FRAMES = 5000


class TrackError(Exception):
    pass


def frame_to_ms(frame_no: int, fps: float | None) -> int:
    """Момент кадра. Без частоты честнее вернуть ноль, чем выдумать её."""
    if not fps or fps <= 0:
        return 0
    return int(round(frame_no * 1000.0 / fps))


def ms_to_frame(time_ms: int, fps: float | None) -> int:
    if not fps or fps <= 0:
        return 0
    return int(round(time_ms * fps / 1000.0))


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def interpolate(box_a: dict, box_b: dict, t: float) -> dict:
    """Промежуточное положение бокса. t=0 — первый, t=1 — второй."""
    return {
        key: round(_lerp(float(box_a.get(key, 0)), float(box_b.get(key, 0)), t), 2)
        for key in ("x", "y", "w", "h")
    }


def normalize_ranges(raw) -> list[list[int]]:
    """Приводим отрезки к порядку и склеиваем пересекающиеся.

    Разметчик режет их мышью и легко делает внахлёст; хранить как есть значило
    бы каждый раз гадать, что такое два наложенных отрезка.
    """
    clean = []
    for item in raw or []:
        try:
            start, end = int(item[0]), int(item[1])
        except (TypeError, ValueError, IndexError):
            raise TrackError("Отрезок невидимости должен быть парой кадров.")
        if end <= start:
            continue
        clean.append([start, end])
    clean.sort()

    merged: list[list[int]] = []
    for start, end in clean:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def is_hidden(track: dict, frame_no: int) -> bool:
    """Заслонён ли объект на этом кадре. Отрезок полуоткрыт: [от, до)."""
    for start, end in track.get("hidden_ranges") or []:
        if start <= frame_no < end:
            return True
    return False


def track_end(track: dict, keys: list[dict], last_frame: int | None = None) -> int:
    """Последний кадр, на котором трек ещё существует.

    Пустой ``end_frame`` значит «ещё не убирали». Такой трек живёт до
    последнего ключа, а не до конца ролика: иначе он замер бы в последнем
    положении и потащил в датасет кадры, которых никто не размечал.
    """
    if track.get("end_frame") is not None:
        return max(int(track["start_frame"]), int(track["end_frame"]))
    if keys:
        return max(int(k["frame_no"]) for k in keys)
    return int(track["start_frame"])


def state_at(track: dict, keys: list[dict], frame_no: int) -> dict | None:
    """Положение объекта на кадре и виден ли он там.

    Возвращает ``{"geometry": …, "hidden": bool}`` либо ``None``, если объекта
    на кадре нет вовсе — то есть кадр вне жизни трека или раньше первого
    ключа. Заслонённый объект существует: редактор рисует его прерывистой
    рамкой, а в выгрузку он не идёт.
    """
    if not keys:
        return None
    ordered = sorted(keys, key=lambda k: k["frame_no"])
    start = int(track["start_frame"])
    end = track_end(track, ordered)
    if frame_no < start or frame_no > end:
        return None

    prev = None
    nxt = None
    for key in ordered:
        if key["frame_no"] <= frame_no:
            prev = key
        else:
            nxt = key
            break
    if prev is None:
        return None

    if nxt is None or not track.get("interpolate", True):
        geometry = dict(prev["geometry"])
    else:
        span = nxt["frame_no"] - prev["frame_no"]
        geometry = (
            dict(prev["geometry"]) if span <= 0
            else interpolate(prev["geometry"], nxt["geometry"],
                             (frame_no - prev["frame_no"]) / span)
        )
    return {"geometry": geometry, "hidden": is_hidden(track, frame_no)}


def box_at(track: dict, keys: list[dict], frame_no: int) -> dict | None:
    """Бокс, который уйдёт в разметку, или ``None``. Заслонённый не уходит."""
    state = state_at(track, keys, frame_no)
    if state is None or state["hidden"]:
        return None
    return state["geometry"]


def export_frames(track: dict, keys: list[dict], last_frame: int | None = None) -> list[int]:
    """Кадры трека, которые станут изображениями проекта.

    Ключевые кадры берутся всегда — это работа руками, терять её нельзя.
    Остальное добирается шагом трека: быстрый объект выгружают часто, стоящий
    редко. Заслонённые участки отсеиваются вместе с боксами.
    """
    if not keys:
        return []
    step = max(1, int(track.get("export_step", 1) or 1))
    start = int(track["start_frame"])
    end = track_end(track, keys, last_frame)

    wanted = {int(k["frame_no"]) for k in keys if start <= k["frame_no"] <= end}
    frame = start
    while frame <= end:
        wanted.add(frame)
        frame += step
        if len(wanted) > MAX_TRACK_FRAMES:
            raise TrackError(
                f"При шаге {step} трек даёт больше {MAX_TRACK_FRAMES} кадров. "
                "Возьмите шаг покрупнее или укоротите трек."
            )
    return sorted(f for f in wanted if box_at(track, keys, f) is not None)


def plan(tracks: list[dict], singles: list[dict], last_frame: int | None = None) -> dict:
    """Что именно материализуется при закрытии разметки ролика.

    Возвращает ``{frame_no: [бокс, ...]}``. Бокс — словарь с ``class_id``,
    геометрией и происхождением; из него потом получается обычная аннотация.
    Одиночные боксы (не трековые) идут на свои кадры как есть.
    """
    by_frame: dict[int, list[dict]] = {}

    for track in tracks:
        keys = sorted(track.get("keys") or [], key=lambda k: k["frame_no"])
        for frame_no in export_frames(track, keys, last_frame):
            geometry = box_at(track, keys, frame_no)
            if geometry is None:
                continue
            exact = next((k for k in keys if k["frame_no"] == frame_no), None)
            by_frame.setdefault(frame_no, []).append({
                "class_id": track["class_id"],
                "geometry": geometry,
                # Посчитанное положение — не работа человека, и помечать его
                # как ручную разметку было бы неправдой в истории объекта.
                "source": exact.get("source", "human") if exact else "model",
                "track_id": track.get("id"),
            })

    for single in singles:
        by_frame.setdefault(int(single["frame_no"]), []).append({
            "class_id": single["class_id"],
            "geometry": dict(single["geometry"]),
            "source": single.get("source", "human"),
            "track_id": None,
        })

    return by_frame
