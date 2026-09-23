"""Как из маски получается обводка. Одно место на всю платформу.

Обводку снимают двое: полуавтомат, когда SAM2 вернул маску, и аугментации,
когда контур покрутили вместе с картинкой. Разойдись они — и один и тот же
вагон выглядел бы по-разному до и после аугментации, а объяснить эту разницу
человеку было бы нечем.

Внешние контуры и только они (``RETR_EXTERNAL``): формат, в который мы
выгружаем, отверстий не знает, и обводка с дыркой всё равно превратилась бы в
сплошную при первой же выгрузке.
"""
# Сколько кусков объекта считаем осмысленным. Объект часто распадается —
# заслонён стойкой, виден двумя половинами; но двадцать пятый кусок — это уже
# не объект, а шум обводки.
MAX_PARTS = 24
# Кроха меньше доли процента от главного куска — тоже шум.
PART_MIN_SHARE = 0.002

# Три маски SAM2 — это разбор неоднозначности «что именно вы ткнули».
# Сортируем их по площади, чтобы уровень был предсказуемым, а не как повезёт.
DETAIL_ORDER = {"subpart": 0, "part": 1, "object": 2}
# По умолчанию берём ту, в которой уверена сама модель: самая крупная из трёх
# сплошь и рядом оказывается мусором с уверенностью 0,07, тогда как средняя
# даёт 0,6. Явные уровни остаются для случая, когда человек знает лучше.
DETAIL_AUTO = "auto"


def pick_mask(masks, scores, detail=DETAIL_AUTO):
    """(маска uint8, оценка) из ответов SAM2. Полуавтомат и агент выбирают
    одинаково: одна рамка у обоих обязана дать один и тот же контур."""
    import numpy as np

    if detail == DETAIL_AUTO or detail not in DETAIL_ORDER:
        pick = int(np.argmax(scores))
    else:
        order = np.argsort([float(m.sum()) for m in masks])
        pick = int(order[min(DETAIL_ORDER[detail], len(order) - 1)])
    return masks[pick].astype(np.uint8), float(scores[pick])


def clean_mask(mask, min_area=0, fill_holes=False):
    import cv2
    import numpy as np

    if min_area > 0:
        count, labels_img, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        keep = np.zeros_like(mask)
        for i in range(1, count):
            if stats[i, cv2.CC_STAT_AREA] >= min_area:
                keep[labels_img == i] = 1
        mask = keep
    if fill_holes:
        # Замыкание закрывает дыры внутри объекта, не трогая его границу.
        kernel = np.ones((5, 5), np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    return mask


def mask_bounds(mask):
    """(x, y, w, h) по крайним точкам маски, в пикселях. ``None`` — маска пуста."""
    import numpy as np

    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    return x0, y0, x1 - x0 + 1, y1 - y0 + 1


def polygons_from_mask(mask, max_points=0):
    """Все куски маски кольцами точек.

    Бокс охватывает их все, и контур обязан показывать то же самое, иначе
    рамка и обводка противоречат друг другу на одном экране.
    """
    import cv2

    contours, _ = cv2.findContours(
        mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    if not contours:
        return []
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:MAX_PARTS]
    biggest = cv2.contourArea(contours[0]) or 1.0
    out = []
    for contour in contours:
        if cv2.contourArea(contour) < biggest * PART_MIN_SHARE:
            continue
        if max_points and len(contour) > max_points:
            # Подбираем допуск, пока точек не станет достаточно мало.
            perimeter = cv2.arcLength(contour, True)
            eps = 0.001
            while eps < 0.2:
                approx = cv2.approxPolyDP(contour, eps * perimeter, True)
                if len(approx) <= max_points:
                    contour = approx
                    break
                eps *= 1.6
        out.append([[int(p[0][0]), int(p[0][1])] for p in contour])
    return out
