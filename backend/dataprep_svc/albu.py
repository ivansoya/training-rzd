"""Мост к albumentations: подобрать имена параметров и собрать преобразование.

Библиотека переименовывает параметры между версиями и делает это мягко —
старое имя ещё принимается, но уже с предупреждением, а через версию исчезает.
Граф, сохранённый год назад, от этого не должен переставать работать молча.

Поэтому имя параметра не записано в графе. В графе записан смысл («наклон
струй»), а имя подбирается по установленной версии: сперва ``slant_range``,
если его нет — пара ``slant_lower``/``slant_upper``. Не нашли ни одного — узел
честно помечается недоступным, и это видно в палитре, а не всплывает на
сороковой минуте сборки.
"""
import base64
import inspect
import io
import os

os.environ.setdefault("NO_ALBUMENTATIONS_UPDATE", "1")

from dataprep_svc import registry

# Пары суффиксов, которыми albumentations записывает диапазон двумя числами.
PAIRS = (("_lower", "_upper"), ("_min", "_max"))

_CACHE = {}


def available() -> bool:
    try:
        import albumentations  # noqa: F401
        import cv2  # noqa: F401
        import numpy  # noqa: F401
    except Exception:
        return False
    return True


def _cls(op):
    import albumentations as A

    return getattr(A, op, None)


def signature_of(op):
    """Имена параметров, которые принимает установленная версия трансформа."""
    cls = _cls(op)
    if cls is None:
        return None
    try:
        params = inspect.signature(cls.__init__).parameters
    except (TypeError, ValueError):
        return None
    return {
        name for name, p in params.items()
        if name not in ("self", "always_apply")
        and p.kind not in (p.VAR_POSITIONAL, p.VAR_KEYWORD)
    }


def resolve(op):
    """Как объявленные параметры ложатся на установленную версию.

    Возвращает ``{"available", "reason", "params": {ключ: способ передачи}}``.
    """
    if op in _CACHE:
        return _CACHE[op]

    item = registry.BY_OP.get(op)
    if item is None:
        got = {"available": False, "reason": "Узла нет в каталоге.", "params": {}}
        _CACHE[op] = got
        return got

    sig = signature_of(op)
    if sig is None:
        got = {
            "available": False,
            "reason": "Установленная версия albumentations такого не знает.",
            "params": {},
        }
        _CACHE[op] = got
        return got

    mapping, missing = {}, []
    for key, spec in item["params"].items():
        found = None
        for name in spec["names"]:
            if name in sig:
                # Диапазон могут принимать одним доводом или парой соседних.
                pair = None
                for low_sfx, high_sfx in PAIRS:
                    if name.endswith(low_sfx):
                        mate = name[: -len(low_sfx)] + high_sfx
                        if mate in sig:
                            pair = (name, mate)
                        break
                found = {"name": name, "pair": pair}
                break
        if found is None:
            missing.append(spec.get("label") or key)
        else:
            mapping[key] = found

    got = {
        "available": not missing,
        "reason": (
            "В установленной версии нет параметров: " + ", ".join(missing)
            if missing else None
        ),
        "params": mapping,
    }
    _CACHE[op] = got
    return got


def catalogue():
    """Каталог для палитры: объявленное плюс то, что подтвердила библиотека."""
    lib = available()
    out = []
    for item in registry.CATALOGUE:
        info = resolve(item["op"]) if lib else {
            "available": False,
            "reason": "albumentations на сервере не поднялась.",
            "params": {},
        }
        out.append({
            "op": item["op"],
            "name": item["name"],
            "group": item["group"],
            "group_title": registry.GROUP_TITLES.get(item["group"], item["group"]),
            "why": item["why"],
            "available": info["available"],
            "reason": info["reason"],
            "params": [
                {
                    "key": key,
                    "label": spec.get("label", key),
                    "hint": spec.get("hint"),
                    # Пределы отдаём те, что действуют в этой версии: у
                    # редактора ползунок обязан ходить по настоящей шкале.
                    **{
                        k: v for k, v in registry.spec_for(
                            spec, (info["params"].get(key) or {}).get("name")
                        ).items()
                        if k not in ("names", "label", "hint", "per_name")
                    },
                }
                for key, spec in item["params"].items()
            ],
            "chance": dict(registry.CHANCE),
        })
    return {
        "available": lib,
        "groups": [{"key": k, "title": t} for k, t in registry.GROUPS],
        "nodes": out,
    }


