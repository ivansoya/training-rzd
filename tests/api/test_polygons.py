"""Полигональная разметка: от редактора до архива и обратно.

Чистая геометрия закрыта единицами (`test_polygon.py`, `test_shapes.py`).
Здесь проверяется то, чего они не видят: доходит ли контур до базы целым,
возвращается ли он тем же, во что превращается на выгрузке и узнаёт ли его
импорт. Круг замыкается на настоящем архиве, а не на строке в памяти.
"""
import io
import zipfile

import pytest
from PIL import Image as PilImage

from conftest import BASE_URL, tag, wait_job


@pytest.fixture
def image(api, task):
    """Один кадр в таске: полигоны живут на изображениях."""
    buf = io.BytesIO()
    PilImage.new("RGB", (400, 200), (40, 60, 90)).save(buf, "JPEG")
    buf.seek(0)
    res = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/images",
        files={"files": ("test-frame.jpg", buf, "image/jpeg")},
    )
    assert res.status_code in (200, 201), res.text
    listing = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images")
    assert listing.status_code == 200, listing.text
    images = listing.json()["images"]
    assert images, "кадр не появился в таске"
    return images[0]


def square(x, y, side):
    return [[x, y], [x + side, y], [x + side, y + side], [x, y + side]]


def save(api, image_id, boxes):
    res = api.put(f"{BASE_URL}/api/images/{image_id}/annotations", json={"boxes": boxes})
    assert res.status_code == 200, res.text
    return res.json()


def read_back(api, task_id, image_id):
    res = api.get(f"{BASE_URL}/api/tasks/{task_id}/images")
    assert res.status_code == 200, res.text
    for row in res.json()["images"]:
        if row["id"] == image_id:
            return row["boxes"]
    raise AssertionError("кадр пропал из таски")


# --------------------------------------------------------------------------- #
# Хранение
# --------------------------------------------------------------------------- #
def test_контур_возвращается_целым(api, task, image, label_class):
    """Сколько точек послали, столько и вернулось: округление до сотых долей
    пикселя формы не меняет, а потеря точки — меняет."""
    ring = [[10.0, 20.0], [300.0, 25.0], [280.0, 180.0], [20.0, 150.0]]
    save(api, image["id"], [{
        "class_index": label_class["class_index"],
        "kind": "polygon", "parts": [ring],
        "x": 10, "y": 20, "w": 290, "h": 160,
    }])
    got = read_back(api, task["id"], image["id"])
    assert len(got) == 1
    assert got[0]["kind"] == "polygon"
    assert got[0]["parts"] == [ring]


def test_объект_из_двух_частей_остаётся_одним(api, task, image, label_class):
    save(api, image["id"], [{
        "class_index": label_class["class_index"],
        "kind": "polygon", "parts": [square(10, 10, 50), square(200, 10, 50)],
        "x": 10, "y": 10, "w": 240, "h": 50,
    }])
    got = read_back(api, task["id"], image["id"])
    assert len(got) == 1, "две части — это один объект, а не два"
    assert len(got[0]["parts"]) == 2


def test_контур_несёт_охватывающую_рамку(api, task, image, label_class):
    """По ней рисует всё, что не знает о контурах, — и она обязана быть верной."""
    save(api, image["id"], [{
        "class_index": label_class["class_index"],
        "kind": "polygon", "parts": [square(10, 10, 50), square(200, 10, 50)],
        "x": 0, "y": 0, "w": 0, "h": 0,  # заведомо неверная: сервер считает сам
    }])
    got = read_back(api, task["id"], image["id"])[0]
    assert (got["x"], got["y"], got["w"], got["h"]) == (10, 10, 240, 50)


def test_боксы_и_контуры_уживаются_на_одном_кадре(api, task, image, label_class):
    ci = label_class["class_index"]
    save(api, image["id"], [
        {"class_index": ci, "x": 10, "y": 10, "w": 40, "h": 40},
        {"class_index": ci, "kind": "polygon", "parts": [square(200, 10, 50)],
         "x": 200, "y": 10, "w": 50, "h": 50},
    ])
    kinds = sorted(b["kind"] for b in read_back(api, task["id"], image["id"]))
    assert kinds == ["bbox", "polygon"]


