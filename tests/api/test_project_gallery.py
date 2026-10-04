"""Галерея датасетов и список проектов: фильтры по имени и тагам, сводка групп, цифры плитки проекта."""
from conftest import BASE_URL
from test_project_data import draft, imported, url  # noqa: F401 — фикстуры


def images(api, project, **params):
    res = api.get(url(project, "/images"), params=params)
    assert res.status_code == 200, res.text
    return res.json()


def test_сводка_групп_и_классов(api, project, imported):
    body = images(api, project, summary="1", limit="0")
    assert body["images"] == [] and body["matched"] == 2
    s = body["summary"]
    assert s["by_dataset"] == {imported: 2}
    assert s["by_split"] == {"train": 1, "val": 1}
    assert s["boxes_by_class"] == {"0": 1, "1": 1}
    # Сводка — по отбору, а не по проекту
    s = images(api, project, summary="1", limit="0", split="val")["summary"]
    assert s["by_split"] == {"val": 1} and s["boxes_by_class"] == {"1": 1}


def test_поиск_по_имени_и_один_кадр(api, project, imported):
    found = images(api, project, q="A.JP")["images"]
    assert [i["file_name"] for i in found] == ["a.jpg"]
    # Знаки шаблона LIKE ищутся буквально
    assert images(api, project, q="%")["matched"] == 0
    one = images(api, project, image=found[0]["id"])
    assert one["matched"] == 1 and one["images"][0]["id"] == found[0]["id"]
    assert one["images"][0]["task_status"] and one["images"][0]["tags"] == []
    assert api.get(url(project, "/images"), params={"image": "00000000-0000-0000-0000-000000000000"}).status_code == 404


def test_таги_нужен_и_исключить(api, project, imported, db):
    res = api.post(url(project, "/tags"), json={"name": "ночь"})
    assert res.status_code in (200, 201), res.text
    night = res.json()["id"]
    a = images(api, project, q="a.jpg")["images"][0]
    with db.cursor() as cur:
        cur.execute("INSERT INTO image_tags (image_id, tag_id) VALUES (%s, %s)", (a["id"], night))
    tagged = images(api, project, tags=night)
    assert [i["file_name"] for i in tagged["images"]] == ["a.jpg"]
    assert tagged["images"][0]["tags"] == ["ночь"]
    assert [i["file_name"] for i in images(api, project, notags=night)["images"]] == ["b.jpg"]
    bad = api.get(url(project, "/images"), params={"tags": "00000000-0000-0000-0000-000000000000"})
    assert bad.status_code == 400


def test_плитка_проекта(api, project, imported, draft):
    res = api.get(f"{BASE_URL}/api/projects")
    assert res.status_code == 200, res.text
    mine = next(p for p in res.json()["projects"] if p["code"] == project["code"])
    # Два кадра архива размечены; черновик таски не данные проекта
    assert mine["images_count"] == 2 and mine["done_count"] == 2
    assert mine["tasks_open"] == 1
    assert mine["last_run"] is None
