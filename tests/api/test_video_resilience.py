"""Как система ведёт себя, когда что-то идёт не так.

Все проверки здесь про одно: сбой в подготовке видео обязан стоить видео, а не
всего сервиса. Раньше было иначе. Нарезка жила потоками внутри gunicorn и
занимала его пул, поэтому пятеро на холодном ролике останавливали проект
целиком. Отказ ничем не запоминался, поэтому битый ролик заводил новую нарезку
на каждое движение разметчика по таймлайну — и добивал машину сам.

Отсюда три свойства, которые тут и проверяются: неготовое — это «202», а не
ошибка и не зависшее соединение; одна и та же работа не заводится дважды;
сломанная ступень помнит, что сломана.
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


def ask_table(api, video, quality):
    return api.get(clip_url(video["task_id"], video["id"]) + "/table", params={"q": quality})


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


def test_неготовая_ступень_отвечает_202_и_говорит_когда_вернуться(api, fresh):
    """Держать соединение, пока ступень жмётся, значит занимать поток, нужный
    всем остальным. Клиенту говорят «готовится» и отпускают."""
    wait_clip(api, fresh["task_id"], fresh["id"], ready=False)
    res = ask_table(api, fresh, "480")
    assert res.status_code in (200, 202), res.text
    if res.status_code == 202:
        body = res.json()
        assert body["status"] == "preparing"
        assert body["quality"] == "480"
        assert body["retry_after_ms"] > 0


def test_ответ_приходит_быстро_даже_когда_ничего_не_готово(api, fresh):
    """Запрос ступени не ждёт сжатия. Секунды с запасом — это про сеть и базу."""
    wait_clip(api, fresh["task_id"], fresh["id"], ready=False)
    started = time.monotonic()
    res = ask_table(api, fresh, "480")
    spent = time.monotonic() - started
    assert res.status_code in (200, 202)
    assert spent < 5.0, f"ответ шёл {spent:.1f} с — сжатие снова в запросе?"


# --------------------------------------------------------------------------- #
# Одна работа — один раз
# --------------------------------------------------------------------------- #
def test_толпа_за_одной_ступенью_заводит_одну_работу(api, db, fresh):
    """Шестнадцать разметчиков, открывших ролик разом, не должны запустить
    шестнадцать кодировщиков. Повтор отсекает база, а не проверка в коде:
    между проверкой и вставкой помещается второй такой же запрос."""
    wait_clip(api, fresh["task_id"], fresh["id"], ready=False)
    with futures.ThreadPoolExecutor(max_workers=16) as pool:
        answers = list(pool.map(lambda _: ask_table(api, fresh, "480"), range(16)))

    assert all(r.status_code in (200, 202) for r in answers), [r.status_code for r in answers]
    for_480 = [j for j in jobs_of(db, fresh["id"], kind="variant") if j["quality"] == "480"]
    assert len(for_480) == 1, f"на одну ступень завели {len(for_480)} работ"


def test_неизвестная_ступень_работы_не_заводит(api, db, fresh):
    """Ошибка в имени качества не должна оборачиваться работой в очереди."""
    wait_clip(api, fresh["task_id"], fresh["id"], ready=False)
    assert ask_table(api, fresh, "9999").status_code == 400
    assert [j for j in jobs_of(db, fresh["id"]) if j["quality"] == "9999"] == []


# --------------------------------------------------------------------------- #
# Отказ помнится
# --------------------------------------------------------------------------- #
def _break_rung(db, video_id, quality, error):
    """Ступень, которую воркер сдал безнадёжной (так её отмечает ``_mark_failed``).

    Сломать настоящий ролик так, чтобы он прошёл загрузку и упал в воркере, из
    теста нельзя. Проверить же надо память об отказе — ровно она отличает «не
    смогли» от «долбим до последнего».
    """
    with db.cursor() as cur:
        cur.execute(
            "UPDATE video_assets SET file_status = 'error', file_path = NULL, error = %s"
            " WHERE video_id = %s AND quality = %s",
            (error, video_id, quality),
        )


def test_сломанная_ступень_отвечает_отказом_а_не_новой_попыткой(api, db, fresh):
    wait_clip(api, fresh["task_id"], fresh["id"], quality="480")
    _break_rung(db, fresh["id"], "480", "кодировщик не смог")

    res = ask_table(api, fresh, "480")
    assert res.status_code == 409, res.text
    body = res.json()
    assert body["status"] == "failed"
    assert "кодировщик не смог" in body["error"]
    clip = wait_clip(api, fresh["task_id"], fresh["id"], ready=False)
    assert next(q for q in clip["qualities"] if q["id"] == "480")["failed"] is True


def test_сломанная_ступень_не_пережимается_на_каждый_взгляд(api, db, fresh):
    """Именно это и клало сервис: каждое движение по ролику заводило новую работу."""
    wait_clip(api, fresh["task_id"], fresh["id"], quality="480")
    _break_rung(db, fresh["id"], "480", "сломалось")

    before = len(jobs_of(db, fresh["id"], kind="variant"))
    for _ in range(10):
        ask_table(api, fresh, "480")
        api.get(clip_url(fresh["task_id"], fresh["id"]) + "/clip")
    after = jobs_of(db, fresh["id"], kind="variant")
    assert len(after) == before, f"десять просьб завели {len(after) - before} работ"


# --------------------------------------------------------------------------- #
# Падение воркера
# --------------------------------------------------------------------------- #
def test_осиротевшая_работа_возвращается_в_очередь(api, db, fresh):
    """Так выглядит падение воркера снаружи: работа осталась «в работе», но
    её никто не продлевает. Через срок аренды она снова чья-то — иначе ролик,
    застигнутый рестартом, остался бы неподготовленным навсегда."""
    wait_clip(api, fresh["task_id"], fresh["id"], quality="480")
    # Кинолента к этому времени склеена: её повтор воркер пропустит, ничего не трогая.
    deadline = time.time() + 60
    while jobs_of(db, fresh["id"], kind="strip", statuses=["queued", "running"]) and time.time() < deadline:
        time.sleep(0.5)
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO video_jobs (id, video_id, kind, quality, chunk_no,"
            " priority, status, attempts, lease_until, created_at, started_at)"
            " VALUES (gen_random_uuid(), %s, 'strip', '', -1, 25, 'running',"
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
def test_чужому_ролик_не_отдаётся(api, fresh, db):
    """Отрезок и таблица — содержимое проекта. Отдельный путь отдачи не повод
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

    for path in ("/table", "/source"):
        res = stranger.get(clip_url(fresh["task_id"], fresh["id"]) + path, params={"q": "480"})
        assert res.status_code == 403, res.text
