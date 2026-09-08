"""Воспроизводимость сборки: albumentations обязана садиться на зерно.

Самая дешёвая из проверок и самая важная. Обещание «пересобрать набор тем же
зерном и получить те же файлы» держится на одном вызове, и потеря его ничем
себя не выдаёт: картинки просто станут другими.

До версии 2.0 у ``Compose`` не было ``set_random_seed`` вовсе — случайность
бралась из глобального состояния и зависела от порядка обхода и числа потоков.
Тест не даёт вернуться на такую версию незаметно.
"""
import numpy as np
import pytest

A = pytest.importorskip("albumentations")

from dataprep_svc import albu  # noqa: E402


def pipeline():
    return albu.compose(
        [
            {"op": "RandomRain", "args": {}, "chance": 1.0},
            {"op": "RandomBrightnessContrast", "args": {}, "chance": 1.0},
        ],
        with_boxes=True,
    )


def frame():
    return (np.random.default_rng(0).random((64, 64, 3)) * 255).astype("uint8")


def run(seed, image):
    p = pipeline()
    albu.seed_compose(p, seed)
    return p(image=image, bboxes=[[0.5, 0.5, 0.2, 0.2]], class_labels=[0])


def test_библиотека_умеет_садиться_на_зерно():
    assert hasattr(A.Compose([]), "set_random_seed"), (
        "Нужна albumentations 2.0 и новее: без зерна сборка невоспроизводима."
    )


def test_одно_зерно_даёт_тот_же_кадр():
    image = frame()
    assert np.array_equal(run(42, image)["image"], run(42, image)["image"])


def test_другое_зерно_даёт_другой_кадр():
    image = frame()
    assert not np.array_equal(run(42, image)["image"], run(43, image)["image"])


def test_без_зерна_падаем_а_не_работаем_как_нибудь():
    """Молчаливая потеря воспроизводимости хуже падения: её никто не заметит."""
    class Deaf:
        pass

    with pytest.raises(albu.NotReproducible):
        albu.seed_compose(Deaf(), 1)


def test_единицы_шума_привязаны_к_имени_параметра():
    """Вместе с именем у шума сменились единицы: дисперсия 10..50 стала долей
    0..1. Подставить старые числа под новое имя значит выкрутить шум до
    белого — и заметить это можно только глазом на готовом наборе."""
    info = albu.resolve("GaussNoise")
    name = info["params"]["var_limit"]["name"]
    from dataprep_svc import registry

    bounds = registry.spec_for(
        registry.BY_OP["GaussNoise"]["params"]["var_limit"], name
    )
    if name == "std_range":
        assert bounds["high"] <= 1.0
    else:
        assert bounds["high"] > 1.0
