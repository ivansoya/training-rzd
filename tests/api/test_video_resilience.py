"""Как система ведёт себя, когда что-то идёт не так.

Все проверки здесь про одно: сбой в подготовке видео обязан стоить видео, а не
всего сервиса. Раньше было иначе. Нарезка жила потоками внутри gunicorn и
занимала его пул, поэтому пятеро на холодном ролике останавливали проект
целиком. Отказ ничем не запоминался, поэтому битый ролик заводил новую нарезку
на каждое движение разметчика по таймлайну — и добивал машину сам.

Отсюда три свойства, которые тут и проверяются: неготовое — это «202», а не
ошибка и не зависшее соединение; одна и та же работа не заводится дважды;
упавшая работа помнит, что упала.
"""
import concurrent.futures as futures
import time

import pytest
import sample
from conftest import BASE_URL, clip_url, jobs_of, wait_clip


@pytest.fixture(scope="session")
def tall_video_file():
    return sample.ensure_tall()


@pytest.fixture
def fresh(api, task, tall_video_file):
    """Только что загруженный ролик: подготовка ещё идёт."""
    with open(tall_video_file, "rb") as fh:
        res = api.post(
            f"{BASE_URL}/api/tasks/{task['id']}/videos",
            files={"file": ("sample-tall.mp4", fh, "video/mp4")},
            data={"mode": "annotate"},
        )
    assert res.status_code in (200, 201), res.text
    body = res.json()
    body["task_id"] = task["id"]
    return body


def ask_chunk(api, video, n, quality=None):
    return api.get(clip_url(video["task_id"], video["id"]) + f"/chunks/{n}",
                   params={"q": quality} if quality else None)


# --------------------------------------------------------------------------- #
# Неготовое — это не ошибка
# --------------------------------------------------------------------------- #
def test_ролик_на_подготовке_отвечает_202_а_не_ошибкой(api, fresh):
    """Пока таблицы кадров нет, показывать нечего — но и падать не с чего."""
    res = api.get(clip_url(fresh["task_id"], fresh["id"]) + "/clip")
    assert res.status_code in (200, 202), res.text
    if res.status_code == 202:
        body = res.json()
        assert body["status"] == "preparing"
        assert body["retry_after_ms"] > 0
        assert res.headers.get("Retry-After")


def test_неготовый_перегон_отвечает_202_и_говорит_когда_вернуться(api, fresh):
    """Держать соединение, пока идёт нарезка, значит занимать поток, нужный
    всем остальным. Клиенту говорят «готовится» и отпускают."""
    wait_clip(api, fresh["task_id"], fresh["id"], chunks=False)
    res = ask_chunk(api, fresh, 1, "480")
    assert res.status_code in (200, 202), res.text
    if res.status_code == 202:
        body = res.json()
        assert body["status"] == "preparing"
        assert body["quality"] == "480"
        assert body["retry_after_ms"] > 0


def test_ответ_приходит_быстро_даже_когда_ничего_не_готово(api, fresh):
    """Смысл всей переделки: запрос перегона больше не ждёт перекодирования.
    Секунда с запасом — это про сеть и базу, а не про кодировщик."""
    wait_clip(api, fresh["task_id"], fresh["id"], chunks=False)
    started = time.monotonic()
    res = ask_chunk(api, fresh, 1, "480")
    spent = time.monotonic() - started
    assert res.status_code in (200, 202)
    assert spent < 5.0, f"ответ шёл {spent:.1f} с — нарезка снова в запросе?"


# --------------------------------------------------------------------------- #
# Одна работа — один раз
# --------------------------------------------------------------------------- #
def test_толпа_за_одним_перегоном_заводит_одну_работу(api, db, fresh):
    """Шестнадцать разметчиков, открывших ролик разом, не должны запустить
    шестнадцать кодировщиков. Повтор отсекает база, а не проверка в коде:
    между проверкой и вставкой помещается второй такой же запрос."""
    wait_clip(api, fresh["task_id"], fresh["id"], chunks=False)
    with futures.ThreadPoolExecutor(max_workers=16) as pool:
        answers = list(pool.map(lambda _: ask_chunk(api, fresh, 1, "480"), range(16)))

    assert all(r.status_code in (200, 202) for r in answers), \
        [r.status_code for r in answers]
    rows = jobs_of(db, fresh["id"], kind="chunk", chunk_no=1)
    for_480 = [j for j in rows if j["quality"] == "480"]
    assert len(for_480) <= 1, f"на один перегон завели {len(for_480)} работ"


def test_за_концом_ролика_работа_не_заводится(api, db, fresh):
    """Ошибка в номере перегона не должна оборачиваться работой в очереди."""
    wait_clip(api, fresh["task_id"], fresh["id"], chunks=False)
    res = ask_chunk(api, fresh, 9999)
    assert res.status_code == 404
    assert jobs_of(db, fresh["id"], kind="chunk", chunk_no=9999) == []


