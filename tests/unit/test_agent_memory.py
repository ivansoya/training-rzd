"""Память агента и вердикт «влезет ли», порция слов SAM 3, NMS между агентами.

Решения владельца 09.10.2026: одна SAM 3 на вход, поочерёдный режим только
когда сумма не влезает, а самый тяжёлый блок влезает; процессора нет."""
from common import agent_graph, agent_memory as am


def sam3(nid, words, side=1008, per=None, sets=0):
    rows = [{"on": True, "agent": f"к{i}", "prompt": f"слово {i}"} for i in range(words)]
    rows += [{"on": True, "agent": f"о{i}", "kind": "examples", "set": f"s{i}"} for i in range(sets)]
    params = {"model": "sam3", "side": side, "prompts": rows}
    if per is not None:
        params["words"] = per
    return {"id": nid, "type": "text", "params": params}


def net(nid, **params):
    return {"id": nid, "type": "net", "params": params}


def sam(nid, model="sam2.1_hiera_small"):
    return {"id": nid, "type": "sam", "params": {"model": model}}


def card(name="RTX 5070 Ti", cap=13312, free=None):
    return {"name": name, "cap_mb": cap, "free_mb": cap if free is None else free}


# ---- порция слов -------------------------------------------------------------
def test_авто_берёт_умолчание_входа_пока_влезает():
    node = sam3("t", 8)
    assert agent_graph.sam3_words_per_call(node["params"], 8) == 4
    assert agent_graph.sam3_words_per_call(sam3("t", 8, side=644)["params"], 8) == 16


def test_авто_ужимает_порцию_под_потолок_карты():
    # 1008: 2070 + 845·4 = 5450 > 5000 → 2 слова: 3760.
    assert agent_graph.sam3_words_per_call(sam3("t", 8)["params"], 8, cap_mb=5000) == 2


def test_ручная_порция_не_зависит_от_карты():
    node = sam3("t", 8, per=1)
    assert agent_graph.sam3_words_per_call(node["params"], 8, cap_mb=100_000) == 1
    assert agent_graph.text_vram_mb(node) == 2070 + 845


def test_без_тумблера_сервера_sam3_упирается_во_всплеск_загрузки():
    # 644, одно слово: работа 1990, а fp32-копия при загрузке — 3250.
    params = sam3("t", 1, side=644)["params"]
    assert agent_graph.sam3_mb(params, 1) == 1990
    assert agent_graph.sam3_mb(params, 1, cpu_half=False) == 3250
    # 1008, 4 слова: работа больше всплеска — тумблер не меняет пик.
    assert agent_graph.sam3_mb(sam3("t", 4)["params"], 4, cpu_half=False) == 2070 + 4 * 845
    doc = {"nodes": [sam3("t", 1, side=644)]}
    assert am.plan(doc, sam3_cpu_half=False)["total_mb"] == 3250


def test_порция_умножает_вызовы():
    one = sam3("t", 8, per=1)
    four = sam3("t", 8, per=4)
    assert agent_graph.calls(one, 1008, 1008) == 8
    assert agent_graph.calls(four, 1008, 1008) == 2


def test_неверная_порция_ошибка():
    doc = {"nodes": [{"id": "f", "type": "frame"}, sam3("t", 2, per=3), {"id": "o", "type": "output"}],
           "edges": [{"source": "f", "target": "t"}, {"source": "t", "target": "o"}]}
    try:
        agent_graph._check_text(doc["nodes"][1], True, None)
    except agent_graph.AgentGraphError as exc:
        assert "Слов за проход" in str(exc)
    else:
        raise AssertionError("порция 3 прошла")


# ---- блоки памяти ------------------------------------------------------------
def test_узлы_sam3_делят_одну_модель():
    doc = {"nodes": [sam3("a", 2), sam3("b", 4)]}
    got = am.plan(doc)
    sam_units = [u for u in got["units"] if u["kind"] == "sam3"]
    assert len(sam_units) == 1
    assert sam_units[0]["mb"] == 2070 + 845 * 4
    assert got["total_mb"] == 2070 + 845 * 4


