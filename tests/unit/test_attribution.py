"""Авторство рамок переживает сохранение кадра.

Главная отрицательная проверка — клиент не может подписать рамку агентом:
без неё любое сохранение с `agent_version_id` в теле подделало бы подпись.
Вторая — разбор фигуры с провода идемпотентен: иначе нетронутая рамка агента
после круга «база → клиент → база» выглядела бы сдвинутой и теряла автора.
"""
from common import shapes
from common.attribution import settle

AGENT, OWNER, EDITOR = "v3", "ivan", "petr"


def _old(**kw):
    row = {"class_id": "c-wagon", "ann_type": "bbox",
           "geometry": {"x": 10.0, "y": 20.0, "w": 100.0, "h": 50.0},
           "source": "model", "created_by": OWNER, "agent_version_id": AGENT}
    row.update(kw)
    return row


def _in(id_, **kw):
    item = {"id": id_, "class_id": "c-wagon", "ann_type": "bbox",
            "geometry": {"x": 10.0, "y": 20.0, "w": 100.0, "h": 50.0}}
    item.update(kw)
    return item


def test_нетронутая_рамка_остаётся_за_агентом():
    [row] = settle({"a": _old()}, [_in("a")], EDITOR)
    assert (row["source"], row["created_by"], row["agent_version_id"]) == ("model", OWNER, AGENT)


def test_сдвинутая_становится_рамкой_правившего_с_происхождением():
    moved = _in("a", geometry={"x": 12.0, "y": 20.0, "w": 100.0, "h": 50.0})
    [row] = settle({"a": _old()}, [moved], EDITOR)
    assert (row["source"], row["created_by"], row["agent_version_id"]) == ("human", EDITOR, AGENT)


def test_перекрашенная_тоже_правка():
    [row] = settle({"a": _old()}, [_in("a", class_id="c-tank")], EDITOR)
    assert row["created_by"] == EDITOR and row["source"] == "human"


def test_клиент_не_подписывает_рамку_агентом():
    forged = _in("чужой-id", source="model", agent_version_id=AGENT, created_by=OWNER)
    [row] = settle({"a": _old()}, [forged], EDITOR)
    assert row["agent_version_id"] is None
    assert row["created_by"] == EDITOR
    # полуавтомат по-прежнему может пометить свою рамку машинной
    assert row["source"] == "model"


def test_копия_рамки_не_наследует_авторство():
    rows = settle({"a": _old()}, [_in("a"), _in("a")], EDITOR)
    assert [r["created_by"] for r in rows] == [OWNER, EDITOR]
    assert rows[1]["agent_version_id"] is None


def test_фигура_с_провода_разбирается_одинаково_по_кругу():
    for raw in (
        {"kind": "bbox", "x": 10.337, "y": 5.1, "w": 99.999, "h": 40},
        {"kind": "polygon", "parts": [[[10.111, 10], [60.5, 12.25], [40, 50.019]]]},
    ):
        _, geom, _ = shapes.from_wire(raw, 1920, 1080)
        wire = shapes.to_wire("polygon" if "parts" in geom else "bbox", geom)
        _, again, _ = shapes.from_wire(wire, 1920, 1080)
        assert again == geom


def test_номер_рамки_переживает_сохранение():
    rows = settle({"a": _old(), "b": _old(agent_version_id=None, source="human")},
                  [_in("a"), _in("b", geometry={"x": 1.0, "y": 1.0, "w": 9.0, "h": 9.0}),
                   _in("новая")], EDITOR)
    assert [r["id"] for r in rows] == ["a", "b", None]
