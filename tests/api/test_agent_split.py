"""Агент, который целиком на одну карту не влезает, расходится блоками по картам.

Решения владельца (10.10.2026): смысл не в скорости, а чтобы большой агент
запустился вообще; человек ничего не выбирает. Двух карт на стенде нет — вторая
заводится записью, указывающей на ту же карту (номер 0 на чужом «хосте»):
диспетчер видит две карты, а считает одна. Потолки обеих снижаются так, чтобы
агент из двух YOLOE с тайлами целиком не влез ни на одну, а по блоку — на каждую.
"""
import time
import uuid

import pytest

from common import agent_graph, agent_memory
from conftest import BASE_URL, tag
from test_agent_text import PROMPTS, _run, setup  # noqa: F401 — фикстура
from test_agent_video import PERSON, _person_blocks, clip, owner  # noqa: F401 — фикстуры

CAP = 5000  # МБ под задачи на каждой «карте»: YOLOE-l и -m с тайлами по ≈ 4,3 ГБ


def _doc():
    text = lambda model: {"model": model, "prompts": PROMPTS, "tiles": True}  # noqa: E731
    return {"v": 1, "nodes": [
        {"id": "frame", "type": "frame", "params": {}},
        {"id": "big", "type": "text", "params": text("l")},
        {"id": "mid", "type": "text", "params": text("m")},
        {"id": "merge", "type": "merge", "params": {"inputs": 2}},
        {"id": "nms", "type": "nms", "params": {"iou": 0.6}},
        {"id": "out", "type": "output", "params": {}}],
        "edges": [{"from": "frame", "out": "out", "to": "big", "in": "in"},
                  {"from": "frame", "out": "out", "to": "mid", "in": "in"},
                  {"from": "big", "out": "out", "to": "merge", "in": "i0"},
                  {"from": "mid", "out": "out", "to": "merge", "in": "i1"},
                  {"from": "merge", "out": "out", "to": "nms", "in": "in"},
                  {"from": "nms", "out": "out", "to": "out", "in": "in"}]}


def _forget(cur):
    """Стереть замер этого агента: разведка на маленьком ролике меряет ≈ 0,9 ГБ (тайлов меньше
    восьми), и со второго прогона вердикт по замеру — «влезает». Подпись у разведки и прикидки
    одна: у агента без SAM2 они не различаются."""
    cur.execute("delete from gpu_usage_hints where kind = 'agent' and signature = %s",
                (agent_memory.signature(agent_graph.prepare(_doc()), {}),))


@pytest.fixture(scope="module")
def two_cards(db):
    """Вторая «карта» — та же физическая; потолки обеих — по CAP."""
    with db.cursor() as cur:
        _forget(cur)
        cur.execute("""select id, total_mb, reserved_mb, sam2_reserve_mb from gpu_devices
                       where enabled and seen_at > now() - interval '5 min' order by device_index limit 1""")
        row = cur.fetchone()
        if row is None:
            pytest.skip("На стенде нет живой карты")
        real, total, reserved, sam2 = row
        fake = str(uuid.uuid4())
        cur.execute("update gpu_devices set reserved_mb = %s where id = %s", (total - sam2 - CAP, real))
        cur.execute("""insert into gpu_devices (id, host, device_index, uuid_str, name, total_mb, reserved_mb,
                       sam2_reserve_mb, max_heavy, enabled, seen_at, created_at)
                       values (%s, 'probe-split', 0, %s, 'RTX проба', %s, %s, 0, 1, true,
                               now() + interval '1 day', now())""",
                    (fake, f"probe-{fake}", total, total - CAP))
    db.commit()
    try:
        yield {"real": str(real), "fake": fake}
    finally:
        with db.cursor() as cur:
            # Брони, задевшие пробную карту, — целиком: каскад стёр бы одну часть группы,
            # а вторая (тёплое превью) висела бы на настоящей карте держателем-сиротой.
            cur.execute("""update gpu_leases set status = 'released', released_at = now(), lease_until = null
                           where status in ('queued', 'held') and (device_id = %s or group_id in
                           (select group_id from gpu_leases where device_id = %s))""", (fake, fake))
            cur.execute("update gpu_devices set reserved_mb = %s where id = %s", (reserved, real))
            cur.execute("delete from gpu_devices where id = %s", (fake,))
            _forget(cur)
        db.commit()


