"""Граф агента: номера классов сетей не смешиваются, одно имя — один класс.

Сеть подменена таблицей ответов, так что проверяется ровно то, о чём решали:
`0` у двух сетей — разные классы, одинаковое имя класса агента у двух сетей —
один класс. «Объединение» только складывает ветки, дубли гасит «NMS» — по
умолчанию внутри класса.
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
            {"id": "n", "type": "nms", "params": {"iou": 0.6}},
            {"id": "o", "type": "output"},
        ],
        "edges": [
            {"from": "f", "out": "out", "to": "a", "in": "in"},
            {"from": "f", "out": "out", "to": "b", "in": "in"},
            {"from": "a", "out": "out", "to": "m", "in": "i0"},
            {"from": "b", "out": "out", "to": "m", "in": "i1"},
            {"from": "m", "out": "out", "to": "n", "in": "in"},
            {"from": "n", "out": "out", "to": "o", "in": "in"},
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


def test_объединение_только_складывает():
    doc = _doc()
    doc["nodes"] = [n for n in doc["nodes"] if n["id"] != "n"]
    doc["edges"] = [e for e in doc["edges"] if "n" not in (e["from"], e["to"])]
    doc["edges"].append({"from": "m", "out": "out", "to": "o", "in": "in"})
    out = ag.run(doc, lambda node: ANSWERS[node["id"]])
    # без «NMS» вагон сети b остаётся рядом с вагоном сети a
    assert sorted(d["cls"] for d in out) == ["вагон", "вагон", "рельс", "цистерна"]


def test_nms_внутри_класса_и_между_классами():
    dets = [_det("Человек", 0.34, (2313, 1389, 363, 131)),   # пара с кадра 00-42.942
            _det("Человек", 0.27, (2310, 1384, 363, 136)),
            _det("Инструмент", 0.30, (2312, 1386, 362, 133))]
    inside = ag.nms(dets)
    assert [(d["cls"], d["conf"]) for d in inside] == [("Человек", 0.34), ("Инструмент", 0.30)]
    across = ag.nms(dets, agnostic=True)
    assert [(d["cls"], d["conf"]) for d in across] == [("Человек", 0.34)]
    # порог выше перекрытия пары — гасить нечего
    assert len(ag.nms(dets, threshold=0.99)) == 3


@pytest.mark.parametrize("value", [0, -0.1, 1.5])
def test_nms_порог_от_нуля_до_единицы(value):
    doc = _doc()
    doc["nodes"][4]["params"]["iou"] = value
    with pytest.raises(ag.AgentGraphError, match="IoU"):
        ag.check(doc)


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
    # трасса для превью: фильтр видно по тому, чего нет на выходе; у SAM имя
    # обнаружения то же, но уже с обводкой
    trace = {}
    ag.run(doc, lambda node: [(0, 0.9, 40, 40, 100, 80), (0, 0.9, 0, 0, 10, 10)], segment=segment, trace=trace)
    assert [d["id"] for d in trace["flt"]["in"]] == ["a.0", "a.1"]
    assert [d["id"] for d in trace["flt"]["out"]] == ["a.0"]
    assert "parts" not in trace["s"]["in"][0] and trace["s"]["out"][0]["id"] == "a.0"
    assert trace["s"]["out"][0]["parts"] and trace["o"]["out"] == trace["s"]["out"]
    doc["nodes"][3]["params"]["model"] = "sam3"
    with pytest.raises(ag.AgentGraphError, match="неизвестная модель"):
        ag.check(doc)


def test_плитки_кадра_рсм_при_входе_1280():
    got = ag.tiles(2688, 1520, 1280)
    assert [(x0, y0) for x0, y0, _, _ in got] == [(0, 0), (704, 0), (1408, 0), (0, 240), (704, 240), (1408, 240)]
    assert all(x1 - x0 == 1280 and y1 - y0 == 1280 for x0, y0, x1, y1 in got)
    assert ag.tiles(1280, 720, 1280) == []           # кадр влезает во вход — плиток нет
    assert ag.views({"tiles": True}, 2688, 1520, 1280)[0] == (0, 0, 2688, 1520)   # целый кадр первым
    assert len(ag.views({}, 2688, 1520, 1280)) == 1


def test_tta_проходы():
    assert ag.variants({}) == [(False, 1.0)]
    assert len(ag.variants({"tta_flip": True, "tta_scales": True})) == 6


def test_wbf_усредняет_и_штрафует_случайную_находку():
    dets = [(0, 0.9, (100, 100, 50, 50)), (0, 0.6, (104, 100, 50, 50)),   # два прохода видят одно
            (0, 0.9, (400, 400, 20, 20))]                                  # один проход из двух
    out = sorted(ag.wbf(dets, passes=2), key=lambda d: d[2][0])
    cls, conf, box = out[0]
    assert conf == pytest.approx(0.75) and box[0] == pytest.approx(101.6)
    assert out[1][1] == pytest.approx(0.45)


def test_склейка_сращивает_обрывки_и_гасит_дубль_целого():
    whole = (0, 0.8, (100, 100, 200, 100))
    left, right = (0, 0.9, (100, 100, 110, 100)), (0, 0.7, (190, 100, 110, 100))
    other = (1, 0.9, (100, 100, 110, 100))                                   # другой класс не трогаем
    out = ag.glue([whole, left, right, other])
    assert sorted(out) == [(0, 0.9, (100, 100, 200, 100)), (1, 0.9, (100, 100, 110, 100))]


def test_detect_снимает_отражение_и_сдвиг_плитки():
    asked = []

    def infer(jobs, scale):
        asked.append((len(jobs), scale))
        # в каждом вырезке объект у левого края; в отражённом — у правого
        return [[(0, 0.9, (x1 - x0) - 60 if flip else 10, 20, 50, 40)] for (x0, _, x1, _), flip in jobs]

    params = {"tiles": True, "tta_flip": True}
    out = ag.detect(params, 2688, 1520, 1280, infer)
    assert asked == [(14, 1.0)]                       # 7 видов × 2 отражения одной пачкой
    got = sorted((round(x), round(y)) for _, _, x, y, _, _ in out)
    # после снятия отражения оба прохода совпали (x = 10 внутри вырезка) и
    # слились; целый кадр и первая плитка видят одно место — склеились в одну
    assert got == [(10, 20), (10, 260), (714, 20), (714, 260), (1418, 20), (1418, 260)]
    assert all(conf == pytest.approx(0.9) for _, conf, *_ in out)


def test_таблица_классов_сверяется_с_весами():
    with pytest.raises(ag.AgentGraphError, match="не совпадает"):
        ag.check(_doc(), weights={"w-vagon": 3, "w-put": 4})
    with pytest.raises(ag.AgentGraphError, match="полке"):
        ag.check(_doc(), weights={"w-vagon": 2})
    ag.check(_doc(), weights={"w-vagon": 2, "w-put": 4})


def test_ролик_каждый_n_й_кадр_кроме_занятых():
    assert ag.sampled(100, 25) == [0, 25, 50, 75, 100]
    assert ag.sampled(99, 25, skip={25}) == [0, 50, 75]


def test_разведка_склеивает_разрывы_до_допуска():
    hits = {0: {"человек"}, 25: {"человек"}, 50: {"человек"}, 75: {"инструмент"},
            150: {"человек"}}
    got = ag.segments(hits, step=25, gap_frames=50, last_frame=160)
    # между 50 и 150 пустоты 75 кадров — больше допуска в 50: два участка;
    # края расширены на полшага и прижаты к концу ролика
    assert got["человек"] == [[0, 62, 3], [138, 160, 1]]
    assert got["инструмент"] == [[63, 87, 1]]
    # допуск шире — один участок
    assert ag.segments(hits, 25, 100, 160)["человек"] == [[0, 160, 4]]


def test_кадры_где_работал_человек():
    from common.video_tracks import human_frames
    track = {"start_frame": 10, "end_frame": None, "interpolate": True, "hidden_ranges": [],
             "keys": [{"frame_no": 10, "geometry": {"x": 0, "y": 0, "w": 5, "h": 5}},
                      {"frame_no": 20, "geometry": {"x": 5, "y": 0, "w": 5, "h": 5}}]}
    singles = [{"frame_no": 30, "source": "human", "agent_version_id": None},
               {"frame_no": 0, "source": "model", "agent_version_id": "v1"},     # рамка агента — не занят
               {"frame_no": 35, "source": "human", "agent_version_id": "v1"}]    # правленая агентова — занят
    busy = human_frames([track], singles, marks=[25], frames=[0, 10, 15, 20, 25, 30, 35, 40])
    assert busy == {10, 15, 20, 25, 30, 35}


def test_статистика_разведки():
    frames = {
        "0": [["Человек", 0.9, 0, 0, 100, 200], ["металл", 0.5, 0, 0, 20, 10]],
        "25": [],
        "50": [["Человек", 0.7, 0, 0, 120, 220], ["Человек", 0.95, 300, 0, 80, 180]],
    }
    got = ag.scout_stats(frames)
    assert got["checked"] == [0, 25, 50]
    assert (got["with_hits"], got["boxes"], got["max"], got["max_at"]) == (2, 4, 2, 0)
    assert got["per_frame"] == [2, 0, 2]
    person, metal = got["classes"]
    assert person["name"] == "Человек" and metal["name"] == "металл"
    assert (person["boxes"], person["frames"], person["max"]) == (3, 2, 2)
    assert person["counts"] == [1, 0, 2]
    assert person["conf"]["median"] == 0.9 and person["conf"]["min"] == 0.7
    assert person["conf"]["hist"][7] == 1 and person["conf"]["hist"][9] == 2
    assert person["size"] == [100, 200]
    assert ag.scout_stats({})["max_at"] is None
