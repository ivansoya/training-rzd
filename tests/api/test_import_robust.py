"""Импорт переживает «Блокнот», плоскую раскладку, отмену и не держит проект вечно."""
import io
import zipfile

from PIL import Image as PilImage

from conftest import BASE_URL, wait_job


def jpeg():
    buf = io.BytesIO()
    PilImage.new("RGB", (64, 48), (40, 60, 90)).save(buf, "JPEG")
    return buf.getvalue()


def archive():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("data.yaml", "﻿names:\n  0: вагон\n")
        z.writestr("images/train/a.jpg", jpeg())
        # BOM от «Блокнота» — раньше «нечисловое значение» и кадр долой.
        z.writestr("labels/train/a.txt", "﻿0 0.5 0.5 0.2 0.2\n")
        # Плоская раскладка: метка рядом с картинкой.
        z.writestr("flat/b.jpg", jpeg())
        z.writestr("flat/b.txt", "0 0.4 0.4 0.2 0.2\n")
        z.writestr("labels/train/lost.txt", "0 0.5 0.5 0.1 0.1\n")
    return buf.getvalue()


def url(project, tail=""):
    return f"{BASE_URL}/api/projects/{project['code']}{tail}"


def scan(api, project):
    res = api.post(url(project, "/import"),
                   files={"file": ("test-robust.zip", archive(), "application/zip")})
    assert res.status_code == 202, res.text
    assert wait_job(api, res.json()["job_id"])["status"] == "done"
    return api.get(url(project, "/import")).json()


def test_bom_плоская_раскладка_и_метки_без_картинки(api, project):
    state = scan(api, project)
    report = state["report"]
    assert report["skipped"] == 0, report
    assert report["annotations"] == 2 and report["orphan_labels"] == 1
    # Пока идёт импорт, ручной класс налетел бы на номера из архива.
    assert api.post(url(project, "/classes"), json={"name": "x"}).status_code == 409
    res = api.post(url(project, "/import/commit"), json={
        "dataset_name": "Робастный", "classes": [{"class_index": 0, "name": "вагон"}]})
    assert wait_job(api, res.json()["job_id"])["status"] == "done"
    done = api.get(url(project, "/import")).json()
    assert done["status"] == "done" and done["dataset_name"] == "Робастный"
    assert done["archive"]["name"] == "test-robust.zip" and done["report"]


def test_отмена_на_шаге_классов_освобождает_проект(api, project):
    scan(api, project)
    assert api.delete(url(project, "/import")).status_code == 200
    assert api.get(url(project)).json()["project"]["status"] == "ready"
    assert api.get(url(project, "/import")).json()["status"] == "none"
    scan(api, project)  # второй архив в тот же проект принимается
