"""Фикстуры для тестов против живого бэкенда.

Тесты ходят в тот же стек, что открыт у разработчика в браузере, — через тот
же nginx и с той же базой. Значит, они обязаны за собой убирать: всё, что
создаётся, помечено префиксом `test-`, а в конце прогона стирается каскадом.

Подтверждение почты делается напрямую в базе. Ходить за письмом в Mailpit
можно, но это добавило бы к каждому прогону зависимость от почтовика ради
одного поля.
"""
import base64
import os
import shutil
import time
import uuid

import av
import psycopg2
import pytest
import requests

import sample

BASE_URL = os.environ.get("TEST_BASE_URL", "http://frontend")
DB_DSN = os.environ.get(
    "TEST_DB_DSN", "postgresql://app:app@db:5432/app"
)
# По этой метке уборка находит своё и не трогает чужое.
PREFIX = "test-"
DATA_DIR = os.environ.get("DATA_DIR", "/app/data")


@pytest.fixture(scope="session")
def db():
    conn = psycopg2.connect(DB_DSN)
    conn.autocommit = True
    yield conn
    conn.close()


@pytest.fixture(scope="session", autouse=True)
def cleanup(db):
    """Прибираемся до и после: упавший прошлый прогон не должен мешать этому."""
    _wipe(db)
    yield
    _wipe(db)


def drop_project(conn, code):
    """Удалить проект мимо ручки — со строками и папкой на томе.

    Ручка отказывает, пока в проекте идёт работа, а тестам надо прибраться и
    посреди прогона агента или разбора ролика. Раньше такие тесты стирали одну
    строку, и папки с роликами копились на томе."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM projects WHERE code = %s RETURNING id", (code,))
        for (pid,) in cur.fetchall():
            shutil.rmtree(os.path.join(DATA_DIR, "projects", str(pid)), ignore_errors=True)


def _wipe(conn):
    with conn.cursor() as cur:
        # Проекты уходят каскадом вместе с датасетами, тасками и разметкой.
        # Файлы каскадом не уходят: их папки стираем следом, иначе они копились
        # на томе сотнями. Том смонтирован в контейнер тестов (compose).
        cur.execute("DELETE FROM projects WHERE name LIKE %s RETURNING id", (PREFIX + "%",))
        for (pid,) in cur.fetchall():
            shutil.rmtree(os.path.join(DATA_DIR, "projects", str(pid)), ignore_errors=True)
        cur.execute("DELETE FROM users WHERE login LIKE %s", (PREFIX + "%",))


def tag() -> str:
    return PREFIX + uuid.uuid4().hex[:8]


@pytest.fixture
def api(db):
    """Сессия с выполненным входом: почти каждому тесту нужен свой человек."""
    login = tag()
    session = requests.Session()
    session.base = BASE_URL

    res = session.post(f"{BASE_URL}/api/auth/register", json={
        "email": f"{login}@example.test",
        "login": login,
        "display_name": "Тестовый разметчик",
        "password": "Test-Passw0rd",
    })
    assert res.status_code in (200, 201), res.text

    with db.cursor() as cur:
        cur.execute(
            "UPDATE users SET email_confirmed_at = now() WHERE login = %s", (login,)
        )

    res = session.post(f"{BASE_URL}/api/auth/login", json={
        "identity": login, "password": "Test-Passw0rd",
    })
    assert res.status_code == 200, res.text
    session.login_name = login
    return session


@pytest.fixture
def project(api):
    res = api.post(f"{BASE_URL}/api/projects", json={
        "name": tag(), "description": "Проверка разметки видео",
    })
    assert res.status_code in (200, 201), res.text
    return res.json()


@pytest.fixture
def label_class(api, project):
    res = api.post(f"{BASE_URL}/api/projects/{project['code']}/classes",
                   json={"name": "вагон"})
    assert res.status_code in (200, 201), res.text
    return res.json()


@pytest.fixture
def task(api, project):
    res = api.post(f"{BASE_URL}/api/projects/{project['code']}/tasks",
                   json={"name": tag()})
    assert res.status_code in (200, 201), res.text
    body = res.json()
    # Разметка идёт только в таске, взятой в работу.
    api.post(f"{BASE_URL}/api/tasks/{body['id']}/status", json={"status": "in_progress"})
    return body


@pytest.fixture(scope="session")
def sample_video():
    """Ролик, общий со сквозными тестами: 3 секунды, 10 к/с, 30 кадров."""
    return sample.ensure()


@pytest.fixture
def video(api, task, sample_video):
    """Ролик, загруженный в режиме разметки."""
    with open(sample_video, "rb") as fh:
        res = api.post(
            f"{BASE_URL}/api/tasks/{task['id']}/videos",
            files={"file": ("sample-30f.mp4", fh, "video/mp4")},
            data={"mode": "annotate"},
        )
    assert res.status_code in (200, 201), res.text
    return res.json()


def wait_job(api, job_id, timeout=180):
    """Ждём фоновую задачу. Возвращает её итоговое состояние."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        res = api.get(f"{BASE_URL}/api/jobs/{job_id}")
        assert res.status_code == 200, res.text
        body = res.json()
        if body.get("status") in ("done", "error"):
            return body
        time.sleep(0.4)
    raise AssertionError(f"Задача {job_id} не завершилась за {timeout} с")


