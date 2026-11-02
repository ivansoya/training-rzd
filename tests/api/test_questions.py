"""Вопросы в разметке (решения 29.10.2026) сквозь настоящие ручки: держат место при «Готово»,
не дают закрыть, права наблюдателя и автора, объект удалён, правка своих сообщений, колокольчик.

Таблица прав и чистые функции — `tests/unit/test_questions.py`.
"""
from conftest import BASE_URL, hand_over
from test_project_admin import join, person
from test_task_states import first_image, move, upload, me_id


def ask(s, task_id, **body):
    return s.post(f"{BASE_URL}/api/tasks/{task_id}/questions", json={"text": "Это вагон или тень?", **body})


def questions(s, task_id):
    return s.get(f"{BASE_URL}/api/tasks/{task_id}/questions").json()["questions"]


def put_box(s, image_id, ci):
    res = s.put(f"{BASE_URL}/api/images/{image_id}/annotations",
                json={"boxes": [{"class_index": ci, "x": 5, "y": 5, "w": 20, "h": 20}]})
    assert res.status_code == 200, res.text
    return res.json()


def inbox(s):
    return s.get(f"{BASE_URL}/api/tasks/questions-inbox").json()["items"]


def test_вопрос_держит_изображение_и_закрытие(api, task, label_class):
    tid, ci = task["id"], label_class["class_index"]
    for _ in range(2):
        assert upload(api, tid).status_code == 201
    images = api.get(f"{BASE_URL}/api/tasks/{tid}/images").json()["images"]
    held, free = images[0]["id"], images[1]["id"]
    saved = put_box(api, held, ci)
    put_box(api, free, ci)
    box_id = next(b["id"] for b in saved["shapes"] if b)

    res = ask(api, tid, image_id=held, object_id=box_id, object_kind="ann")
    assert res.status_code == 201, res.text
    q = res.json()
    assert q["status"] == "open" and q["class"]["name"] == label_class["name"] and not q["object_gone"]
    assert q["can_settle"] and q["messages"][0]["text"] == "Это вагон или тень?"

    res = move(api, tid, "done")
    assert res.status_code == 200, res.text
    assert res.json()["accepted"] == 1
    by_id = {i["id"]: i for i in api.get(f"{BASE_URL}/api/tasks/{tid}/images").json()["images"]}
    assert not by_id[held]["accepted"] and by_id[free]["accepted"], by_id

    res = move(api, tid, "closed")
    assert res.status_code == 409 and res.json()["code"] == "open_questions", res.text
    assert res.json()["error"] == "Закрыть нельзя: 1 открытый вопрос."

    res = api.post(f"{BASE_URL}/api/tasks/{tid}/questions/{q['id']}/resolve")
    assert res.status_code == 200 and res.json()["status"] == "resolved", res.text
    assert move(api, tid, "updating").status_code == 200
    res = move(api, tid, "done")
    assert res.status_code == 200 and res.json()["accepted"] == 1, res.text
    assert move(api, tid, "closed").status_code == 200
    # Закрытая — только чтение
    assert ask(api, tid, image_id=held).status_code == 409
    assert questions(api, tid)[0]["status"] == "resolved"


def test_доска_видит_открытые_вопросы(api, project, task, label_class):
    assert upload(api, task["id"]).status_code == 201
    image = first_image(api, task["id"])
    assert ask(api, task["id"], image_id=image["id"]).status_code == 201
    tasks = api.get(f"{BASE_URL}/api/projects/{project['code']}/tasks").json()["tasks"]
    mine = next(t for t in tasks if t["id"] == task["id"])
    assert mine["questions"]["open"] == 1 and mine["questions"]["last_by"], mine["questions"]


