"""«Исходное» по Range против живого бэкенда: те ли байты приезжают и те ли в них кадры.

Главная проверка здесь одна и стоит всех остальных. На каждом кадре тестового
ролика нарисован его номер, поэтому тест не верит заголовкам на слово: он
берёт отрезок по Range, вырезает кадры по таблице пакетов и разжимает их тем
же способом, что и браузер, — и читает номер с самой картинки. Если нумерация
где-то съедет — в таблице, на границе отрезка, в зазорах между пакетами, —
бокс уедет на чужой кадр и молча попадёт в датасет. Здесь это падает тестом.
"""
import pytest
import sample
from conftest import BASE_URL, clip_url, decode_segment, get_segment, get_table, wait_clip


@pytest.fixture(scope="session")
def long_video_file():
    return sample.ensure_long()


@pytest.fixture
def clip(api, task, long_video_file):
    """Длинный ролик в H.264: «Исходное» отдаётся из него самого."""
    with open(long_video_file, "rb") as fh:
        res = api.post(
            f"{BASE_URL}/api/tasks/{task['id']}/videos",
            files={"file": ("sample-300f.mp4", fh, "video/mp4")},
            data={"mode": "annotate"},
        )
    assert res.status_code in (200, 201), res.text
    body = res.json()
    # Подготовка идёт в воркере; тесту нужна готовая, чтобы мерить не гонку.
    assert body.get("preparing"), "загрузка не поставила подготовку в очередь"
    wait_clip(api, task["id"], body["id"], quality="src")
    body["task_id"] = task["id"]
    body["table"] = get_table(api, task["id"], body["id"], "src")
    return body


def source(api, clip, start, end, **params):
    return api.get(clip_url(clip["task_id"], clip["id"]) + "/source",
                   params={"q": "src", "v": clip["table"]["tag"], **params},
                   headers={"Range": f"bytes={start}-{end}"} if start is not None else {})


def test_число_кадров_точное_а_не_прикидка(api, clip):
    """Контейнер о числе кадров врёт или молчит; таблица кадров — знает."""
    body = wait_clip(api, clip["task_id"], clip["id"])
    assert body["frame_count"] == sample.LONG_FRAMES
    assert body["version"], "у ролика нет отпечатка таблицы кадров"


def test_лёгкий_оригинал_открывается_в_исходном(api, clip):
    """Решение 11 (22.10.2026): оригинал легче 8 Мбит/с — с него и открываем."""
    body = wait_clip(api, clip["task_id"], clip["id"])
    src = next(q for q in body["qualities"] if q["id"] == "src")
    assert src["ready"] and src["reason"] is None
    assert src["codec"].startswith("avc1.")
    assert body["default_quality"] == "src"
    # Ролик 320×240: ступеней ниже нет, а копия в рост ему не нужна — оригинал отдаётся сам.
    assert [q["id"] for q in body["qualities"]] == ["src"]


def test_отрезки_покрывают_ролик_целыми_группами(clip):
    """Каждый кадр — ровно в одном отрезке; отрезок с опорного и не короче 120."""
    segs = clip["table"]["segments"]
    covered = []
    for seg in segs:
        covered.extend(range(seg["first"], seg["first"] + seg["count"]))
        assert seg["first"] in clip["table"]["keys"], f"отрезок {seg['n']} не с опорного"
    assert covered == list(range(sample.LONG_FRAMES))
    # Опорный через 50: отрезок — три группы.
    assert [s["count"] for s in segs] == [150, 150]


def test_отрезок_объявляет_свои_кадры_заголовками(api, clip):
    res = get_segment(api, clip["task_id"], clip["id"], clip["table"], 1)
    assert int(res.headers["X-Segment-First"]) == 150
    assert int(res.headers["X-Segment-Count"]) == 150
    assert res.headers["X-Segment-Quality"] == "src"
    assert res.headers["X-Index-Version"] == wait_clip(api, clip["task_id"], clip["id"])["version"]
    seg = clip["table"]["segments"][1]
    assert res.headers["Content-Range"].startswith(f"bytes {seg['start']}-{seg['end']}/")


@pytest.mark.parametrize("n", [0, 1])
def test_кадр_в_отрезке_это_тот_самый_кадр_ролика(api, clip, n):
    """Сквозная проверка нумерации: номер читается с самой картинки — на краях и в середине."""
    res = get_segment(api, clip["task_id"], clip["id"], clip["table"], n)
    frames = decode_segment(clip["table"], n, res.content)
    first = clip["table"]["segments"][n]["first"]
    assert len(frames) == clip["table"]["segments"][n]["count"]
    for offset in (0, 49, 50, len(frames) // 2, len(frames) - 1):
        got = sample.read_mark(frames[offset])
        assert got == first + offset, f"отрезок {n}, кадр {offset}: на картинке {got}, а обещано {first + offset}"


def test_соседние_отрезки_стыкуются_без_дыры(api, clip):
    """Последний кадр отрезка и первый следующего — соседи, а не через один."""
    t = clip["table"]
    tail = decode_segment(t, 0, get_segment(api, clip["task_id"], clip["id"], t, 0).content)[-1]
    head = decode_segment(t, 1, get_segment(api, clip["task_id"], clip["id"], t, 1).content)[0]
    assert sample.read_mark(head) == sample.read_mark(tail) + 1


def test_отдаются_только_объявленные_отрезки(api, clip):
    """Решение 3: кусок мимо границ — 416, а не обрывок с чужими кадрами."""
    seg = clip["table"]["segments"][0]
    assert source(api, clip, seg["start"] + 1, seg["end"]).status_code == 416
    assert source(api, clip, seg["start"], seg["end"] - 1).status_code == 416
    assert source(api, clip, None, None).status_code == 416
    two = api.get(clip_url(clip["task_id"], clip["id"]) + "/source",
                  params={"q": "src", "v": clip["table"]["tag"]},
                  headers={"Range": f"bytes={seg['start']}-{seg['end']},0-10"})
    assert two.status_code == 416


def test_чужая_метка_ступени_отказывает(api, clip):
    """Ступень пересжали, а у клиента прежняя таблица: байты не те — 409 «stale»."""
    seg = clip["table"]["segments"][0]
    res = source(api, clip, seg["start"], seg["end"], v="старая")
    assert res.status_code == 409
    assert res.json()["code"] == "stale"


def test_неизвестное_качество_отвергается(api, clip):
    url = clip_url(clip["task_id"], clip["id"])
    assert api.get(url + "/table", params={"q": "ультра"}).status_code == 400
    assert api.get(url + "/source", params={"q": "ультра"}).status_code == 400
