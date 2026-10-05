"""Доска тасок и паспорт таски: откуда кадры, когда трогали, с какого момента в состоянии."""
from conftest import BASE_URL
from test_project_data import draft, imported  # noqa: F401 — фикстуры


def board(api, project):
    res = api.get(f"{BASE_URL}/api/projects/{project['code']}/tasks")
    assert res.status_code == 200, res.text
    return {t["id"]: t for t in res.json()["tasks"]}


def test_карточка_доски_знает_источники_и_активность(api, project, imported, draft, task):
    card = board(api, project)[task["id"]]
    assert card["sources"] == {"files": 1, "cut": 0, "uncut": 0, "annotate": 0}
    assert card["pending_frames"] == 0
    assert card["last_box_at"] and card["last_at"] >= card["last_box_at"]
    assert card["created_by"] and card["can_work"] is True


def test_состояние_с_момента_перехода(api, project, task):
    detail = api.get(f"{BASE_URL}/api/tasks/{task['id']}").json()
    # Фикстура взяла таску в работу — момент перехода позже создания
    assert detail["status"] == "in_progress"
    assert detail["status_at"] >= detail["created_at"]
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})
    assert res.status_code == 200, res.text
    assert res.json()["status_at"] >= detail["status_at"]


def test_пустая_таска_на_очереди_с_даты_создания(api, project):
    res = api.post(f"{BASE_URL}/api/projects/{project['code']}/tasks", json={"name": "пустая"})
    assert res.status_code in (200, 201), res.text
    card = board(api, project)[res.json()["id"]]
    assert card["status"] == "queued" and card["status_at"] == card["created_at"]
    assert card["sources"]["files"] == 0 and card["last_box_at"] is None
