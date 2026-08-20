"""Перегоны против живого бэкенда: то ли видео приезжает и те ли в нём кадры.

Главная проверка здесь одна и стоит всех остальных. На каждом кадре тестового
ролика нарисован его номер, поэтому тест не верит заголовкам на слово: он
скачивает перегон, разжимает его тем же способом, что и браузер, и читает
номер с самой картинки. Если нумерация где-то съедет — при нарезке, при
перекодировании, на границе перегона, — бокс уедет на чужой кадр и молча
попадёт в датасет. Здесь это падает тестом.
"""
import io
import time

import av
import pytest
import sample
from conftest import BASE_URL, wait_clip
from PIL import Image


@pytest.fixture(scope="session")
def long_video_file():
    return sample.ensure_long()


@pytest.fixture
def clip(api, task, long_video_file):
    """Длинный ролик, загруженный в разметку и нарезанный на перегоны."""
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
    wait_clip(api, task["id"], body["id"])
    body["task_id"] = task["id"]
    return body


def get_clip(api, clip):
    res = api.get(f"{BASE_URL}/api/tasks/{clip['task_id']}/videos/{clip['id']}/clip")
    assert res.status_code == 200, res.text
    return res.json()


def get_chunk(api, clip, n, quality=None, timeout=180):
    """Перегон — как его берёт браузер: «202» значит «ещё готовится», и на
    него отвечают ожиданием, а не падением."""
    deadline = time.time() + timeout
    while True:
        res = api.get(
            f"{BASE_URL}/api/tasks/{clip['task_id']}/videos/{clip['id']}/chunks/{n}",
            params={"q": quality} if quality else None,
        )
        if res.status_code != 202:
            assert res.status_code == 200, res.text
            return res
        assert time.time() < deadline, f"перегон {n} не подготовился: {res.text}"
        time.sleep(res.json().get("retry_after_ms", 700) / 1000)


def decode(payload):
    """Разжать перегон в список картинок — как это сделает браузер."""
    out = []
    with av.open(io.BytesIO(payload)) as container:
        stream = container.streams.video[0]
        for frame in container.decode(stream):
            out.append(frame.to_image())
    return out


def test_число_кадров_точное_а_не_прикидка(api, clip):
    """Контейнер о числе кадров врёт или молчит; таблица кадров — знает."""
    body = get_clip(api, clip)
    assert body["frame_count"] == sample.LONG_FRAMES
    assert body["version"], "у ролика нет отпечатка таблицы кадров"


def test_перегоны_покрывают_ролик_целиком(api, clip):
    body = get_clip(api, clip)
    covered = []
    for chunk in body["chunks"]:
        covered.extend(range(chunk["first"], chunk["first"] + chunk["count"]))
    assert covered == list(range(sample.LONG_FRAMES))
    assert body["ready"] == len(body["chunks"]), "нарезаны не все перегоны"


def test_перегон_объявляет_свои_кадры_заголовками(api, clip):
    res = get_chunk(api, clip, 1)
    assert res.headers["Content-Type"] == "video/mp4"
    assert int(res.headers["X-Chunk-First"]) == 120
    assert int(res.headers["X-Chunk-Count"]) == 120
    assert res.headers["X-Index-Version"] == get_clip(api, clip)["version"]


def test_в_перегоне_ровно_столько_кадров_сколько_обещано(api, clip):
    for n in range(len(get_clip(api, clip)["chunks"])):
        res = get_chunk(api, clip, n)
        promised = int(res.headers["X-Chunk-Count"])
        frames = decode(res.content)
        assert len(frames) == promised, f"перегон {n}: обещано {promised}, разжалось {len(frames)}"


@pytest.mark.parametrize("chunk_no", [0, 1, 2])
def test_кадр_в_перегоне_это_тот_самый_кадр_ролика(api, clip, chunk_no):
    """Сквозная проверка нумерации: номер читается с самой картинки.

    Проверяются края и середина: на границе перегона ошибка на единицу как раз
    и вылезает, а в середине — сдвиг всей нумерации.
    """
    res = get_chunk(api, clip, chunk_no)
    first = int(res.headers["X-Chunk-First"])
    frames = decode(res.content)

    for offset in (0, len(frames) // 2, len(frames) - 1):
        got = sample.read_mark(frames[offset])
        assert got == first + offset, (
            f"перегон {chunk_no}, кадр {offset}: на картинке номер {got}, "
            f"а сервер обещал {first + offset}"
        )


def test_соседние_перегоны_стыкуются_без_дыры(api, clip):
    """Последний кадр перегона и первый следующего — соседи, а не через один."""
    tail = decode(get_chunk(api, clip, 0).content)[-1]
    head = decode(get_chunk(api, clip, 1).content)[0]
    assert sample.read_mark(head) == sample.read_mark(tail) + 1


def test_ступени_качества_не_меняют_нумерацию(api, clip):
    """Качество меняет картинку, но не нумерацию: иначе выбор ступени уводил бы
    разметчика на соседний кадр."""
    body = get_clip(api, clip)
    ladder = [q["id"] for q in body["qualities"]]
    assert "src" in ladder
    for quality in ladder:
        frames = decode(get_chunk(api, clip, 0, quality).content)
        assert sample.read_mark(frames[7]) == 7, f"ступень {quality} сбила номер кадра"


def test_за_концом_ролика_перегона_нет(api, clip):
    res = api.get(
        f"{BASE_URL}/api/tasks/{clip['task_id']}/videos/{clip['id']}/chunks/99"
    )
    assert res.status_code == 404


def test_ролик_предлагает_ступени_качества(api, clip):
    """Ступени выше исходника бессмысленны и в список не попадают."""
    body = get_clip(api, clip)
    assert body["quality"] in [q["id"] for q in body["qualities"]]
    # Тестовый ролик 320×240 — предлагать ему 1080p не за чем.
    assert [q["id"] for q in body["qualities"]] == ["src"]


def test_неизвестное_качество_отвергается(api, clip):
    res = api.get(
        f"{BASE_URL}/api/tasks/{clip['task_id']}/videos/{clip['id']}/chunks/0",
        params={"q": "ультра"},
    )
    assert res.status_code == 400
