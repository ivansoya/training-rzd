"""Одна нумерация кадров ролика: нарезка, прикидка и проверка номеров."""
from conftest import BASE_URL, wait_job


def _cut_video(api, task, sample_video):
    with open(sample_video, "rb") as fh:
        res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/videos",
                       files={"file": ("sample-30f.mp4", fh, "video/mp4")},
                       data={"mode": "cut"})
    assert res.status_code in (200, 201), res.text
    return res.json()


def _frames(api, task, video_id):
    rows = api.get(f"{BASE_URL}/api/tasks/{task['id']}/images").json()["images"]
    return [r for r in rows if r.get("source_video_id") == video_id]


def test_шаг_меньше_кадра_не_плодит_дублей(api, task, sample_video):
    video = _cut_video(api, task, sample_video)
    url = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}"
    # 10 к/с, шаг 50 мс: два момента на кадр. Кадров — десять, а не двадцать.
    plan = {"segments": [{"start_ms": 0, "end_ms": 1000, "step_ms": 50}]}
    est = api.post(f"{url}/estimate", json=plan).json()
    assert est["frames"] == 10, est
    for _ in range(2):
        res = api.post(f"{url}/cut", json=plan)
        if res.status_code == 400:      # второй раз: «Плану нечего менять»
            break
        assert wait_job(api, res.json()["job_id"])["status"] == "done"
    assert len(_frames(api, task, video["id"])) == 10
    again = api.post(f"{url}/estimate", json=plan).json()
    assert again["add"] == 0, again


def test_момент_за_концом_ролика_не_обещается(api, task, sample_video):
    video = _cut_video(api, task, sample_video)
    url = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}"
    est = api.post(f"{url}/estimate",
                   json={"segments": [{"start_ms": 2900, "end_ms": 5000, "step_ms": 100}]}).json()
    assert est["frames"] == 1, est


def test_кадр_за_концом_ролика_это_400(api, task, video):
    url = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/frame"
    assert api.get(url, params={"n": 30}).status_code == 400
    assert api.get(url, params={"n": -1}).status_code == 400


def test_три_закрытия_разом_дают_одну_работу(api, task, video, label_class):
    import threading

    url = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}"
    res = api.post(f"{url}/tracks", json={
        "class_index": label_class["class_index"], "frame_no": 0,
        "geometry": {"x": 10, "y": 10, "w": 40, "h": 40}})
    assert res.status_code in (200, 201), res.text
    codes = []
    threads = [threading.Thread(target=lambda: codes.append(
        api.post(f"{url}/close-annotation").status_code)) for _ in range(3)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(codes).count(202) == 1, codes


def test_закрытая_таска_не_принимает_ролик(api, task, sample_video):
    _cut_video(api, task, sample_video)
    assert api.post(f"{BASE_URL}/api/tasks/{task['id']}/status",
                    json={"status": "closed"}).status_code == 200
    with open(sample_video, "rb") as fh:
        res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/videos",
                       files={"file": ("again.mp4", fh, "video/mp4")}, data={"mode": "cut"})
    assert res.status_code == 409


def _strip(api, task, video_id, timeout=60):
    import time

    url = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video_id}/strip"
    deadline = time.time() + timeout
    while time.time() < deadline:
        res = api.get(url)
        if res.status_code != 202:
            return res
        time.sleep(1)
    return res


def test_лента_склеивается(api, task, sample_video):
    video = _cut_video(api, task, sample_video)
    res = _strip(api, task, video["id"])
    assert res.status_code == 200 and res.headers["Content-Type"] == "image/jpeg", res.text[:200]


def test_битый_ролик_даёт_отказ_а_не_вечное_ожидание(api, task):
    junk = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 4096
    res = api.post(f"{BASE_URL}/api/tasks/{task['id']}/videos",
                   files={"file": ("broken.mp4", junk, "video/mp4")}, data={"mode": "cut"})
    if res.status_code != 201:
        return  # сервер не принял файл вовсе — тоже честный отказ
    res = _strip(api, task, res.json()["id"], timeout=120)
    assert res.status_code in (404, 409), res.status_code