def hand_over(api, task_id, status="done", timeout=300):
    """Сдача таски с роликами идёт фоном (решение 14.10.2026): ждём её, возвращаем итог работы."""
    res = api.post(f"{BASE_URL}/api/tasks/{task_id}/status", json={"status": status})
    assert res.status_code == 202, res.text
    job = wait_job(api, res.json()["job_id"], timeout)
    assert job["status"] == "done", job.get("error")
    return job


def clip_url(task_id, video_id):
    return f"{BASE_URL}/api/tasks/{task_id}/videos/{video_id}"


def wait_clip(api, task_id, video_id, quality=None, ready=True, timeout=300):
    """Ждём, пока ролик станет пригоден для разметки.

    Готовность спрашивается у самого ролика: есть таблицы кадров и пакетов, и
    названная ступень (по умолчанию — та, с которой ролик откроют) готова.
    ``ready=False`` — хватит таблиц.
    """
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        res = api.get(clip_url(task_id, video_id) + "/clip",
                      params={"q": quality} if quality else None)
        assert res.status_code in (200, 202, 409), res.text
        last = res.json()
        if res.status_code == 409:
            raise AssertionError(f"Ролик подготовить не удалось: {last}")
        if res.status_code == 200:
            want = quality or last["quality"]
            item = next((q for q in last["qualities"] if q["id"] == want), None)
            if not ready or (item and item["ready"]):
                return last
            if item and item["failed"]:
                raise AssertionError(f"Ступень {want} не вышла: {item}")
        time.sleep(0.5)
    raise AssertionError(f"Ролик не подготовился за {timeout} с: {last}")


def get_table(api, task_id, video_id, quality, timeout=240):
    """Таблица пакетов ступени — как её берёт браузер: «202» значит «ещё готовится»."""
    deadline = time.time() + timeout
    while True:
        res = api.get(clip_url(task_id, video_id) + "/table", params={"q": quality})
        if res.status_code != 202:
            assert res.status_code == 200, res.text
            return res.json()
        assert time.time() < deadline, f"ступень {quality} не подготовилась: {res.text}"
        time.sleep(res.json().get("retry_after_ms", 700) / 1000)


def get_segment(api, task_id, video_id, table, n):
    """Отрезок по Range ровно по объявленным границам."""
    seg = table["segments"][n]
    res = api.get(clip_url(task_id, video_id) + "/source",
                  params={"q": table["quality"], "v": table["tag"]},
                  headers={"Range": f"bytes={seg['start']}-{seg['end']}"})
    assert res.status_code == 206, res.text
    assert len(res.content) == seg["end"] - seg["start"] + 1
    return res


def decode_segment(table, n, payload):
    """Разжать отрезок, как браузер: кадры вырезаются по таблице, декодер — по описанию потока."""
    seg = table["segments"][n]
    pos, at = [], 0
    for size, gap in zip(table["sizes"], table["gaps"]):
        at += gap
        pos.append(at)
        at += size
    ctx = av.CodecContext.create("hevc" if table["codec"].startswith(("hvc1", "hev1")) else "h264", "r")
    ctx.extradata = base64.b64decode(table["description"])
    out = []
    for i in range(seg["count"]):
        no = seg["first"] + i
        offset = pos[no] - seg["start"]
        out += [f.to_image() for f in ctx.decode(av.Packet(payload[offset:offset + table["sizes"][no]]))]
    out += [f.to_image() for f in ctx.decode(None)]
    return out


def jobs_of(db, video_id, kind=None, statuses=None):
    """Задачи очереди по этому ролику — тестам нужна не только выдача API,
    но и то, сколько работы она за собой завела."""
    sql = "SELECT kind, quality, status, attempts, error FROM video_jobs WHERE video_id = %s"
    args = [video_id]
    if kind is not None:
        sql += " AND kind = %s"
        args.append(kind)
    if statuses is not None:
        # Колонка — перечисление postgres, и сравнивать её с массивом текста
        # без приведения нельзя: «operator does not exist». Приводим явно.
        sql += " AND status = ANY(%s::video_job_status[])"
        args.append(list(statuses))
    with db.cursor() as cur:
        cur.execute(sql, args)
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def assets_of(db, video_id):
    """Ступени качества ролика: файлы и их размеры."""
    with db.cursor() as cur:
        cur.execute(
            "SELECT quality, file_status, file_path, width, height, size_bytes, error,"
            " frame_index IS NOT NULL AS has_table"
            " FROM video_assets WHERE video_id = %s ORDER BY quality",
            (video_id,),
        )
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


__all__ = [
    "BASE_URL", "wait_job", "hand_over", "wait_clip", "clip_url", "jobs_of", "assets_of", "tag",
    "get_table", "get_segment", "decode_segment",
]


def pytest_configure(config):
    """Без живого бэкенда тесты бессмысленны — говорим об этом сразу."""
    try:
        requests.get(f"{BASE_URL}/api/auth/me", timeout=5)
    except requests.RequestException as exc:
        raise pytest.UsageError(
            f"Бэкенд по адресу {BASE_URL} не отвечает: {exc}. "
            "Поднимите стек: docker compose up -d"
        )
