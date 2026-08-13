"""Треки на видео: где объект находится на кадре, которого никто не размечал.

Разметчик ставит ключевые кадры — положения, заданные рукой. Всё между ними
считается здесь. Этот модуль не знает ни про базу, ни про Flask: на вход
простые словари, на выход простые словари. Так интерполяцию и план выгрузки
можно проверить тестами, не поднимая ни контейнера, ни ролика.

Кадр — единица адресации. Время (миллисекунды) считается из кадра и частоты,
а не наоборот: обратный пересчёт на дробном fps уводит на соседний кадр, и
разметка перестаёт совпадать с картинкой.
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


def track_span(track: dict, last_frame: int | None = None) -> tuple[int, int]:
    """Кадры, на которых трек существует: от появления до кадра, где убран.

    Пустой ``end_frame`` значит «ещё не убирали» — трек живёт до конца ролика.
    """
    start = int(track["start_frame"])
    end = track.get("end_frame")
    if end is None:
        end = last_frame if last_frame is not None else start
    return start, max(start, int(end))


def box_at(track: dict, keys: list[dict], frame_no: int) -> dict | None:
    """Бокс трека на кадре или ``None``, если объекта там нет.

    Объекта нет в трёх случаях: кадр вне жизни трека, кадр раньше первого
    ключевого, и участок, объявленный невидимым (объект заслонён). Последний
    случай — не отсутствие разметки, а осознанное «здесь его не видно», и в
    выгрузку такой кадр не идёт.
    """
    if not keys:
        return None
    start, end = track_span(track, None)
    if track.get("end_frame") is None:
        end = max(end, keys[-1]["frame_no"])
    if frame_no < start or frame_no > end:
        return None

    ordered = sorted(keys, key=lambda k: k["frame_no"])
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
    if not prev.get("visible", True):
        return None
    if nxt is None or not track.get("interpolate", True):
        return dict(prev["geometry"])
    span = nxt["frame_no"] - prev["frame_no"]
    if span <= 0:
        return dict(prev["geometry"])
    t = (frame_no - prev["frame_no"]) / span
    return interpolate(prev["geometry"], nxt["geometry"], t)


def export_frames(track: dict, keys: list[dict], last_frame: int | None = None) -> list[int]:
    """Кадры трека, которые станут изображениями проекта.

    Ключевые кадры берутся всегда — это работа руками, терять её нельзя.
    Остальное добирается шагом трека: быстрый объект выгружают часто, стоящий
    редко. Невидимые участки отсеиваются вместе с боксами.
    """
    if not keys:
        return []
    step = max(1, int(track.get("export_step", 1) or 1))
    start, end = track_span(track, last_frame)
    if track.get("end_frame") is None:
        end = max(end, max(k["frame_no"] for k in keys))

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
    """Что именно материализуется при сдаче таски.

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
                "source": (exact or {}).get("source", "human") if exact else "model",
                "track_id": track.get("id"),
            })

    for single in singles:
        if not single.get("visible", True):
            continue
        by_frame.setdefault(int(single["frame_no"]), []).append({
            "class_id": single["class_id"],
            "geometry": dict(single["geometry"]),
            "source": single.get("source", "human"),
            "track_id": None,
        })

    return by_frame
