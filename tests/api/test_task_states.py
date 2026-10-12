"""Права в таске по состоянию (решение 12.10.2026) — сквозь настоящие ручки.

Таблица случаев самих правил — `tests/unit/test_task_rights.py`; здесь —
доходят ли они до каждой ручки и что видно в ответах и истории.
"""
import io

from PIL import Image as PilImage

from conftest import BASE_URL, tag
from test_project_admin import join, person


def me_id(s):
    body = s.get(f"{BASE_URL}/api/auth/me").json()
    return (body.get("user") or body)["id"]


def new_task(api, project, **body):
    res = api.post(f"{BASE_URL}/api/projects/{project['code']}/tasks", json={"name": tag(), **body})
    assert res.status_code == 201, res.text
    return res.json()


def upload(s, task_id):
    buf = io.BytesIO()
    PilImage.new("RGB", (64, 48), (40, 60, 90)).save(buf, "JPEG")
    buf.seek(0)
    return s.post(f"{BASE_URL}/api/tasks/{task_id}/images",
                  files={"files": ("f.jpg", buf, "image/jpeg")})


def first_image(s, task_id):
    return s.get(f"{BASE_URL}/api/tasks/{task_id}/images").json()["images"][0]


def move(s, task_id, status):
    return s.post(f"{BASE_URL}/api/tasks/{task_id}/status", json={"status": status})


def boxes(s, image_id, ci):
    return s.put(f"{BASE_URL}/api/images/{image_id}/annotations",
                 json={"boxes": [{"class_index": ci, "x": 5, "y": 5, "w": 20, "h": 20}]})


def editor_in(api, db, project):
    s = person(db)
    join(api, s, project["code"], "editor")
    return s


def test_на_очереди_наполняют_но_не_размечают(api, project, label_class):
    task = new_task(api, project)
    assert task["status"] == "queued"
    assert task["rights"]["fill"] and not task["rights"]["edit"]
    assert upload(api, task["id"]).status_code == 201
    res = boxes(api, first_image(api, task["id"])["id"], label_class["class_index"])
    assert res.status_code == 409 and res.json()["code"] == "task_queued", res.text


def test_ничью_берёт_любой_редактор_и_становится_исполнителем(api, db, project):
    task = new_task(api, project, assignees=[])
    editor = editor_in(api, db, project)
    res = move(editor, task["id"], "in_progress")
    assert res.status_code == 200, res.text
    assert [p["id"] for p in res.json()["assignees"]] == [me_id(editor)]


def test_назначенную_чужой_редактор_не_берёт(api, db, project):
    task = new_task(api, project)  # исполнитель — автор
    editor = editor_in(api, db, project)
    assert move(editor, task["id"], "in_progress").status_code == 403


def test_редактор_назначает_только_себя(api, db, project):
    editor = editor_in(api, db, project)
    res = editor.post(f"{BASE_URL}/api/projects/{project['code']}/tasks",
                      json={"name": tag(), "assignees": [me_id(api)]})
    assert res.status_code == 403, res.text


def test_в_работе_правят_исполнители_и_админ(api, db, project, label_class):
    editor, other = editor_in(api, db, project), editor_in(api, db, project)
    task = new_task(api, project, assignees=[me_id(editor)])
    # На очереди наполняют исполнитель и автор, но не посторонний
    assert upload(editor, task["id"]).status_code == 201
    assert upload(other, task["id"]).status_code == 403
    assert move(editor, task["id"], "in_progress").status_code == 200

    image, ci = first_image(api, task["id"]), label_class["class_index"]
    assert boxes(editor, image["id"], ci).status_code == 200
    res = boxes(other, image["id"], ci)
    assert res.status_code == 403 and res.json()["code"] == "not_yours", res.text
    assert boxes(api, image["id"], ci).status_code == 200  # админ без назначения

    assert move(editor, task["id"], "closed").status_code == 403  # закрывает только админ
    assert move(editor, task["id"], "queued").status_code == 200  # пауза: назначение остаётся
    detail = api.get(f"{BASE_URL}/api/tasks/{task['id']}").json()
    assert [p["id"] for p in detail["assignees"]] == [me_id(editor)]


def test_готово_замораживает_даже_админа_кроме_тагов(api, project, task, label_class):
    assert upload(api, task["id"]).status_code == 201
    image = first_image(api, task["id"])  # нетронутый — на «Готово» останется в таске
    assert move(api, task["id"], "done").status_code == 200
    res = boxes(api, image["id"], label_class["class_index"])
    assert res.status_code == 409 and res.json()["code"] == "task_done", res.text
    res = api.patch(f"{BASE_URL}/api/images/{image['id']}/task-status", json={"status": "skipped"})
    assert res.status_code == 409, res.text
    assert upload(api, task["id"]).status_code == 409
    res = api.put(f"{BASE_URL}/api/images/{image['id']}/tags", json={"tags": []})
    assert res.status_code == 200, res.text


def test_переназначение_видно_в_истории(api, db, project, task):
    editor = editor_in(api, db, project)
    res = api.patch(f"{BASE_URL}/api/tasks/{task['id']}", json={"assignees": [me_id(editor)]})
    assert res.status_code == 200, res.text
    assert res.json()["rights"]["moves"]  # админ по-прежнему ведёт таску
    events = api.get(f"{BASE_URL}/api/tasks/{task['id']}/events").json()["events"]
    last = next(e for e in events if e["kind"] == "assignees")
    assert last["payload"]["added"] == ["Тестовый участник"] and len(last["payload"]["removed"]) == 1
    # Редактор переназначать не может
    res = editor.patch(f"{BASE_URL}/api/tasks/{task['id']}", json={"assignees": []})
    assert res.status_code == 403, res.text


def test_готово_ждёт_агента(api, db, project, task):
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO agent_runs (id, project_id, task_id, params, status, processed,"
            " cancel_requested, created_at) SELECT gen_random_uuid(), project_id, id, '{}',"
            " 'running', 0, false, now() FROM tasks WHERE id = %s RETURNING id", (task["id"],))
        run_id = cur.fetchone()[0]
    try:
        for target in ("done", "queued"):
            res = move(api, task["id"], target)
            assert res.status_code == 409 and res.json()["code"] == "agent_running", res.text
    finally:
        with db.cursor() as cur:
            cur.execute("DELETE FROM agent_runs WHERE id = %s", (run_id,))
    assert move(api, task["id"], "done").status_code == 200


def test_кадр_ролика_не_пишется_поверх_чужой_правки(api, task, video, label_class):
    url = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frames/7/boxes"
    box = {"class_index": label_class["class_index"], "x": 5, "y": 5, "w": 20, "h": 20}
    first = api.put(url, json={"boxes": [box], "rev": None})
    assert first.status_code == 200, first.text
    seen = first.json()["rev"]
    assert api.put(url, json={"boxes": [box, box], "rev": seen}).status_code == 200
    stale = api.put(url, json={"boxes": [box], "rev": seen})
    assert stale.status_code == 409 and stale.json()["code"] == "stale", stale.text
    assert len(stale.json()["singles"]) == 2
    chunk = api.get(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/annotations/singles",
                    params={"from": 0, "to": 30}).json()
    assert chunk["revs"] == {"7": stale.json()["rev"]}
