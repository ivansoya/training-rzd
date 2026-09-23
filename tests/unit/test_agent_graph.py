"""Граф агента: номера классов сетей не смешиваются, одно имя — один класс.

Сеть подменена таблицей ответов, так что проверяется ровно то, о чём решали:
`0` у двух сетей — разные классы, одинаковое имя класса агента у двух сетей —
один класс, и «Объединение» гасит дубли только внутри класса.
"""
import pytest

from common import agent_graph as ag


def _net(nid, weights, rows):
    return {"id": nid, "type": "net",
            "params": {"weights": weights, "classes": [{"agent": a, "on": on} for a, on in rows]}}


def _doc():
    return {
        "nodes": [
            {"id": "f", "type": "frame"},
            _net("a", "w-vagon", [("вагон", True), ("цистерна", True)]),
            _net("b", "w-put", [("рельс", True), ("шпала", True), ("вагон", True), ("знак", False)]),
            {"id": "m", "type": "merge", "params": {"inputs": 2}},
            {"id": "o", "type": "output"},
        ],
        "edges": [
            {"from": "f", "out": "out", "to": "a", "in": "in"},
            {"from": "f", "out": "out", "to": "b", "in": "in"},
            {"from": "a", "out": "out", "to": "m", "in": "i0"},
            {"from": "b", "out": "out", "to": "m", "in": "i1"},
            {"from": "m", "out": "out", "to": "o", "in": "in"},
        ],
    }


ANSWERS = {
    # номер в весах, уверенность, x, y, w, h
    "a": [(0, 0.9, 10, 10, 100, 50), (1, 0.8, 300, 10, 80, 40)],
    "b": [(0, 0.95, 10, 10, 100, 50),   # «рельс» ровно там же, где вагон сети a
          (2, 0.7, 12, 11, 98, 50),     # «вагон» у сети b — дубль вагона сети a
          (3, 0.99, 500, 500, 10, 10)], # «знак» выключен
}


def test_классы_агента_по_именам_а_не_по_номерам():
    names = [c["name"] for c in ag.classes(_doc())]
    assert names == ["вагон", "цистерна", "рельс", "шпала"]
    vagon = ag.classes(_doc())[0]
    assert vagon["sources"] == [("a", 0), ("b", 2)]


def test_ноль_у_двух_сетей_разные_классы_дубли_только_внутри_класса():
    out = ag.run(_doc(), lambda node: ANSWERS[node["id"]])
    got = sorted((d["cls"], d["conf"]) for d in out)
    # вагон сети b погашен вагоном сети a; рельс на том же месте остался —
    # другой класс; знак выключен и не появился вовсе
    assert got == [("вагон", 0.9), ("рельс", 0.95), ("цистерна", 0.8)]


def test_сеть_дописывает_а_не_заменяет():
    doc = {
        "nodes": [{"id": "f", "type": "frame"},
                  _net("a", "w1", [("вагон", True)]),
                  _net("b", "w2", [("рельс", True)]),
                  {"id": "o", "type": "output"}],
        "edges": [{"from": "f", "out": "out", "to": "a", "in": "in"},
                  {"from": "a", "out": "out", "to": "b", "in": "in"},
                  {"from": "b", "out": "out", "to": "o", "in": "in"}],
    }
    out = ag.run(doc, lambda node: [(0, 0.5, 0, 0, 5, 5)])
    assert sorted(d["cls"] for d in out) == ["вагон", "рельс"]


@pytest.mark.parametrize("breaking,text", [
    (lambda d: d["nodes"].pop(), "Выхода"),
    (lambda d: d["edges"].pop(0), "не подключён"),
    (lambda d: d["nodes"][1]["params"].update(weights=None), "веса"),
    (lambda d: [r.update(on=False) for r in d["nodes"][1]["params"]["classes"]], "ни один класс"),
    (lambda d: d["edges"].append({"from": "m", "out": "out", "to": "a", "in": "in"}), "два провода"),
])
def test_форма_ломается_с_понятным_текстом(breaking, text):
    doc = _doc()
    breaking(doc)
    with pytest.raises(ag.AgentGraphError, match=text):
        ag.check(doc)


def test_таблица_классов_сверяется_с_весами():
    with pytest.raises(ag.AgentGraphError, match="не совпадает"):
        ag.check(_doc(), weights={"w-vagon": 3, "w-put": 4})
    with pytest.raises(ag.AgentGraphError, match="полке"):
        ag.check(_doc(), weights={"w-vagon": 2})
    ag.check(_doc(), weights={"w-vagon": 2, "w-put": 4})
