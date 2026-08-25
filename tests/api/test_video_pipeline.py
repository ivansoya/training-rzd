"""Конвейер подготовки ролика: очередь, ступени качества, уборка.

Проверяется не «работает ли нарезка» — это дело `test_video_chunks`, — а то,
как она устроена снаружи. Загрузка не должна ничего готовить сама, подготовка
должна быть видна в очереди, копии ступеней — лежать в базе путями, а закрытая
таска — не оставлять за собой ни перегонов, ни копий.

Главная проверка здесь та же, что и везде вокруг видео: номер кадра. На каждом
кадре тестового ролика нарисован его номер, и копия 480p обязана показать на
седьмом кадре ровно семёрку. Копия, сдвинувшая нумерацию, увела бы всю
разметку на соседний кадр — и заметить это можно было бы только в датасете.
"""
import io
import time

import av
import pytest
import sample
from conftest import BASE_URL, assets_of, clip_url, jobs_of, wait_clip


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


def decode(payload):
    out = []
    with av.open(io.BytesIO(payload)) as container:
        for frame in container.decode(container.streams.video[0]):
            out.append(frame.to_image())
    return out


def chunk(api, tall, n, quality=None, timeout=240):
    deadline = time.time() + timeout
    while True:
        res = api.get(clip_url(tall["task_id"], tall["id"]) + f"/chunks/{n}",
                      params={"q": quality} if quality else None)
        if res.status_code != 202:
            assert res.status_code == 200, res.text
            return res
        assert time.time() < deadline, f"перегон {n} не подготовился: {res.text}"
        time.sleep(res.json().get("retry_after_ms", 700) / 1000)


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
    assert "strip" in kinds, "кинолента не заказана"


def test_подготовка_доходит_до_конца(api, db, tall):
    body = wait_clip(api, tall["task_id"], tall["id"])
    assert body["frame_count"] == sample.TALL_FRAMES
    assert body["status"] == "ready"
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
    assert body["default_quality"] == "720"


def test_копия_ступени_делается_в_нужном_размере(api, db, tall):
    """Копия — настоящий файл, и её размер записан в базу: по нему видно, что
    ступень сделана той, за которую себя выдаёт."""
    wait_clip(api, tall["task_id"], tall["id"], quality="720")
    rows = {a["quality"]: a for a in assets_of(db, tall["id"])}
    assert "720" in rows, "ступень 720 не завелась"
    assert rows["720"]["file_status"] == "ready", rows["720"]["error"]
    assert rows["720"]["height"] == 720
    # Ширина считается от исходной пропорции и обязана быть чётной: yuv420p
    # делит цветность пополам, нечётная сторона кодировщику не годится.
    assert rows["720"]["width"] % 2 == 0


@pytest.mark.parametrize("quality", ["720", "480"])
def test_копия_убирается_когда_перегоны_нарезаны(api, db, tall, quality):
    """Копия и её перегоны — одни и те же байты дважды: перегон вырезается из
    копии перекладыванием пакетов, а не пересжатием. На двадцатиминутном
    ролике это четверть гигабайта, лежащая зря.

    ``file_status`` при этом остаётся ``ready``: он про то, удалась ли копия, а
    не про то, лежит ли она сейчас. Есть ли файл — говорит ``file_path``.
    """
    wait_clip(api, tall["task_id"], tall["id"], quality=quality)
    rows = {a["quality"]: a for a in assets_of(db, tall["id"])}
    assert rows[quality]["chunks_status"] == "ready"
    assert rows[quality]["file_path"] is None, "копия осталась на томе"
    assert rows[quality]["file_status"] == "ready"


def test_убранная_копия_не_мешает_отдавать_перегоны(api, tall):
    """Проверка, ради которой уборка и опасна: перегоны обязаны отдаваться и
    после того, как копию, из которой их резали, убрали."""
    wait_clip(api, tall["task_id"], tall["id"], quality="480")
    frames = decode(chunk(api, tall, 1, "480").content)
    assert sample.read_mark(frames[0]) == 120


def test_у_исходного_качества_копии_нет(api, db, tall):
    """Исходное — это сам ролик; копировать его незачем и негде."""
    wait_clip(api, tall["task_id"], tall["id"])
    rows = {a["quality"]: a for a in assets_of(db, tall["id"])}
    assert rows.get("src", {}).get("file_path") in (None, "")