def test_разные_входы_это_разные_модели():
    got = am.plan({"nodes": [sam3("a", 1), sam3("b", 1, side=644)]})
    assert {u["key"] for u in got["units"]} == {"sam3@1008", "sam3@644"}


def test_модели_sam2_один_блок_и_разведке_не_нужны():
    doc = {"nodes": [net("n"), sam("s1"), sam("s2", "sam2.1_hiera_large")]}
    small, large = am.SAM2_PEAK["sam2.1_hiera_small"], am.SAM2_PEAK["sam2.1_hiera_large"]
    assert [u["mb"] for u in am.plan(doc)["units"] if u["kind"] == "sam"] == [small + large]
    assert all(u["kind"] != "sam" for u in am.plan(doc, scout=True)["units"])


def test_самый_тяжёлый_блок():
    got = am.plan({"nodes": [net("n"), sam3("t", 4)]})
    assert got["heaviest"]["key"] == "sam3@1008"
    assert got["total_mb"] == am.net_mb({}) + 2070 + 845 * 4


def test_сеть_по_весу_файла_задаче_и_тайлам():
    n11 = {"file_mb": 5.4, "task": "detect", "imgsz": 640}
    seg = {"file_mb": 52.2, "task": "segment", "imgsz": 640}
    # Сетка 10.10.2026: yolo11n на 640 — пик 34 МБ, yolo26m-seg на 1280 с 8 видами — 4313.
    assert 30 <= am.net_mb({}, n11) <= 60
    assert 4313 <= am.net_mb({"imgsz": 1280, "tiles": True}, seg) <= 4700
    # Без строки полки — с запасом, не меньше настоящей сегментации на 50 МБ.
    assert am.net_mb({"imgsz": 1280, "tiles": True}) >= 4200
    plan = am.plan({"nodes": [net("a", imgsz=1280)]}, nets={"a": n11})
    assert plan["nodes"]["a"] == am.net_mb({"imgsz": 1280}, n11)

# ---- вердикт -----------------------------------------------------------------
def test_влезает_на_ту_где_свободнее():
    got = am.verdict(7000, {"mb": 7000, "label": "SAM 3"},
                     [card("A", free=7500), card("B", free=12000)])
    assert got["state"] == am.FITS and got["card"] == "B"


def test_занято_значит_ждать_а_не_процессор():
    got = am.verdict(7000, {"mb": 7000, "label": "SAM 3"}, [card(free=2000)])
    assert got["state"] == am.WAIT and got["want_mb"] == 7000


def test_целиком_нет_по_частям_да():
    got = am.verdict(15000, {"mb": 9000, "label": "SAM 3"}, [card()])
    assert got["state"] == am.SEQUENTIAL and got["want_mb"] == 9000


def test_самый_тяжёлый_больше_карты_не_запустится():
    got = am.verdict(15000, {"mb": 14000, "label": "SAM 3 · вход 1008"}, [card()])
    assert got["state"] == am.NEVER
    assert "SAM 3 · вход 1008" in got["reason"]


def test_без_карт_не_запустится():
    assert am.verdict(100, {"mb": 100, "label": "x"}, [])["state"] == am.NEVER


# ---- делёж по картам (решения 10.10.2026) ------------------------------------
UNITS = [{"label": "SAM 3 · вход 1008", "mb": 8830}, {"label": "YOLOE-l", "mb": 4340},
         {"label": "Уточнение SAM", "mb": 640}]


def test_целиком_не_влезает_блоки_по_двум_картам():
    # 13,8 ГБ на картах по 11 ГБ: SAM 3 на одну, YOLOE и SAM2 на другую.
    got = am.verdict(13810, UNITS[0], [card("A", cap=11263), card("B", cap=11263)], UNITS)
    assert got["state"] == am.SPLIT and got["ready"] and got["cards"] == 2
    assert got["parts"] == [8830, 4340, 640]
    assert [u["label"] for u in got["placement"][0]["units"]] == ["SAM 3 · вход 1008"]


def test_карты_под_делёж_заняты_значит_ждать_их():
    # Решение владельца: ждать карты под делёж, а не уходить поочерёдно на одну.
    got = am.verdict(13810, UNITS[0], [card("A", cap=11263, free=3000), card("B", cap=11263, free=3000)], UNITS)
    assert got["state"] == am.SPLIT and not got["ready"]
    assert "ждёт 2 карты" in got["reason"]


