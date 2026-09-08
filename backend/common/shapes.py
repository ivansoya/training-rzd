"""Фигура разметки на проводе: одна форма записи для бокса и для полигона.

Редактор, просмотр датасета и список кадров таски сериализуют разметку каждый
у себя, а разбирает её сохранение — четвёртое место. Пока фигура была одна,
это сходило с рук. Теперь их две, и разойтись они обязаны были бы при первой же
правке, поэтому запись и разбор живут здесь, а зовут их отовсюду.

**Полигон на проводе всегда несёт и свою охватывающую рамку.** Поля ``x, y, w,
h`` у него заполнены так же, как у бокса, — по всем частям сразу. Это не
избыточность, а совместимость: всё, что умеет только прямоугольники (счётчики,
ленты кадров, старый код просмотра), продолжает работать, не зная о полигонах
вовсе, и показывает объект рамкой вместо контура. Отличает их поле ``kind``.
"""
from common import polygon as polylib

# Бокс тоньше двух пикселей — это промах мышью, а не объект.
MIN_BOX_PX = 2.0


def clamp_box(box, width, height):
    """Загоняет бокс внутрь кадра.

    Вылезший за край бокс при экспорте в YOLO даёт координату вне [0,1] —
    ровно ту, которую мы отбраковываем на импорте. Чинить это на экспорте
    поздно: там уже не видно, что человек имел в виду.
    """
    try:
        x = float(box.get("x", 0))
        y = float(box.get("y", 0))
        w = float(box.get("w", 0))
        h = float(box.get("h", 0))
    except (TypeError, ValueError):
        return None
    # Отрицательные размеры — это протяжка справа налево; нормализуем.
    if w < 0:
        x, w = x + w, -w
    if h < 0:
        y, h = y + h, -h
    x2 = min(x + w, float(width))
    y2 = min(y + h, float(height))
    x = max(0.0, min(x, float(width)))
    y = max(0.0, min(y, float(height)))
    w = x2 - x
    h = y2 - y
    if w < MIN_BOX_PX or h < MIN_BOX_PX:
        return None
    return {"x": round(x, 2), "y": round(y, 2),
            "w": round(w, 2), "h": round(h, 2)}


def to_wire(ann_type, geometry):
    """Геометрия из базы → поля фигуры для ответа.

    Пустой словарь означает «эту разметку показать нечем»: вызывающий такую
    пропускает, потому что кадр из-за одного битого объекта не прячут.
    """
    geometry = geometry or {}
    if (ann_type or "bbox") != "polygon":
        return {
            "kind": "bbox",
            "x": geometry.get("x", 0), "y": geometry.get("y", 0),
            "w": geometry.get("w", 0), "h": geometry.get("h", 0),
        }
    parts = polylib.parts_of(geometry)
    box = polylib.bounds(parts)
    if box is None:
        return {}
    return {
        "kind": "polygon",
        "parts": [[[x, y] for x, y in ring] for ring in parts],
        **box,
    }


def from_wire(raw, width, height):
    """Фигура из запроса → (ann_type, geometry, area), или None.

    None — «от фигуры ничего не осталось»: промах мышью, контур целиком за
    краем кадра, меньше трёх различимых точек. Такую пропускают молча.
    """
    if (raw.get("kind") or "bbox") != "polygon":
        geometry = clamp_box(raw, width, height)
        if geometry is None:
            return None
        return "bbox", geometry, round(geometry["w"] * geometry["h"], 2)

    parts = polylib.clamp(polylib.parts_of(raw), width, height)
    if not parts:
        return None
    geometry = {"parts": [[[round(x, 2), round(y, 2)] for x, y in ring]
                          for ring in parts]}
    # Площадь — сумма площадей частей. Объект, разорванный надвое, занимает
    # ровно столько места, сколько занимают обе его половины.
    area = sum(polylib.area(ring) for ring in parts)
    return "polygon", geometry, round(area, 2)
