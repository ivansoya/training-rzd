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


def test_accept_invitation_twice(api, db, project):
    """Двойной щелчок «Принять»: два запроса параллельно — оба без 500."""
    from concurrent.futures import ThreadPoolExecutor
    code = project["code"]
    other = person(db)
    api.post(f"{BASE_URL}/api/projects/{code}/invite",
             json={"identity": other.login_name, "role": "viewer"})
    iid = other.get(f"{BASE_URL}/api/invitations").json()["invitations"][0]["id"]
    with ThreadPoolExecutor(2) as pool:
        codes = list(pool.map(
            lambda _: other.post(f"{BASE_URL}/api/invitations/{iid}/accept").status_code,
            range(2)))
    assert codes == [200, 200], codes
    members = api.get(f"{BASE_URL}/api/projects/{code}").json()["members"]
    assert len(members) == 2


# ------------------------------------------------------ длины и пароль --- #

def test_long_fields_are_400_not_500(api):
    res = api.post(f"{BASE_URL}/api/projects", json={"name": tag() + "я" * 250})
    assert res.status_code == 400, res.text
    assert "длиннее 255" in res.json()["errors"]["name"]

    login = tag()
    res = requests.post(f"{BASE_URL}/api/auth/register", json={
        "email": "a" * 250 + "@example.test", "login": login,
        "display_name": "Я" * 129, "password": "Test-Passw0rd",
    })
    assert res.status_code == 400, res.text
    errors = res.json()["errors"]
    assert "длиннее 128" in errors["display_name"] and "длиннее 255" in errors["email"]


def test_new_password_must_differ(api):
    res = api.post(f"{BASE_URL}/api/auth/password",
                   json={"current": "Test-Passw0rd", "new": "Test-Passw0rd"})
    assert res.status_code == 400, res.text
    assert "совпадает" in res.json()["error"]


def test_зритель_не_становится_исполнителем(api, db, project, task):
    viewer = person(db)
    join(api, viewer, project["code"], "viewer")
    me = viewer.get(f"{BASE_URL}/api/auth/me").json()
    vid = (me.get("user") or me)["id"]
    res = api.patch(f"{BASE_URL}/api/tasks/{task['id']}", json={"assignee_id": vid})
    assert res.status_code == 400, res.text
    res = api.post(f"{BASE_URL}/api/projects/{project['code']}/tasks",
                   json={"name": tag(), "assignee_id": vid})
    assert res.status_code == 400, res.text


def test_редактор_не_удаляет_чужое_обучение(api, db, project):
    editor = person(db)
    join(api, editor, project["code"], "editor")
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO train_runs (id, project_id, name, base_model, task, params, device,"
            " status, epochs, created_at, queued_at, number, created_by)"
            " SELECT gen_random_uuid(), p.id, 'чужое', 'yolo11n.pt', 'detect', '{}', 'cuda:0',"
            " 'done', 1, now(), now(), 1, m.user_id FROM projects p JOIN project_members m"
            " ON m.project_id = p.id AND m.role = 'admin' WHERE p.code = %s RETURNING id",
            (project["code"],),
        )
        run_id = cur.fetchone()[0]
    url = f"{BASE_URL}/api/projects/{project['code']}/runs/{run_id}"
    assert editor.delete(url).status_code == 403
    assert editor.post(f"{url}/stop").status_code == 403
    assert api.delete(url).status_code == 200


def test_таги_кадра_правит_исполнитель_а_не_любой_редактор(api, db, project, task):
    buf = io.BytesIO()
    PilImage.new("RGB", (64, 64)).save(buf, "JPEG")
    buf.seek(0)
    api.post(f"{BASE_URL}/api/tasks/{task['id']}/images",
             files={"files": ("t.jpg", buf, "image/jpeg")})
    image_id = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"][0]["id"]
    editor = person(db)
    join(api, editor, project["code"], "editor")
    url = f"{BASE_URL}/api/images/{image_id}/tags"
    assert editor.put(url, json={"tags": []}).status_code == 403
    assert api.put(url, json={"tags": []}).status_code == 200


def test_заявка_по_почте_не_раскрывает_логин_и_присутствие(api, db):
    other = person(db)
    res = api.post(f"{BASE_URL}/api/friends",
                   json={"identity": f"{other.login_name}@example.test"})
    assert res.status_code == 201, res.text
    assert res.json()["user"]["login"] == ""
    [sent] = api.get(f"{BASE_URL}/api/friends").json()["outgoing"]
    assert sent["user"]["login"] == "" and "online" not in sent["user"]


def test_название_проекта_меняет_только_админ(api, db, project):
    url = f"{BASE_URL}/api/projects/{project['code']}"
    editor = person(db)
    join(api, editor, project["code"], "editor")
    assert editor.patch(url, json={"name": "чужое"}).status_code == 403
    assert api.patch(url, json={"name": "строка\nвторая"}).status_code == 400
    res = api.patch(url, json={"name": project["code"] + " новое", "description": "о проекте"})
    assert res.status_code == 200, res.text
    got = api.get(url).json()["project"]
    assert got["description"] == "о проекте"
