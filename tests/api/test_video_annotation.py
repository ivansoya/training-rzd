"""Разметка видео целиком: загрузка, треки, закрытие разметки, кадры в проекте.

Проверяется живой бэкенд — тот же, что открыт в браузере. Поэтому тесты
говорят про наблюдаемое поведение (что вернул API, что появилось в таске),
а не про внутренности.

Главное правило механизма: разметка ролика становится кадрами не при сдаче
таски, а когда её закрывают отдельным действием. Дальше эти кадры — обычные
кадры таски, и никто их не переписывает.
"""
from conftest import BASE_URL, wait_clip, wait_job


def test_видео_загружается_в_режиме_разметки(api, task, video):
    """Разбор ролика уехал в отдельный воркер и стал асинхронным.

    Сразу после загрузки сервис намеренно отвечает «готовлю»: число кадров
    ещё неизвестно. Ждать готовности — дело теста, а не повод возвращать
    выдуманное число из сервиса.
    """
    assert video["mode"] == "annotate"
    assert video["frame_count"] is None
    assert video.get("preparing") is True

    wait_clip(api, task["id"], video["id"])
    res = api.get(f"{BASE_URL}/api/tasks/{task['id']}")
    assert res.status_code == 200, res.text
    ready = next(
        v for v in res.json()["videos"] if v["id"] == video["id"]
    )
    assert ready["frame_count"] == 30
    assert ready["fps"] == 10.0


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


# --- кадры ----------------------------------------------------------------- #
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


def test_окно_кадров_греется_одним_проходом(api, task, video):
    """Подряд идущие кадры декодируются в разы дешевле одиночных — на этом
    держится быстрая перемотка."""
    url = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frames/prefetch"
    res = api.post(url, json={"from": 0, "to": 20})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ready"] == 21
    assert body["decoded"] >= 1

    # Повторный прогрев того же окна ничего не декодирует: всё уже на месте.
    again = api.post(url, json={"from": 0, "to": 20}).json()
    assert again["decoded"] == 0


def test_окно_подрезается_длиной_ролика(api, task, video):
    """Запрос за конец ролика — не ошибка: на краю таймлайна это обычное дело,
    и окно просто упирается в последний кадр."""
    res = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frames/prefetch",
        json={"from": 0, "to": 5000},
    )
    assert res.status_code == 200, res.text
    assert res.json()["ready"] == 30      # столько кадров в ролике и есть


def test_окно_наизнанку_ничего_не_делает(api, task, video):
    res = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frames/prefetch",
        json={"from": 20, "to": 5},
    )
    assert res.status_code == 200
    assert res.json() == {"ready": 0, "decoded": 0}


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
    assert track["hidden_ranges"] == []


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


def test_ключ_переносится_одной_операцией(api, task, video, label_class):
    """Удалить и поставить заново — две операции, между ними трек без ключа."""
    track = make_track(api, task, video, label_class)
    api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20",
            json={"geometry": {"x": 170, "y": 90, "w": 60, "h": 60}})
    res = api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20",
                    json={"to": 14})
    assert res.status_code == 200, res.text
    assert [k["frame_no"] for k in res.json()["keys"]] == [0, 14]


def test_перенос_на_занятый_кадр_отвергается(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20", json={})
    res = api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20", json={"to": 0})
    assert res.status_code == 409


def test_перенос_первого_ключа_двигает_начало(api, task, video, label_class):
    track = make_track(api, task, video, label_class, frame_no=5)
    api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20", json={})
    res = api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/5", json={"to": 12})
    assert res.json()["start_frame"] == 12


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


def test_отрезки_невидимости_склеиваются(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    res = api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}",
                    json={"hidden_ranges": [[12, 18], [4, 9], [7, 13]]})
    assert res.status_code == 200, res.text
    assert res.json()["hidden_ranges"] == [[4, 18]]


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


# --- предпросмотр ---------------------------------------------------------- #
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


def test_заслонённый_участок_в_план_не_идёт(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20",
            json={"geometry": {"x": 170, "y": 90, "w": 60, "h": 60}})
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}",
              json={"export_step": 5, "hidden_ranges": [[10, 20]]})

    body = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/materialize/preview",
        json={},
    ).json()
    # 10 и 15 заслонены, остаются 0, 5 и 20.
    assert body["frames"] == 3


# --- закрытие разметки ----------------------------------------------------- #
def close_annotation(api, task, video, expect=202):
    res = api.post(
        f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/close-annotation",
        json={},
    )
    assert res.status_code == expect, res.text
    return res


