"""Тестовый кадр для превью — когда своих кадров у человека нет.

Рисуется кодом, а не лежит картинкой в репозитории: разметка рождается в той
же функции, что и рисунок, и разойтись с ним не может. Готовый PNG пришлось бы
держать рядом с файлом координат и сверять руками.

Сцена нарочно неудобная. Светофор стоит у правого края — поворот с
приближением уводит его за кадр, и превью показывает потерю объекта. Человек
размечен контуром, а не рамкой — чтобы в превью работал и путь масок. Шахматная
мишень в углу выдаёт любую геометрию раньше, чем её заметишь на рельсах.
"""
from dataprep_svc import engine

W, H = 1280, 720
HORIZON = 280
VANISH_X = 660
RAIL_L, RAIL_R = 300, 1000

CLASSES = (
    {"name": "светофор", "color": "#7ec8ff"},
    {"name": "человек", "color": "#ff8a5c"},
    {"name": "шпала", "color": "#2ee07a"},
)
SIGNAL, PERSON, SLEEPER = 0, 1, 2

SLEEPER_RGB = (122, 86, 56)
PERSON_RGB = (224, 112, 58)
_CACHE = []


def _gradient(img, y0, y1, top, bottom):
    import numpy as np

    t = np.linspace(0.0, 1.0, y1 - y0)[:, None]
    rows = (1 - t) * np.array(top) + t * np.array(bottom)
    img[y0:y1] = rows[:, None, :].astype("uint8")


def _rails_at(y):
    """Где левый и правый рельс на строке ``y`` и насколько она близко."""
    f = (y - HORIZON) / (H - HORIZON)
    return (VANISH_X + (RAIL_L - VANISH_X) * f,
            VANISH_X + (RAIL_R - VANISH_X) * f, f)


def draw():
    """(картинка RGB, рамки YOLO, контуры в пикселях). Картинка общая —
    исполнитель её не меняет, а копирует."""
    import cv2
    import numpy as np

    img = np.zeros((H, W, 3), dtype="uint8")
    _gradient(img, 0, HORIZON, (95, 134, 173), (205, 217, 226))
    _gradient(img, HORIZON, H, (108, 101, 91), (59, 53, 47))

    boxes = []
    for i in range(1, 15):
        y = HORIZON + (H - HORIZON) * (i / 14) ** 2
        left, right, f = _rails_at(y)
        pad = (right - left) * 0.16
        th = 4 + 22 * f
        x0, x1 = left - pad, right + pad
        y0, y1 = y - th / 2, y + th / 2
        cv2.rectangle(img, (int(x0), int(y0)), (int(x1), int(y1)),
                      SLEEPER_RGB, -1)
        if i in (11, 13):
            boxes.append(_yolo(SLEEPER, x0 - 3, y0 - 3, x1 + 3, y1 + 3))
    for bottom in (RAIL_L, RAIL_R):
        cv2.line(img, (VANISH_X, HORIZON), (bottom, H), (212, 214, 216), 5,
                 cv2.LINE_AA)

    # Светофор у самого края.
    cv2.rectangle(img, (1180, 160), (1190, 500), (85, 85, 85), -1)
    cv2.rectangle(img, (1160, 132), (1210, 236), (17, 17, 17), -1)
    cv2.circle(img, (1185, 160), 12, (255, 64, 64), -1, cv2.LINE_AA)
    cv2.circle(img, (1185, 206), 12, (34, 204, 85), -1, cv2.LINE_AA)
    boxes.append(_yolo(SIGNAL, 1154, 124, 1216, 504))

    # Человек у пути — контуром.
    px, py = 524, 356
    cv2.circle(img, (px, py), 16, PERSON_RGB, -1, cv2.LINE_AA)
    body = [(px - 20, py + 18), (px + 20, py + 18), (px + 26, py + 80),
            (px + 14, py + 84), (px + 14, py + 148), (px - 14, py + 148),
            (px - 14, py + 84), (px - 26, py + 80)]
    cv2.fillPoly(img, [np.array(body, dtype=np.int32)], PERSON_RGB,
                 cv2.LINE_AA)
    ring = [[px - 18, py - 18], [px + 18, py - 18]] + \
        [list(p) for p in body[1:7]] + [list(body[7]), list(body[0])]
    polys = [(PERSON, [ring])]

    for r in range(4):
        for c in range(6):
            shade = (238, 238, 238) if (r + c) % 2 == 0 else (17, 17, 17)
            x, y = 32 + c * 22, 32 + r * 22
            cv2.rectangle(img, (x, y), (x + 21, y + 21), shade, -1)
    cv2.putText(img, "TEST 1280x720", (32, 150), cv2.FONT_HERSHEY_SIMPLEX,
                0.7, (28, 27, 36), 2, cv2.LINE_AA)
    return img, boxes, polys


def _yolo(cls, x0, y0, x1, y1):
    return (cls, (x0 + x1) / 2 / W, (y0 + y1) / 2 / H, (x1 - x0) / W,
            (y1 - y0) / H)


def sample():
    """Образец для исполнителя. Рисуется один раз на процесс."""
    if not _CACHE:
        _CACHE.append(draw())
    img, boxes, polys = _CACHE[0]
    return engine.Sample(img, boxes, polys)
