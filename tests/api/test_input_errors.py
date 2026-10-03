"""Негодный ввод: 400 со словами по-русски, а не HTML 500 и не тихая подмена."""
import requests

from conftest import BASE_URL, tag


def test_нестроковые_поля_регистрации_дают_400():
    res = requests.post(f"{BASE_URL}/api/auth/register", json={
        "email": 42, "login": ["x"], "display_name": "Имя", "password": "Test-Passw0rd",
    })
    assert res.status_code == 400, res.text
    assert res.json().get("errors") or res.json().get("error")


def test_тело_списком_даёт_400_json(api, project):
    res = api.post(f"{BASE_URL}/api/projects/{project['code']}/classes", json=[1, 2])
    assert res.status_code == 400 and res.json()["error"]


def test_цвет_класса_только_hex(api, project):
    res = api.post(f"{BASE_URL}/api/projects/{project['code']}/classes",
                   json={"name": "вагон", "color": "red"})
    assert res.status_code == 400, res.text
    assert "color" in res.json()["errors"]


def test_галерея_отвергает_чужой_сплит_и_неизвестный_класс(api, project):
    url = f"{BASE_URL}/api/projects/{project['code']}/images"
    assert api.get(url, params={"split": "foo"}).status_code == 400
    assert api.get(url, params={"classes": "999"}).status_code == 400


def test_неизвестный_адрес_отвечает_json(api):
    res = api.get(f"{BASE_URL}/api/projects/НЕТ/images")
    assert res.status_code in (403, 404)
    assert res.headers["Content-Type"].startswith("application/json")


def test_граф_нельзя_переименовать_в_занятое_имя(api):
    names = [tag(), tag()]
    ids = []
    for name in names:
        res = api.post(f"{BASE_URL}/api/aug/graphs", json={"name": name})
        assert res.status_code == 201, res.text
        ids.append(res.json()["id"])
    res = api.patch(f"{BASE_URL}/api/aug/graphs/{ids[1]}", json={"name": names[0]})
    assert res.status_code == 409, res.text


def test_граф_с_негодной_версией_не_остаётся_сиротой(api):
    name = tag()
    res = api.post(f"{BASE_URL}/api/aug/graphs", json={"name": name, "doc": {"nodes": [], "edges": []}})
    assert res.status_code == 400, res.text
    listing = api.get(f"{BASE_URL}/api/aug/graphs").json()
    rows = listing.get("graphs", listing) if isinstance(listing, dict) else listing
    assert all(g["name"] != name for g in rows)


def test_имена_уникальны_без_учёта_регистра(api, project):
    base = f"{BASE_URL}/api/projects/{project['code']}"
    first = api.post(f"{base}/classes", json={"name": "Горыныч"}).json()
    res = api.post(f"{base}/classes", json={"name": "горыныч"})
    assert res.status_code == 409 and res.json()["class"]["id"] == first["id"]
    night = api.post(f"{base}/tags", json={"name": "Night"}).json()
    assert api.post(f"{base}/tags", json={"name": "night"}).json()["id"] == night["id"]
    a = api.post(f"{base}/superclasses", json={"name": "Опасность"}).json()
    b = api.post(f"{base}/superclasses", json={"name": "Прочее"}).json()
    assert api.patch(f"{base}/superclasses/{b['id']}", json={"name": "опасность"}).status_code == 409
    assert a["id"] != b["id"]


def test_неизвестный_api_это_404_json_и_видно_кто_ответил(api):
    res = api.get(f"{BASE_URL}/api/nope/ever")
    assert res.status_code == 404 and res.json()["code"] == "no_route"
    assert api.get(f"{BASE_URL}/api/auth/me").headers.get("X-Served-By") == "auth"
    assert api.get(f"{BASE_URL}/api/storage").headers.get("X-Served-By") == "datasets"
