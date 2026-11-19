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


def touching(mask, rect):
    """Куски маски, задевшие прямоугольник (x0, y0, x1, y1), — целиком, остальные долой."""
    import cv2
    import numpy as np

    x0, y0, x1, y1 = rect
    _, labels_img = cv2.connectedComponents(mask.astype(np.uint8), connectivity=8)
    hit = np.unique(labels_img[y0:y1, x0:x1])
    return np.isin(labels_img, hit[hit > 0]).astype(np.uint8)


def mask_bounds(mask):
    """(x, y, w, h) по крайним точкам маски, в пикселях. ``None`` — маска пуста."""
    import numpy as np

    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    return x0, y0, x1 - x0 + 1, y1 - y0 + 1


SAM_POLYGON_POINTS = 64


def _limit_sam_contour(contour, budget):
    import cv2
    import numpy as np

    # Убираем ступени растровой границы даже при запасе по числу точек.
    smooth = cv2.approxPolyDP(contour, 1.0, True)
    if cv2.contourArea(smooth) > 0:
        if len(smooth) <= budget:
            return smooth
        low = 1.0
    else:
        if len(contour) <= budget:
            return contour
        low = 0.0
    _, _, width, height = cv2.boundingRect(contour)
    high = float(np.hypot(width, height))
    best = None
    for _ in range(16):
        eps = (low + high) / 2
        approx = cv2.approxPolyDP(contour, eps, True)
        if len(approx) > budget:
            low = eps
        else:
            high = eps
            if cv2.contourArea(approx) > 0:
                best = approx
    if best is not None:
        return best

    # Если очередной допуск сразу сплющил кольцо в линию, сохраняем
    # треугольник из исходных точек с максимальной высотой от выбранной базы.
    points = contour.reshape(-1, 2).astype(np.int64)
    axis = 0 if width >= height else 1
    a, b = points[points[:, axis].argmin()], points[points[:, axis].argmax()]
    along = b - a
    offset = points - a
    heights = np.abs(along[0] * offset[:, 1] - along[1] * offset[:, 0])
    return np.array([a, b, points[heights.argmax()]], dtype=np.int32).reshape(-1, 1, 2)


def polygons_from_mask(mask, max_points=0, *, adaptive=False):
    """Все куски маски кольцами точек.

    Бокс охватывает их все, и контур обязан показывать то же самое, иначе
    рамка и обводка противоречат друг другу на одном экране. ``adaptive``
    включает для SAM2 жёсткий лимит на часть с поправкой на её размер.
    """
    import cv2

    contours, _ = cv2.findContours(
        mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    if not contours:
        return []
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:MAX_PARTS]
    biggest = cv2.contourArea(contours[0]) or 1.0
    if adaptive:
        max_points = min(200, max(8, max_points or SAM_POLYGON_POINTS))
        frame_h, frame_w = mask.shape
    out = []
    for contour in contours:
        if cv2.contourArea(contour) < biggest * PART_MIN_SHARE:
            continue
        if adaptive:
            _, _, width, height = cv2.boundingRect(contour)
            # С половины кадра по любой стороне действует полный лимит.
            # Длинный тонкий объект при этом не приравниваем к мелкой точке.
            share = min(1.0, 2 * max(width / frame_w, height / frame_h))
            budget = max(4, round(max_points * share))
            contour = _limit_sam_contour(contour, budget)
        elif max_points and len(contour) > max_points:
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
