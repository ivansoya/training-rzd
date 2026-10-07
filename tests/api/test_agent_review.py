"""Проверка разметки агента и «В разметку» из разведки (решения 2026-10-07).

«На проверке» — флаг на рамке. Проверяется не «ручка отвечает», а правило:
непроверенное не уходит в датасет, сохранение само ничего не подтверждает,
подтверждает только явное `pending: false` или правка рамки, а клиент флаг
поставить не может. Рамки агента и находки разведки кладутся прямо в базу:
сам агент здесь ни при чём, и карта тесту не нужна.
"""
import io
import json

import pytest
from PIL import Image as PilImage

from conftest import BASE_URL, wait_job
from test_video_annotation import close_annotation


@pytest.fixture
def image(api, task):
    buf = io.BytesIO()
    PilImage.new("RGB", (400, 200), (40, 60, 90)).save(buf, "JPEG")
    buf.seek(0)
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/images",
                   files={"files": ("test-frame.jpg", buf, "image/jpeg")})
    assert res.status_code in (200, 201), res.text
    return api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"][0]


def agent_box(db, image_id, label_class, x=10.0):
    """Рамка агента на проверке — так её кладёт прогон."""
    with db.cursor() as cur:
        cur.execute(
            """INSERT INTO annotations (id, image_id, class_id, ann_type, geometry, area, iscrowd, source,
                                        pending, attributes, created_at)
               VALUES (gen_random_uuid(), %s, %s, 'bbox', %s, 1600, false, 'model', true, %s, now())
               RETURNING id""",
            (image_id, label_class["id"], json.dumps({"x": x, "y": 10.0, "w": 40.0, "h": 40.0}),
             json.dumps({"conf": 0.91})))
        return str(cur.fetchone()[0])


def frame(api, task, image_id):
    rows = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"]
    return next(r for r in rows if r["id"] == image_id)


def wire(b, **kw):
    return {"id": b["id"], "class_index": b["class_index"], "x": b["x"], "y": b["y"], "w": b["w"], "h": b["h"],
            "source": b["source"], **kw}


def save(api, image_id, boxes):
    res = api.put(f"{BASE_URL}/api/images/{image_id}/annotations", json={"boxes": boxes})
    assert res.status_code == 200, res.text
    return res.json()


def test_непроверенный_кадр_не_уходит_в_датасет(api, db, task, image, label_class):
    agent_box(db, image["id"], label_class)
    got = frame(api, task, image["id"])
    assert got["task_status"] == "new"
    assert got["boxes"][0]["pending"] is True and got["boxes"][0]["conf"] == 0.91
    listed = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images?status=agent").json()
    assert listed["matched"] == 1 and listed["counts"]["agent"] == 1

    # Человек дорисовал свою рамку — кадр размечен, но непроверенное на нём держит его в таске
    mine = {"class_index": label_class["class_index"], "x": 200, "y": 20, "w": 50, "h": 50}
    res = save(api, image["id"], [wire(got["boxes"][0]), mine])
    assert res["task_status"] == "annotated"
    assert [s["pending"] for s in res["shapes"]] == [True, False]
    done = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"}).json()
    assert done["accepted"] == 0


def test_подтверждение_снимает_флаг_и_кадр_уходит(api, db, task, image, label_class):
    agent_box(db, image["id"], label_class)
    b = frame(api, task, image["id"])["boxes"][0]
    res = save(api, image["id"], [wire(b, pending=False)])
    assert res["task_status"] == "annotated" and res["shapes"][0]["pending"] is False
    got = frame(api, task, image["id"])["boxes"][0]
    # Подтвердить не значит поправить: рамка остаётся за агентом
    assert got["pending"] is False and got["source"] == "model"
    done = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"}).json()
    assert done["accepted"] == 1


def test_правка_рамки_подтверждает_только_её(api, db, task, image, label_class):
    agent_box(db, image["id"], label_class, x=10.0)
    agent_box(db, image["id"], label_class, x=200.0)
    a, b = sorted(frame(api, task, image["id"])["boxes"], key=lambda r: r["x"])
    res = save(api, image["id"], [wire(a, x=12), wire(b)])
    assert [s["pending"] for s in res["shapes"]] == [False, True]


def test_клиент_не_ставит_флаг(api, task, image, label_class):
    res = save(api, image["id"], [{"class_index": label_class["class_index"], "x": 5, "y": 5, "w": 30, "h": 30,
                                   "source": "model", "pending": True}])
    assert res["shapes"][0]["pending"] is False


def test_массового_принятия_больше_нет(api, db, task, image, label_class):
    agent_box(db, image["id"], label_class)
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/accept-agent", json={})
    assert res.status_code in (404, 405)
    assert frame(api, task, image["id"])["task_status"] == "new"


