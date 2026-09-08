"""Параметры обучения, аугментации и предупреждения о покрытии — числами.

Три вещи, которые 08.09.2026 нашлись только разбором живого обучения и
которые больше не должны находиться так:

* модель училась с нуля, хотя все думали, что с предобученных весов;
* аугментации были выключены целиком, и сеть запоминала кадры;
* класс `drill` целиком уехал в обучение, и об этом никто не сказал.
"""
import os
import tempfile

from common.splitting import coverage_warnings
from training_svc import trainer, weights


# --------------------------------------------------------------------------- #
# Модели
# --------------------------------------------------------------------------- #
def test_встроенные_модели_предобученные():
    """Каждая встроенная модель — это файл весов, а описание сети лежит
    отдельно и берётся только по явной галочке."""
    for m in trainer.BUILTIN_MODELS:
        assert m["spec"].endswith(".pt"), m
        assert m["scratch"].endswith(".yaml"), m


def test_в_списке_есть_yolo11_и_yolo26_обеих_задач():
    ids = {m["id"] for m in trainer.BUILTIN_MODELS}
    for want in ("yolo11n", "yolo11n-seg", "yolo26n", "yolo26n-seg"):
        assert want in ids
    tasks = {m["id"]: m["task"] for m in trainer.BUILTIN_MODELS}
    assert tasks["yolo26n"] == "detect"
    assert tasks["yolo26n-seg"] == "segment"


def test_прикидка_памяти_знает_yolo26():
    assert trainer.estimate_vram("yolo26n", "detect", 640, 16) == 3200
    assert trainer.estimate_vram("yolo26m-seg", "segment", 640, 16) == 11000


# --------------------------------------------------------------------------- #
# Параметры
# --------------------------------------------------------------------------- #
def test_неизвестные_ключи_отбрасываются():
    got = trainer.filter_params({"epochs": 5, "rm_rf": True, "data": "x"})
    assert got == {"epochs": 5}


def test_значения_зажимаются_в_пределы_а_не_отвергаются():
    got = trainer.filter_params({"lr0": 5, "epochs": 0, "patience": -3})
    assert got["lr0"] == 1.0
    assert got["epochs"] == 1
    assert got["patience"] == 0


def test_типы_приводятся():
    got = trainer.filter_params({
        "epochs": "12", "cos_lr": "true", "pretrained": "нет",
        "optimizer": "AdamW", "imgsz": 641.4,
    })
    assert got["epochs"] == 12 and isinstance(got["epochs"], int)
    assert got["cos_lr"] is True
    assert got["pretrained"] is False
    assert got["optimizer"] == "AdamW"
    assert got["imgsz"] == 641


def test_оптимизатор_не_из_списка_отбрасывается():
    assert trainer.filter_params({"optimizer": "Lion"}) == {}


def test_пустое_и_none_пропускаются():
    assert trainer.filter_params({"epochs": "", "batch": None}) == {}


def test_в_train_уходят_только_параметры_библиотеки():
    params = trainer.filter_params({
        "epochs": 3, "pretrained": False, "augment_mode": "off",
        "mosaic": 0.5, "patience": 10,
    })
    got = trainer.train_overrides(params)
    assert got == {"epochs": 3, "patience": 10}


def test_спецификация_для_формы_повторяет_умолчания():
    view = trainer.param_spec_view()
    assert view["patience"]["default"] == trainer.PARAM_SPEC["patience"]["default"]
    assert view["mosaic"]["default"] == trainer.YOLO_AUG_DEFAULTS["mosaic"]
    assert "ultralytics" not in view["pretrained"]


# --------------------------------------------------------------------------- #
# Аугментации
# --------------------------------------------------------------------------- #
def test_набор_из_графа_гасит_аугментации_yolo():
    over, mode = trainer.aug_overrides({"augment_mode": "yolo", "mosaic": 1.0},
                                       has_graph=True)
    assert mode == "graph"
    assert over["mosaic"] == 0.0 and over["fliplr"] == 0.0


def test_без_графа_берутся_рекомендуемые_значения():
    over, mode = trainer.aug_overrides({}, has_graph=False)
    assert mode == "yolo"
    for key, want in trainer.YOLO_AUG_DEFAULTS.items():
        assert over[key] == want, key
    # Ручки классификации остаются выключенными: они не про детекцию.
    assert over["erasing"] == 0.0 and over["auto_augment"] is None


def test_свои_значения_перекрывают_рекомендуемые():
    over, _ = trainer.aug_overrides({"mosaic": 0.3, "fliplr": 0.0},
                                    has_graph=False)
    assert over["mosaic"] == 0.3
    assert over["fliplr"] == 0.0
    assert over["hsv_s"] == trainer.YOLO_AUG_DEFAULTS["hsv_s"]


def test_режим_off_выключает_всё():
    over, mode = trainer.aug_overrides({"augment_mode": "off", "mosaic": 1.0},
                                       has_graph=False)
    assert mode == "off"
    assert all(not v for v in over.values())


# --------------------------------------------------------------------------- #
# Веса
# --------------------------------------------------------------------------- #
def test_описание_сети_возвращается_как_есть():
    assert trainer.resolve_weights("yolo11n.yaml") == "yolo11n.yaml"


def test_готовый_путь_возвращается_как_есть(tmp_path):
    f = tmp_path / "own.pt"
    f.write_bytes(b"PK" + b"\0" * 10)
    assert trainer.resolve_weights(str(f)) == str(f)


def test_обрезок_и_страница_не_считаются_весами():
    with tempfile.TemporaryDirectory() as d:
        html = os.path.join(d, "a.pt")
        with open(html, "wb") as fh:
            fh.write(b"<html>Not found")
        assert not weights.looks_like_checkpoint(html)
        zipped = os.path.join(d, "b.pt")
        with open(zipped, "wb") as fh:
            fh.write(b"PK\x03\x04rest")
        assert weights.looks_like_checkpoint(zipped)


def test_маленький_файл_на_томе_не_считается_скачанным(monkeypatch, tmp_path):
    monkeypatch.setattr(weights, "WEIGHTS_DIR", str(tmp_path))
    (tmp_path / "yolo11n.pt").write_bytes(b"PK" + b"\0" * 100)
    assert not weights.is_cached("yolo11n.pt")
    (tmp_path / "yolo26n.pt").write_bytes(b"PK" + b"\0" * weights.MIN_BYTES)
    assert weights.is_cached("yolo26n.pt")


# --------------------------------------------------------------------------- #
# Покрытие проверки
# --------------------------------------------------------------------------- #
def test_класс_без_проверки_называется_по_имени():
    got = coverage_warnings([("drill", 91, 0), ("brush", 671, 159)])
    assert len(got) == 1
    assert "drill" in got[0] and "brush" not in got[0]


def test_класс_с_двумя_кадрами_отдельным_предупреждением():
    got = coverage_warnings([("bag", 46, 2), ("rotor", 140, 22)])
    assert len(got) == 1
    assert "bag" in got[0] and "rotor" not in got[0]


def test_класса_без_обучения_не_ругаем():
    """Класс, которого нет вовсе, — не «нет в проверке», а «нет нигде»;
    об этом говорит другая часть отчёта."""
    assert coverage_warnings([("ghost", 0, 0)]) == []


def test_длинный_список_обрезается_со_счётчиком():
    rows = [(f"c{i}", 10, 0) for i in range(9)]
    got = coverage_warnings(rows)
    assert "и ещё 3" in got[0]


def test_нормальное_покрытие_молчит():
    assert coverage_warnings([("a", 100, 20), ("b", 50, 10)]) == []
