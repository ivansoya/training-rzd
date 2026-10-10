"""Сколько памяти карты нужно агенту и влезет ли он — чистое, без базы и торча.

Агента собирает человек, и собрать можно то, что не поместится ни на одну
карту. Отвечать об этом обязаны одинаково редактор, окно запуска, страница
агентов проекта и сам прогон, поэтому счёт один — здесь.

Память считается блоками, которые прогон держит одновременно: каждая сеть,
каждая YOLOE, одна SAM 3 на каждый вход (узлы SAM 3 делят модель, у них разные
только промты) и все модели «Уточнения SAM» вместе — они нужны на одном шаге
графа. Целиком агент держит сумму блоков; поочерёдно — самый тяжёлый блок,
модели грузятся по одной на пачку кадров.
"""
import hashlib

from common import agent_graph

# Пики по сетке 10.10.2026 (tests/bench/agent_memory_grid.py), МБ.
# Сеть со своими весами — по весу файла: постоянное ≈ 15 + 1,8·файл, вид на 1280 —
# 80 + 5·файл у детекции и 110 + 8,2·файл у сегментации (yolo11n…yolo26m-seg).
NET_FIXED = (15, 1.8)
NET_VIEW = {"detect": (80, 5.0), "segment": (110, 8.2)}
# Строки полки нет (черновик без весов) — как за сегментацию на 50 МБ: с запасом.
NET_FILE_MB = 50
# SAM2 по рамке: от размера кадра пик не зависит — кадр сжимается до 1024.
SAM2_PEAK = {"sam2.1_hiera_tiny": 600, "sam2.1_hiera_small": 640,
             "sam2.1_hiera_base_plus": 820, "sam2.1_hiera_large": 1480}
SAM2_UNKNOWN = 1480
# Поочерёдно кадры идут пачками: модель грузится раз на пачку, а не на кадр.
SEQ_BATCH = 16

FITS, WAIT, SEQUENTIAL, NEVER = "fits", "wait", "sequential", "never"


def _gb(mb) -> str:
    return f"{mb / 1024:.1f} ГБ".replace(".", ",")


def net_info(weights):
    """{id узла: строка полки} → то, по чему считается память сети."""
    return {nid: {"file_mb": (row.size_bytes or 0) / (1 << 20), "task": row.task, "imgsz": row.imgsz}
            for nid, row in (weights or {}).items() if row is not None}


def net_mb(params, info=None) -> int:
    """Пик узла «Сеть»: по весу файла, задаче и входу; вход — из узла или из весов."""
    info = info or {}
    file_mb = float(info.get("file_mb") or NET_FILE_MB)
    base, slope = NET_VIEW["detect" if info.get("task") == "detect" else "segment"]
    side = int(agent_graph.num((params or {}).get("imgsz"), info.get("imgsz") or 640))
    return agent_graph.peak_mb(NET_FIXED[0] + NET_FIXED[1] * file_mb, base + slope * file_mb,
                               side, agent_graph.views_per_call(params))


def plan(doc, cap_mb=None, scout=False, nets=None, sam3_cpu_half=True):
    """Блоки памяти агента. `cap_mb` — потолок самой большой карты: по нему
    «Авто» у SAM 3 выбирает порцию слов. `scout` — разведка, SAM2 не грузится.
    `nets` — {id узла «Сеть»: вес файла, задача, вход} с полки (`net_info`).
    `sam3_cpu_half` — тумблер сервера: без него SAM 3 при загрузке везёт на карту fp32.

    {units: [{key, kind, label, mb, nodes}], total_mb, heaviest: блок,
     nodes: {id узла: МБ}, words: {id узла SAM 3: слов за проход}}"""
    units, nodes, words = [], {}, {}
    sam3, sams = {}, {}
    for node in doc.get("nodes") or []:
        kind, params = node.get("type"), node.get("params") or {}
        if kind == "net":
            mb = net_mb(params, (nets or {}).get(node["id"]))
            nodes[node["id"]] = mb
            units.append({"key": f"net:{node['id']}", "kind": "net", "label": agent_graph.title(node),
                          "mb": mb, "nodes": [node["id"]]})
        elif kind == "text" and agent_graph.text_model(params) == "sam3":
            total = len(agent_graph.text_prompts(node))
            words[node["id"]] = agent_graph.sam3_words_per_call(params, total, cap_mb, sam3_cpu_half)
            mb = agent_graph.text_vram_mb(node, cap_mb, sam3_cpu_half)
            nodes[node["id"]] = mb
            side = agent_graph.sam3_side(params)
            unit = sam3.setdefault(side, {"key": f"sam3@{side}", "kind": "sam3", "label": f"SAM 3 · вход {side}",
                                          "mb": 0, "nodes": []})
            unit["mb"] = max(unit["mb"], mb)
            unit["nodes"].append(node["id"])
        elif kind == "text":
            mb = agent_graph.text_vram_mb(node)
            nodes[node["id"]] = mb
            units.append({"key": f"text:{node['id']}", "kind": "yoloe", "label": agent_graph.title(node),
                          "mb": mb, "nodes": [node["id"]]})
        elif kind == "sam" and not scout:
            name = params.get("model") or agent_graph.SAM_DEFAULTS["model"]
            sams.setdefault(name, []).append(node["id"])
            nodes[node["id"]] = SAM2_PEAK.get(name, SAM2_UNKNOWN)
    units += [sam3[side] for side in sorted(sam3)]
    if sams:
        units.append({"key": "sam", "kind": "sam", "label": "Уточнение SAM",
                      "mb": sum(SAM2_PEAK.get(name, SAM2_UNKNOWN) for name in sams),
                      "nodes": [i for ids in sams.values() for i in ids]})
    heaviest = max(units, key=lambda u: u["mb"], default=None)
    return {"units": units, "total_mb": sum(u["mb"] for u in units), "heaviest": heaviest,
            "nodes": nodes, "words": words}


