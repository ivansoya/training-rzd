"""Экран «Участники»: вклад каждого — боксы во всех кадрах проекта, дата вступления.

Боксы считаются и в черновиках тасок: разметка в таске — тоже работа человека.
"""
from conftest import BASE_URL
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
