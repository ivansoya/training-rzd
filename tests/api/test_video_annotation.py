"""Разметка видео целиком: загрузка, треки, сдача таски, кадры в проекте.

Проверяется живой бэкенд — тот же, что открыт в браузере. Поэтому тесты
говорят про наблюдаемое поведение (что вернул API, что появилось в проекте),
а не про внутренности.
"""
from conftest import BASE_URL, wait_job


def test_видео_загружается_в_режиме_разметки(video):
    assert video["mode"] == "annotate"
    assert video["frame_count"] == 30
    assert video["fps"] == 10.0


def test_видео_для_нарезки_остаётся_нарезкой(api, task, sample_video):
    with open(sample_video, "rb") as fh:
        res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/videos",
                       files={"file": ("cut.mp4", fh, "video/mp4")},
                       data={"mode": "cut"})
    assert res.status_code == 201, res.text
    assert res.json()["mode"] == "cut"


def test_неизвестный_режим_отвергается(api, task, sample_video):
    with open(sample_video, "rb") as fh:
        res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/videos",
                       files={"file": ("x.mp4", fh, "video/mp4")},
                       data={"mode": "как-нибудь"})
    assert res.status_code == 400


def test_кадр_отдаётся_картинкой(api, task, video):
    res = api.get(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frame?n=5")
    assert res.status_code == 200
    assert res.headers["Content-Type"].startswith("image/")
    assert len(res.content) > 500


def test_разные_кадры_дают_разные_картинки(api, task, video):
    a = api.get(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frame?n=2")
    b = api.get(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frame?n=25")
    assert a.content != b.content


def test_отрицательный_кадр_отвергается(api, task, video):
    res = api.get(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frame?n=-1")
    assert res.status_code == 400


# --- треки ----------------------------------------------------------------- #
def make_track(api, task, video, label_class, frame_no=0, geometry=None):
    res = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/tracks",
        json={
            "class_index": label_class["class_index"],
            "frame_no": frame_no,
            "geometry": geometry or {"x": 10, "y": 90, "w": 60, "h": 60},
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_трек_создаётся_с_первым_ключом(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    assert track["start_frame"] == 0
    assert track["end_frame"] is None
    assert len(track["keys"]) == 1
    assert track["interpolate"] is True
    assert track["export_step"] == 1


def test_трек_без_класса_не_создаётся(api, task, video):
    res = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/tracks",
        json={"class_index": 999, "frame_no": 0,
              "geometry": {"x": 1, "y": 1, "w": 5, "h": 5}},
    )
    assert res.status_code == 400


def test_ключ_добавляется_на_другом_кадре(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    res = api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20",
                  json={"geometry": {"x": 170, "y": 90, "w": 60, "h": 60}})
    assert res.status_code == 200, res.text
    assert [k["frame_no"] for k in res.json()["keys"]] == [0, 20]


def test_последний_ключ_снять_нельзя(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    res = api.delete(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/0")
    assert res.status_code == 409


def test_настройки_трека_меняются(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    res = api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}",
                    json={"interpolate": False, "export_step": 5, "label": "вагон #3"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["interpolate"] is False
    assert body["export_step"] == 5
    assert body["label"] == "вагон #3"


def test_нулевой_шаг_выгрузки_отвергается(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    res = api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 0})
    assert res.status_code == 400


def test_объект_не_может_исчезнуть_раньше_появления(api, task, video, label_class):
    track = make_track(api, task, video, label_class, frame_no=10)
    res = api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"end_frame": 5})
    assert res.status_code == 400


def test_разметка_читается_целиком(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20",
            json={"geometry": {"x": 170, "y": 90, "w": 60, "h": 60}})
    res = api.get(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/annotations")
    assert res.status_code == 200
    body = res.json()
    assert body["video"]["mode"] == "annotate"
    assert body["editable"] is True
    assert len(body["tracks"]) == 1
    assert len(body["tracks"][0]["keys"]) == 2


# --- одиночные боксы ------------------------------------------------------- #
def test_боксы_кадра_заменяются_целиком(api, task, video, label_class):
    url = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frames/7/boxes"
    ci = label_class["class_index"]
    res = api.put(url, json={"boxes": [
        {"class_index": ci, "x": 5, "y": 5, "w": 20, "h": 20},
        {"class_index": ci, "x": 50, "y": 50, "w": 20, "h": 20},
    ]})
    assert res.json()["saved"] == 2

    res = api.put(url, json={"boxes": [{"class_index": ci, "x": 5, "y": 5, "w": 20, "h": 20}]})
    assert res.json()["saved"] == 1

    body = api.get(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/annotations"
    ).json()
    assert len([s for s in body["singles"] if s["frame_no"] == 7]) == 1


# --- материализация -------------------------------------------------------- #
def test_предпросмотр_считает_кадры_по_шагу(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20",
            json={"geometry": {"x": 170, "y": 90, "w": 60, "h": 60}})
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 5})

    res = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/materialize/preview",
        json={},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # Кадры 0,5,10,15,20 — трек живёт до последнего ключа.
    assert body["frames"] == 5
    assert body["boxes"] == 5
    assert body["new_frames"] == 5


def test_заслонённый_участок_в_план_не_идёт(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/10", json={"visible": False})
    api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20",
            json={"geometry": {"x": 170, "y": 90, "w": 60, "h": 60}, "visible": True})
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 5})

    body = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/materialize/preview",
        json={},
    ).json()
    # 10 и 15 заслонены, остаются 0, 5 и 20.
    assert body["frames"] == 3


def test_сдача_таски_кладёт_кадры_в_проект(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20",
            json={"geometry": {"x": 170, "y": 90, "w": 60, "h": 60}})
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 10})

    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})
    assert res.status_code == 202, res.text
    job = wait_job(api, res.json()["job_id"])
    assert job["status"] == "done", job.get("error")
    assert job["result"]["created"] == 3          # кадры 0, 10, 20
    assert job["result"]["boxes"] == 3
    assert job["result"]["accepted"] == 3

    body = api.get(f"{BASE_URL}/api/tasks/{task['id']}").json()
    assert body["status"] == "done"
    assert body["counts"]["accepted"] == 3

    images = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"]
    assert len(images) == 3
    assert all(i["annotations"] == 1 for i in images)
    assert sorted(i["source_time_ms"] for i in images) == [0, 1000, 2000]


