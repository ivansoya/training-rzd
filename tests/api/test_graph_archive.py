"""Архив графов: архивный не держит имя, вернуть его можно, только если имя свободно."""
from conftest import BASE_URL, tag

URL = f"{BASE_URL}/api/aug/graphs"


def test_архивный_граф_не_держит_имя(api):
    name = tag()
    first = api.post(URL, json={"name": name, "kind": "agent"}).json()
    assert api.patch(f"{URL}/{first['id']}", json={"archived": True}).status_code == 200
    second = api.post(URL, json={"name": name, "kind": "agent"})
    assert second.status_code == 201, second.text
    back = api.patch(f"{URL}/{first['id']}", json={"archived": False})
    assert back.status_code == 409 and "переименуйте" in back.json()["error"]
    assert api.patch(f"{URL}/{second.json()['id']}", json={"name": tag()}).status_code == 200
    assert api.patch(f"{URL}/{first['id']}", json={"archived": False}).status_code == 200
    assert api.delete(f"{URL}/{first['id']}").status_code == 200
