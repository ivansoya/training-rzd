"""Конвейер подготовки ролика: очередь, ступени качества, уборка.

Проверяется не «отдаётся ли отрезок» — это дело `test_video_source`, — а то,
как подготовка устроена снаружи. Загрузка не должна ничего готовить сама,
подготовка должна быть видна в очереди, ступень — лежать одним файлом с
таблицей пакетов, а закрытая таска — не оставлять за собой ничего.

Ролик здесь в mpeg4: браузер такой кодек не разжимает, поэтому «Исходное»
недоступно, и работают ступени — ровно запасной путь решения 5 (22.10.2026).

Главная проверка та же, что и везде вокруг видео: номер кадра. На каждом
кадре тестового ролика нарисован его номер, и ступень 480p обязана показать на
седьмом кадре ровно семёрку.
"""
import io

import pytest
import sample
from conftest import BASE_URL, assets_of, clip_url, decode_segment, get_segment, get_table, hand_over, jobs_of, wait_clip


@pytest.fixture(scope="session")
def tall_video_file():
    return sample.ensure_tall()


@pytest.fixture
def tall(api, task, tall_video_file):
    """Высокий ролик: ему есть куда уменьшаться, значит есть и ступени."""
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


# --------------------------------------------------------------------------- #
# Загрузка ничего не готовит сама
# --------------------------------------------------------------------------- #
def test_загрузка_отдаёт_ответ_не_разбирая_ролик(tall):
    """Раньше загрузка строила таблицу кадров и клеила киноленту в том же
    потоке, что и отвечала. На большом ролике это секунды занятого потока, а
    при нескольких загрузках разом — весь пул сразу."""
    assert tall["preparing"] is True
    assert tall["frame_count"] is None


def test_загрузка_ставит_работу_в_очередь(db, tall):
    kinds = {j["kind"] for j in jobs_of(db, tall["id"])}
    assert "index" in kinds, "разбор ролика на кадры не заказан"


def test_подготовка_доходит_до_конца(api, db, tall):
    body = wait_clip(api, tall["task_id"], tall["id"])
    assert body["frame_count"] == sample.TALL_FRAMES
    assert body["status"] == "ready"
    wait_clip(api, tall["task_id"], tall["id"], quality="480")
    failed = jobs_of(db, tall["id"], statuses=["error"])
    assert not failed, f"часть подготовки упала: {failed}"


# --------------------------------------------------------------------------- #
# Ступени качества
# --------------------------------------------------------------------------- #
def test_ролику_предлагаются_ступени_ниже_его_роста(api, tall):
    """Лестница спускается до 480p и ниже не идёт: на 360 разметчик перестаёт
    различать мелкие объекты, а весь смысл ступеней — чтобы он мог работать."""
    body = wait_clip(api, tall["task_id"], tall["id"])
    assert [q["id"] for q in body["qualities"]] == ["src", "720", "480"]


def test_исходное_в_кодеке_не_для_браузера_только_ступенями(api, tall):
    """mpeg4 браузер не разжимает: «Исходное» в списке с причиной, открываем 720p."""
    body = wait_clip(api, tall["task_id"], tall["id"])
    src = next(q for q in body["qualities"] if q["id"] == "src")
    assert src["ready"] is False
    assert src["reason"] == "кодек mpeg4"
    assert body["default_quality"] == "720"
    res = api.get(clip_url(tall["task_id"], tall["id"]) + "/table", params={"q": "src"})
    assert res.status_code == 409, res.text


def test_ступень_один_файл_нужного_размера_с_таблицей(api, db, tall):
    """Ступень — один файл, как у YouTube, и её размер записан в базу."""
    wait_clip(api, tall["task_id"], tall["id"], quality="720")
    rows = {a["quality"]: a for a in assets_of(db, tall["id"])}
    assert rows["720"]["file_status"] == "ready", rows["720"]["error"]
    assert rows["720"]["height"] == 720
    # Ширина считается от исходной пропорции и обязана быть чётной: yuv420p
    # делит цветность пополам, нечётная сторона кодировщику не годится.
    assert rows["720"]["width"] % 2 == 0
    assert rows["720"]["file_path"].endswith("_v720.mp4")
    assert rows["720"]["has_table"]


@pytest.mark.parametrize("quality", ["720", "480"])
def test_ступень_не_тяжелее_оригинала(api, db, tall, quality):
    """Решение 7: потолок битрейта ступени — битрейт оригинала (с запасом на буфер)."""
    wait_clip(api, tall["task_id"], tall["id"], quality=quality)
    body = wait_clip(api, tall["task_id"], tall["id"])
    rung = next(q for q in body["qualities"] if q["id"] == quality)
    original = next(a for a in assets_of(db, tall["id"]) if a["quality"] == "src")
    seconds = sample.TALL_FRAMES / sample.TALL_FPS
    assert rung["bitrate"] <= original["size_bytes"] * 8 / seconds * 1.15


