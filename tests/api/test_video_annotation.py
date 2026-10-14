"""Разметка видео целиком: загрузка, треки, сдача таски, кадры в датасете.

Проверяется живой бэкенд — тот же, что открыт в браузере. Поэтому тесты
говорят про наблюдаемое поведение (что вернул API, что появилось в таске),
а не про внутренности.

Главное правило механизма (решение 14.10.2026): разметка ролика становится
кадрами датасета при сдаче таски. Кадр «ролик + номер» один на все сдачи и
обновляется на месте; правленый в датасете сдача не трогает.
"""
from conftest import BASE_URL, hand_over, wait_clip


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


def test_уменьшенный_кадр_для_карточки_разведки(api, task, video):
    """`w` — ширина для карточки при наведении; меньше исходной — ужимается,
    пропорции те же."""
    from io import BytesIO
    from PIL import Image
    url = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frame"
    full = Image.open(BytesIO(api.get(url, params={"n": 5}).content))
    res = api.get(url, params={"n": 5, "w": 32})
    assert res.status_code == 200 and res.headers["Content-Type"] == "image/jpeg"
    small = Image.open(BytesIO(res.content))
    assert small.width == 32
    assert abs(small.height - round(full.height * 32 / full.width)) <= 1


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


def test_каркас_и_куски_одиночных(api, task, video, label_class):
    """Редактор берёт каркас без фигур и сводку по кадрам, фигуры — кусками [from, to)."""
    base = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}"
    ci = label_class["class_index"]
    box = {"class_index": ci, "x": 5, "y": 5, "w": 20, "h": 20}
    for f, n in ((3, 2), (9, 1), (20, 3)):
        assert api.put(f"{base}/frames/{f}/boxes", json={"boxes": [box] * n}).status_code == 200
    make_track(api, task, video, label_class, frame_no=5)

    skel = api.get(f"{base}/annotations?singles=0").json()
    assert "singles" not in skel and len(skel["tracks"]) == 1
    # Ключ трека в сводку одиночных не попадает
    assert skel["marks"] == [[3, 2, 0, []], [9, 1, 0, []], [20, 3, 0, []]]

    part = api.get(f"{base}/annotations/singles?from=4&to=21").json()
    assert sorted({s["frame_no"] for s in part["singles"]}) == [9, 20]
    assert len(part["singles"]) == 4 and all(s["shape"] for s in part["singles"])
    assert api.get(f"{base}/annotations/singles?from=x&to=5").status_code == 400


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


# --- сдача таски: кадры ролика --------------------------------------------- #
def move(api, task, status, expect=200):
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/status", json={"status": status})
    assert res.status_code == expect, res.text
    return res


def video_images(db, video):
    """{номер кадра: (id, в датасете, рамок)} — кадры ролика в базе."""
    with db.cursor() as cur:
        cur.execute(
            "SELECT i.source_frame_no, i.id::text, i.dataset_id IS NOT NULL,"
            " (SELECT count(*) FROM annotations a WHERE a.image_id = i.id)"
            " FROM images i WHERE i.source_video_id = %s", (video["id"],))
        return {f: (iid, ds, n) for f, iid, ds, n in cur.fetchall()}


def three_frames(api, task, video, label_class):
    """Трек с ключами на 0 и 20, шаг 10: при сдаче уйдут кадры 0, 10 и 20."""
    track = make_track(api, task, video, label_class)
    api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20",
            json={"geometry": {"x": 170, "y": 90, "w": 60, "h": 60}})
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 10})
    return track


def test_сдача_делает_кадры_ролика_в_датасете(api, task, video, label_class, db):
    three_frames(api, task, video, label_class)
    job = hand_over(api, task["id"])
    assert (job["result"]["created"], job["result"]["accepted"]) == (3, 3)

    body = api.get(f"{BASE_URL}/api/tasks/{task['id']}").json()
    assert body["status"] == "done" and body["handover"] is None
    assert body["videos"][0]["accepted"] == 3
    # Во вкладку «Кадры» кадры ролика не входят: в таске они правятся только в ролике.
    counts = api.get(f"{BASE_URL}/api/tasks/{task['id']}/counts").json()["counts"]
    assert (counts["total"], counts["accepted"], counts["video_accepted"]) == (0, 0, 3)
    assert api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"] == []
    frames = video_images(db, video)
    assert sorted(frames) == [0, 10, 20]
    assert all(ds and n == 1 for _, ds, n in frames.values())


