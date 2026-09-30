"""Удаление проекта и управление его участниками.

Проверяются права (чужому — «не найден», не-админу — «запрещено»), отказ
при идущей работе и то, что после удаления проекта нет ни строк, ни папки.
"""
import io

import requests
from PIL import Image as PilImage

from conftest import BASE_URL, tag


def person(db):
    """Второй, третий человек в тесте: фикстура `api` даёт только одного."""
    login = tag()
    s = requests.Session()
    res = s.post(f"{BASE_URL}/api/auth/register", json={
        "email": f"{login}@example.test", "login": login,
        "display_name": "Тестовый участник", "password": "Test-Passw0rd",
    })
    assert res.status_code in (200, 201), res.text
    with db.cursor() as cur:
        cur.execute("UPDATE users SET email_confirmed_at = now() WHERE login = %s", (login,))
    res = s.post(f"{BASE_URL}/api/auth/login",
                 json={"identity": login, "password": "Test-Passw0rd"})
    assert res.status_code == 200, res.text
    s.login_name = login
    return s


def join(owner, other, code, role):
    """Позвать и принять: участником становятся только так."""
    res = owner.post(f"{BASE_URL}/api/projects/{code}/invite",
                     json={"identity": other.login_name, "role": role})
    assert res.status_code in (200, 201), res.text
    inv = other.get(f"{BASE_URL}/api/invitations").json()["invitations"]
    iid = next(i["id"] for i in inv if i["project"]["code"] == code)
    res = other.post(f"{BASE_URL}/api/invitations/{iid}/accept")
    assert res.status_code == 200, res.text
    return iid


# ------------------------------------------------------------ удаление --- #

def test_delete_rights(api, db, project):
    code = project["code"]
    stranger = person(db)
    assert stranger.delete(f"{BASE_URL}/api/projects/{code}").status_code == 404
    assert stranger.get(f"{BASE_URL}/api/projects/{code}/cost").status_code == 404

    editor = person(db)
    join(api, editor, code, "editor")
    res = editor.delete(f"{BASE_URL}/api/projects/{code}")
    assert res.status_code == 403, res.text

    res = api.delete(f"{BASE_URL}/api/projects/{code}")
    assert res.status_code == 200, res.text
    assert api.get(f"{BASE_URL}/api/projects/{code}").status_code == 404
    # Участник тоже потерял проект — и в списке, и в /me.
    me = editor.get(f"{BASE_URL}/api/auth/me").json()
    assert code not in [p["code"] for p in me["projects"]]


def test_delete_counts_and_files(api, db, project, task):
    code = project["code"]
    buf = io.BytesIO()
    PilImage.new("RGB", (64, 48), (40, 60, 90)).save(buf, "JPEG")
    buf.seek(0)
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/images",
                   files={"files": ("test-frame.jpg", buf, "image/jpeg")})
    assert res.status_code in (200, 201), res.text

    cost = api.get(f"{BASE_URL}/api/projects/{code}/cost").json()
    assert cost["images"] == 1 and cost["tasks"] == 1 and cost["busy"] is None

    res = api.delete(f"{BASE_URL}/api/projects/{code}")
    assert res.status_code == 200, res.text
    # Кадр лёг файлом в папку проекта — значит, папка была и уехала.
    assert res.json()["files_removed"] is True
    with db.cursor() as cur:
        cur.execute("SELECT count(*) FROM images i JOIN tasks t ON t.id = i.task_id "
                    "WHERE t.id = %s", (task["id"],))
        assert cur.fetchone()[0] == 0


def test_delete_refused_while_busy(api, db, project):
    code = project["code"]
    # Импорт — самая безобидная «работа» для теста: воркеры его не подхватят.
    with db.cursor() as cur:
        cur.execute("UPDATE projects SET status = 'importing' WHERE code = %s", (code,))
    assert api.get(f"{BASE_URL}/api/projects/{code}/cost").json()["busy"]
    res = api.delete(f"{BASE_URL}/api/projects/{code}")
    assert res.status_code == 409, res.text
    assert "импорт" in res.json()["error"]
    with db.cursor() as cur:
        cur.execute("UPDATE projects SET status = 'ready' WHERE code = %s", (code,))
    assert api.delete(f"{BASE_URL}/api/projects/{code}").status_code == 200


# ----------------------------------------------------------- участники --- #

def test_member_roles_and_last_admin(api, db, project):
    code = project["code"]
    me_id = api.get(f"{BASE_URL}/api/auth/me").json()["user"]["id"]
    other = person(db)
    join(api, other, code, "viewer")
    other_id = other.get(f"{BASE_URL}/api/auth/me").json()["user"]["id"]
    url = f"{BASE_URL}/api/projects/{code}/members"

    # Не-админ роли не меняет и чужих не исключает.
    assert other.patch(f"{url}/{me_id}", json={"role": "viewer"}).status_code == 403
    assert other.delete(f"{url}/{me_id}").status_code == 403
    # Единственный админ не может ни понизить себя, ни выйти.
    assert api.patch(f"{url}/{me_id}", json={"role": "editor"}).status_code == 409
    assert api.delete(f"{url}/{me_id}").status_code == 409
    assert api.patch(f"{url}/{other_id}", json={"role": "boss"}).status_code == 400

    res = api.patch(f"{url}/{other_id}", json={"role": "admin"})
    assert res.status_code == 200, res.text
    # Админов двое — теперь первый может уйти, а второй остаётся последним.
    assert api.delete(f"{url}/{me_id}").status_code == 200
    assert code not in [p["code"] for p in api.get(f"{BASE_URL}/api/auth/me").json()["projects"]]
    assert other.delete(f"{url}/{other_id}").status_code == 409


def test_remove_member_and_revoke_invitation(api, db, project):
    code = project["code"]
    other = person(db)
    join(api, other, code, "editor")
    other_id = other.get(f"{BASE_URL}/api/auth/me").json()["user"]["id"]
    res = api.delete(f"{BASE_URL}/api/projects/{code}/members/{other_id}")
    assert res.status_code == 200, res.text
    assert other.get(f"{BASE_URL}/api/projects/{code}").status_code == 403

    third = person(db)
    api.post(f"{BASE_URL}/api/projects/{code}/invite",
             json={"identity": third.login_name, "role": "viewer"})
    pending = api.get(f"{BASE_URL}/api/projects/{code}").json()["pending_invitations"]
    iid = pending[0]["id"]
    assert third.delete(f"{BASE_URL}/api/projects/{code}/invitations/{iid}").status_code == 404
    res = api.delete(f"{BASE_URL}/api/projects/{code}/invitations/{iid}")
    assert res.status_code == 200, res.text
    assert third.get(f"{BASE_URL}/api/invitations").json()["invitations"] == []
    assert third.post(f"{BASE_URL}/api/invitations/{iid}/accept").status_code == 404
