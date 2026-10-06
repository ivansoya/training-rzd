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


def test_тайлы_кадра_рсм_при_тайле_1280():
    got = ag.tiles(2688, 1520, 1280)
    assert [(x0, y0) for x0, y0, _, _ in got] == [(0, 0), (704, 0), (1408, 0), (0, 240), (704, 240), (1408, 240)]
    assert all(x1 - x0 == 1280 and y1 - y0 == 1280 for x0, y0, x1, y1 in got)
    assert ag.tiles(1280, 720, 1280) == []           # кадр влезает в тайл — тайлов нет
    assert ag.views({"tiles": True}, 2688, 1520, 1280)[0] == (0, 0, 2688, 1520)   # целый кадр первым
    assert len(ag.views({}, 2688, 1520, 1280)) == 1


def test_без_целого_кадра_только_тайлы_но_малый_кадр_остаётся():
    assert len(ag.views({"tiles": True, "whole": False}, 2688, 1520, 1280)) == 6
    assert ag.views({"tiles": True, "whole": False}, 1280, 720, 1280) == [(0, 0, 1280, 720)]


def test_тайл_по_умолчанию_вход_сети():
    net = {"type": "net", "params": {"tiles": True}}
    assert ag.tile_side(net, 960) == 960                            # вход весов
    assert ag.tile_side({"type": "net", "params": {"imgsz": 1280}}, 960) == 1280
    assert ag.tile_side({"type": "net", "params": {"tile": 640, "imgsz": 1280}}) == 640
    assert ag.tile_side({"type": "text", "params": {}}) == ag.TEXT_IMGSZ
    assert ag.tile_side({"type": "text", "params": {"model": "sam3"}}) == ag.SAM3_SIDE
    # 1 целый + 5×3 тайлов по 640 при перекрытии 0,2
    assert ag.passes({"type": "net", "params": {"tiles": True, "tile": 640}}, 2688, 1520) == 16


def test_потолок_проходов_на_самом_большом_кадре():
    doc = _doc()
    doc["nodes"][1]["params"].update(tiles=True, tile=160)
    ag.check(doc)                                    # кадр неизвестен — не сверяем
    with pytest.raises(ag.AgentGraphError, match="тайл 160 на кадре 2688×1520 — 2[0-9]{2} проходов"):
        ag.check(doc, frame=(2688, 1520))
    doc["nodes"][1]["params"]["tile"] = 640
    ag.check(doc, frame=(2688, 1520))


def test_склейка_сращивает_обрывки_и_гасит_дубль_целого():
    whole = (0, 0.8, (100, 100, 200, 100), None, False)
    left, right = (0, 0.9, (100, 100, 110, 100), None, True), (0, 0.7, (190, 100, 110, 100), None, True)
    other = (1, 0.9, (100, 100, 110, 100), None, True)                     # другой класс не трогаем
    out = ag.glue([whole, left, right, other])
    assert sorted(out) == [(0, 0.9, (100, 100, 200, 100), None), (1, 0.9, (100, 100, 110, 100), None)]


def _square(x, y, w, h):
    return {"box": (x, y, w, h), "sam": 0.8, "parts": [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]]}


def test_склейка_берёт_контур_целого_вида_а_обрывки_объединяет():
    whole = (0, 0.6, (100, 100, 200, 100), _square(100, 100, 200, 100), False)
    cut = (0, 0.9, (100, 100, 110, 100), _square(100, 100, 110, 100), True)
    [(_, conf, _, shape)] = ag.glue([whole, cut])
    assert conf == 0.9 and shape["box"] == (100, 100, 200, 100)     # уверенность лучшая, контур — целого
    right = (0, 0.7, (150, 100, 150, 100), _square(150, 100, 150, 100), True)   # IoS 0,55
    [(_, _, _, shape)] = ag.glue([cut, right])
    x, y, w, h = shape["box"]
    assert (x, y) == (100, 100) and abs(w - 201) <= 1 and abs(h - 101) <= 1