def test_вырожденный_контур_не_сохраняется(api, task, image, label_class):
    """Три записи одной точки — не фигура. Кадр из-за неё не роняем."""
    res = save(api, image["id"], [{
        "class_index": label_class["class_index"],
        "kind": "polygon", "parts": [[[5, 5], [5, 5], [5, 5]]],
        "x": 5, "y": 5, "w": 0, "h": 0,
    }])
    assert res["saved"] == 0
    assert read_back(api, task["id"], image["id"]) == []


def test_контур_за_краем_подрезается(api, task, image, label_class):
    """Кадр 400×200: точки снаружи прижимаются, а не отбраковываются."""
    save(api, image["id"], [{
        "class_index": label_class["class_index"],
        "kind": "polygon", "parts": [[[-50, -50], [900, 10], [900, 900]]],
        "x": 0, "y": 0, "w": 400, "h": 200,
    }])
    ring = read_back(api, task["id"], image["id"])[0]["parts"][0]
    assert all(0 <= x <= 400 and 0 <= y <= 200 for x, y in ring)


# --------------------------------------------------------------------------- #
# Выгрузка и обратный путь
# --------------------------------------------------------------------------- #
def accept(api, task_id):
    """Сдаём таску: кадры уезжают в датасет, откуда их берёт выгрузка."""
    res = api.post(f"{BASE_URL}/api/tasks/{task_id}/status", json={"status": "done"})
    assert res.status_code in (200, 202), res.text
    body = res.json()
    if body.get("job_id"):
        assert wait_job(api, body["job_id"])["status"] == "done"


def export(api, code, ann_type):
    res = api.post(f"{BASE_URL}/api/projects/{code}/export/preview",
                   json={"datasets": [], "classes": [], "ann_type": ann_type})
    assert res.status_code == 200, res.text
    return res.json()


def test_план_сегментации_пропускает_боксы_и_говорит_сколько(
    api, task, project, image, label_class
):
    ci = label_class["class_index"]
    save(api, image["id"], [
        {"class_index": ci, "x": 10, "y": 10, "w": 40, "h": 40},
        {"class_index": ci, "kind": "polygon", "parts": [square(200, 10, 50)],
         "x": 200, "y": 10, "w": 50, "h": 50},
    ])
    accept(api, task["id"])

    datasets = api.get(f"{BASE_URL}/api/projects/{project['code']}").json()["datasets"]
    classes = api.get(f"{BASE_URL}/api/projects/{project['code']}/classes").json()["classes"]
    sel = {"datasets": [d["id"] for d in datasets], "classes": [c["id"] for c in classes]}

    seg = api.post(f"{BASE_URL}/api/projects/{project['code']}/export/preview",
                   json={**sel, "ann_type": "polygon"}).json()
    assert seg["wrong_kind"] == 1, "бокс обязан быть пропущен и посчитан"
    assert seg["annotations"] == 1
    # Слов о боксах сервер больше не пишет: окно выгрузки собирает одну строку
    # с единицами из wrong_kind, а серверное предупреждение её дублировало.
    assert not any("боксы" in w for w in seg["warnings"])

    box = api.post(f"{BASE_URL}/api/projects/{project['code']}/export/preview",
                   json={**sel, "ann_type": "bbox"}).json()
    assert box["wrong_kind"] == 0, "полигон в боксовую выгрузку идёт рамкой"
    assert box["annotations"] == 2


