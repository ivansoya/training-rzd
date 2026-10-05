"""Экран «Прогоны»: номер в проекте, сводка для истории, прошлый на том же наборе, продолжение."""
import json
import os
import uuid

from conftest import BASE_URL, DATA_DIR, tag
from test_project_admin import join, person


def _pid(db, code):
    with db.cursor() as cur:
        cur.execute("SELECT id FROM projects WHERE code = %s", (code,))
        return cur.fetchone()[0]


def _set(db, pid, name=None):
    sid = uuid.uuid4()
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO train_sets (id, project_id, name, kind, status, spec, split_mode, val_ratio, seed,"
            " counts, created_at) VALUES (%s, %s, %s, 'bbox', 'ready', '{}', 'random', 0.2, 1, %s, now())",
            (str(sid), str(pid), name or tag(), json.dumps({"samples": 10, "train": 8, "val": 2})),
        )
    return str(sid)


def _run(db, pid, sid, number, status, epochs=5, age_min=0, current=0, rows=()):
    """Прогон прямо в базу; rows — (эпоха, mAP50, mAP50-95, секунд)."""
    rid = str(uuid.uuid4())
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO train_runs (id, project_id, set_id, number, name, base_model, task, params, device, status,"
            " epochs, current_epoch, created_at, queued_at)"
            " VALUES (%s, %s, %s, %s, %s, 'yolo11n', 'detect', %s, '0', %s, %s, %s,"
            " now() - make_interval(mins => %s), now() - make_interval(mins => %s))",
            (rid, str(pid), sid, number, f"прогон {number}", json.dumps({"imgsz": 640, "epochs": epochs}),
             status, epochs, current, age_min, age_min),
        )
        for epoch, m50, m95, secs in rows:
            cur.execute(
                "INSERT INTO train_epochs (run_id, epoch, metrics, seconds, created_at) VALUES (%s, %s, %s, %s, now())",
                (rid, epoch, json.dumps({"metrics/mAP50(B)": m50, "metrics/mAP50-95(B)": m95}), secs),
            )
    return rid


def test_номер_прогона_не_сдвигается_после_удаления(api, db, project):
    code = project["code"]
    pid = _pid(db, code)
    sid = _set(db, pid)
    url = f"{BASE_URL}/api/projects/{code}/runs"
    got = []
    for _ in range(2):
        res = api.post(url, json={"set_id": sid, "model": "yolo11n", "params": {"epochs": 1}})
        assert res.status_code == 202, res.text
        got.append(res.json())
        # Учить не на чем — снимаем сразу, чтобы воркер не тратил на это время
        api.post(f"{url}/{res.json()['id']}/stop")
    assert [r["number"] for r in got] == [1, 2]
    assert api.get(f"{url}/2").json()["id"] == got[1]["id"]
    assert api.delete(f"{url}/1").status_code == 200
    res = api.post(url, json={"set_id": sid, "model": "yolo11n", "params": {"epochs": 1}})
    assert res.json()["number"] == 3
    api.post(f"{url}/{res.json()['id']}/stop")
    assert api.get(f"{url}/99").status_code == 404


def test_история_и_разница_к_прошлому_на_том_же_наборе(api, db, project):
    code = project["code"]
    pid = _pid(db, code)
    sid, other = _set(db, pid), _set(db, pid)
    first = _run(db, pid, sid, 1, "done", age_min=30, rows=[(1, 0.4, 0.2, 60), (2, 0.6, 0.3, 50)])
    _run(db, pid, other, 2, "done", age_min=20, rows=[(1, 0.9, 0.7, 10)])
    cur = _run(db, pid, sid, 3, "done", age_min=10, rows=[(1, 0.5, 0.25, 40), (2, 0.7, 0.4, 45)])

    runs = {r["id"]: r for r in api.get(f"{BASE_URL}/api/projects/{code}/runs").json()["runs"]}
    row = runs[first]
    assert row["number"] == 1 and row["imgsz"] == 640
    assert row["best_metrics"]["metrics/mAP50(B)"] == 0.6
    assert row["spark"] == [0.4, 0.6]
    assert row["train_seconds"] == 110
    assert row["set"]["graphs"] == []

    got = api.get(f"{BASE_URL}/api/projects/{code}/runs/3").json()
    # Прошлый — на том же наборе, а не просто предыдущий по номеру
    assert got["previous"]["number"] == 1
    assert got["previous"]["best_metrics"]["metrics/mAP50-95(B)"] == 0.3
    assert got["id"] == cur
    assert api.get(f"{BASE_URL}/api/projects/{code}/runs/1").json()["previous"] is None


def test_продолжение_с_last_pt_в_конец_очереди(api, db, project):
    code = project["code"]
    pid = _pid(db, code)
    sid = _set(db, pid)
    rid = _run(db, pid, sid, 1, "stopped", epochs=5, age_min=60, current=3,
               rows=[(1, 0.3, 0.1, 30), (2, 0.4, 0.2, 30)])
    url = f"{BASE_URL}/api/projects/{code}/runs/{rid}"

    # Без last.pt продолжать не с чего
    assert api.get(url).json()["resumable"] is False
    assert api.post(f"{url}/resume").status_code == 409

    weights = os.path.join(DATA_DIR, "projects", str(pid), "runs", rid, "train", "weights")
    os.makedirs(weights, exist_ok=True)
    with open(os.path.join(weights, "last.pt"), "wb") as fh:
        fh.write(b"\0")
    assert api.get(url).json()["resumable"] is True

    viewer = person(db)
    join(api, viewer, code, "viewer")
    assert viewer.post(f"{url}/resume").status_code == 403

    res = api.post(f"{url}/resume")
    assert res.status_code == 202, res.text
    body = res.json()
    assert body["status"] == "queued" and body["number"] == 1
    # В очередь — по времени постановки, а не по дате создания часовой давности
    assert body["queued_at"] > body["created_at"]
    api.post(f"{url}/stop")


def test_всё_пройдено_и_удалённый_набор_не_продолжаются(api, db, project):
    code = project["code"]
    pid = _pid(db, code)
    sid = _set(db, pid)
    full = _run(db, pid, sid, 1, "error", epochs=2, current=2, rows=[(1, 0.3, 0.1, 30), (2, 0.4, 0.2, 30)])
    gone = _run(db, pid, None, 2, "stopped", epochs=5, current=2, rows=[(1, 0.3, 0.1, 30)])
    for rid in (full, gone):
        weights = os.path.join(DATA_DIR, "projects", str(pid), "runs", rid, "train", "weights")
        os.makedirs(weights, exist_ok=True)
        open(os.path.join(weights, "last.pt"), "wb").close()
        res = api.post(f"{BASE_URL}/api/projects/{code}/runs/{rid}/resume")
        assert res.status_code == 409, res.text