def fix_words(doc, words):
    """Вписать порции «Авто», выбранные `plan`, в копию документа прогона:
    вызовы SAM 3 обязаны идти той порцией, под которую просили память."""
    for node in doc.get("nodes") or []:
        if node.get("id") in words:
            node.setdefault("params", {})["words"] = words[node["id"]]
    return doc


def signature(doc, words, sequential=False, scout=False, sam3_cpu_half=True) -> str:
    """Отпечаток расхода для замера диспетчера (`gpu_usage_hints`).

    В подписи всё, от чего зависит пик: веса и вход сети, размер и вход YOLOE, тайлы,
    вход и порция слов SAM 3 с тумблером сервера, модели SAM2, режим. Хэшем — поле в базе 64 знака.
    Приставка `agent2` отрезала замеры до 10.10.2026: они не видели пика внутри кадра."""
    parts = []
    for n in sorted(doc.get("nodes") or [], key=lambda n: str(n.get("id"))):
        p = n.get("params") or {}
        tiles = "t" if p.get("tiles") else ""
        if n["type"] == "net":
            parts.append(f"net:{p.get('weights')}@{p.get('imgsz')}{tiles}")
        elif n["type"] == "text" and agent_graph.text_model(p) == "sam3":
            fp32 = "" if sam3_cpu_half else "f"
            parts.append(f"sam3{fp32}@{agent_graph.sam3_side(p)}w{words.get(n['id'])}:{len(agent_graph.text_sets(n))}s{tiles}")
        elif n["type"] == "text":
            parts.append(f"yoloe-{agent_graph.text_model(p)}@{agent_graph.num(p.get('imgsz'), agent_graph.TEXT_IMGSZ)}"
                         f":{len(agent_graph.text_rows(n))}c{tiles}")
        elif n["type"] == "sam" and not scout:
            parts.append(f"sam2:{p.get('model') or agent_graph.SAM_DEFAULTS['model']}")
    full = ",".join(sorted(parts)) + (":seq" if sequential else "")
    return "agent2:" + hashlib.sha1(full.encode("utf-8")).hexdigest()[:32]


def verdict(total_mb, heaviest, cards):
    """Влезет ли агент. `cards` — живые карты [{name, cap_mb, free_mb}]
    (`gpu.cards`), `heaviest` — блок из `plan`.

    {state, want_mb, card, reason}: `want_mb` — сколько просить у диспетчера
    (поочерёдно — самый тяжёлый блок), `card` — где влезает сейчас."""
    top = heaviest["mb"] if heaviest else 0
    if not cards:
        return {"state": NEVER, "want_mb": total_mb, "card": None,
                "reason": "На сервере нет видеокарт, а на процессоре агенты не считают."}
    cap = max(c["cap_mb"] for c in cards)
    if total_mb <= cap:
        now = [c for c in cards if total_mb <= c["free_mb"]]
        if now:
            card = max(now, key=lambda c: c["free_mb"])
            return {"state": FITS, "want_mb": total_mb, "card": card["name"],
                    "reason": f"Влезает: {card['name']}, свободно {_gb(card['free_mb'])} из {_gb(card['cap_mb'])}."}
        free = max(c["free_mb"] for c in cards)
        return {"state": WAIT, "want_mb": total_mb, "card": None,
                "reason": f"Придётся ждать: свободно {_gb(free)} из нужных {_gb(total_mb)}."}
    if top <= cap:
        return {"state": SEQUENTIAL, "want_mb": top, "card": None,
                "reason": f"Целиком нужно {_gb(total_mb)}, а карта отдаёт не больше {_gb(cap)}: "
                          f"модели пойдут по очереди, медленнее."}
    return {"state": NEVER, "want_mb": total_mb, "card": None,
            "reason": f"Не запустится: «{heaviest['label']}» один требует {_gb(top)}, "
                      f"а карта отдаёт не больше {_gb(cap)}."}
