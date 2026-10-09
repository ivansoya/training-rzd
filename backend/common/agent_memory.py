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
from common import agent_graph

# Прикидка на одну сеть, пока нет замера: средний yolo11 на входе 1280 с запасом.
NET_MB = 1500
# SAM2 small на кадре 1920×1400 — около гигабайта; large вдвое больше.
SAM_MB = 1500
# Поочерёдно кадры идут пачками: модель грузится раз на пачку, а не на кадр.
SEQ_BATCH = 16

FITS, WAIT, SEQUENTIAL, NEVER = "fits", "wait", "sequential", "never"


def _gb(mb) -> str:
    return f"{mb / 1024:.1f} ГБ".replace(".", ",")


def plan(doc, cap_mb=None, scout=False):
    """Блоки памяти агента. `cap_mb` — потолок самой большой карты: по нему
    «Авто» у SAM 3 выбирает порцию слов. `scout` — разведка, SAM2 не грузится.

    {units: [{key, kind, label, mb, nodes}], total_mb, heaviest: блок,
     nodes: {id узла: МБ}, words: {id узла SAM 3: слов за проход}}"""
    units, nodes, words = [], {}, {}
    sam3, sams = {}, {}
    for node in doc.get("nodes") or []:
        kind, params = node.get("type"), node.get("params") or {}
        if kind == "net":
            nodes[node["id"]] = NET_MB
            units.append({"key": f"net:{node['id']}", "kind": "net", "label": agent_graph.title(node),
                          "mb": NET_MB, "nodes": [node["id"]]})
        elif kind == "text" and agent_graph.text_model(params) == "sam3":
            total = len(agent_graph.text_prompts(node))
            words[node["id"]] = agent_graph.sam3_words_per_call(params, total, cap_mb)
            mb = agent_graph.text_vram_mb(node, cap_mb)
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
            nodes[node["id"]] = SAM_MB
    units += [sam3[side] for side in sorted(sam3)]
    if sams:
        units.append({"key": "sam", "kind": "sam", "label": "Уточнение SAM", "mb": SAM_MB * len(sams),
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


def signature(doc, words, sequential=False, scout=False) -> str:
    """Отпечаток расхода для замера диспетчера (`gpu_usage_hints`).

    Порция слов и режим — в подписи: замер SAM 3 по 4 слова не годится для
    порции 1, а поочерёдный пик — это один блок, а не сумма."""
    nodes = doc.get("nodes") or []
    nets = [n for n in nodes if n["type"] == "net"]
    texts = [n for n in nodes if n["type"] == "text"]
    sams = sorted({(n.get("params") or {}).get("model") or agent_graph.SAM_DEFAULTS["model"]
                   for n in nodes if n["type"] == "sam"}) if not scout else []
    families = sorted(
        f"sam3@{agent_graph.sam3_side(n.get('params'))}w{words.get(n['id'])}"
        if agent_graph.text_model(n.get("params")) == "sam3" else "yoloe" for n in texts)
    batch = max((agent_graph.TILE_BATCH if (n.get("params") or {}).get("tiles") else 1
                 for n in nets + texts), default=1)
    prompts = sorted(f"{len(agent_graph.text_prompts(n))}p{len(agent_graph.text_sets(n))}s" for n in texts)
    return (f"agent:{len(nets)}:b{batch}:{','.join(sams)}:{','.join(families)}:{','.join(prompts)}"
            f"{':seq' if sequential else ''}")


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