def test_закрытие_разметки_делает_кадры_таски(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20",
            json={"geometry": {"x": 170, "y": 90, "w": 60, "h": 60}})
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 10})

    job = wait_job(api, close_annotation(api, task, video).json()["job_id"])
    assert job["status"] == "done", job.get("error")
    assert job["result"]["created"] == 3          # кадры 0, 10, 20
    assert job["result"]["boxes"] == 3

    body = api.get(f"{BASE_URL}/api/tasks/{task['id']}").json()
    assert body["videos"][0]["annotation_closed_at"] is not None
    # Кадры уже в таске, но ещё не в проекте — это обычные кадры.
    assert body["counts"]["annotated"] == 3
    assert body["counts"]["accepted"] == 0

    images = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"]
    assert len(images) == 3
    assert all(i["annotations"] == 1 for i in images)
    assert sorted(i["source_time_ms"] for i in images) == [0, 1000, 2000]


def test_разметку_без_боксов_закрыть_нечем(api, task, video):
    close_annotation(api, task, video, expect=400)


def test_повторное_закрытие_требует_убрать_кадры(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 30})
    wait_job(api, close_annotation(api, task, video).json()["job_id"])

    api.post(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/reopen-annotation")
    res = close_annotation(api, task, video, expect=409)
    assert res.json()["code"] == "frames_exist"
    assert res.json()["frames"] == 1


def test_кадры_ролика_убираются_и_разметка_идёт_заново(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 30})
    wait_job(api, close_annotation(api, task, video).json()["job_id"])
    api.post(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/reopen-annotation")

    res = api.delete(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frames")
    assert res.status_code == 200, res.text
    assert res.json() == {"removed": 1, "kept_accepted": 0}

    # Кадров нет — закрывать снова можно.
    wait_job(api, close_annotation(api, task, video).json()["job_id"])
    assert len(api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"]) == 1


def test_принятые_кадры_уборка_не_трогает(api, task, video, label_class):
    """После сдачи кадры — данные проекта, а не черновик таски."""
    track = make_track(api, task, video, label_class)
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 30})
    wait_job(api, close_annotation(api, task, video).json()["job_id"])
    api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})
    api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "updating"})

    res = api.delete(f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frames")
    assert res.json() == {"removed": 0, "kept_accepted": 1}


def test_сдача_принимает_кадры_ролика_как_обычные(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20", json={})
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 10})
    wait_job(api, close_annotation(api, task, video).json()["job_id"])

    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})
    assert res.status_code == 200, res.text
    assert res.json()["accepted"] == 3
    assert api.get(f"{BASE_URL}/api/tasks/{task['id']}").json()["counts"]["accepted"] == 3


def test_правка_кадра_переживает_повторную_сдачу(api, task, video, label_class):
    """Кадр в таске — обычный кадр: план ролика его больше не переписывает."""
    track = make_track(api, task, video, label_class)
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 30})
    wait_job(api, close_annotation(api, task, video).json()["job_id"])

    image = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"][0]
    ci = label_class["class_index"]
    api.put(f"{BASE_URL}/api/images/{image['id']}/annotations", json={"boxes": [
        {"class_index": ci, "x": 5, "y": 5, "w": 30, "h": 30},
        {"class_index": ci, "x": 90, "y": 20, "w": 40, "h": 40},
    ]})

    api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})
    api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "updating"})
    api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})

    after = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"]
    assert len(after) == 1
    assert after[0]["annotations"] == 2, "правку руками переписал план ролика"


def test_незакрытые_ролики_видны_в_сводке(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 10})

    body = api.get(f"{BASE_URL}/api/tasks/{task['id']}").json()
    assert len(body["pending_videos"]) == 1
    assert body["pending_videos"][0]["file_name"] == "sample-30f.mp4"
    assert body["pending_videos"][0]["frames"] == 1
    assert body["pending_videos"][0]["tracks"] == 1

    wait_job(api, close_annotation(api, task, video).json()["job_id"])
    assert api.get(f"{BASE_URL}/api/tasks/{task['id']}").json()["pending_videos"] == []


# --- границы --------------------------------------------------------------- #
def test_закрытие_таски_уносит_видео_но_оставляет_принятые_кадры(
    api, task, video, label_class
):
    track = make_track(api, task, video, label_class)
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 30})
    wait_job(api, close_annotation(api, task, video).json()["job_id"])
    api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "done"})

    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": "closed"})
    assert res.status_code == 200, res.text
    assert res.json()["removed_videos"] == 1

    body = api.get(f"{BASE_URL}/api/tasks/{task['id']}").json()
    assert body["videos"] == []
    assert body["counts"]["accepted"] == 1


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
