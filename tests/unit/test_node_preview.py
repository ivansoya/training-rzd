"""Превью узла: честный прогон одного кадра и тестовая сцена.

Превью обещает показать ровно то, что ляжет в набор. Держится это на трёх
вещах, и каждая закрыта здесь числом: запись сработавших трансформов не
меняет случайность, подбор номера кадра доводит образец до любой ветки
разделителя, а нарисованная разметка тестового кадра лежит на нарисованном.
"""
import numpy as np
import pytest

pytest.importorskip("albumentations")
pytest.importorskip("cv2")

from dataprep_svc import albu, engine, preview, testframe  # noqa: E402

BRIGHT = {"op": "RandomBrightnessContrast", "args": {}, "chance": 1.0}


def e(a, b, out="out", into="in"):
    return {"from": a, "out": out, "to": b, "in": into}


def go(doc, node, load=None, seed="t"):
    compiled = engine.compile_graph(doc, load, with_masks=True, trace=True)
    ins, out = preview.ends(doc, load or (lambda *_: None), node)
    feed = {s: testframe.sample() for s in preview.upstream(doc, node)}
    return compiled, preview.run(
        compiled, feed, "test", ins=ins, out=out, seed=seed
    )


# --------------------------------------------------------------------------- #
# Тестовая сцена
# --------------------------------------------------------------------------- #
def test_разметка_тестового_кадра_лежит_на_нарисованном():
    img, boxes, polys = testframe.draw()
    assert img.shape == (testframe.H, testframe.W, 3)
    for cls, cx, cy, bw, bh in boxes:
        assert 0 < cx - bw / 2 and cx + bw / 2 < 1
        assert 0 < cy - bh / 2 and cy + bh / 2 < 1
        if cls == testframe.SLEEPER:
            # Середина шпалы — между рельсами, там сама шпала.
            x, y = int(cx * testframe.W), int(cy * testframe.H)
            assert tuple(img[y, x - 60]) == testframe.SLEEPER_RGB
    (cls, parts), = polys
    assert cls == testframe.PERSON
    ring = np.array(parts[0])
    x, y = ring.mean(axis=0).astype(int)
    assert tuple(img[y, x]) == testframe.PERSON_RGB


def test_светофор_стоит_у_края_и_поворот_может_его_потерять():
    _, boxes, _ = testframe.draw()
    signal = next(b for b in boxes if b[0] == testframe.SIGNAL)
    assert signal[1] + signal[3] / 2 > 0.93


# --------------------------------------------------------------------------- #
# Честность
# --------------------------------------------------------------------------- #
def test_запись_сработавших_не_меняет_случайность():
    ops = [
        {"op": "Rotate", "args": {}, "chance": 0.7},
        {"op": "RandomRain", "args": {}, "chance": 0.5},
        BRIGHT,
    ]
    img = testframe.draw()[0]
    for seed in range(5):
        got = []
        for trace in (False, True):
            p = albu.compose(ops, trace=trace)
            albu.seed_compose(p, seed)
            got.append(p(image=img, bboxes=[[0.5, 0.5, 0.2, 0.2]],
                         class_labels=[0])["image"])
        assert np.array_equal(*got)


def test_превью_достаёт_до_каждой_ветки_разделителя():
    doc = {"nodes": [
        {"id": "s", "type": "source"},
        {"id": "sp", "type": "split_share",
         "params": {"branches": 3, "shares": [1, 1, 1]}},
        {"id": "a0", "type": "aug", "params": BRIGHT},
        {"id": "a1", "type": "aug", "params": BRIGHT},
        {"id": "a2", "type": "aug", "params": BRIGHT},
        {"id": "o", "type": "output"},
    ], "edges": [
        e("s", "sp"),
        e("sp", "a0", "o0"), e("sp", "a1", "o1"), e("sp", "a2", "o2"),
        e("a0", "o"),
    ]}
    for node in ("a0", "a1", "a2"):
        _, got = go(doc, node)
        assert got is not None and got["total"] == 1, node