def test_detect_сдвигает_тайл_и_гонит_пачками():
    asked = []

    def infer(views):
        asked.append(len(views))
        # в каждом вырезке объект у левого края
        return [[(0, 0.9, 10, 20, 50, 40)] for _ in views]

    out = ag.detect({"tiles": True, "tile": 640}, 2688, 1520, 640, infer)
    assert asked == [8, 8]                          # 16 видов пачками по 8
    got = sorted({(round(x), round(y)) for _, _, x, y, *_ in out})
    # целый кадр и первый тайл видят одно место — склеились в одну
    assert (10, 20) in got and len(out) == 15
    assert all(len(d) == 7 for d in out)            # седьмым — контур (здесь None)


def test_detect_сдвигает_контур_тайла():
    def infer(views):
        return [[(0, 0.9, 10, 20, 50, 40, _square(10, 20, 50, 40))] if v[0] > 0 else [] for v in views]

    out = ag.detect({"tiles": True, "tile": 1280, "whole": False}, 2688, 1520, 1280, infer)
    xs = sorted(d[6]["parts"][0][0][0] for d in out)
    assert xs == [714, 714, 1418, 1418]


def test_трасса_меряет_время_узла():
    trace = {}
    ag.run(_doc(), lambda node: ANSWERS[node["id"]], trace=trace)
    assert all(isinstance(t["ms"], float) for t in trace.values())


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


# --------------------------------------------------------------------------- #
# «Сеть по тексту»
# --------------------------------------------------------------------------- #
def _text(nid, rows, **params):
    return {"id": nid, "type": "text",
            "params": {"prompts": [{"prompt": p, "agent": a, "on": on} for p, a, on in rows], **params}}


def _text_doc(node):
    return {"nodes": [{"id": "f", "type": "frame"}, node, {"id": "o", "type": "output"}],
            "edges": [{"from": "f", "out": "out", "to": node["id"], "in": "in"},
                      {"from": node["id"], "out": "out", "to": "o", "in": "in"}]}


ROWS = [("person", "Человек", True), ("rag", "Тряпьё", False), ("worker", "Человек", True),
        ("", "Пусто", True), ("bottle", "Тряпьё", True)]


def test_текст_модель_видит_только_включённые_промты_а_номер_строки_сохраняется():
    node = _text("t", ROWS)
    # выключенная строка и строка без промта в модель не идут
    assert ag.text_prompts(node) == [(0, "person"), (2, "worker"), (4, "bottle")]
    # синонимы сходятся в один класс; класс «Пусто» без промта не рождается
    assert [(c["name"], c["sources"]) for c in ag.classes(_text_doc(node))] == [
        ("Человек", [("t", 0), ("t", 2)]), ("Тряпьё", [("t", 4)])]


def test_текст_в_графе_номер_строки_переводится_в_класс_агента():
    doc = _text_doc(_text("t", ROWS))
    out = ag.run(doc, lambda node: [(2, 0.7, 1, 1, 5, 5), (4, 0.6, 9, 9, 5, 5), (1, 0.9, 0, 0, 1, 1)])
    # строка 1 выключена — её находку не пропускаем, даже если модель её дала
    assert [(d["cls"], d["conf"]) for d in out] == [("Человек", 0.7), ("Тряпьё", 0.6)]


def test_текст_контур_sam3_только_когда_он_нужен():
    shape = {"box": (2, 2, 3, 3), "parts": [[[2, 2], [5, 2], [5, 5]]], "sam": 0.8}
    doc = _text_doc(_text("t", ROWS, model="sam3"))
    answer = lambda node: [(0, 0.8, 1, 1, 5, 5, shape), (2, 0.5, 9, 9, 5, 5, None)]
    out = ag.run(doc, answer, segment=lambda *a: None)
    assert out[0]["parts"] == shape["parts"] and out[0]["box"] == (2, 2, 3, 3)
    assert "parts" not in out[1]
    # разведка идёт без segment — контур ей не пишется
    assert all("parts" not in d for d in ag.run(doc, answer))


