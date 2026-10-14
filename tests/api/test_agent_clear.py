"""«Очистить непроверенное агентов» и устаревший редактор (11.10.2026).

Очистка стирает только рамки на проверке: своё и принятое человеком остаётся, а
число в окне считается тем же отбором, что удаляет. Редактор, открытый до
очистки, стёртое не возвращает: кадр изображения отвечает «stale», кадр ролика
не пишет непроверенную рамку, которой в базе уже нет.
"""
from conftest import BASE_URL, hand_over
from test_agent_review import agent_box, frame, image, save, singles, video_agent_box, wire  # noqa: F401


def clear(api, task, dry=False, **scope):
    return api.post(f"{BASE_URL}/api/tasks/{task['id']}/agent-clear", json={**scope, "dry": dry})


def test_очистка_снимает_только_непроверенное(api, db, task, image, video, label_class):
    agent_box(db, image["id"], label_class, x=10.0)
    agent_box(db, image["id"], label_class, x=200.0)
    a, b = sorted(frame(api, task, image["id"])["boxes"], key=lambda r: r["x"])
    mine = {"class_index": label_class["class_index"], "x": 300, "y": 20, "w": 50, "h": 50}
    save(api, image["id"], [wire(a, pending=False), wire(b), mine])  # первую принял человек
    video_agent_box(db, video, label_class, 5)
    video_agent_box(db, video, label_class, 10)
    video_agent_box(db, video, label_class, 10, x=200.0)
    scope = {"sources": ["files"], "videos": [video["id"]]}

    plan = clear(api, task, dry=True, **scope)
    assert plan.status_code == 200, plan.text
    assert plan.json() == {"boxes": 4, "frames": 3}
    assert len(singles(api, task, video)) == 3  # счёт ничего не стёр

    assert clear(api, task, **scope).json() == {"boxes": 4, "frames": 3}
    left = frame(api, task, image["id"])
    assert sorted((r["x"], r["pending"]) for r in left["boxes"]) == [(10.0, False), (300.0, False)]
    assert left["task_status"] == "annotated"
    assert singles(api, task, video) == []
    events = api.get(f"{BASE_URL}/api/tasks/{task['id']}/events").json()["events"]
    cleared = next(e for e in events if e["kind"] == "agent_cleared")
    assert cleared["payload"]["boxes"] == 4 and "изображения" in cleared["payload"]["place"]
    assert clear(api, task, dry=True, **scope).json() == {"boxes": 0, "frames": 0}


def test_устаревший_редактор_не_возвращает_стёртое(api, db, task, image, video, label_class):
    agent_box(db, image["id"], label_class)
    seen = frame(api, task, image["id"])  # кадр открыт в редакторе
    video_agent_box(db, video, label_class, 5)
    stale = singles(api, task, video)[0]
    assert clear(api, task, sources=["files"], videos=[video["id"]]).json()["boxes"] == 2

    mine = {"class_index": label_class["class_index"], "x": 100, "y": 20, "w": 50, "h": 50}
    res = api.put(f"{BASE_URL}/api/images/{image['id']}/annotations",
                  json={"boxes": [wire(seen["boxes"][0]), mine], "rev": seen["rev"]})
    assert res.status_code == 409 and res.json()["code"] == "stale"

    res = api.put(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frames/5/boxes",
                  json={"boxes": [{"id": stale["id"], **stale["shape"], "class_index": stale["class_index"],
                                   "pending": True}, mine]})
    assert res.status_code == 200, res.text
    [got] = singles(api, task, video)
    assert got["shape"]["x"] == 100 and got["pending"] is False


def test_очистка_не_идёт_поверх_агента_и_сданной_таски(api, db, task, video, label_class):
    with db.cursor() as cur:
        cur.execute("""INSERT INTO agent_runs (id, project_id, task_id, params, status, created_at)
                       SELECT gen_random_uuid(), project_id, id, '{}', 'running', now() FROM tasks WHERE id = %s
                       RETURNING id""", (task["id"],))
        run_id = cur.fetchone()[0]
        try:
            res = clear(api, task, sources=["files"])
            assert res.status_code == 409 and res.json()["code"] == "agent_running"
        finally:
            cur.execute("DELETE FROM agent_runs WHERE id = %s", (run_id,))

    # Сданная таска правке не подлежит — ни ролик, ни его кадры
    video_agent_box(db, video, label_class, 5)
    hand_over(api, task["id"])
    assert clear(api, task, videos=[video["id"]]).status_code == 409
    assert clear(api, task, sources=["files"]).status_code == 409
