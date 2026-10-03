"""Ориентация кадра по EXIF: одна каноническая ориентация пикселей для всех.

Телефон пишет кадр «как сняла матрица» и ставит тег поворота. Браузер тег
читает, а PIL, SAM2 и обучение — нет: рамки ложились мимо объекта, а кадр из
таски лежал набок. Поэтому поворот применяется к пикселям один раз, на входе.
"""
from PIL import ImageOps

ORIENTATION = 0x0112


def needs_turn(img) -> bool:
    try:
        return img.getexif().get(ORIENTATION, 1) not in (None, 1)
    except Exception:  # noqa: BLE001
        return False


def upright(img):
    """Кадр так, как его видит человек; без тега — тот же объект."""
    return ImageOps.exif_transpose(img) if needs_turn(img) else img
