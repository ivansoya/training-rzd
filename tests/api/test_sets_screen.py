"""Экран «Наборы»: предпросмотр мастера, сборка и то, что страница набора читает из ответа."""
import time

from test_project_data import imported, url  # noqa: F401 — фикстуры


def spec(api, project, mode="balanced"):
    detail = api.get(url(project)).json()
    return {
        "datasets": [d["id"] for d in detail["datasets"]],
        "classes": [c["id"] for c in api.get(url(project, "/classes")).json()["classes"]],
        "split_mode": mode, "val_ratio": 0.5, "seed": 7,
    }


def wait_ready(api, project, set_id, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        got = api.get(url(project, f"/trainsets/{set_id}")).json()
        if got["status"] not in ("queued", "building"):
            return got
        time.sleep(1)
    raise AssertionError("набор не собрался вовремя")


def test_предпросмотр_всеми_способами(api, project, imported):
    # До 06.10.2026 предупреждения по классам роняли предпросмотр с 500 на любом способе
    for mode in ("manual", "random", "balanced", "smart"):
        res = api.post(url(project, "/trainsets/preview"), json=spec(api, project, mode))
        assert res.status_code == 200, (mode, res.text)
        assert res.json()["images"] == 2


def test_собранный_набор_для_страницы(api, project, imported):
    res = api.post(url(project, "/trainsets"), json={**spec(api, project), "name": "Экран наборов"})
    assert res.status_code == 202, res.text
    made = res.json()
    assert made["can_manage"] is True and made["author"]

    got = wait_ready(api, project, made["id"])
    assert got["status"] == "ready", got.get("error")
    # Спек целиком — из него «Собрать похожий» заполняет мастер
    assert got["spec"]["datasets"] == [imported] and got["spec"]["seed"] == 7
    built = got["built"]
    assert built["split"]["train"] + built["split"]["val"] == got["counts"]["source_images"]
    assert sum(f["samples"] for f in built["feeds"]) == got["counts"]["samples"]
    assert {f["part"] for f in built["feeds"]} == {"train", "val"}

    page = api.get(url(project, f"/trainsets/{made['id']}/samples?limit=10")).json()
    tally = page["tally"]
    assert tally["train"] + tally["val"] == page["total"]
    # Без графа копий нет: всё — оригиналы, ссылками на файлы проекта
    assert tally["orig"] == page["total"] and tally["copy"] == 0
    assert all(s["source_name"] for s in page["samples"])
    copies = api.get(url(project, f"/trainsets/{made['id']}/samples?kind=copy")).json()
    assert copies["matched"] == 0
    origs = api.get(url(project, f"/trainsets/{made['id']}/samples?kind=orig&split=train")).json()
    assert origs["matched"] == tally["train"]

    listed = api.get(url(project, "/trainsets")).json()["sets"]
    assert next(s for s in listed if s["id"] == made["id"])["can_manage"] is True

    assert api.delete(url(project, f"/trainsets/{made['id']}")).status_code in (200, 202)