def test_текст_проверка_формы():
    ag.check(_text_doc(_text("t", ROWS)))
    with pytest.raises(ag.AgentGraphError, match="ни одна строка"):
        ag.check(_text_doc(_text("t", [("person", "Человек", False)])))
    with pytest.raises(ag.AgentGraphError, match="повторяется"):
        ag.check(_text_doc(_text("t", [("person", "Человек", True), ("Person ", "Люди", True)])))
    with pytest.raises(ag.AgentGraphError, match="неизвестная модель"):
        ag.check(_text_doc(_text("t", ROWS, model="n")))
    sam3 = _text_doc(_text("t", ROWS, model="sam3"))
    ag.check(sam3)               # не сверяем — черновик
    ag.check(sam3, sam3=True)
    with pytest.raises(ag.AgentGraphError, match="нет весов SAM 3"):
        ag.check(sam3, sam3=False)


def test_текст_порог_по_модели():
    assert ag.text_conf({}) == 0.25
    assert ag.text_conf({"model": "sam3"}) == 0.4
    assert ag.text_conf({"model": "sam3", "conf": 0.1}) == 0.1
    assert ag.text_model({"model": "мусор"}) == "l"


def test_текст_контур_sam3_возвращается_в_пиксели_кадра():
    np = pytest.importorskip("numpy")
    pytest.importorskip("cv2")
    k = 0.5
    mask = np.zeros((60, 100), dtype=bool)
    mask[10:30, 20:60] = True   # в ужатом кадре: x 20..59, y 10..29
    got = ag.text_outline((38, 18, 84, 44), mask, 0.9, {}, k)
    x, y, w, h = got["box"]
    assert (x, y, w, h) == (40, 20, 80, 40)
    xs = [px for ring in got["parts"] for px, _ in ring]
    assert min(xs) >= 40 and max(xs) <= 120
    # пятнышко меньше 5 % рамки — контура нет
    tiny = np.zeros((60, 100), dtype=bool)
    tiny[10:11, 20:21] = True
    assert ag.text_outline((38, 18, 84, 44), tiny, 0.9, {}, k) is None


def test_текст_образцы_и_порог_строки():
    rows = [{"prompt": "person", "agent": "Человек", "on": True},
            {"kind": "examples", "set": "s1", "agent": "Инструмент", "on": True, "conf": 0.1},
            {"kind": "examples", "set": "", "agent": "Пусто", "on": True},
            {"prompt": "rag", "agent": "Тряпьё", "on": True, "conf": 0.5}]
    node = {"id": "t", "type": "text", "params": {"prompts": rows}}
    doc = _text_doc(node)
    # строка-образцы без набора не считается; порядок классов модели — строки
    assert [i for i, _ in ag.text_rows(node)] == [0, 1, 3]
    assert ag.text_sets(node) == [(1, "s1")] and ag.text_prompts(node) == [(0, "person"), (3, "rag")]
    assert ag.min_conf(node) == 0.1
    # у каждой строки свой порог: 0,2 проходит у образцов (0,1), но не у слова (0,25)
    out = ag.run(doc, lambda n: [(0, 0.2, 0, 0, 5, 5), (1, 0.2, 9, 9, 5, 5), (3, 0.45, 20, 20, 5, 5)])
    assert [(d["cls"], d["conf"]) for d in out] == [("Инструмент", 0.2)]
    ag.check(doc, examples={"s1": True})
    with pytest.raises(ag.AgentGraphError, match="нет на вашей полке"):
        ag.check(doc, examples={})
    with pytest.raises(ag.AgentGraphError, match="ещё не собран"):
        ag.check(doc, examples={"s1": False})
    rows.append({"kind": "examples", "set": "s1", "agent": "Другое", "on": True})
    with pytest.raises(ag.AgentGraphError, match="в двух строках"):
        ag.check(doc)
    rows.pop()
    rows[1]["conf"] = 1.5
    with pytest.raises(ag.AgentGraphError, match="от 0 до 1"):
        ag.check(doc)