def test_закрытие_таски_снимает_непроверенное_с_принятых_кадров(api, db, task, image, label_class):
    mine = {"class_index": label_class["class_index"], "x": 200, "y": 20, "w": 50, "h": 50}
    save(api, image["id"], [mine])
    assert api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"}).json()["accepted"] == 1
    # Агента позвали на уже принятый кадр — его непроверенное в данные не уходит
    agent_box(db, image["id"], label_class)
    closed = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "closed"})
    assert closed.status_code == 200, closed.text
    assert closed.json()["removed_unchecked"] == 1
    with db.cursor() as cur:
        cur.execute("SELECT pending FROM annotations WHERE image_id = %s", (image["id"],))
        assert [r[0] for r in cur.fetchall()] == [False]


# --- ролик ---------------------------------------------------------------- #
def video_agent_box(db, video, label_class, frame_no, x=10.0):
    with db.cursor() as cur:
        cur.execute(
            """INSERT INTO video_annotations (id, video_id, frame_no, class_id, ann_type, geometry, source,
                                              pending, attributes, created_at)
               VALUES (gen_random_uuid(), %s, %s, %s, 'bbox', %s, 'model', true, %s, now())""",
            (video["id"], frame_no, label_class["id"], json.dumps({"x": x, "y": 90.0, "w": 60.0, "h": 60.0}),
             json.dumps({"conf": 0.8})))


def singles(api, task, video):
    return api.get(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/annotations").json()["singles"]


def test_ролик_подтверждение_кадра(api, db, task, video, label_class):
    video_agent_box(db, video, label_class, 5)
    video_agent_box(db, video, label_class, 5, x=200.0)
    got = singles(api, task, video)
    assert all(s["pending"] for s in got) and got[0]["conf"] == 0.8
    # «Подтвердить кадр» — запись кадра с pending: false у оставшихся; одну отклонили
    keep = got[0]
    res = api.put(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frames/5/boxes",
                  json={"boxes": [{"id": keep["id"], **keep["shape"], "class_index": keep["class_index"],
                                   "pending": False}]})
    assert res.status_code == 200, res.text
    assert res.json()["pending"] == 0
    after = singles(api, task, video)
    assert len(after) == 1 and after[0]["pending"] is False


def test_закрытие_ролика_переносит_флаг_на_кадры(api, db, task, video, label_class):
    video_agent_box(db, video, label_class, 5)
    plan = api.post(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/materialize/preview").json()
    assert plan["unchecked"] == 1
    wait_job(api, close_annotation(api, task, video).json()["job_id"])
    rows = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images?status=agent").json()["images"]
    assert len(rows) == 1 and rows[0]["task_status"] == "new"
    assert rows[0]["boxes"][0]["pending"] is True


def test_в_разметку_из_разведки(api, db, task, video, label_class):
    with db.cursor() as cur:
        cur.execute(
            """INSERT INTO video_scouts (id, video_id, agent_name, step, gap_s, last_frame, frames, segments, created_at)
               VALUES (gen_random_uuid(), %s, 'тест', 5, 2, 29, %s, %s, now())""",
            (video["id"], json.dumps({"10": [["вагон агента", 0.77, 20, 30, 80, 60]]}),
             json.dumps({"вагон агента": [[10, 10, 1]]})))
    url = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/scout/take"
    # Класс агента ни с чем не сопоставлен — без класса редактора не взять
    res = api.post(url, json={"frame_no": 10, "items": [{"i": 0}]})
    assert res.status_code == 409 and res.json()["code"] == "unmapped"
    res = api.post(url, json={"frame_no": 10, "items": [{"i": 0, "class_index": label_class["class_index"]}]})
    assert res.status_code == 201, res.text
    got = singles(api, task, video)
    # Взятая находка — сразу проверенная: человек выбрал её сам
    assert len(got) == 1 and got[0]["pending"] is False and got[0]["frame_no"] == 10
    assert api.post(url, json={"frame_no": 3, "items": [{"i": 0}]}).status_code == 404


def test_агент_таски_сохраняет_сопоставление_без_запуска(api, task, label_class):
    graph = api.post(f"{BASE_URL}/api/aug/graphs", json={"name": "test-агент", "kind": "agent"}).json()
    url = f"{BASE_URL}/api/agents/tasks/{task['id']}/mapping"
    res = api.put(url, json={"graph_id": graph["id"], "mapping": {"cls-a": label_class["id"], "cls-b": "чужой"}})
    assert res.status_code == 200, res.text
    # Чужой класс не прилипает: сопоставить можно только с классом этого проекта
    assert res.json()["mapping"] == {"cls-a": label_class["id"], "cls-b": None}
    ctx = api.get(f"{BASE_URL}/api/agents/tasks/{task['id']}").json()
    assert ctx["mappings"][graph["id"]]["cls-a"] == label_class["id"]
    # Дописывается, а не затирается: у другой версии могли быть свои классы
    api.put(url, json={"graph_id": graph["id"], "mapping": {"cls-c": None}})
    ctx = api.get(f"{BASE_URL}/api/agents/tasks/{task['id']}").json()
    assert set(ctx["mappings"][graph["id"]]) == {"cls-a", "cls-b", "cls-c"}
    api.delete(f"{BASE_URL}/api/aug/graphs/{graph['id']}")
