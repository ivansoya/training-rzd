"""Имя таски длиннее столбца — внятный отказ, а не HTTP 500."""
from conftest import BASE_URL, tag


def test_длинное_имя_таски_отклоняется(api, project, task):
    long = "т" * 256
    res = api.post(f"{BASE_URL}/api/projects/{project['code']}/tasks", json={"name": long})
    assert res.status_code == 400, res.text
    assert "255" in res.json()["error"]

    res = api.patch(f"{BASE_URL}/api/tasks/{task['id']}", json={"name": long})
    assert res.status_code == 400, res.text

    # В пределах 255 — законно.
    ok = api.post(f"{BASE_URL}/api/projects/{project['code']}/tasks",
                  json={"name": tag() + "т" * 240})
    assert ok.status_code in (200, 201), ok.text
