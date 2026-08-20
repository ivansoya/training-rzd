"""Фикстуры для тестов против живого бэкенда.

Тесты ходят в тот же стек, что открыт у разработчика в браузере, — через тот
же nginx и с той же базой. Значит, они обязаны за собой убирать: всё, что
создаётся, помечено префиксом `test-`, а в конце прогона стирается каскадом.

Подтверждение почты делается напрямую в базе. Ходить за письмом в Mailpit
можно, но это добавило бы к каждому прогону зависимость от почтовика ради
одного поля.
"""
import os
import time
import uuid

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


def _wipe(conn):
    with conn.cursor() as cur:
        # Проекты уходят каскадом вместе с датасетами, тасками и разметкой.
        cur.execute("DELETE FROM projects WHERE name LIKE %s", (PREFIX + "%",))
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


def clip_url(task_id, video_id):
    return f"{BASE_URL}/api/tasks/{task_id}/videos/{video_id}"


def wait_clip(api, task_id, video_id, quality=None, chunks=True, timeout=300):
    """Ждём, пока ролик станет пригоден для разметки.

    Готовность спрашивается у самого ролика, а не у номера задачи: подготовка
    теперь не одна работа, а несколько (таблица кадров, копия ступени,
    перегоны), и снаружи важно ровно одно — можно ли уже размечать.
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
            if not chunks or last["state"]["chunks"] == "ready":
                return last
            if last["state"]["chunks"] == "error":
                raise AssertionError(f"Перегоны не нарезались: {last['state']}")
        time.sleep(0.5)
    raise AssertionError(f"Ролик не подготовился за {timeout} с: {last}")


def jobs_of(db, video_id, kind=None, chunk_no=None, statuses=None):
    """Задачи очереди по этому ролику — тестам нужна не только выдача API,
    но и то, сколько работы она за собой завела."""
    sql = "SELECT kind, quality, chunk_no, status, attempts, error FROM video_jobs WHERE video_id = %s"
    args = [video_id]
    if kind is not None:
        sql += " AND kind = %s"
        args.append(kind)
    if chunk_no is not None:
        sql += " AND chunk_no = %s"
        args.append(chunk_no)
    if statuses is not None:
        sql += " AND status = ANY(%s)"
        args.append(list(statuses))
    with db.cursor() as cur:
        cur.execute(sql, args)
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def assets_of(db, video_id):
    """Ступени качества ролика: пути к копиям и готовность перегонов."""
    with db.cursor() as cur:
        cur.execute(
            "SELECT quality, file_status, file_path, width, height,"
            " chunks_status, chunks_ready, chunks_total, error"
            " FROM video_assets WHERE video_id = %s ORDER BY quality",
            (video_id,),
        )
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


__all__ = [
    "BASE_URL", "wait_job", "wait_clip", "clip_url", "jobs_of", "assets_of", "tag",
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
