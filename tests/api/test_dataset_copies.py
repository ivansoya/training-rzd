"""Таска из датасета (решения 14.10.2026): копии кадров, сдача на место, исходник только для чтения."""
from conftest import BASE_URL
from test_project_data import imported, url  # noqa: F401 — фикстура


def frames(api, project, **params):
    res = api.get(url(project, "/images"), params=params)
    assert res.status_code == 200, res.text
    return {i["file_name"]: i for i in res.json()["images"]}


def new_task(api, project, ids, work=True):
    res = api.post(url(project, "/tasks"), json={"name": "Проверка", "image_ids": ids})
    assert res.status_code == 201, res.text
    body = res.json()
    if work:
        status(api, body["id"], "in_progress")
    return body


def status(api, task_id, to, expect=200):
    res = api.post(f"{BASE_URL}/api/tasks/{task_id}/status", json={"status": to})
    assert res.status_code == expect, res.text
    return res.json()


def copies(api, task_id):
    res = api.get(f"{BASE_URL}/api/tasks/{task_id}/images", params={"source": "dataset"})
    assert res.status_code == 200, res.text
    return {i["file_name"]: i for i in res.json()["images"]}


def put(api, image_id, boxes, expect=200):
    res = api.put(f"{BASE_URL}/api/images/{image_id}/annotations", json={"boxes": boxes})
    assert res.status_code == expect, res.text
    return res.json()


BOX0 = {"class_index": 0, "x": 2, "y": 2, "w": 8, "h": 8}
BOX1 = {"class_index": 1, "x": 3, "y": 3, "w": 5, "h": 5}


def test_копии_и_сдача_на_место(api, project, imported):
    a, b = frames(api, project)["a.jpg"], frames(api, project)["b.jpg"]
    task = new_task(api, project, [a["id"], b["id"]])
    assert task["taken"] == {"added": 2, "busy": []}
    got = copies(api, task["id"])
    ca, cb = got["a.jpg"], got["b.jpg"]
    assert ca["id"] != a["id"] and ca["origin"]["image_id"] == a["id"]
    assert ca["origin"]["dataset_name"] == "Первый"
    assert ca["task_status"] == "new" and len(ca["boxes"]) == 1 and not ca["accepted"]
    # Блоки страницы таски: копии — свой источник, не «файлы»
    by = api.get(f"{BASE_URL}/api/tasks/{task['id']}/counts").json()["by_source"]
    assert by["dataset"]["new"] == 2 and "files" not in by
    # Галерея знает, что кадр в таске; копий в ней нет
    shown = frames(api, project)
    assert set(shown) == {"a.jpg", "b.jpg"} and shown["a.jpg"]["held"]["task_id"] == task["id"]

    # Исходник с живой копией — только чтение
    assert put(api, a["id"], [], expect=409)["code"] == "in_task"
    assert api.put(f"{BASE_URL}/api/images/{a['id']}/tags", json={"tags": []}).status_code == 409
    assert api.delete(f"{BASE_URL}/api/images/{a['id']}").status_code == 409

    # Второй раз тот же кадр не берётся: окно называет держащую таску
    pre = api.post(url(project, "/images/take"), json={"image_ids": [a["id"], b["id"]]}).json()
    assert pre["take"] == 0 and pre["busy"] == [{"task_id": task["id"], "name": "Проверка", "n": 2}]
    assert new_task(api, project, [a["id"]], work=False)["taken"]["added"] == 0

    # Правим копию a, бракуем копию b
    put(api, ca["id"], [BOX0, BOX1])
    assert api.delete(f"{BASE_URL}/api/images/{cb['id']}").status_code == 200
    # Решённая копия ляжет на исходник — в «уйдёт в датасет» таски её нет; раскладка по датасетам исходников
    assert api.get(f"{BASE_URL}/api/tasks/{task['id']}/counts").json()["counts"]["copies_decided"] == 1
    src = api.get(f"{BASE_URL}/api/tasks/{task['id']}").json()["sources"]["dataset"]
    assert src["datasets"] == [{"id": imported, "name": "Первый", "n": 1}]
    done = status(api, task["id"], "done")
    assert done["copies"] == {"placed": 1, "removed": 1, "edited": 0, "waiting": 0}
    assert done["accepted"] == 0  # копии в датасет отдельными кадрами не идут

    shown = frames(api, project)
    # a — на месте, с правками; b из архива — удалён насовсем
    assert set(shown) == {"a.jpg"} and shown["a.jpg"]["id"] == a["id"]
    assert sorted(x["class_index"] for x in shown["a.jpg"]["boxes"]) == [0, 1]
    assert shown["a.jpg"]["held"] is None
    assert api.get(f"{BASE_URL}/api/images/{a['id']}/thumb").status_code == 200


