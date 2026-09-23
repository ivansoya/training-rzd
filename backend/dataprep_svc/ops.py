"""Свои трансформы — то, чего в albumentations нет.

Каждый здесь появился потому, что библиотека либо не умеет нужного, либо умеет
не тем способом. Наследуемся от её же ``DualTransform`` и зовём её же функции
кропа: геометрию, пересчёт разметки и посадку на зерно она делает правильно, и
переписывать это ради одной новой мерки было бы глупо.
"""
import os

os.environ.setdefault("NO_ALBUMENTATIONS_UPDATE", "1")

import albumentations as A
import albumentations.augmentations.crops.functional as F
import numpy as np


class RandomAreaCrop(A.DualTransform):
    """Случайный кусок кадра с порогом видимости объекта.

    Чем отличается от соседей по палитре:

    ``RandomSizedBBoxSafeCrop`` обрезает так, чтобы **вся** разметка осталась
    внутри. Кадр с объектами по разным углам он почти не режет, а модель так и
    не видит наполовину вошедшего в кадр предмета — хотя в жизни он именно
    таким на границе и появляется.

    ``RandomCrop`` библиотеки берёт размер в пикселях. Набор же собирается из
    кадров разных размеров, и «640 на 640» вырежет из 2688×1520 угол, а из
    720×480 — почти весь кадр. Поэтому размер здесь задаётся **долей стороны**:
    одна и та же настройка значит одно и то же на любом кадре.

    Доля берётся общая на обе стороны — пропорции кадра сохраняются. Иначе
    кроп растягивал бы предметы по одной оси, а разглядывать их модели потом на
    настоящих, неискажённых кадрах.

    Порог видимости — свой, а не общий для всей цепочки. Обрезка тем и
    отличается от поворота, что уводит объекты за край намеренно, и спрашивать
    с неё надо строже: объект, от которого осталась половина, ещё узнаваем, а
    от которого четверть — уже нет.
    """

    def __init__(self, scale=(0.6, 0.9), min_visibility=0.5, p=0.5):
        super().__init__(p=p)
        low, high = (float(scale[0]), float(scale[1])) if len(scale) == 2 \
            else (float(scale), float(scale))
        self.scale = (min(low, high), max(low, high))
        self.min_visibility = float(min_visibility)

    def get_params_dependent_on_data(self, params, data):
        height, width = params["shape"][:2]
        share = self.py_random.uniform(*self.scale)
        crop_h = max(1, min(height, round(height * share)))
        crop_w = max(1, min(width, round(width * share)))
        # Окно целиком внутри кадра: чёрных поле́й от выхода за край быть не
        # должно — модель приняла бы их за часть сцены.
        top = self.py_random.randint(0, height - crop_h)
        left = self.py_random.randint(0, width - crop_w)
        return {"crop_coords": (left, top, left + crop_w, top + crop_h)}

    def apply(self, img, crop_coords, **params):
        return F.crop(img, *crop_coords)

    def apply_to_mask(self, mask, crop_coords, **params):
        return F.crop(mask, *crop_coords)

    def apply_to_bboxes(self, bboxes, crop_coords, **params):
        if len(bboxes) == 0:
            return bboxes
        moved = F.crop_bboxes_by_coords(
            bboxes, crop_coords, params["shape"][:2], normalized_input=True
        )
        return moved[visible(moved) >= self.min_visibility]

    def get_transform_init_args_names(self):
        return ("scale", "min_visibility")


class FractionCrop(RandomAreaCrop):
    """Кроп заданного окна: четыре границы долями стороны, от 0 до 1.

    Не ``A.Crop`` библиотеки: тот берёт пиксели, а кадры в наборе разного
    размера — «x от 0,1 до 0,9» должно значить одно и то же на любом. Порог
    видимости и пересчёт разметки — от ``RandomAreaCrop``: отличается только
    то, какое окно режем.
    """

    def __init__(self, x_range=(0.0, 1.0), y_range=(0.0, 1.0),
                 min_visibility=0.5, p=0.5):
        A.DualTransform.__init__(self, p=p)
        self.x_range = _span(x_range)
        self.y_range = _span(y_range)
        self.min_visibility = float(min_visibility)

    def get_params_dependent_on_data(self, params, data):
        height, width = params["shape"][:2]
        return {"crop_coords": window(self.x_range, self.y_range, width, height)}

    def get_transform_init_args_names(self):
        return ("x_range", "y_range", "min_visibility")


def _span(pair):
    low, high = sorted(min(max(float(v), 0.0), 1.0) for v in pair)
    return (low, high)


def window(x_range, y_range, width, height):
    """Окно кропа в пикселях. Не уже пикселя: окно нулевой ширины дало бы
    пустую картинку, и сборка упала бы на записи файла, а не здесь."""
    left = min(int(round(x_range[0] * width)), width - 1)
    top = min(int(round(y_range[0] * height)), height - 1)
    right = max(int(round(x_range[1] * width)), left + 1)
    bottom = max(int(round(y_range[1] * height)), top + 1)
    return (left, top, right, bottom)


def visible(boxes):
    """Какая доля каждого бокса осталась в кадре, от 0 до 1.

    Считается уже после переноса в координаты куска: библиотека не подрезает
    вылезшее, и разница между «сколько было» и «сколько влезло в 0..1» — это и
    есть видимая доля. Отдельной функцией, потому что вся ценность узла в этом
    числе, а закрыть его тестом надо без картинок и без библиотеки.
    """
    boxes = np.asarray(boxes, dtype=float)
    if len(boxes) == 0:
        return np.zeros(0)
    whole = (
        (boxes[:, 2] - boxes[:, 0]).clip(0)
        * (boxes[:, 3] - boxes[:, 1]).clip(0)
    )
    inside = np.clip(boxes[:, :4], 0.0, 1.0)
    seen = (
        (inside[:, 2] - inside[:, 0]).clip(0)
        * (inside[:, 3] - inside[:, 1]).clip(0)
    )
    # Бокс нулевой площади видимым не считается: делить на ноль нечем, а
    # «сохранить на всякий случай» здесь означало бы строку разметки без объекта.
    return np.divide(seen, whole, out=np.zeros_like(seen), where=whole > 0)