# --------------------------------------------------------------------------- #
# Отказ помнится
# --------------------------------------------------------------------------- #
def _plant_failure(db, video_id, kind, quality="", chunk_no=-1, error="сломалось"):
    """Подкладываем в очередь упавшую работу.

    Сломать настоящий ролик так, чтобы он прошёл проверку на загрузке и упал
    в воркере, из теста нельзя. А проверить надо именно память об отказе —
    ровно она отличает «не смогли» от «долбим до последнего».
    """
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO video_jobs (id, video_id, kind, quality, chunk_no,"
            " priority, status, attempts, error, created_at, finished_at)"
            " VALUES (gen_random_uuid(), %s, %s, %s, %s, 20, 'error', 3, %s,"
            " now(), now())",
            (video_id, kind, quality, chunk_no, error),
        )


def test_упавший_перегон_отвечает_отказом_а_не_новой_попыткой(api, db, fresh):
    wait_clip(api, fresh["task_id"], fresh["id"], chunks=False)
    _plant_failure(db, fresh["id"], "chunk", "480", 1, "кодировщик не смог")

    res = ask_chunk(api, fresh, 1, "480")
    assert res.status_code == 409, res.text
    body = res.json()
    assert body["status"] == "failed"
    assert "кодировщик не смог" in body["error"]


def test_упавшая_работа_не_заводится_заново_сразу(api, db, fresh):
    """Именно это и клало сервис: каждое движение по таймлайну по битому
    ролику заводило новую полную нарезку."""
    wait_clip(api, fresh["task_id"], fresh["id"], chunks=False)
    _plant_failure(db, fresh["id"], "chunk", "480", 2)

    before = len(jobs_of(db, fresh["id"], kind="chunk", chunk_no=2))
    for _ in range(10):
        ask_chunk(api, fresh, 2, "480")
    after = jobs_of(db, fresh["id"], kind="chunk", chunk_no=2)
    assert len(after) == before, f"десять просьб завели {len(after) - before} работ"
    assert all(j["status"] == "error" for j in after)


# --------------------------------------------------------------------------- #
# Падение воркера
# --------------------------------------------------------------------------- #
def test_осиротевшая_работа_возвращается_в_очередь(api, db, fresh):
    """Так выглядит падение воркера снаружи: работа осталась «в работе», но
    её никто не продлевает. Через срок аренды она снова чья-то — иначе ролик,
    застигнутый рестартом, остался бы недорезанным навсегда."""
    wait_clip(api, fresh["task_id"], fresh["id"], chunks=False)
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO video_jobs (id, video_id, kind, quality, chunk_no,"
            " priority, status, attempts, lease_until, created_at, started_at)"
            " VALUES (gen_random_uuid(), %s, 'chunk', '480', 3, 20, 'running',"
            " 1, now() - interval '10 minutes', now(), now())"
            " RETURNING id",
            (fresh["id"],),
        )
        job_id = cur.fetchone()[0]

    deadline = time.time() + 90
    while time.time() < deadline:
        with db.cursor() as cur:
            cur.execute(
                "SELECT status, lease_until FROM video_jobs WHERE id = %s", (job_id,)
            )
            row = cur.fetchone()
        if row is None:
            return  # работу успели доделать и убрать вместе с роликом
        status, lease = row
        if status != "running" or (lease is not None and lease > _now(db)):
            return
        time.sleep(2)
    raise AssertionError("просроченная работа так и осталась брошенной")


def _now(db):
    with db.cursor() as cur:
        cur.execute("SELECT now()")
        return cur.fetchone()[0]


# --------------------------------------------------------------------------- #
# Права никуда не делись
# --------------------------------------------------------------------------- #
def test_чужому_перегоны_не_отдаются(api, fresh, db):
    """Перегон — это содержимое проекта. Отдельный путь отдачи не повод
    забыть про права."""
    import requests
    from conftest import tag

    stranger = requests.Session()
    login = tag()
    stranger.post(f"{BASE_URL}/api/auth/register", json={
        "email": f"{login}@example.test", "login": login,
        "display_name": "Посторонний", "password": "Test-Passw0rd",
    })
    with db.cursor() as cur:
        cur.execute(
            "UPDATE users SET email_confirmed_at = now() WHERE login = %s", (login,)
        )
    stranger.post(f"{BASE_URL}/api/auth/login",
                  json={"identity": login, "password": "Test-Passw0rd"})

    res = stranger.get(clip_url(fresh["task_id"], fresh["id"]) + "/chunks/0")
    assert res.status_code == 403, res.text