def test_правка_в_датасете_побеждает_сдачу(api, project, imported):
    a = frames(api, project)["a.jpg"]
    task = new_task(api, project, [a["id"]])
    ca = copies(api, task["id"])["a.jpg"]
    put(api, ca["id"], [BOX1])
    assert status(api, task["id"], "done")["copies"]["placed"] == 1
    # После «Готово» исходник свободен — правят в датасете
    put(api, a["id"], [BOX0, BOX0])
    status(api, task["id"], "updating")
    put(api, ca["id"], [BOX1, BOX1, BOX1])
    assert status(api, task["id"], "done")["copies"] == {"placed": 0, "removed": 0, "edited": 1, "waiting": 0}
    assert len(frames(api, project)["a.jpg"]["boxes"]) == 2


def test_таг_в_датасете_тоже_правка(api, project, imported):
    a = frames(api, project)["a.jpg"]
    task = new_task(api, project, [a["id"]])
    put(api, copies(api, task["id"])["a.jpg"]["id"], [BOX1])
    status(api, task["id"], "done")
    # Кадр архива без таски — таги теперь правятся в датасете
    tagged = api.post(url(project, "/tags"), json={"name": "ночь"}).json()["id"]
    res = api.put(f"{BASE_URL}/api/images/{a['id']}/tags", json={"tags": [tagged]})
    assert res.status_code == 200, res.text
    status(api, task["id"], "updating")
    assert status(api, task["id"], "done")["copies"]["edited"] == 1


def test_перенос_класса_не_правка_и_нетронутое_не_трогает(api, project, imported):
    shown = frames(api, project)
    a, b = shown["a.jpg"], shown["b.jpg"]
    task = new_task(api, project, [a["id"], b["id"]])
    ca = copies(api, task["id"])["a.jpg"]
    put(api, ca["id"], [BOX0])
    classes = {c["class_index"]: c for c in api.get(url(project, "/classes")).json()["classes"]}
    res = api.post(url(project, f"/classes/{classes[1]['id']}/move"),
                   json={"target_id": classes[0]["id"], "delete_source": False})
    assert res.status_code == 200, res.text
    out = status(api, task["id"], "done")["copies"]
    # a правили в таске — лёг; b не трогали — исходник прежний (перенос класса правкой не считается)
    assert out == {"placed": 1, "removed": 0, "edited": 0, "waiting": 0}
    assert frames(api, project)["b.jpg"]["rev"] == b["rev"] + 1  # только перенос


def test_закрытие_убирает_только_копии(api, project, imported):
    a = frames(api, project)["a.jpg"]
    task = new_task(api, project, [a["id"]])
    ca = copies(api, task["id"])["a.jpg"]
    put(api, ca["id"], [BOX1])
    out = status(api, task["id"], "closed")
    assert out["copies"]["placed"] == 1 and out["removed_images"] == 1
    assert api.get(f"{BASE_URL}/api/images/{ca['id']}/thumb").status_code == 404
    assert api.get(f"{BASE_URL}/api/images/{a['id']}/thumb").status_code == 200
    assert [x["class_index"] for x in frames(api, project)["a.jpg"]["boxes"]] == [1]


def test_пусто_в_датасете_и_выдача_id(api, project, imported):
    shown = frames(api, project)
    a = shown["a.jpg"]
    # «Пусто» в датасете: стёрли всё — кадр фоновый
    assert put(api, a["id"], [])["task_status"] == "empty"
    ids = api.get(url(project, "/images"), params={"ids_only": "1", "split": "val"}).json()
    assert ids == {"ids": [shown["b.jpg"]["id"]], "matched": 1}
    assert api.get(url(project, "/images"), params={"pending": "1"}).json()["matched"] == 0


def test_пополнить_открытую_таску(api, project, imported):
    a, b = frames(api, project)["a.jpg"], frames(api, project)["b.jpg"]
    task = new_task(api, project, [a["id"]])
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/from-dataset", json={"image_ids": [a["id"], b["id"]]})
    assert res.status_code == 200, res.text
    assert res.json()["added"] == 1 and res.json()["busy"][0]["n"] == 1
    listed = api.get(url(project, "/tasks")).json()
    rows = listed["tasks"] if isinstance(listed, dict) else listed
    assert next(t for t in rows if t["id"] == task["id"])["fill"] is True
    status(api, task["id"], "done")
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/from-dataset", json={"image_ids": [b["id"]]})
    assert res.status_code == 409, res.text


def test_агент_в_датасете_и_свободные_id(api, project, imported):
    a, b = frames(api, project)["a.jpg"], frames(api, project)["b.jpg"]
    # G в «Фокусе» датасета: контекст агентов проекта без таски
    ctx = api.get(url(project, "/agents/context"))
    assert ctx.status_code == 200, ctx.text
    assert ctx.json()["can_run"] is True and ctx.json()["videos"] == []
    res = api.post(url(project, "/agents/apply"), json={"graph_id": "00000000-0000-0000-0000-000000000000",
                                                         "image_id": a["id"]})
    assert res.status_code == 404, res.text
    # Флажок группы берёт только свободные: кадр с живой копией не выбирается
    new_task(api, project, [a["id"]])
    got = api.get(url(project, "/images"), params={"ids_only": "1", "free": "1"}).json()
    assert got["ids"] == [b["id"]]