@pytest.mark.parametrize("quality", ["720", "480"])
def test_ступень_не_сдвигает_нумерацию_кадров(api, tall, quality):
    """Самая дорогая ошибка из возможных: i-й кадр ступени обязан быть i-м
    кадром оригинала. Номер читается с самой картинки, а не с заголовков."""
    wait_clip(api, tall["task_id"], tall["id"], quality=quality)
    table = get_table(api, tall["task_id"], tall["id"], quality)
    # Опорный у ступени ровно через 120: отрезки по 120, последний — остаток.
    assert [s["count"] for s in table["segments"]] == [120, 80]
    frames = decode_segment(table, 0, get_segment(api, tall["task_id"], tall["id"], table, 0).content)
    assert sample.read_mark(frames[0]) == 0
    assert sample.read_mark(frames[7]) == 7
    assert sample.read_mark(frames[-1]) == len(frames) - 1


def test_соседние_отрезки_ступени_стыкуются_без_дыры(api, tall):
    wait_clip(api, tall["task_id"], tall["id"], quality="480")
    table = get_table(api, tall["task_id"], tall["id"], "480")
    tail = decode_segment(table, 0, get_segment(api, tall["task_id"], tall["id"], table, 0).content)[-1]
    head = decode_segment(table, 1, get_segment(api, tall["task_id"], tall["id"], table, 1).content)[0]
    assert sample.read_mark(head) == sample.read_mark(tail) + 1
    assert sample.read_mark(head) == 120


def test_ступень_готовится_один_раз(api, db, tall):
    """Второе открытие ролика не должно заводить вторую копию той же ступени."""
    wait_clip(api, tall["task_id"], tall["id"], quality="480")
    for _ in range(5):
        api.get(clip_url(tall["task_id"], tall["id"]) + "/clip", params={"q": "480"})
        api.get(clip_url(tall["task_id"], tall["id"]) + "/table", params={"q": "480"})
    for_480 = [j for j in jobs_of(db, tall["id"], kind="variant") if j["quality"] == "480"]
    assert len(for_480) == 1, f"ступень 480 заказали {len(for_480)} раз"


# --------------------------------------------------------------------------- #
# Кадр для полуавтомата
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("frame_no", [0, 1, 7, 119, 120, 121, 150, 199])
def test_кадр_по_номеру_это_тот_самый_кадр(api, tall, frame_no):
    """Полуавтомат обводит объект на кадре, который сервер распаковал файлом
    из оригинала, — и он обязан совпадать с номером до единицы.

    Ошибка здесь тише некуда: SAM2 обведёт объект на соседнем кадре, бокс
    ляжет на текущий, и увидит это только тот, кто потом откроет датасет.
    Поэтому номер читается с самой картинки.
    """
    wait_clip(api, tall["task_id"], tall["id"])
    res = api.get(clip_url(tall["task_id"], tall["id"]) + "/frame",
                  params={"n": frame_no})
    assert res.status_code == 200, res.text
    from PIL import Image
    got = sample.read_mark(Image.open(io.BytesIO(res.content)))
    assert got == frame_no, f"попросили кадр {frame_no}, распаковался {got}"


def test_кадр_приходит_в_размерах_источника(api, tall):
    """Кадр по номеру нужен полуавтомату, и размер у него не «примерно тот».

    Точки клика приходят в пикселях источника: канва редактора считает
    координаты от размеров ролика и не знает, какую ступень качества сейчас
    показывают. Пока кадр брали из ближайшего готового перегона, SAM2 получал
    1024×768 как 960×720 — и обводил то, что оказалось в этом месте, а не то,
    что просили. Здесь это падает тестом.
    """
    wait_clip(api, tall["task_id"], tall["id"])
    res = api.get(clip_url(tall["task_id"], tall["id"]) + "/frame", params={"n": 42})
    assert res.status_code == 200, res.text
    from PIL import Image
    img = Image.open(io.BytesIO(res.content))
    assert img.size == (sample.TALL_WIDTH, sample.TALL_HEIGHT)
    # И то же самое — заголовками: клиенту нужен размер, а не догадка о нём.
    assert res.headers.get("X-Frame-Width") == str(sample.TALL_WIDTH)
    assert res.headers.get("X-Frame-Height") == str(sample.TALL_HEIGHT)
    assert sample.read_mark(img) == 42


# --------------------------------------------------------------------------- #
# Уборка
# --------------------------------------------------------------------------- #
def test_закрытие_таски_уносит_ступени_и_очередь(api, db, tall):
    """Ступени переживали удаление ролика и оставались на томе навсегда, а
    весили больше самого исходника."""
    wait_clip(api, tall["task_id"], tall["id"], quality="480")
    assert assets_of(db, tall["id"]), "ступени не завелись — проверять нечего"

    # Таска с роликом на разметку закрывается сдачей — фоном (решение 14.10.2026)
    assert hand_over(api, tall["task_id"], "closed")["result"]["removed_videos"] == 1

    assert assets_of(db, tall["id"]) == []
    assert jobs_of(db, tall["id"]) == []