def test_архив_сегментации_несёт_строки_контуров(
    api, task, project, image, label_class
):
    """Главная проверка выгрузки: две части объекта — одна строка в файле."""
    save(api, image["id"], [{
        "class_index": label_class["class_index"],
        "kind": "polygon", "parts": [square(10, 10, 50), square(200, 10, 50)],
        "x": 10, "y": 10, "w": 240, "h": 50,
    }])
    accept(api, task["id"])

    code = project["code"]
    datasets = api.get(f"{BASE_URL}/api/projects/{code}").json()["datasets"]
    classes = api.get(f"{BASE_URL}/api/projects/{code}/classes").json()["classes"]
    res = api.post(f"{BASE_URL}/api/projects/{code}/export", json={
        "datasets": [d["id"] for d in datasets],
        "classes": [c["id"] for c in classes],
        "ann_type": "polygon",
    })
    assert res.status_code == 202, res.text
    job = wait_job(api, res.json()["job_id"])
    assert job["status"] == "done", job

    dl = api.get(f"{BASE_URL}/api/projects/{code}/export/{res.json()['job_id']}/download")
    assert dl.status_code == 200, dl.text
    with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
        labels = [n for n in zf.namelist() if n.startswith("labels/")]
        assert labels, zf.namelist()
        text = zf.read(labels[0]).decode()

    lines = [ln for ln in text.splitlines() if ln.strip()]
    assert len(lines) == 1, "объект один — и строка обязана быть одна"
    fields = lines[0].split()
    assert (len(fields) - 1) % 2 == 0
    # Обе части внутри одной строки: восемь вершин плюс две точки перемычки.
    assert len(fields) - 1 >= 8 * 2
    assert all(0.0 <= float(v) <= 1.0 for v in fields[1:])


# --------------------------------------------------------------------------- #
# Контуры в разметке ролика
# --------------------------------------------------------------------------- #
def frame_shapes(api, task_id, video_id, boxes):
    res = api.put(
        f"{BASE_URL}/api/tasks/{task_id}/videos/{video_id}/frames/0/boxes",
        json={"boxes": boxes},
    )
    assert res.status_code == 200, res.text
    return res.json()


def singles_of(api, task_id, video_id, frame_no=0):
    res = api.get(f"{BASE_URL}/api/tasks/{task_id}/videos/{video_id}/annotations")
    assert res.status_code == 200, res.text
    return [s for s in res.json()["singles"] if s["frame_no"] == frame_no]


def test_контур_на_кадре_ролика_сохраняется(api, task, video, label_class):
    """Ролик 320×240: контур внутри кадра."""
    ring = [[20, 20], [180, 30], [160, 140], [30, 120]]
    frame_shapes(api, task["id"], video["id"], [{
        "class_index": label_class["class_index"],
        "kind": "polygon", "parts": [ring],
        "x": 20, "y": 20, "w": 160, "h": 120,
    }])
    got = singles_of(api, task["id"], video["id"])
    assert len(got) == 1
    assert got[0]["shape"]["kind"] == "polygon"
    assert got[0]["shape"]["parts"] == [ring]


def test_контур_и_рамка_уживаются_на_кадре_ролика(api, task, video, label_class):
    ci = label_class["class_index"]
    frame_shapes(api, task["id"], video["id"], [
        {"class_index": ci, "x": 10, "y": 10, "w": 40, "h": 40},
        {"class_index": ci, "kind": "polygon", "parts": [[[100, 20], [180, 30], [150, 110]]],
         "x": 100, "y": 20, "w": 80, "h": 90},
    ])
    kinds = sorted(s["shape"]["kind"] for s in singles_of(api, task["id"], video["id"]))
    assert kinds == ["bbox", "polygon"]


def test_контур_ролика_становится_контуром_кадра_таски(api, task, video, label_class):
    """Главная проверка: закрытие разметки не превращает контур в рамку.

    Материализация переносит фигуру как есть — иначе работа разметчика тихо
    упрощалась бы ровно в тот момент, когда её уже нельзя проверить глазами.
    """
    ring = [[20, 20], [180, 30], [160, 140], [30, 120]]
    frame_shapes(api, task["id"], video["id"], [{
        "class_index": label_class["class_index"],
        "kind": "polygon", "parts": [ring],
        "x": 20, "y": 20, "w": 160, "h": 120,
    }])
    res = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/close-annotation",
        json={},
    )
    assert res.status_code == 202, res.text
    job = wait_job(api, res.json()["job_id"])
    assert job["status"] == "done", job.get("error")
    assert job["result"]["boxes"] == 1

    images = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"]
    made = [i for i in images if i["source_video_id"] == video["id"]]
    assert len(made) == 1
    shape = made[0]["boxes"][0]
    assert shape["kind"] == "polygon"
    assert len(shape["parts"][0]) == len(ring)
    # Площадь считается по частям, а не по рамке: у рамки она была бы 160×120.
    assert shape["w"] == 160 and shape["h"] == 120


