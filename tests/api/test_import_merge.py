"""Повторный импорт в проект с классами: архив сверяется с классами проекта.

Сопоставленный класс принимает разметку архива и не меняет своего номера;
новый получает следующий свободный номер — номера архива в проекте с классами
столкнулись бы с занятыми.
"""
import io
import zipfile

from conftest import wait_job
from test_project_data import imported, jpeg, url  # noqa: F401 — фикстуры


def second_archive():
    """В этом архиве номера переставлены: 0 — опора, 1 — вагон, 2 — мост."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("data.yaml", "names:\n  0: опора\n  1: вагон\n  2: мост\n")
        for i, cls in enumerate((0, 1, 2)):
            z.writestr(f"images/train/s{i}.jpg", jpeg())
            z.writestr(f"labels/train/s{i}.txt", f"{cls} 0.5 0.5 0.2 0.2\n")
    return buf.getvalue()


def scan(api, project):
    res = api.post(url(project, "/import"),
                   files={"file": ("second.zip", second_archive(), "application/zip")})
    assert res.status_code == 202, res.text
    assert wait_job(api, res.json()["job_id"])["status"] == "done"
    state = api.get(url(project, "/import")).json()
    assert state["status"] == "classes", state
    return state


def classes_by_name(api, project):
    rows = api.get(url(project, "/classes")).json()["classes"]
    return {c["name"]: c for c in rows}


def test_второй_архив_сверяется_с_классами(api, project, imported):
    before = classes_by_name(api, project)
    scan(api, project)
    res = api.post(url(project, "/import/commit"), json={
        "dataset_name": "Второй",
        "classes": [
            {"class_index": 0, "target": before["опора"]["id"]},
            {"class_index": 1, "target": before["вагон"]["id"]},
            {"class_index": 2, "name": "мост"},
        ],
    })
    assert res.status_code == 202, res.text
    assert wait_job(api, res.json()["job_id"])["status"] == "done"

    after = classes_by_name(api, project)
    assert set(after) == {"вагон", "опора", "мост"}
    # Номера классов проекта не тронуты, новый — следующий свободный
    assert after["вагон"]["class_index"] == before["вагон"]["class_index"]
    assert after["опора"]["class_index"] == before["опора"]["class_index"]
    assert after["мост"]["class_index"] == max(c["class_index"] for c in before.values()) + 1
    # Разметка архива легла в сопоставленные классы
    assert after["вагон"]["annotations"] == before["вагон"]["annotations"] + 1
    assert after["опора"]["annotations"] == before["опора"]["annotations"] + 1
    assert after["мост"]["annotations"] == 1


def test_новый_класс_с_занятым_именем_отклоняется(api, project, imported):
    scan(api, project)
    res = api.post(url(project, "/import/commit"), json={
        "dataset_name": "Второй",
        "classes": [
            {"class_index": 0, "name": "опора-2"},
            {"class_index": 1, "name": "Вагон"},   # регистр не спасает
            {"class_index": 2, "name": "мост"},
        ],
    })
    assert res.status_code == 400
    assert "уже есть в проекте" in res.json()["error"]
