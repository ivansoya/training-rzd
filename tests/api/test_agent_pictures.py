"""Свои картинки на полке — источник образцов «Сети по тексту» (решения 23.10.2026).

Повод — борщевик «Искры»: в проекте его нет, снимки — из открытого доступа. Картинка
ложится на личную полку по имени класса, рамки рисует человек, набор собирается из
рамок картинок так же, как из рамок кадров проекта. Картинку, чьи рамки в сохранённой
версии агента, удалить нельзя.

Нужен стенд с картой: набор считает векторы YOLOE в воркере (как `test_agent_examples`).
"""
import io
import os

import cv2
import numpy as np
import pytest
from PIL import Image

from conftest import BASE_URL, DATA_DIR, tag
from test_agent_examples import _doc, people, source  # noqa: F401 — фикстуры и документ агента
from test_agent_video import owner  # noqa: F401 — фикстура

URL = f"{BASE_URL}/api/agents/pictures"


def _jpeg(w=640, h=480, seed=0, orientation=None):
    """Снимок с цветным пятном: разные зёрна — разные файлы (отпечаток у полки свой)."""
    rng = np.random.default_rng(seed)
    pic = (rng.random((h, w, 3)) * 60).astype(np.uint8)
    pic[h // 4: h // 2, w // 3: w // 2] = (230, 230, 240)
    buf = io.BytesIO()
    img = Image.fromarray(pic)
    if orientation:
        exif = Image.Exif()
        exif[0x0112] = orientation
        img.save(buf, "JPEG", exif=exif)
    else:
        img.save(buf, "JPEG")
    return buf.getvalue()


@pytest.fixture(scope="module")
def shelf():
    return f"Борщевик {tag()}"


@pytest.fixture(scope="module")
def made(db):
    """Картинки тестов: строки и файлы убираем сами — владельца сотрёт общая уборка, картинки остались бы."""
    ids = []
    yield ids
    with db.cursor() as cur:
        cur.execute("DELETE FROM agent_pictures WHERE id = ANY(%s::uuid[]) RETURNING file_path", (ids,))
        for (path,) in cur.fetchall():
            if os.path.exists(os.path.join(DATA_DIR, path)):
                os.remove(os.path.join(DATA_DIR, path))


def _put(session, raw, shelf, name="a.jpg"):
    return session.put(URL, params={"shelf": shelf, "name": name}, data=raw)


@pytest.fixture(scope="module")
def pic(owner, shelf, made):
    res = _put(owner, _jpeg(seed=1), shelf)
    assert res.status_code == 201, res.text
    made.append(res.json()["id"])
    return res.json()


def test_картинка_ложится_на_полку_и_второй_раз_не_ложится(owner, shelf, pic):
    assert pic["shelf"] == shelf and (pic["width"], pic["height"]) == (640, 480)
    assert pic["boxes"] == [] and pic["locked"] is None
    again = _put(owner, _jpeg(seed=1), "другая полка", name="b.jpg")
    assert again.status_code == 409 and again.json()["code"] == "duplicate", again.text
    assert f"«{shelf}»" in again.json()["error"]
    listed = owner.get(URL).json()["pictures"]
    assert [p["id"] for p in listed if p["shelf"] == shelf] == [pic["id"]]


def test_отказы_приёма(owner, shelf):
    assert _put(owner, b"not an image", shelf).status_code == 400
    assert _put(owner, b"", shelf).status_code == 400
    assert _put(owner, _jpeg(seed=2), "").status_code == 400


def test_exif_разворачивается_при_приёме(owner, shelf, made):
    # 6 — «повернуть на 90° по часовой»: браузер покажет 480×640, файл на полке — тоже.
    res = _put(owner, _jpeg(seed=3, orientation=6), shelf, name="phone.jpg")
    assert res.status_code == 201, res.text
    made.append(res.json()["id"])
    assert (res.json()["width"], res.json()["height"]) == (480, 640)


def test_рамки_обрезаются_краем_и_мелкие_отбрасываются(owner, pic):
    res = owner.patch(f"{URL}/{pic['id']}", json={"boxes": [[-10, 10, 120, 100], [200, 100, 5, 40], [600, 400, 100, 100]]})
    assert res.status_code == 200, res.text
    assert res.json()["boxes"] == [[0, 10, 110, 100], [600, 400, 40, 80]]
    assert owner.patch(f"{URL}/{pic['id']}", json={"boxes": [[1, 2]]}).status_code == 400
    assert owner.patch(f"{URL}/{pic['id']}", json={"boxes": "x"}).status_code == 400


def test_картинка_и_вырезка_рамки(owner, pic):
    small = owner.get(f"{URL}/{pic['id']}/image", params={"w": 200})
    assert small.status_code == 200 and small.headers["Content-Type"] == "image/jpeg"
    assert cv2.imdecode(np.frombuffer(small.content, np.uint8), cv2.IMREAD_COLOR).shape[:2] == (150, 200)
    crop = owner.get(f"{URL}/{pic['id']}/crop", params={"box": "0,10,110,100"})
    assert crop.status_code == 200 and crop.headers["Content-Type"] == "image/jpeg"


def test_чужую_картинку_не_видно(api, pic):
    assert api.get(f"{URL}/{pic['id']}/image").status_code == 404
    assert api.patch(f"{URL}/{pic['id']}", json={"boxes": []}).status_code == 404
    assert api.delete(f"{URL}/{pic['id']}").status_code == 404
    assert all(p["id"] != pic["id"] for p in api.get(URL).json()["pictures"])


def _set(owner, body):
    res = owner.post(f"{BASE_URL}/api/agents/examples", json=body)
    assert res.status_code == 201, res.text
    return res.json()["set"]


def test_набор_только_со_своих_картинок_без_проекта(owner, shelf, pic):
    boxes = owner.patch(f"{URL}/{pic['id']}", json={"boxes": [[200, 100, 120, 130], [20, 20, 80, 60]]}).json()["boxes"]
    made = _set(owner, {"shelf": shelf, "items": [{"picture_id": pic["id"], "box": b} for b in reversed(boxes)]})
    assert made["status"] == "ready" and made["class_name"] == shelf and made["project_id"] is None
    assert [it["picture_id"] for it in made["items"]] == [pic["id"]] * 2 and made["frames"] == 1
    assert [it["box"] for it in made["items"]] == list(reversed(boxes))
    crop = owner.get(f"{BASE_URL}/api/agents/examples/{made['id']}/crops/{made['items'][0]['uid']}")
    assert crop.status_code == 200 and len(crop.content) > 500
    # рамки, которой на картинке нет, — отказ, как у кадров проекта
    res = owner.post(f"{BASE_URL}/api/agents/examples", json={"shelf": shelf, "items": [{"picture_id": pic["id"], "box": [1, 1, 30, 30]}]})
    assert res.status_code == 422 and "больше нет" in res.json()["error"], res.text


def test_смешанный_набор_и_коллаж(owner, source, people, pic):
    cls = next(c for c in source["classes"] if c["id"] == people["class_id"])
    frame = people["items"][0]
    items = [{"image_id": frame["image_id"], "box": frame["box"]}, {"picture_id": pic["id"], "box": pic_box(owner, pic)}]
    made = _set(owner, {"project": source["project"]["code"], "class_id": cls["id"], "items": items})
    assert [bool(it["picture_id"]) for it in made["items"]] == [False, True] and made["frames"] == 2
    res = owner.post(f"{BASE_URL}/api/agents/examples/collage",
                     json={"image_id": frame["image_id"], "items": items, "side": 1008, "pass": 0})
    assert res.status_code == 200 and res.headers["X-Passes"] == "1", res.text


def pic_box(owner, pic):
    return next(p for p in owner.get(URL).json()["pictures"] if p["id"] == pic["id"])["boxes"][0]


def test_картинку_из_версии_агента_не_удалить(owner, shelf, made):
    res = _put(owner, _jpeg(seed=4), shelf, name="locked.jpg")
    assert res.status_code == 201, res.text
    locked = res.json()
    made.append(locked["id"])
    box = owner.patch(f"{URL}/{locked['id']}", json={"boxes": [[100, 100, 200, 150]]}).json()["boxes"][0]
    kept = _set(owner, {"shelf": shelf, "items": [{"picture_id": locked["id"], "box": box}]})
    graph = owner.post(f"{BASE_URL}/api/aug/graphs", json={"name": tag(), "kind": "agent"}).json()
    res = owner.post(f"{BASE_URL}/api/aug/graphs/{graph['id']}/versions", json={"doc": _doc("l", kept["id"])})
    assert res.status_code in (200, 201), res.text
    row = next(p for p in owner.get(URL).json()["pictures"] if p["id"] == locked["id"])
    assert row["locked"] and graph["name"] in row["locked"]
    res = owner.delete(f"{URL}/{locked['id']}")
    assert res.status_code == 409 and res.json()["code"] == "locked", res.text
    # в версии — набор, у него своя вырезка: картинка и рамки на месте
    assert owner.get(f"{URL}/{locked['id']}/image").status_code == 200


def test_свободную_картинку_удалить_можно(owner, shelf):
    res = _put(owner, _jpeg(seed=5), shelf, name="free.jpg")
    assert res.status_code == 201, res.text
    free = res.json()
    assert owner.delete(f"{URL}/{free['id']}").status_code == 200
    assert owner.get(f"{URL}/{free['id']}/image").status_code == 404
    assert all(p["id"] != free["id"] for p in owner.get(URL).json()["pictures"])
