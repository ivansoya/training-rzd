"""Пересчёт координат между пространством разметчика и пикселями кадра.

Редактор говорит в пикселях источника: канва считает координаты от размеров
ролика и не знает, какую ступень качества сейчас показывает. Модель говорит в
пикселях того файла, который ей дали. Пока эти два пространства молча считали
себя одним, точка из 1920×1080 приходила в кадр 1280×720 — то есть в две трети
пути к цели, — а обводка возвращалась уменьшенной в те же полтора раза.

Поэтому пространство объявляется, а не угадывается: клиент присылает `space` —
размер, в котором он рисует, — и получает ответ в нём же. Совпало с кадром
(обычный случай: кадр для полуавтомата распаковывается в разрешении источника)
— пересчёт вырождается в тождество, и стоит он тогда ничего.

Модуль намеренно чистый: ни модели, ни файлов, ни numpy. Такую арифметику
проверяют числами (`tests/unit/test_auto_space.py`), а не глазами по картинке.
"""


def factors(space, width, height):
    """Во сколько раз пиксель кадра мельче пикселя разметчика.

    Отдельно по осям: пропорции обязаны совпадать, но проверять это здесь
    нечем, а молчаливое усреднение увело бы обводку по одной из осей.
    """
    if not space:
        return 1.0, 1.0
    try:
        sw = float(space.get("w") or 0)
        sh = float(space.get("h") or 0)
    except (AttributeError, TypeError, ValueError):
        return 1.0, 1.0
    if sw <= 0 or sh <= 0 or not width or not height:
        return 1.0, 1.0
    return float(width) / sw, float(height) / sh


def to_frame(prompts, kx, ky):
    """Точки и рамку-подсказку — в пиксели кадра.

    Возвращается новый словарь: запрос клиента — не наша собственность, а
    правка на месте однажды всплыла бы в ответе, который ушёл обратно.
    """
    if not prompts:
        return {}
    if kx == 1.0 and ky == 1.0:
        return prompts
    out = dict(prompts)
    points = prompts.get("points")
    if points:
        out["points"] = [
            {**p, "x": float(p["x"]) * kx, "y": float(p["y"]) * ky} for p in points
        ]
    box = prompts.get("box")
    if box:
        out["box"] = {
            "x": float(box["x"]) * kx,
            "y": float(box["y"]) * ky,
            "w": float(box["w"]) * kx,
            "h": float(box["h"]) * ky,
        }
    return out


def to_space(shape, kx, ky, space=None):
    """Ответ модели — обратно в пиксели разметчика.

    Обводка (`polygons`) пересчитывается вместе с рамкой: для сегментации она и
    есть результат, а рамка — её тень. Разъехавшись, они противоречили бы друг
    другу на одном и том же экране.
    """
    if not shape or (kx == 1.0 and ky == 1.0):
        return shape
    out = dict(shape)
    box = shape.get("box")
    if box:
        out["box"] = _fit(
            {
                "x": round(float(box["x"]) / kx, 2),
                "y": round(float(box["y"]) / ky, 2),
                "w": round(float(box["w"]) / kx, 2),
                "h": round(float(box["h"]) / ky, 2),
            },
            space,
        )
    polygons = shape.get("polygons")
    if polygons:
        out["polygons"] = [
            [[round(float(x) / kx, 2), round(float(y) / ky, 2)] for x, y in ring]
            for ring in polygons
        ]
    return out


def _fit(box, space):
    """Рамку — внутрь кадра. Деление даёт дробные края, и на границе они
    вылезают за картинку на доли пикселя; хранилищу разметки этого хватает,
    чтобы потом обрезать бокс по-своему."""
    if not space:
        return box
    try:
        sw = float(space.get("w") or 0)
        sh = float(space.get("h") or 0)
    except (AttributeError, TypeError, ValueError):
        return box
    if sw <= 0 or sh <= 0:
        return box
    x = min(max(box["x"], 0.0), sw)
    y = min(max(box["y"], 0.0), sh)
    return {
        "x": x,
        "y": y,
        "w": min(box["w"], sw - x),
        "h": min(box["h"], sh - y),
    }