@pytest.mark.parametrize("nid,key,value,text", [
    ("a", "conf", 7, "«Сеть»: «Уверенность от» — число от 0 до 1, сейчас 7"),
    ("a", "conf", -0.1, "Уверенность от"),
    ("a", "conf", "много", "Уверенность от"),
    ("a", "imgsz", 0, "«Размер входа» — целое от 320 до 4096, сейчас 0"),
    ("a", "imgsz", 1, "Размер входа"),        # вход 1 с тайлами — миллионы видов на кадр
    ("a", "imgsz", 640.5, "целое"),
    ("a", "overlap", 0.95, "Перекрытие"),
    ("m", "inputs", 9, "Входов"),
])
def test_числа_узлов_в_пределах_и_ошибка_называет_узел_и_поле(nid, key, value, text):
    doc = _doc()
    next(n for n in doc["nodes"] if n["id"] == nid)["params"][key] = value
    with pytest.raises(ag.AgentGraphError, match=text):
        ag.check(doc)


def test_края_пределов_и_пустое_проходят():
    doc = _doc()
    doc["nodes"][1]["params"].update(conf=0, imgsz=320, overlap=None, glue="")
    doc["nodes"][2]["params"].update(conf=1, imgsz=4096.0)
    ag.check(doc)


def test_фильтр_стороны_и_пороги_классов():
    doc = _doc()
    doc["nodes"].insert(5, {"id": "flt", "type": "filter", "params": {"min_side": 500, "max_side": 10}})
    doc["edges"][-1] = {"from": "n", "out": "out", "to": "flt", "in": "in"}
    doc["edges"].append({"from": "flt", "out": "out", "to": "o", "in": "in"})
    with pytest.raises(ag.AgentGraphError, match="«Сторона от» больше"):
        ag.check(doc)
    doc["nodes"][5]["params"] = {"min_side": 10, "classes": [{"cls": "вагон", "on": True, "conf": 5}]}
    with pytest.raises(ag.AgentGraphError, match="порог класса"):
        ag.check(doc)
    doc["nodes"][5]["params"]["classes"][0]["conf"] = 0.5
    ag.check(doc)


def test_подпись_узла_в_ошибке_различает_две_сети():
    doc = _doc()
    doc["nodes"][2]["params"].update(label=" путь ", conf=7)
    with pytest.raises(ag.AgentGraphError, match="«Сеть — путь»"):
        ag.check(doc)


def test_ноль_не_подменяется_умолчанием():
    # уверенность 0 — «всё подряд»; прогон берёт её через num, а не через `or`
    assert ag.num(0, 0.25) == 0 and ag.num(None, 0.25) == 0.25 and ag.num("", 0.25) == 0.25


def test_прогон_зажимает_старые_числа_а_не_отвергает():
    # версия, сохранённая до пределов, должна запускаться
    doc = _doc()
    doc["nodes"][1]["params"].update(conf=7, imgsz=0, overlap="много")
    ag.check(doc, clamp=True)
    p = doc["nodes"][1]["params"]
    assert p["conf"] == 1 and p["imgsz"] == 320 and "overlap" not in p


def test_прогон_зажимает_фильтр():
    doc = _doc()
    doc["nodes"].insert(5, {"id": "flt", "type": "filter", "params": {
        "min_side": 500, "max_side": 10, "classes": [{"cls": "вагон", "on": True, "conf": 5}]}})
    doc["edges"][-1] = {"from": "n", "out": "out", "to": "flt", "in": "in"}
    doc["edges"].append({"from": "flt", "out": "out", "to": "o", "in": "in"})
    ag.check(doc, clamp=True)
    p = doc["nodes"][5]["params"]
    assert p["max_side"] == 500 and p["classes"][0]["conf"] == 1


def test_sam3_не_больше_16_строк_и_бронь_растёт_с_промтами():
    many = [(f"w{i}", f"Класс {i}", True) for i in range(17)]
    with pytest.raises(ag.AgentGraphError, match="не больше 16"):
        ag.check(_text_doc(_text("t", many, model="sam3")))
    ag.check(_text_doc(_text("t", many)))  # YOLOE — без потолка
    two = _text("t", many[:2], model="sam3")
    assert ag.text_vram_mb(two) == ag.SAM3_BASE_MB + 2 * ag.SAM3_PER_PROMPT_MB
    assert ag.text_vram_mb(_text("t", many[:2])) == ag.YOLOE_MB


def test_длинный_промт_отвергается_словами():
    with pytest.raises(ag.AgentGraphError, match="длиннее 64"):
        ag.check(_text_doc(_text("t", [("слово " * 20, "Класс", True)])))