def test_контур_треком_не_становится(api, task, video, label_class):
    """Трек ведут рамкой: положение между ключами он считает сам, а посчитать
    контур нечем. Правило серверное — интерфейс прячет кнопку, но ручка
    открыта всем."""
    res = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/tracks",
        json={
            "class_index": label_class["class_index"],
            "frame_no": 0,
            "geometry": {"parts": [[[20, 20], [180, 30], [160, 140]]]},
        },
    )
    assert res.status_code == 400, res.text
    # Отказ обязан назвать причину: «Рамка слишком мала» отправило бы человека
    # искать ошибку в рамке, которой он не рисовал.
    assert "контур" in res.json()["error"].lower()


def test_ключ_трека_контуром_не_ставится(api, task, video, label_class):
    res = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/tracks",
        json={"class_index": label_class["class_index"], "frame_no": 0,
              "geometry": {"x": 10, "y": 10, "w": 50, "h": 50}},
    )
    assert res.status_code in (200, 201), res.text
    track = res.json()
    bad = api.put(
        f"{BASE_URL}/api/video-tracks/{track['id']}/keys/10",
        json={"geometry": {"kind": "polygon", "parts": [[[20, 20], [80, 30], [60, 90]]]}},
    )
    assert bad.status_code == 400, bad.text
    assert "контур" in bad.json()["error"].lower()


def test_рамка_треком_становится_по_прежнему(api, task, video, label_class):
    """Запрет не должен задеть обычный путь: одиночная рамка треком становится."""
    res = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/tracks",
        json={"class_index": label_class["class_index"], "frame_no": 0,
              "geometry": {"x": 10, "y": 10, "w": 50, "h": 50}},
    )
    assert res.status_code in (200, 201), res.text
    assert api.put(
        f"{BASE_URL}/api/video-tracks/{res.json()['id']}/keys/10",
        json={"geometry": {"x": 20, "y": 20, "w": 50, "h": 50}},
    ).status_code in (200, 201)


def test_битое_тело_не_стирает_разметку(api, task, image, label_class):
    save(api, image["id"], [{
        "class_index": label_class["class_index"], "x": 10, "y": 10, "w": 50, "h": 50,
    }])
    url = f"{BASE_URL}/api/images/{image['id']}/annotations"
    for body in ('[]', '{"rev": 1}', '{"boxes": [1]}', '{"boxes": [{"x": NaN}]}', 'мусор'):
        res = api.put(url, data=body.encode(), headers={"Content-Type": "application/json"})
        assert res.status_code == 400, (body, res.status_code, res.text)
        assert res.json()["error"]
    assert len(read_back(api, task["id"], image["id"])) == 1


def test_рамка_модели_остаётся_её_пока_не_поправили(api, image, label_class):
    box = {"class_index": label_class["class_index"], "x": 10, "y": 10, "w": 50, "h": 50,
           "source": "model"}
    got = save(api, image["id"], [box, {**box, "w": 0}])
    first, dropped = got["shapes"]
    assert dropped is None and first["source"] == "model" and first["id"]
    again = save(api, image["id"], [{**box, "id": first["id"]}])["shapes"][0]
    assert again == first, "нетронутая рамка сохраняет и id, и автора"
    moved = save(api, image["id"], [{**box, "id": first["id"], "x": 20}])["shapes"][0]
    assert moved == {"id": first["id"], "source": "human", "pending": False}