def test_сдача_без_роликов_идёт_сразу(api, task):
    assert "job_id" not in move(api, task, "done").json()


def test_ролик_без_разметки_сдаче_не_мешает(api, task, video):
    assert hand_over(api, task["id"])["result"]["created"] == 0


def test_сломанный_объект_держит_сдачу(api, task, video, label_class, db):
    """План не считается — кадров не будет: отказ до начала, с именем ролика."""
    track = make_track(api, task, video, label_class)
    with db.cursor() as cur:  # трек на 20 000 кадров с шагом 1 — больше потолка выгрузки
        cur.execute("UPDATE task_videos SET frame_count = 20000 WHERE id = %s", (video["id"],))
        cur.execute("UPDATE video_tracks SET end_frame = 19999 WHERE id = %s", (track["id"],))
    res = move(api, task, "done", expect=409)
    assert res.json()["code"] == "video_plan"
    assert "sample-30f.mp4" in res.json()["error"]
    assert api.get(f"{BASE_URL}/api/tasks/{task['id']}").json()["status"] == "in_progress"


def test_повторная_сдача_обновляет_кадры_на_месте(api, task, video, label_class, db):
    """Кадр «ролик + номер» один на все сдачи: id и сплит остаются, рамки — из ролика."""
    track = three_frames(api, task, video, label_class)
    hand_over(api, task["id"])
    before = video_images(db, video)
    with db.cursor() as cur:
        cur.execute("UPDATE images SET split = 'val' WHERE id = %s", (before[20][0],))
        cur.execute("SELECT geometry::text FROM annotations WHERE image_id = %s", (before[20][0],))
        was = cur.fetchone()[0]

    move(api, task, "updating")
    api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/20",
            json={"geometry": {"x": 100, "y": 100, "w": 50, "h": 50}})
    job = hand_over(api, task["id"])
    assert (job["result"]["created"], job["result"]["updated"]) == (0, 3)

    after = video_images(db, video)
    assert {f: v[0] for f, v in after.items()} == {f: v[0] for f, v in before.items()}, "id кадров сменились"
    with db.cursor() as cur:
        cur.execute("SELECT geometry::text FROM annotations WHERE image_id = %s", (after[20][0],))
        assert cur.fetchone()[0] != was, "правка ролика не дошла до кадра"
        cur.execute("SELECT split FROM images WHERE id = %s", (after[20][0],))
        assert cur.fetchone()[0] == "val"


def test_выпавший_из_разметки_кадр_уходит_из_датасета(api, task, video, label_class, db):
    track = three_frames(api, task, video, label_class)
    hand_over(api, task["id"])
    move(api, task, "updating")
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 20})
    assert hand_over(api, task["id"])["result"]["removed"] == 1
    assert sorted(video_images(db, video)) == [0, 20]


def test_правленый_в_датасете_кадр_сдача_не_трогает(api, task, video, label_class, db):
    """Чужая работа в датасете молча не затирается: ни рамки, ни сам кадр."""
    track = three_frames(api, task, video, label_class)
    hand_over(api, task["id"])
    frames = video_images(db, video)
    ci = label_class["class_index"]
    # Принятый кадр правит любой редактор с экрана датасета — таска ему не указ.
    res = api.put(f"{BASE_URL}/api/images/{frames[10][0]}/annotations", json={"boxes": [
        {"class_index": ci, "x": 5, "y": 5, "w": 30, "h": 30},
        {"class_index": ci, "x": 90, "y": 20, "w": 40, "h": 40},
    ]})
    assert res.status_code == 200, res.text

    move(api, task, "updating")
    # Кадр 10 выпадает из плана, но его правили — остаётся как есть.
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 20})
    job = hand_over(api, task["id"])
    assert (job["result"]["kept_edited"], job["result"]["removed"]) == (1, 0)
    assert video_images(db, video)[10] == (frames[10][0], True, 2), "правку в датасете затёрла сдача"


def test_перенос_класса_правкой_не_считается(api, project, task, video, label_class, db):
    """Перенос класса меняет и ролик, и кадр одинаково: сдача кадр обновляет как раньше."""
    three_frames(api, task, video, label_class)
    hand_over(api, task["id"])
    res = api.post(f"{BASE_URL}/api/projects/{project['code']}/classes", json={"name": "test-цель"})
    assert res.status_code in (200, 201), res.text
    res = api.post(f"{BASE_URL}/api/projects/{project['code']}/classes/{label_class['id']}/move",
                   json={"target_id": res.json()["id"]})
    assert res.status_code == 200, res.text
    move(api, task, "updating")
    job = hand_over(api, task["id"])
    assert (job["result"]["kept_edited"], job["result"]["updated"]) == (0, 3)


