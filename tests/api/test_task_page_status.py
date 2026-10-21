"""Страница таски 21.10.2026: «Продолжить» у остановленного и упавшего прогона, «размечает Имя» на ролике.

Прогон кладётся прямо в базу: проверяется ручка, а не агент. Присутствие нигде не хранится —
проверяется само живое событие, которое слушает страница таски.
"""
import json
import select
import time

import psycopg2
import pytest

from conftest import BASE_URL, DB_DSN
from test_project_admin import join, person


def run_row(db, task, status, created_by, **stats):
    with db.cursor() as cur:
        cur.execute(
            """INSERT INTO agent_runs (id, project_id, task_id, params, status, stats, processed, total,
                                       error, created_by, created_at, finished_at)
               SELECT gen_random_uuid(), project_id, id, %s, %s, %s, 5, 10, %s,
                      (SELECT id FROM users WHERE login = %s), now(), now()
               FROM tasks WHERE id = %s RETURNING id""",
            (json.dumps({"mode": "annotate", "videos": []}), status, json.dumps(stats),
             "упал" if status == "error" else None, created_by, task["id"]))
        return str(cur.fetchone()[0])


def resume(session, run_id):
    return session.post(f"{BASE_URL}/api/agents/runs/{run_id}/resume")


def test_продолжить_тот_же_прогон_с_места(api, db, project, task):
    busy = run_row(db, task, "running", api.login_name)
    stopped = run_row(db, task, "error", api.login_name, cursor=[0, 120], retries=1)
    try:
        res = resume(api, stopped)
        assert res.status_code == 409 and "уже идёт" in res.json()["error"]
        with db.cursor() as cur:
            cur.execute("DELETE FROM agent_runs WHERE id = %s", (busy,))

        other = person(db)
        join(api, other, project["code"], "editor")
        assert resume(other, stopped).status_code == 403

        res = resume(api, stopped)
        assert res.status_code == 202, res.text
        got = res.json()
        assert got["status"] == "queued" and got["error"] is None and got["finished_at"] is None
        assert got["processed"] == 5 and got["stats"]["cursor"] == [0, 120] and "retries" not in got["stats"]
    finally:
        with db.cursor() as cur:
            cur.execute("DELETE FROM agent_runs WHERE id IN (%s, %s)", (busy, stopped))


@pytest.fixture
def listener():
    conn = psycopg2.connect(DB_DSN)
    conn.autocommit = True
    conn.cursor().execute("LISTEN mag_events")
    yield conn
    conn.close()


def heard(conn, video_id, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        select.select([conn], [], [], 0.5)
        conn.poll()
        while conn.notifies:
            body = json.loads(conn.notifies.pop(0).payload)
            if body["k"] == "here" and body["id"] == video_id:
                return body
    raise AssertionError("события «here» нет")


def test_присутствие_в_ролике_идёт_событием(api, db, project, task, video, listener):
    url = f"{BASE_URL}/api/tasks/{task['id']}/videos/{video['id']}/here"
    assert api.post(url).status_code == 204
    on = heard(listener, video["id"])
    with db.cursor() as cur:
        cur.execute("SELECT (SELECT id FROM projects WHERE code = %s), (SELECT id FROM users WHERE login = %s)",
                    (project["code"], api.login_name))
        pid, uid = map(str, cur.fetchone())
    assert on["p"] == pid and on["u"] == uid and "s" not in on

    assert api.post(url + "?off=1").status_code == 204
    assert heard(listener, video["id"])["s"] == "off"

    # Смотреть может, размечать — нет: и «размечает» про него не скажут
    viewer = person(db)
    join(api, viewer, project["code"], "viewer")
    assert viewer.post(url).status_code == 403