def test_вернуть_после_брака_восстанавливает_принятый_фон(api, db, task, image):
    url = f"{BASE_URL}/api/images/{image['id']}/task-status"
    assert api.patch(url, json={"status": "empty"}).status_code == 200
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})
    assert res.status_code == 200, res.text

    def row():
        with db.cursor() as cur:
            cur.execute("SELECT task_status, dataset_id FROM images WHERE id = %s", (image["id"],))
            return cur.fetchone()

    status, dataset = row()
    assert status == "empty" and dataset is not None
    assert api.post(f"{BASE_URL}/api/tasks/{task['id']}/status",
                    json={"status": "updating"}).status_code == 200
    assert api.delete(f"{BASE_URL}/api/images/{image['id']}").status_code == 200
    assert row() == ("deleted", None)
    # Клиент шлёт «new» по пустой разметке — сервер помнит, что кадр был фоном.
    res = api.patch(url, json={"status": "new"})
    assert res.status_code == 200 and res.json()["task_status"] == "empty"
    assert row() == ("empty", dataset)


def test_удаление_класса_снимает_размечен_с_опустевшего_кадра(api, db, project, image, label_class):
    save(api, image["id"], [{"class_index": label_class["class_index"],
                             "x": 10, "y": 10, "w": 50, "h": 50}])
    res = api.delete(f"{BASE_URL}/api/projects/{project['code']}/classes/{label_class['id']}",
                     params={"confirm": "1"})
    assert res.status_code == 200, res.text
    with db.cursor() as cur:
        cur.execute("SELECT task_status FROM images WHERE id = %s", (image["id"],))
        assert cur.fetchone()[0] == "new"


def test_jpg_и_png_с_одной_основой_не_делят_файл_разметки(api, task, project, label_class):
    for name, fmt in (("collide.jpg", "JPEG"), ("collide.png", "PNG")):
        buf = io.BytesIO()
        PilImage.new("RGB", (100, 80), (20, 40, 60)).save(buf, fmt)
        buf.seek(0)
        assert api.post(f"{BASE_URL}/api/tasks/{task['id']}/images",
                        files={"files": (name, buf, "image/" + fmt.lower())}).status_code in (200, 201)
    for i, row in enumerate(api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"]):
        save(api, row["id"], [{"class_index": label_class["class_index"],
                               "x": 10 + i * 20, "y": 10, "w": 30, "h": 30}])
    accept(api, task["id"])
    code = project["code"]
    datasets = api.get(f"{BASE_URL}/api/projects/{code}").json()["datasets"]
    res = api.post(f"{BASE_URL}/api/projects/{code}/export", json={
        "datasets": [d["id"] for d in datasets], "classes": [label_class["id"]], "ann_type": "bbox",
    })
    assert wait_job(api, res.json()["job_id"])["status"] == "done"
    dl = api.get(f"{BASE_URL}/api/projects/{code}/export/{res.json()['job_id']}/download")
    with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
        labels = [n for n in zf.namelist() if n.startswith("labels/") and "collide" in n]
    assert len(labels) == len(set(labels)) == 2, labels


def test_фон_выгрузки_разложен_по_родам(api, task, project, label_class):
    code = project["code"]
    other = api.post(f"{BASE_URL}/api/projects/{code}/classes", json={"name": "цистерна"}).json()
    for i in range(3):
        buf = io.BytesIO()
        PilImage.new("RGB", (100, 80), (20, 40, 60 + i)).save(buf, "JPEG")
        buf.seek(0)
        api.post(f"{BASE_URL}/api/tasks/{task['id']}/images",
                 files={"files": (f"bg{i}.jpg", buf, "image/jpeg")})
    rows = sorted(api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"],
                  key=lambda r: r["file_name"])
    save(api, rows[0]["id"], [{"class_index": label_class["class_index"], "x": 5, "y": 5, "w": 20, "h": 20}])
    save(api, rows[1]["id"], [{"class_index": other["class_index"], "x": 5, "y": 5, "w": 20, "h": 20}])
    assert api.patch(f"{BASE_URL}/api/images/{rows[2]['id']}/task-status",
                     json={"status": "empty"}).status_code == 200
    accept(api, task["id"])
    datasets = api.get(f"{BASE_URL}/api/projects/{code}").json()["datasets"]
    plan = api.post(f"{BASE_URL}/api/projects/{code}/export/preview", json={
        "datasets": [d["id"] for d in datasets], "classes": [label_class["id"]]}).json()
    # Кадр с чужим классом — не «без разметки», а «только другие классы».
    assert plan["background_parts"] == {"marked": 1, "bare": 0, "other": 1}