def test_повторная_сдача_правит_тот_же_кадр(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 30})

    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})
    job = wait_job(api, res.json()["job_id"])
    assert job["result"]["created"] == 1
    first = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"]
    assert len(first) == 1

    # Вернулись к разметке, добавили второй объект на тот же кадр и сдали снова.
    api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "updating"})
    api.put(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frames/0/boxes",
            json={"boxes": [{"class_index": label_class["class_index"],
                             "x": 200, "y": 20, "w": 40, "h": 40}]})
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})
    job = wait_job(api, res.json()["job_id"])
    assert job["result"]["created"] == 0
    assert job["result"]["updated"] == 1

    second = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"]
    assert len(second) == 1, "кадр не должен раздваиваться"
    assert second[0]["id"] == first[0]["id"]
    assert second[0]["annotations"] == 2


def test_закрытие_таски_убирает_видео_но_оставляет_кадры(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 30})
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})
    wait_job(api, res.json()["job_id"])

    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "closed"})
    assert res.status_code == 200, res.text
    assert res.json()["removed_videos"] == 1

    body = api.get(f"{BASE_URL}/api/tasks/{task['id']}").json()
    assert body["videos"] == []
    assert body["counts"]["accepted"] == 1


def test_закрытие_таски_уносит_треки_вместе_с_роликом(api, task, video, label_class):
    """Закрытие убирает черновое, а трек — это разметка ролика, а не проекта.

    Кадры, которые он успел дать, уже лежат в датасете отдельными файлами со
    своей разметкой, поэтому терять тут нечего.
    """
    track = make_track(api, task, video, label_class)
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 30})
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})
    wait_job(api, res.json()["job_id"])
    api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "closed"})

    res = api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 2})
    assert res.status_code == 404


def test_в_замороженной_таске_трек_не_правится(api, task, video, label_class):
    """До закрытия таска замораживается сдачей: ролик ещё жив, но правки нет."""
    track = make_track(api, task, video, label_class)
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 30})
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})
    wait_job(api, res.json()["job_id"])

    # «Готово» — не заморозка: к разметке возвращаются через «изменение».
    res = api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 5})
    assert res.status_code == 200, res.text


def test_нарезаемое_видео_треков_не_принимает(api, task, sample_video, label_class):
    with open(sample_video, "rb") as fh:
        cut = api.post(f"{BASE_URL}/api/tasks/{task['id']}/videos",
                       files={"file": ("cut.mp4", fh, "video/mp4")},
                       data={"mode": "cut"}).json()
    res = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{cut['id']}/tracks",
        json={"class_index": label_class["class_index"], "frame_no": 0,
              "geometry": {"x": 1, "y": 1, "w": 20, "h": 20}},
    )
    assert res.status_code == 409


def test_чужой_в_проект_не_лезет(api, task, video, label_class):
    """Разметка видео закрыта теми же правами, что и всё остальное."""
    import requests
    from conftest import tag

    other = requests.Session()
    login = tag()
    other.post(f"{BASE_URL}/api/auth/register", json={
        "email": f"{login}@example.test", "login": login,
        "display_name": "Посторонний", "password": "Test-Passw0rd",
    })
    res = other.get(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/annotations")
    assert res.status_code in (401, 403, 404)
