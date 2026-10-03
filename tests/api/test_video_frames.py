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