def test_объект_удалён_правка_и_права(api, db, project, task, label_class):
    tid, ci = task["id"], label_class["class_index"]
    assert upload(api, tid).status_code == 201
    image = first_image(api, tid)["id"]
    box = next(b["id"] for b in put_box(api, image, ci)["shapes"] if b)
    viewer = person(db)
    join(api, viewer, project["code"], "viewer")

    q = ask(api, tid, image_id=image, object_id=box, object_kind="ann").json()
    # Рамку стёрли — вопрос на месте, объект помечен удалённым
    assert api.put(f"{BASE_URL}/api/images/{image}/annotations", json={"boxes": []}).status_code == 200
    got = questions(api, tid)[0]
    assert got["object_gone"] and got["place"] == q["place"]

    # Наблюдатель отвечает, правит своё, чужое — нет
    url = f"{BASE_URL}/api/tasks/{tid}/questions/{q['id']}"
    res = viewer.post(f"{url}/messages", json={"text": "Тень, на соседних его нет"})
    assert res.status_code == 201, res.text
    mine = res.json()["messages"][-1]
    assert mine["can_edit"]
    res = viewer.patch(f"{url}/messages/{mine['id']}", json={"text": "Тень от фонаря"})
    assert res.status_code == 200 and res.json()["messages"][-1]["edited"], res.text
    assert api.patch(f"{url}/messages/{mine['id']}", json={"text": "чужое"}).status_code == 403
    first = q["messages"][0]["id"]
    res = api.delete(f"{url}/messages/{first}")
    assert res.status_code == 409 and res.json()["code"] == "first", res.text
    assert viewer.delete(f"{url}/messages/{mine['id']}").status_code == 200
    assert len(questions(api, tid)[0]["messages"]) == 1

    # Наблюдатель решает только свой вопрос; ответ в решённое его не открывает
    assert viewer.post(f"{url}/resolve").status_code == 403
    own = ask(viewer, tid, image_id=image).json()
    assert own["can_settle"] and not next(x for x in questions(viewer, tid) if x["id"] == q["id"])["can_settle"]
    assert viewer.post(f"{BASE_URL}/api/tasks/{tid}/questions/{own['id']}/resolve").status_code == 200
    res = api.post(f"{BASE_URL}/api/tasks/{tid}/questions/{own['id']}/messages", json={"text": "спасибо"})
    assert res.status_code == 201 and res.json()["status"] == "resolved", res.text
    assert api.post(f"{BASE_URL}/api/tasks/{tid}/questions/{own['id']}/reopen").json()["status"] == "open"
    assert api.delete(f"{BASE_URL}/api/tasks/{tid}/questions/{own['id']}").status_code == 200
    assert [x["id"] for x in questions(api, tid)] == [q["id"]]

    assert ask(api, tid, image_id=image, text="   ").status_code == 400
    assert ask(api, tid, image_id=image, text="я" * 2001).status_code == 400
    assert ask(api, tid).status_code == 400


def test_колокольчик(api, db, project, label_class):
    worker = person(db)
    join(api, worker, project["code"], "editor")
    task = api.post(f"{BASE_URL}/api/projects/{project['code']}/tasks",
                    json={"name": "Колокольчик", "assignees": [me_id(worker)]}).json()
    assert move(worker, task["id"], "in_progress").status_code == 200
    assert upload(worker, task["id"]).status_code == 201
    image = first_image(api, task["id"])["id"]

    q = ask(api, task["id"], image_id=image).json()
    got = [i for i in inbox(worker) if i["question_id"] == q["id"]]
    assert len(got) == 1 and got[0]["kind"] == "new" and got[0]["task"]["name"] == "Колокольчик", got
    assert not [i for i in inbox(api) if i["question_id"] == q["id"]]  # себе не пишем

    url = f"{BASE_URL}/api/tasks/{task['id']}/questions/{q['id']}"
    assert worker.post(f"{url}/messages", json={"text": "Смотрю"}).status_code == 201
    got = [i for i in inbox(api) if i["question_id"] == q["id"]]
    assert len(got) == 1 and got[0]["kind"] == "reply" and got[0]["text"] == "Смотрю", got

    assert worker.post(f"{url}/read").status_code == 200
    assert not [i for i in inbox(worker) if i["question_id"] == q["id"]]
    assert worker.post(f"{url}/resolve").status_code == 200  # исполнитель решает чужой
    assert not [i for i in inbox(api) if i["question_id"] == q["id"]]


def test_вопрос_держит_кадр_ролика(api, db, task, video, label_class):
    url = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}"
    track = api.post(f"{url}/tracks", json={
        "class_index": label_class["class_index"], "frame_no": 0,
        "geometry": {"x": 10, "y": 10, "w": 40, "h": 40}}).json()
    # Второй ключ: между ключами кадры уходят каждый, с одним ключом — только он сам
    assert api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/10",
                   json={"geometry": {"x": 60, "y": 10, "w": 40, "h": 40}}).status_code == 200
    res = ask(api, task["id"], video_id=video["id"], frame_no=5, object_id=track["id"], object_kind="track")
    assert res.status_code == 201, res.text
    q = res.json()
    assert q["place"] == f"{video['file_name']}, 0:00" and q["time_ms"] == 500 and q["class"], q
    assert ask(api, task["id"], video_id=video["id"], frame_no=-1).status_code == 400

    hand_over(api, task["id"])
    with db.cursor() as cur:
        cur.execute("SELECT source_frame_no, dataset_id IS NOT NULL FROM images WHERE source_video_id = %s",
                    (video["id"],))
        accepted = dict(cur.fetchall())
    assert accepted.get(5) is False and accepted.get(6) is True, sorted(accepted.items())