def _held(db, kind=None):
    """Кто держит карты — чтобы 503 превью объяснял себя сам."""
    with db.cursor() as cur:
        cur.execute("""select kind, title, label, granted_mb, device_id, created_at from gpu_leases
                       where status = 'held' and (%s::text is null or kind = %s)""", (kind, kind))
        return cur.fetchall()


def _agent(owner, setup):
    graph = owner.post(f"{BASE_URL}/api/aug/graphs", json={"name": tag(), "kind": "agent"}).json()
    setup["graphs"]["split"] = graph
    res = owner.post(f"{BASE_URL}/api/aug/graphs/{graph['id']}/versions", json={"doc": _doc()})
    assert res.status_code in (200, 201), res.text
    return graph


def test_вердикт_на_двух_картах(owner, setup, two_cards):
    graph = setup["graphs"].get("split") or _agent(owner, setup)
    got = owner.post(f"{BASE_URL}/api/agents/estimate", json={"graph_id": graph["id"], "doc": _doc()}).json()
    verdict = got["verdict"]
    assert got["measured"] == 0, "замер подписи не стёрт — вердикт считан по нему"
    assert verdict["state"] == "split", verdict
    # `ready` не проверяем: тёплое превью предыдущего модуля держит карту до 3 мин (замер 11.10).
    assert verdict["cards"] == 2 and len(verdict["placement"]) == 2, verdict
    assert got["total_mb"] > CAP


def test_прогон_расходится_по_картам_и_находит_человека(owner, setup, db, two_cards):
    graph = setup["graphs"].get("split") or _agent(owner, setup)
    run = _run(owner, setup, graph, mode="scout", gap=0.5)
    with db.cursor() as cur:
        cur.execute("""select group_id, device_id, label, want_mb from gpu_leases
                       where ref_id = %s and status = 'released' order by part""", (run["id"],))
        leases = cur.fetchall()
    # Одна группа, две части, две разные карты — каждая со своим блоком.
    assert len(leases) == 2, leases
    assert leases[0][0] is not None and leases[0][0] == leases[1][0], leases
    assert {str(r[1]) for r in leases} == {two_cards["real"], two_cards["fake"]}, leases
    assert all(r[3] <= CAP for r in leases), leases
    scouts = owner.get(f"{BASE_URL}/api/agents/tasks/{setup['task']['id']}/scouts").json()["scouts"]
    people = scouts[setup["video"]["id"]]["segments"].get(PERSON, [])
    for block in _person_blocks():
        assert any(a <= block[-1] and b >= block[0] for a, b, _ in people), (block, people)


def test_превью_поделённого_агента(owner, setup, db, two_cards):
    graph = setup["graphs"].get("split") or _agent(owner, setup)
    import agent_data

    code = agent_data.source_project(owner, db, frames=2)
    with db.cursor() as cur:
        cur.execute("""select i.id from images i join projects p on p.id = i.project_id
                       where p.code = %s and i.dataset_id is not null order by i.file_name limit 1""", (code,))
        image_id = cur.fetchone()[0]
    # Прогон из соседнего теста отпускает карты чуть позже, чем становится «готов».
    held = _held(db, "agent")
    for _ in range(50):
        if not held:
            break
        time.sleep(0.2)
        held = _held(db, "agent")
    res = owner.post(f"{BASE_URL}/api/agents/preview", json={
        "graph_id": graph["id"], "doc": _doc(), "project": code, "image_id": str(image_id), "step": "same"})
    assert res.status_code == 200, (res.text, _held(db))
    body = res.json()
    assert body["verdict"]["state"] == "split", body["verdict"]
    assert any(d["cls"] == PERSON for d in body["nodes"]["big"]["out"]), body["nodes"]["big"]