def test_возврат_к_разметке_убирает_черновики_ролика(api, task, video, label_class, db):
    """Непроверенное агента в датасет не идёт и ждёт черновиком; к разметке — уходит, рамка в ролике."""
    base = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}"
    box = {"x": 10, "y": 10, "w": 40, "h": 40}
    res = api.put(f"{base}/frames/5/boxes", json={"boxes": [{"class_index": label_class["class_index"], **box}]})
    assert res.status_code == 200, res.text
    with db.cursor() as cur:  # будто рамку поставил агент и её никто не проверил
        cur.execute("UPDATE video_annotations SET pending = true, source = 'model'"
                    " WHERE video_id = %s AND frame_no = 5", (video["id"],))

    job = hand_over(api, task["id"])
    assert (job["result"]["created"], job["result"]["unchecked"], job["result"]["accepted"]) == (1, 1, 0)
    assert video_images(db, video)[5][1] is False

    move(api, task, "updating")
    assert video_images(db, video) == {}
    with db.cursor() as cur:
        cur.execute("SELECT count(*) FROM video_annotations WHERE video_id = %s", (video["id"],))
        assert cur.fetchone()[0] == 1


def test_сводка_ролика_до_сдачи(api, task, video, label_class):
    track = make_track(api, task, video, label_class)
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 10})

    pending = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/pending"
    row = api.get(pending).json()["pending"]
    assert (row["file_name"], row["frames"], row["tracks"]) == ("sample-30f.mp4", 1, 1)
    # Доска считает то же число одним полем
    summary = f"{BASE_URL}/api/tasks/{task['id']}/summary"
    assert api.get(summary).json()["pending_frames"] == 1

    hand_over(api, task["id"])
    assert api.get(pending).json()["pending"] is None
    assert api.get(summary).json()["pending_frames"] == 0


def test_сданная_таска_ролик_не_правит(api, task, video, label_class):
    """После «Готово» ролик только для просмотра; вернули к разметке — снова правится."""
    track = make_track(api, task, video, label_class)
    api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 30})
    hand_over(api, task["id"])
    base = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}"
    ann = api.get(f"{base}/annotations").json()
    assert ann["editable"] is False

    box = {"x": 10, "y": 10, "w": 40, "h": 40}
    ci = label_class["class_index"]
    writes = [
        api.post(f"{base}/tracks", json={"class_index": ci, "frame_no": 3, "geometry": box}),
        api.put(f"{BASE_URL}/api/video-tracks/{track['id']}/keys/5", json={"geometry": box}),
        api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 2}),
        api.delete(f"{BASE_URL}/api/video-tracks/{track['id']}"),
        api.put(f"{base}/frames/4/boxes", json={"boxes": [{"class_index": ci, **box}]}),
        api.put(f"{base}/empty-frames/20"),
    ]
    assert [r.status_code for r in writes] == [409] * len(writes), [r.text for r in writes]

    move(api, task, "updating")
    assert api.get(f"{base}/annotations").json()["editable"] is True
    res = api.patch(f"{BASE_URL}/api/video-tracks/{track['id']}", json={"export_step": 2})
    assert res.status_code == 200, res.text


def test_закрытие_из_работы_сдаёт_ролик_и_уносит_его(api, task, video, label_class):
    three_frames(api, task, video, label_class)
    job = hand_over(api, task["id"], "closed")
    assert (job["result"]["accepted"], job["result"]["removed_videos"]) == (3, 1)
    body = api.get(f"{BASE_URL}/api/tasks/{task['id']}").json()
    assert body["status"] == "closed" and body["videos"] == []
    # Ролика больше нет — его кадры теперь просто кадры датасета.
    counts = api.get(f"{BASE_URL}/api/tasks/{task['id']}/counts").json()["counts"]
    assert counts["accepted"] + counts["video_accepted"] == 3


def test_закрытие_после_готово_уносит_ролик_сразу(api, task, video, label_class):
    three_frames(api, task, video, label_class)
    hand_over(api, task["id"])
    res = move(api, task, "closed")
    assert res.json()["removed_videos"] == 1
    counts = api.get(f"{BASE_URL}/api/tasks/{task['id']}/counts").json()["counts"]
    assert counts["accepted"] + counts["video_accepted"] == 3


# --- границы --------------------------------------------------------------- #
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
