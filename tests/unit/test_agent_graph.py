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


def _det(cls, conf, box):
    return {"cls": cls, "conf": conf, "box": box}


def test_фильтр_порог_по_классу_и_незнакомый_класс_проходит():
    dets = [_det("вагон", 0.4, (0, 0, 50, 50)), _det("вагон", 0.8, (0, 0, 50, 50)),
            _det("рельс", 0.9, (0, 0, 50, 50)), _det("шпала", 0.1, (0, 0, 50, 50))]
    params = {"classes": [{"cls": "вагон", "on": True, "conf": 0.5},
                          {"cls": "рельс", "on": False, "conf": 0}]}
    got = [(d["cls"], d["conf"]) for d in ag.filter_dets(dets, params)]
    # «шпалы» в таблице нет — проходит насквозь даже с 0,1
    assert got == [("вагон", 0.8), ("шпала", 0.1)]


def test_фильтр_по_сторонам_рамки():
    dets = [_det("а", 1, (0, 0, 5, 100)), _det("а", 1, (0, 0, 20, 30)), _det("а", 1, (0, 0, 20, 900))]
    got = [d["box"] for d in ag.filter_dets(dets, {"min_side": 8, "max_side": 500})]
    assert got == [(0, 0, 20, 30)]
    # пустые поля — без предела
    assert len(ag.filter_dets(dets, {"min_side": "", "max_side": None})) == 3


def _masks(*rects, size=(200, 300)):
    import numpy as np
    out = []
    for x0, y0, x1, y1 in rects:
        m = np.zeros(size, dtype=bool)
        m[y0:y1, x0:x1] = True
        out.append(m)
    return np.array(out)


def test_sam_дописывает_обводку_и_подтягивает_рамку():
    det = _det("вагон", 0.9, (40, 40, 100, 80))
    masks = _masks((50, 50, 130, 110), (45, 45, 135, 115), (0, 0, 300, 200))
    out = ag.outline(det, masks, [0.6, 0.95, 0.2], {"min_area": 0})
    assert out["box"] == (45, 45, 90, 70)   # «как решит модель» — маска с оценкой 0,95
    assert out["sam"] == 0.95 and len(out["parts"]) == 1
    assert out["conf"] == 0.9 and "parts" not in det


def test_детализация_как_у_полуавтомата():
    from common import contours
    masks = _masks((0, 0, 50, 50), (0, 0, 10, 10), (0, 0, 30, 30))
    scores = [0.1, 0.2, 0.9]
    assert contours.pick_mask(masks, scores, "object")[0].sum() == 2500
    assert contours.pick_mask(masks, scores, "subpart")[0].sum() == 100
    assert contours.pick_mask(masks, scores, "auto")[1] == 0.9


def test_sam_не_справился_рамка_остаётся():
    det = _det("вагон", 0.9, (40, 40, 100, 80))
    tiny = _masks((60, 60, 70, 70), (60, 60, 70, 70), (60, 60, 70, 70))   # 100 px < 5 % от 8000
    assert ag.outline(det, tiny, [0.9, 0.9, 0.9], {}) is det
    low = _masks((45, 45, 135, 115), (45, 45, 135, 115), (45, 45, 135, 115))
    assert ag.outline(det, low, [0.1, 0.2, 0.25], {}) is det   # ниже порога 0,3


def test_sam_маска_за_рамкой_обрезается_с_запасом():
    det = _det("вагон", 0.9, (100, 50, 100, 100))
    # маска утекла на весь кадр: остаётся рамка плюс 10 % с каждой стороны
    spill = _masks((0, 0, 300, 200), (0, 0, 300, 200), (0, 0, 300, 200))
    out = ag.outline(det, spill, [0.9, 0.9, 0.9], {"fill_holes": False})
    assert out["box"] == (90, 40, 120, 120)


def test_sam_в_графе_и_проверка_модели():
    doc = {
        "nodes": [{"id": "f", "type": "frame"}, _net("a", "w1", [("вагон", True)]),
                  {"id": "flt", "type": "filter", "params": {"min_side": 30}},
                  {"id": "s", "type": "sam", "params": {"min_area": 0}},
                  {"id": "o", "type": "output"}],
        "edges": [{"from": "f", "out": "out", "to": "a", "in": "in"},
                  {"from": "a", "out": "out", "to": "flt", "in": "in"},
                  {"from": "flt", "out": "out", "to": "s", "in": "in"},
                  {"from": "s", "out": "out", "to": "o", "in": "in"}],
    }
    asked = []

    def segment(node, box):
        asked.append(box)
        return _masks((45, 45, 135, 115), (45, 45, 135, 115), (45, 45, 135, 115)), [0.9, 0.8, 0.7]

    out = ag.run(doc, lambda node: [(0, 0.9, 40, 40, 100, 80), (0, 0.9, 0, 0, 10, 10)], segment=segment)
    assert asked == [(40, 40, 100, 80)]   # мелкую рамку фильтр отсеял раньше SAM
    assert [d["box"] for d in out] == [(45, 45, 90, 70)] and out[0]["parts"]
    doc["nodes"][3]["params"]["model"] = "sam3"
    with pytest.raises(ag.AgentGraphError, match="неизвестная модель"):
        ag.check(doc)


def test_таблица_классов_сверяется_с_весами():
    with pytest.raises(ag.AgentGraphError, match="не совпадает"):
        ag.check(_doc(), weights={"w-vagon": 3, "w-put": 4})
    with pytest.raises(ag.AgentGraphError, match="полке"):
        ag.check(_doc(), weights={"w-vagon": 2})
    ag.check(_doc(), weights={"w-vagon": 2, "w-put": 4})
