"""Данные проекта: какие кадры считаются, как считаются классы, судьба датасета.

Проверяются числа, которые стоят на одном экране рядом: паспорт проекта,
сетка «Все кадры», отбор классов. Разойтись им нельзя — человек сверяет их
глазами, и любое расхождение читается как потеря данных.
"""
import io
import zipfile

import pytest
from PIL import Image as PilImage

from conftest import BASE_URL, wait_job


# --------------------------------------------------------------------------- #
# Общее
# --------------------------------------------------------------------------- #
def jpeg(w=64, h=48):
    buf = io.BytesIO()
    PilImage.new("RGB", (w, h), (40, 60, 90)).save(buf, "JPEG")
    return buf.getvalue()


def archive():
    """Два кадра: на первом класс 0, на втором класс 1."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("data.yaml", "names:\n  0: вагон\n  1: опора\n")
        z.writestr("images/train/a.jpg", jpeg())
        z.writestr("labels/train/a.txt", "0 0.5 0.5 0.2 0.2\n")
        z.writestr("images/val/b.jpg", jpeg())
        z.writestr("labels/val/b.txt", "1 0.5 0.5 0.2 0.2\n")
    return buf.getvalue()


def url(project, tail=""):
    return f"{BASE_URL}/api/projects/{project['code']}{tail}"


@pytest.fixture
def imported(api, project):
    """Проект с одним импортированным датасетом. Возвращает id датасета."""
    res = api.post(url(project, "/import"),
                   files={"file": ("test-data.zip", archive(), "application/zip")})
    assert res.status_code == 202, res.text
    assert wait_job(api, res.json()["job_id"])["status"] == "done"
    res = api.post(url(project, "/import/commit"), json={
        "dataset_name": "Первый",
        "classes": [{"class_index": 0, "name": "вагон"},
                    {"class_index": 1, "name": "опора"}],
    })
    assert res.status_code == 202, res.text
    done = wait_job(api, res.json()["job_id"])
    assert done["status"] == "done", done
    return done["result"]["dataset_id"]


@pytest.fixture
def draft(api, project, imported, task):
    """Кадр таски, ещё не принятый, с рамкой класса 0 — черновик."""
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/images",
                   files={"files": ("test-draft.jpg", jpeg(), "image/jpeg")})
    assert res.status_code in (200, 201), res.text
    image = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"][0]
    res = api.put(f"{BASE_URL}/api/images/{image['id']}/annotations",
                  json={"boxes": [{"class_index": 0, "x": 1, "y": 1, "w": 9, "h": 9}]})
    assert res.status_code == 200, res.text
    return image


def counts(api, project, scope=None):
    res = api.get(url(project, "/classes"), params={"dataset": scope} if scope else None)
    assert res.status_code == 200, res.text
    return {c["class_index"]: c["annotations"] for c in res.json()["classes"]}


# --------------------------------------------------------------------------- #
# К1: «Все кадры» — это кадры датасетов
# --------------------------------------------------------------------------- #
def test_черновик_таски_не_попадает_во_все_кадры(api, project, imported, draft):
    body = api.get(url(project, "/images")).json()
    assert body["total"] == 2 and body["matched"] == 2
    assert draft["id"] not in {i["id"] for i in body["images"]}
    # Паспорт проекта считает то же множество.
    assert api.get(url(project)).json()["stats"]["images"] == 2


# --------------------------------------------------------------------------- #
# К2: счёт классов — по тому множеству, которое смотрят
# --------------------------------------------------------------------------- #
def test_счёт_классов_по_датасету_и_по_проекту(api, project, imported, draft):
    assert counts(api, project) == {0: 2, 1: 1}            # с черновиком
    assert counts(api, project, "any") == {0: 1, 1: 1}     # только датасеты
    assert counts(api, project, imported) == {0: 1, 1: 1}


def test_чужой_датасет_в_счёте_классов_404(api, project, imported):
    res = api.get(url(project, "/classes"),
                  params={"dataset": "00000000-0000-0000-0000-000000000000"})
    assert res.status_code == 404
