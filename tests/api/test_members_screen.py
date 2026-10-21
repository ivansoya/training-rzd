"""Экран «Участники»: вклад каждого — боксы во всех кадрах проекта, дата вступления.

Боксы считаются и в черновиках тасок: разметка в таске — тоже работа человека.
"""
from conftest import BASE_URL
from test_agent_review import agent_box, frame, image, save, wire  # noqa: F401 — фикстура image
from test_project_admin import join, person
from test_project_data import draft, imported, url  # noqa: F401 — фикстуры


def detail(session, project):
    res = session.get(url(project))
    assert res.status_code == 200, res.text
    return res.json()


def test_вклад_и_дата_вступления(api, db, project, imported, draft):
    other = person(db)
    join(api, other, project["code"], "editor")
    body = detail(api, project)
    by_login = {m["login"]: m for m in body["members"]}
    total = sum(c["annotations"] for c in api.get(url(project, "/classes")).json()["classes"])

    owner = by_login[api.login_name]
    assert owner["boxes"] == total and total > 0
    assert owner["last_box_at"] and owner["joined_at"]

    fresh = by_login[other.login_name]
    assert fresh["boxes"] == 0 and fresh["last_box_at"] is None
    assert fresh["joined_at"] >= owner["joined_at"]


def test_приглашение_несёт_роль_и_время(api, db, project):
    other = person(db)
    res = api.post(f"{BASE_URL}/api/projects/{project['code']}/invite",
                   json={"identity": other.login_name, "role": "viewer"})
    assert res.status_code in (200, 201), res.text
    inv = detail(api, project)["pending_invitations"][0]
    assert inv["role"] == "viewer" and inv["role_label"] and inv["sent_at"]


def test_рамка_агента_засчитывается_проверившему(api, db, project, task, image, label_class):
    """Решение 21.10.2026: непроверенное — ничьё, принятое — того, кто принял, а не того, чей агент."""
    owner = person(db)
    join(api, owner, project["code"], "editor")
    agent_box(db, image["id"], label_class, x=10.0)
    agent_box(db, image["id"], label_class, x=200.0)
    with db.cursor() as cur:
        cur.execute("UPDATE annotations SET created_by = (SELECT id FROM users WHERE login = %s) WHERE image_id = %s",
                    (owner.login_name, image["id"]))

    def boxes():
        return {m["login"]: m["boxes"] for m in detail(api, project)["members"]}

    assert boxes() == {api.login_name: 0, owner.login_name: 0}
    a, b = sorted(frame(api, task, image["id"])["boxes"], key=lambda r: r["x"])
    save(api, image["id"], [wire(a, pending=False), wire(b)])  # приняли одну
    assert boxes() == {api.login_name: 1, owner.login_name: 0}
    assert next(m for m in detail(api, project)["members"] if m["login"] == api.login_name)["last_box_at"]