def test_одна_карта_делёж_невозможен_поочерёдно():
    got = am.verdict(13810, UNITS[0], [card("A", cap=11263)], UNITS)
    assert got["state"] == am.SEQUENTIAL


def test_замер_растит_блоки_в_той_же_доле():
    # Прогон намерил 20 ГБ против прикидки 13,8 — каждый блок просится больше.
    got = am.verdict(20000, UNITS[0], [card("A", cap=15000), card("B", cap=15000)], UNITS)
    assert got["state"] == am.SPLIT
    assert sum(got["parts"]) >= 20000 and got["parts"][0] > 8830


def test_подпись_различает_порцию_и_режим():
    doc = {"nodes": [sam3("t", 8)]}
    assert am.signature(doc, {"t": 4}) != am.signature(doc, {"t": 1})
    assert am.signature(doc, {"t": 4}) != am.signature(doc, {"t": 4}, sequential=True)
    # Без тумблера сервера пик загрузки другой — замер с ним не годится.
    assert am.signature(doc, {"t": 4}) != am.signature(doc, {"t": 4}, sam3_cpu_half=False)


def test_подпись_различает_размер_yoloe_и_веса_сети_и_влезает_в_базу():
    def yoloe(model, **p):
        return {"id": "y", "type": "text", "params": {"model": model, "prompts": [{"on": True, "agent": "a", "prompt": "w"}], **p}}
    s = am.signature({"nodes": [yoloe("s")]}, {})
    assert s != am.signature({"nodes": [yoloe("x")]}, {})
    assert s != am.signature({"nodes": [yoloe("s", tiles=True)]}, {})
    assert s != am.signature({"nodes": [yoloe("s", half=True)]}, {})
    # Тумблер SAM 3 подпись YOLOE не трогает.
    assert s == am.signature({"nodes": [yoloe("s")]}, {}, sam3_cpu_half=False)
    assert am.signature({"nodes": [net("n", weights="a")]}, {}) != am.signature({"nodes": [net("n", weights="b")]}, {})
    assert s.startswith("agent2:") and len(s) <= 64


# ---- NMS между агентами ------------------------------------------------------
MAP = {"вагон": "c1", "болт": "c2"}


def det(cls, conf, box=(0, 0, 100, 100)):
    return {"cls": cls, "conf": conf, "box": box}


def test_уверенная_находка_вытесняет_чужую_рамку():
    kept, gone = agent_graph.settle_agents([det("вагон", 0.9)], [("r1", "c1", (0, 0, 100, 100), 0.6)], MAP)
    assert [d["conf"] for d in kept] == [0.9] and gone == ["r1"]


def test_чужая_уверенней_остаётся():
    kept, gone = agent_graph.settle_agents([det("вагон", 0.5)], [("r1", "c1", (0, 0, 100, 100), 0.6)], MAP)
    assert kept == [] and gone == []


def test_другой_класс_или_место_не_спорят():
    others = [("r1", "c1", (0, 0, 100, 100), 0.99), ("r2", "c2", (500, 500, 50, 50), 0.99)]
    kept, gone = agent_graph.settle_agents([det("болт", 0.1), det("вагон", 0.1, (300, 300, 50, 50))], others, MAP)
    assert len(kept) == 2 and gone == []


def test_одна_чужая_рамка_вытесняется_один_раз():
    kept, gone = agent_graph.settle_agents(
        [det("вагон", 0.9), det("вагон", 0.8, (5, 5, 100, 100))], [("r1", "c1", (0, 0, 100, 100), 0.6)], MAP)
    assert gone == ["r1"] and len(kept) == 2


def test_ничья_по_округлению_не_вытесняет():
    # В базе 0.876 (округлено при записи), новая находка того же качества — 0.8764.
    kept, gone = agent_graph.settle_agents([det("вагон", 0.8764)], [("r1", "c1", (0, 0, 100, 100), 0.876)], MAP)
    assert kept == [] and gone == []
