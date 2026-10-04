"""Сводка «Обзора»: цифры совпадают с паспортом проекта, черновики тасок не считаются.

На экране обзора эти числа стоят рядом с теми, что человек видит в датасетах
и тасках, — разойтись им нельзя.
"""
from conftest import BASE_URL
from test_project_data import draft, imported, url  # noqa: F401 — фикстуры


def overview(api, project):
    res = api.get(url(project, "/overview"))
    assert res.status_code == 200, res.text
    return res.json()


def test_пустой_проект(api, project):
    o = overview(api, project)
    assert o["frames"] == {"total": 0, "week": 0, "series": [0] * 7}
    assert o["annotated"]["count"] == 0 and o["boxes"]["total"] == 0
    assert o["best"] is None and o["latest_run"] is None
    assert o["activity"] == []


def test_импорт_считается_черновик_нет(api, project, imported, draft):
    o = overview(api, project)
    # Два кадра архива; кадр таски до приёмки — черновик
    assert o["frames"]["total"] == 2
    assert o["frames"]["week"] == 2
    assert o["frames"]["series"][-1] == 2
    assert o["annotated"]["count"] == 2
    assert o["annotated"]["share"][-1] == 1
    assert o["boxes"]["total"] == 2
    rows = {r["name"]: r for r in o["classes"]["rows"]}
    assert (rows["вагон"]["train"], rows["вагон"]["val"]) == (1, 0)
    assert (rows["опора"]["train"], rows["опора"]["val"]) == (0, 1)
    assert o["classes"]["declared"] == 2 and o["classes"]["used"] == 2
    # Лента: таску создали и загрузили в неё кадр — от имени того, кто это сделал
    kinds = [a["kind"] for a in o["activity"]]
    assert "images_added" in kinds
    assert all(a["user"] == "Тестовый разметчик" for a in o["activity"] if a["kind"] == "images_added")


def test_чужой_проект_не_отдаётся(api, project, db):
    import requests
    from conftest import tag
    other = requests.Session()
    login = tag()
    other.post(f"{BASE_URL}/api/auth/register", json={
        "email": f"{login}@example.test", "login": login,
        "display_name": "Посторонний", "password": "Test-Passw0rd",
    })
    with db.cursor() as cur:
        cur.execute("UPDATE users SET email_confirmed_at = now() WHERE login = %s", (login,))
    other.post(f"{BASE_URL}/api/auth/login", json={"identity": login, "password": "Test-Passw0rd"})
    assert other.get(url(project, "/overview")).status_code == 403