# --------------------------------------------------------------------------- #
# Сборка преобразования
# --------------------------------------------------------------------------- #
def build_op(op, args, chance=0.5):
    """Один трансформ albumentations по объявленным значениям."""
    info = resolve(op)
    if not info["available"]:
        raise ValueError(f"Узел «{op}» недоступен: {info['reason']}")
    values = registry.clamp_args(
        op, args, {k: v["name"] for k, v in info["params"].items()}
    )

    kwargs = {}
    for key, how in info["params"].items():
        value = values.get(key)
        if value is None:
            continue
        if isinstance(value, list) and len(value) == 2 and how["pair"]:
            low_name, high_name = how["pair"]
            kwargs[low_name] = value[0]
            kwargs[high_name] = value[1]
        elif isinstance(value, list):
            kwargs[how["name"]] = tuple(value)
        else:
            kwargs[how["name"]] = value

    cls = _cls(op)
    try:
        return cls(p=float(chance), **kwargs)
    except Exception as exc:
        raise ValueError(f"Узел «{op}»: {exc}") from exc


def compose(ops, *, with_boxes=True, with_masks=False, min_visibility=0.15):
    """Цепочка трансформов с правилами переноса разметки.

    ``min_visibility`` — сколько объекта должно остаться в кадре, чтобы его
    разметка ещё что-то значила. Объект, от которого осталось пять процентов,
    учит модель находить угол вагона и называть его вагоном.
    """
    import albumentations as A

    steps = [build_op(o["op"], o.get("args"), o.get("chance", 0.5)) for o in ops]
    kwargs = {}
    if with_boxes:
        kwargs["bbox_params"] = A.BboxParams(
            format="yolo",
            label_fields=["class_labels"],
            min_visibility=float(min_visibility),
            clip=True,
        )
    # Маски не требуют своих параметров: albumentations возит их вместе с
    # картинкой тем же преобразованием. Контур мы снимаем обратно сами —
    # см. ``masks.py``.
    return A.Compose(steps, **kwargs)


class NotReproducible(RuntimeError):
    """Библиотека не умеет садиться на зерно."""


def seed_compose(pipeline, seed):
    """Посадить преобразование на заданное зерно.

    Падаем, а не работаем как-нибудь. Обещание «пересобрать набор тем же
    зерном и получить те же файлы» держится целиком на этом вызове, и потеря
    его ничем себя не выдаёт: картинки просто станут другими, а объяснить
    разницу будет нечем.

    До 2.0 у ``Compose`` этого метода не было вовсе — случайность бралась из
    глобального состояния ``random`` и numpy, а значит зависела от порядка
    обхода и числа потоков. Отсюда и жёсткая нижняя граница версии в
    requirements. Проверяется числами: ``tests/unit/test_albu_seed.py``.
    """
    setter = getattr(pipeline, "set_random_seed", None)
    if setter is None:
        raise NotReproducible(
            "Установленная albumentations не умеет садиться на зерно "
            "(нужна 2.0 и новее). Сборка была бы невоспроизводимой."
        )
    setter(int(seed) % (2 ** 32))
    return True


# --------------------------------------------------------------------------- #
# Картинки: чтение, запись, разметка поверх
# --------------------------------------------------------------------------- #
def imread_rgb(path):
    """Чтение через numpy, а не cv2.imread: у того беда с не-ASCII путями."""
    import cv2
    import numpy as np

    data = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"Не удалось прочитать кадр: {path}")
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def imwrite_rgb(path, image, quality=92):
    import cv2

    ext = os.path.splitext(path)[1].lower() or ".jpg"
    params = []
    if ext in (".jpg", ".jpeg"):
        params = [cv2.IMWRITE_JPEG_QUALITY, int(quality)]
    ok, buf = cv2.imencode(ext, cv2.cvtColor(image, cv2.COLOR_RGB2BGR), params)
    if not ok:
        raise ValueError(f"Не удалось записать кадр: {path}")
    buf.tofile(path)
    return len(buf)


def draw_shapes(image, boxes, polygons=(), colour=(46, 224, 122)):
    """Разметка поверх кадра — для превью.

    Рамка и контур рисуются разными фигурами: на превью в полтораста пикселей
    форма сама по себе уже не читается, а «это не рамка» читаться обязано.
    """
    import cv2
    import numpy as np

    out = image.copy()
    h, w = out.shape[:2]
    for cx, cy, bw, bh in boxes:
        x1 = int((cx - bw / 2) * w)
        y1 = int((cy - bh / 2) * h)
        x2 = int((cx + bw / 2) * w)
        y2 = int((cy + bh / 2) * h)
        cv2.rectangle(out, (x1, y1), (x2, y2), colour, 2)
    for parts in polygons:
        for ring in parts:
            pts = np.array(
                [[int(x), int(y)] for x, y in ring], dtype=np.int32
            )
            if len(pts) >= 3:
                cv2.polylines(out, [pts], True, colour, 2)
    return out


def to_data_url(image):
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(image).save(buf, format="PNG", optimize=False)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
