"""Свои данные для тестов агентов: снимки с людьми и COCO-веса, без чужого стенда.

Раньше тесты агентов брали копию проекта «РСМ-2000 · тест» и веса с полки
дев-учётки `tester` — на любом другом стенде все пятнадцать молча
пропускались. Теперь всё заводится заново на каждый прогон:

* снимки `bus.jpg` и `zidane.jpg` из пакета ultralytics — их кладёт в образ
  тестов `tests/Dockerfile` (сам пакет тестам не нужен);
* веса `yolo11n.pt` с тома (`_weights`) — их качает сервис обучения, классы
  COCO, среди них `person`, а на снимках ещё автобус и галстук;
* кадры «без человека» — синтетика, на которой детектору найти нечего.
"""
import io
import os

import pytest
import requests

from conftest import BASE_URL, DATA_DIR, tag, wait_job

ASSETS = os.environ.get("TEST_ASSETS", "/opt/test-assets")
WEIGHTS = os.path.join(DATA_DIR, "_weights", "yolo11n.pt")
PERSON = "person"
SIZE = (1280, 720)

# Люди на снимках, (x0, y0, x1, y1) в пикселях исходника. Сверено с
# детектором и глазами: у Зидана рамка с вытянутой рукой — так и есть.
PEOPLE = {
    "bus.jpg": [(671, 395, 810, 879), (47, 400, 239, 904), (223, 409, 344, 860), (0, 556, 69, 872)],
    "zidane.jpg": [(749, 42, 1148, 711), (125, 200, 1150, 720)],
}


def session(db):
    """Свежий человек с подтверждённой почтой — как фикстура `api`, но на модуль."""
    login = tag()
    s = requests.Session()
    res = s.post(f"{BASE_URL}/api/auth/register", json={
        "email": f"{login}@example.test", "login": login,
        "display_name": "Тестовый владелец агента", "password": "Test-Passw0rd"})
    assert res.status_code in (200, 201), res.text
    with db.cursor() as cur:
        cur.execute("UPDATE users SET email_confirmed_at = now() WHERE login = %s", (login,))
    res = s.post(f"{BASE_URL}/api/auth/login", json={"identity": login, "password": "Test-Passw0rd"})
    assert res.status_code == 200, res.text
    return s


def _photo(name):
    from PIL import Image

    path = os.path.join(ASSETS, name)
    if not os.path.exists(path):
        pytest.skip(f"Нет снимка {path}: пересоберите образ тестов")
    return Image.open(path).convert("RGB")


def place(name, scale=1.0, dx=0):
    """Снимок на серой подложке SIZE: вписан по высоте, уменьшен и сдвинут.

    Возвращает кадр и рамки людей в его координатах (x, y, w, h)."""
    from PIL import Image

    img = _photo(name)
    k = min(SIZE[0] / img.width, SIZE[1] / img.height) * scale
    w, h = round(img.width * k), round(img.height * k)
    left = max(0, min(SIZE[0] - w, (SIZE[0] - w) // 2 + dx))
    top = (SIZE[1] - h) // 2
    canvas = Image.new("RGB", SIZE, (114, 114, 114))
    canvas.paste(img.resize((w, h)), (left, top))
    boxes = [(left + x0 * k, top + y0 * k, (x1 - x0) * k, (y1 - y0) * k)
             for x0, y0, x1, y1 in PEOPLE[name]]
    return canvas, boxes


def blank(i):
    """Кадр без людей: плавный перелив, у каждого свой оттенок."""
    from PIL import Image

    row = Image.new("RGB", (SIZE[0], 1))
    row.putdata([(40 + i * 30, (x * 255) // SIZE[0], 120) for x in range(SIZE[0])])
    return row.resize(SIZE)


def shelf_weights(owner):
    """COCO-веса на полку владельца. Нет файла на томе — тест пропускается."""
    if not os.path.exists(WEIGHTS):
        pytest.skip(f"Нет {WEIGHTS}: сервис обучения ещё не качал встроенные веса")
    with open(WEIGHTS, "rb") as fh:
        res = owner.put(f"{BASE_URL}/api/agents/weights", params={"name": "yolo11n-coco.pt"}, data=fh)
    assert res.status_code in (200, 201), res.text
    return res.json()


def source_project(owner, db, frames=18):
    """Проект с классом `person` и принятой разметкой людей — источник образцов.

    Кадров больше шестнадцати: набор образцов сперва берёт по рамке с кадра."""
    project = owner.post(f"{BASE_URL}/api/projects", json={"name": tag()}).json()
    code = project["code"]
    cls = owner.post(f"{BASE_URL}/api/projects/{code}/classes", json={"name": PERSON}).json()
    task = owner.post(f"{BASE_URL}/api/projects/{code}/tasks", json={"name": tag()}).json()
    owner.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "in_progress"})
    boxes_of = {}
    for i in range(frames):
        name = "bus.jpg" if i % 2 == 0 else "zidane.jpg"
        picture, boxes = place(name, scale=0.7 + 0.06 * (i % 6), dx=(i % 5 - 2) * 60)
        buf = io.BytesIO()
        picture.save(buf, "JPEG", quality=90)
        file_name = f"people-{i:02d}.jpg"
        res = owner.post(f"{BASE_URL}/api/tasks/{task['id']}/images",
                         files={"files": (file_name, buf.getvalue(), "image/jpeg")})
        assert res.status_code in (200, 201), res.text
        boxes_of[file_name] = boxes
    for row in owner.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"]:
        wire = [{"class_index": cls["class_index"], "x": x, "y": y, "w": w, "h": h}
                for x, y, w, h in boxes_of[row["file_name"]]]
        res = owner.put(f"{BASE_URL}/api/images/{row['id']}/annotations", json={"boxes": wire})
        assert res.status_code == 200, res.text
    res = owner.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})
    assert res.status_code in (200, 202), res.text
    if res.json().get("job_id"):
        assert wait_job(owner, res.json()["job_id"])["status"] == "done"
    return code