@pytest.mark.parametrize("quality", ["720", "480"])
def test_копия_не_сдвигает_нумерацию_кадров(api, tall, quality):
    """Самая дорогая ошибка из возможных: i-й кадр копии обязан быть i-м
    кадром оригинала. Номер читается с самой картинки, а не с заголовков."""
    wait_clip(api, tall["task_id"], tall["id"], quality=quality)
    frames = decode(chunk(api, tall, 0, quality).content)
    assert sample.read_mark(frames[0]) == 0
    assert sample.read_mark(frames[7]) == 7
    assert sample.read_mark(frames[-1]) == len(frames) - 1


def test_соседние_перегоны_ступени_стыкуются_без_дыры(api, tall):
    quality = "480"
    wait_clip(api, tall["task_id"], tall["id"], quality=quality)
    tail = decode(chunk(api, tall, 0, quality).content)[-1]
    head = decode(chunk(api, tall, 1, quality).content)[0]
    assert sample.read_mark(head) == sample.read_mark(tail) + 1


def test_перегон_объявляет_свою_ступень(api, tall):
    """Заголовок с качеством — та же защита, что и заголовок с кадрами:
    декодер настраивается по байтам, и перепутанная ступень его сломает."""
    wait_clip(api, tall["task_id"], tall["id"], quality="480")
    res = chunk(api, tall, 0, "480")
    assert res.headers["X-Chunk-Quality"] == "480"
    assert int(res.headers["X-Chunk-First"]) == 0


def test_ступень_готовится_один_раз(api, db, tall):
    """Второе открытие ролика не должно заводить вторую нарезку той же
    ступени: раньше на этом два кодировщика молотили одно и то же."""
    wait_clip(api, tall["task_id"], tall["id"], quality="480")
    for _ in range(5):
        api.get(clip_url(tall["task_id"], tall["id"]) + "/clip", params={"q": "480"})
    sets = jobs_of(db, tall["id"], kind="chunkset")
    for_480 = [j for j in sets if j["quality"] == "480"]
    assert len(for_480) == 1, f"нарезку 480 заказали {len(for_480)} раз"


# --------------------------------------------------------------------------- #
# Кадр для полуавтомата
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("frame_no", [0, 1, 7, 119, 120, 121, 150, 199])
def test_кадр_по_номеру_это_тот_самый_кадр(api, tall, frame_no):
    """Полуавтомат обводит объект на кадре, который сервер распаковал файлом.
    Кадр берётся из готового перегона — так он стоит десятых долей секунды
    вместо перемотки по исходнику, — и обязан совпадать с номером до единицы.

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


def test_кадр_распаковывается_и_на_границе_перегона(api, tall):
    """Границы перегонов — место, где номер съезжает охотнее всего: кадр 120
    это первый кадр второго перегона, а не сто двадцать первый первого."""
    wait_clip(api, tall["task_id"], tall["id"])
    from PIL import Image
    marks = []
    for n in (118, 119, 120, 121):
        res = api.get(clip_url(tall["task_id"], tall["id"]) + "/frame",
                      params={"n": n})
        assert res.status_code == 200, res.text
        marks.append(sample.read_mark(Image.open(io.BytesIO(res.content))))
    assert marks == [118, 119, 120, 121]


def test_кадр_приходит_в_размерах_источника(api, tall):
    """Кадр по номеру нужен полуавтомату, и размер у него не «примерно тот».

    Точки клика приходят в пикселях источника: канва редактора считает
    координаты от размеров ролика и не знает, какую ступень качества сейчас
    показывают. Пока кадр брали из ближайшего готового перегона, SAM2 получал
    1024×768 как 960×720 — и обводил то, что оказалось в этом месте, а не то,
    что просили. Здесь это падает тестом.
    """
    body = wait_clip(api, tall["task_id"], tall["id"])
    assert body["default_quality"] == "720", "ступень по умолчанию сменилась"

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
    """Перегоны и копии переживали удаление ролика и оставались на томе
    навсегда, а весят они больше самого исходника."""
    wait_clip(api, tall["task_id"], tall["id"])
    assert assets_of(db, tall["id"]), "ступени не завелись — проверять нечего"

    res = api.post(f"{BASE_URL}/api/tasks/{tall['task_id']}/status",
                   json={"status": "closed"})
    assert res.status_code == 200, res.text

    assert assets_of(db, tall["id"]) == []
    assert jobs_of(db, tall["id"]) == []
