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
