"""Нагрузка: остаётся ли сервис живым, пока готовится видео.

Набор существует из-за одной конкретной поломки. Нарезка ролика жила потоками
внутри gunicorn, у которого было восемь потоков на весь сервис датасетов — а
он отдаёт и список тасок, и кадры, и сохранение боксов. Восьми одновременных
нарезок хватало, чтобы проект перестал отвечать всем, включая тех, кто видео
вообще не открывал.

Поэтому здесь меряется не пропускная способность видео, а то, что от неё
страдало: время ответа обычных запросов, пока воркер занят перекодированием.
Числа выбраны с большим запасом — тест должен ловить возврат нарезки в
веб-процесс, а не дрожание машины разработчика.
"""
import concurrent.futures as futures
import statistics
import time

import pytest
import sample
from conftest import BASE_URL, clip_url, wait_clip

# Ответ обычного запроса, пока воркер занят. Секунда — это очень много для
# запроса, который делает три обращения к базе; берём её именно потому, что
# ловим не медленность, а блокировку.
CALM_P95 = 1.0
CALM_MAX = 3.0


@pytest.fixture(scope="session")
def tall_video_file():
    return sample.ensure_tall()


@pytest.fixture
def busy(api, task, tall_video_file):
    """Ролик, подготовка которого прямо сейчас идёт: копии ступеней делаются
    фоном, и воркеру есть чем заняться."""
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


def timed(fn, times):
    """Замер: список длительностей и все ответы, чтобы было что показать."""
    spent, answers = [], []
    for _ in range(times):
        started = time.monotonic()
        res = fn()
        spent.append(time.monotonic() - started)
        answers.append(res)
    return spent, answers


def p95(values):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]


def test_список_тасок_отвечает_пока_готовится_видео(api, project, busy):
    """Главная проверка набора. Раньше этот запрос вставал за нарезкой —
    и вставал у всех, включая тех, кто видео не открывал."""
    spent, answers = timed(
        lambda: api.get(f"{BASE_URL}/api/projects/{project['code']}/tasks"), 30
    )
    assert all(r.status_code == 200 for r in answers), \
        [r.status_code for r in answers]
    assert p95(spent) < CALM_P95, (
        f"95-я доля {p95(spent):.2f} с при медиане {statistics.median(spent):.2f} — "
        "похоже, тяжёлая работа вернулась в веб-процесс"
    )
    assert max(spent) < CALM_MAX, f"худший ответ {max(spent):.2f} с"


def test_разметка_сохраняется_пока_режется_видео(api, task, label_class, busy):
    """Пока готовится ступень, разметчик продолжает работать на другом ролике.
    Сохранение бокса — самый частый запрос редактора, и он не должен зависеть
    от того, что делает кодировщик."""
    wait_clip(api, busy["task_id"], busy["id"], chunks=False)
    url = clip_url(busy["task_id"], busy["id"]) + "/frames/5/boxes"
    box = {
        "class_index": label_class["class_index"],
        "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2,
    }

    spent, answers = timed(lambda: api.put(url, json={"boxes": [box]}), 20)
    assert all(r.status_code in (200, 201) for r in answers), \
        [(r.status_code, r.text[:200]) for r in answers if r.status_code >= 400]
    assert max(spent) < CALM_MAX, f"худшее сохранение {max(spent):.2f} с"


def test_двадцать_клиентов_одного_ролика_не_валят_сервис(api, busy):
    """Бригада, открывшая один ролик разом. Ответы могут быть «ещё
    готовится» — это нормально; чего быть не должно, так это пятисотых и
    отвалившихся соединений."""
    wait_clip(api, busy["task_id"], busy["id"], chunks=False)

    def one(n):
        return api.get(clip_url(busy["task_id"], busy["id"]) + f"/chunks/{n % 2}",
                       params={"q": "480"})

    with futures.ThreadPoolExecutor(max_workers=20) as pool:
        answers = list(pool.map(one, range(40)))

    codes = [r.status_code for r in answers]
    assert all(c in (200, 202) for c in codes), codes
    assert not any(c >= 500 for c in codes)


def test_манифест_ролика_отвечает_быстро_при_повторных_запросах(api, busy):
    """Таблица кадров разворачивается один раз на процесс. Раньше она читалась
    с тома и разворачивалась заново на каждый запрос — девяносто тысяч чисел
    на часовом ролике, и всё это в занятом потоке."""
    wait_clip(api, busy["task_id"], busy["id"], chunks=False)
    spent, answers = timed(
        lambda: api.get(clip_url(busy["task_id"], busy["id"]) + "/clip"), 25
    )
    assert all(r.status_code == 200 for r in answers)
    assert p95(spent) < CALM_P95, f"95-я доля {p95(spent):.2f} с"


def test_отдача_готового_перегона_не_зависит_от_числа_просящих(api, busy):
    """Готовый перегон — это отдача файла. Его время не должно расти от того,
    что рядом кто-то ещё смотрит тот же ролик."""
    wait_clip(api, busy["task_id"], busy["id"], quality="480")
    url = clip_url(busy["task_id"], busy["id"]) + "/chunks/0"

    def once():
        return api.get(url, params={"q": "480"})

    alone, _ = timed(once, 5)
    with futures.ThreadPoolExecutor(max_workers=12) as pool:
        crowd = list(pool.map(lambda _: once(), range(24)))
    assert all(r.status_code == 200 for r in crowd), [r.status_code for r in crowd]
    assert max(alone) < CALM_MAX