def test_узел_без_провода_от_источника_не_достижим():
    doc = {"nodes": [
        {"id": "s", "type": "source"},
        {"id": "lone", "type": "aug", "params": BRIGHT},
        {"id": "o", "type": "output"},
    ], "edges": [e("s", "o")]}
    assert go(doc, "lone")[1] is None


def test_образцов_не_больше_восьми_а_всего_честно():
    doc = {"nodes": [
        {"id": "s", "type": "source"},
        {"id": "x", "type": "multiply", "params": {"times": 20}},
        {"id": "a", "type": "aug", "params": BRIGHT},
        {"id": "o", "type": "output"},
    ], "edges": [e("s", "x"), e("x", "a"), e("a", "o")]}
    _, got = go(doc, "o")
    assert got["total"] == 20
    assert len(got["shown"]) == preview.LIMIT
    # Копии разные: у каждой своё зерно.
    first, second = got["shown"][0][0], got["shown"][1][0]
    assert not np.array_equal(first.image, second.image)


def test_вход_узла_это_выход_предыдущего_а_путь_по_порядку():
    doc = {"nodes": [
        {"id": "s", "type": "source"},
        {"id": "a1", "type": "aug", "params": BRIGHT},
        {"id": "a2", "type": "aug",
         "params": {"op": "HorizontalFlip", "args": {}, "chance": 1.0}},
        {"id": "o", "type": "output"},
    ], "edges": [e("s", "a1"), e("a1", "a2"), e("a2", "o")]}
    _, got = go(doc, "a2")
    (item, before), = got["shown"]
    assert before.step["node"] == "a1"
    assert np.array_equal(before.image[:, ::-1], item.image)
    assert [s["node"] for s in preview.trail(item)] == ["a1", "a2"]
    assert preview.trail(item)[1]["fired"] == ["HorizontalFlip"]


def test_несработавший_трансформ_виден_в_пути():
    doc = {"nodes": [
        {"id": "s", "type": "source"},
        {"id": "a", "type": "aug", "params": dict(BRIGHT, chance=0.0)},
        {"id": "o", "type": "output"},
    ], "edges": [e("s", "a"), e("a", "o")]}
    _, got = go(doc, "a")
    (item, before), = got["shown"]
    assert preview.trail(item)[0]["fired"] == []
    assert np.array_equal(item.image, before.image)


def test_у_блока_смотрится_его_выход_а_внутренности_в_пути():
    inner = {"nodes": [
        {"id": "i", "type": "input"},
        {"id": "a", "type": "aug", "params": BRIGHT},
        {"id": "o", "type": "output"},
    ], "edges": [e("i", "a"), e("a", "o")]}
    doc = {"nodes": [
        {"id": "s", "type": "source"},
        {"id": "g", "type": "group",
         "params": {"graph_id": "x", "version_id": "v"}},
        {"id": "out", "type": "output"},
    ], "edges": [e("s", "g"), e("g", "out")]}
    load = lambda _g, v: inner if v == "v" else None  # noqa: E731
    assert preview.ends(doc, load, "g") == (["g/i"], "g/o")
    _, got = go(doc, "g", load)
    (item, before), = got["shown"]
    assert [s["node"] for s in preview.trail(item)] == ["g/a"]
    assert before.step is None     # вход блока — исходный кадр


def test_ответ_шлёт_общий_вход_один_раз():
    doc = {"nodes": [
        {"id": "s", "type": "source"},
        {"id": "x", "type": "multiply", "params": {"times": 3}},
        {"id": "a", "type": "aug", "params": BRIGHT},
        {"id": "o", "type": "output"},
    ], "edges": [e("s", "x"), e("x", "a"), e("a", "o")]}
    compiled, got = go(doc, "a")
    sample = got["shown"][0][1]
    view = preview.describe(compiled, got, sample)
    # Исходный кадр — одна картинка на всех, и три разных «стало».
    assert len(view["pics"]) == 4
    assert {s["before"]["pic"] for s in view["samples"]} == {view["original"]["pic"]}
    assert view["pics"][0]["w"] == testframe.W
