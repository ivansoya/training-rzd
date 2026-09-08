"""Кусочная загрузка архива: файл собирается из кусков и переживает обрывы.

Ни Flask, ни базы — только файлы во временной папке. Ловится здесь то, что
в живом стенде видно лишь на архиве в 16 ГБ и плохой связи: повтор куска
после потерянного ответа, продолжение с места разрыва, дыра в отправке.
"""
import io
import os

import pytest

from datasets_svc import upload


@pytest.fixture(autouse=True)
def tmp_root(tmp_path, monkeypatch):
    monkeypatch.setattr(upload.config, "TMP_DIR", str(tmp_path))
    yield tmp_path


def chunks(data, size):
    return [data[i:i + size] for i in range(0, len(data), size)]


def send_all(up, data, size):
    offset = 0
    for piece in chunks(data, size):
        offset = upload.receive(up, offset, io.BytesIO(piece))
    return offset


def test_файл_собирается_из_кусков_по_порядку():
    data = os.urandom(10_000)
    up = upload.begin(None, "a.zip", len(data))
    assert up["received"] == 0
    assert send_all(up, data, 3_000) == len(data)
    final = upload.finish(up)
    assert final.endswith(".zip")
    with open(final, "rb") as fh:
        assert fh.read() == data
    assert not os.path.exists(upload.part_path(up["id"]))


def test_повтор_уже_принятого_куска_пропускается_без_записи():
    data = b"x" * 5_000
    up = upload.begin(None, "a.zip", len(data))
    upload.receive(up, 0, io.BytesIO(data[:2_000]))
    # Ответ на первый кусок потерялся — клиент шлёт его снова.
    got = upload.receive(up, 0, io.BytesIO(data[:2_000]))
    assert got == 2_000
    assert os.path.getsize(upload.part_path(up["id"])) == 2_000
    upload.receive(up, 2_000, io.BytesIO(data[2_000:]))
    with open(upload.finish(up), "rb") as fh:
        assert fh.read() == data


def test_дыра_в_отправке_это_ошибка_с_настоящей_длиной():
    up = upload.begin(None, "a.zip", 5_000)
    upload.receive(up, 0, io.BytesIO(b"y" * 1_000))
    with pytest.raises(upload.UploadError) as caught:
        upload.receive(up, 3_000, io.BytesIO(b"y" * 1_000))
    assert caught.value.received == 1_000
    assert caught.value.status == 409


def test_недошедший_архив_не_завершается():
    up = upload.begin(None, "a.zip", 5_000)
    upload.receive(up, 0, io.BytesIO(b"z" * 4_000))
    with pytest.raises(upload.UploadError) as caught:
        upload.finish(up)
    assert caught.value.received == 4_000
    # Файл цел, продолжить можно.
    assert os.path.getsize(upload.part_path(up["id"])) == 4_000


def test_тот_же_файл_продолжается_с_места_разрыва():
    data = os.urandom(9_000)
    first = upload.begin(None, "big.zip", len(data))
    upload.receive(first, 0, io.BytesIO(data[:4_000]))
    state = {"status": "uploading", "upload": {**first, "received": 4_000}}

    again = upload.begin(state, "big.zip", len(data))
    assert again["id"] == first["id"]
    assert again["received"] == 4_000
    upload.receive(again, 4_000, io.BytesIO(data[4_000:]))
    with open(upload.finish(again), "rb") as fh:
        assert fh.read() == data


def test_другой_файл_выбрасывает_прежний_обрывок():
    first = upload.begin(None, "one.zip", 5_000)
    upload.receive(first, 0, io.BytesIO(b"q" * 1_000))
    state = {"status": "uploading", "upload": first}

    other = upload.begin(state, "two.zip", 7_000)
    assert other["id"] != first["id"]
    assert other["received"] == 0
    assert not os.path.exists(upload.part_path(first["id"]))


def test_запись_о_загрузке_отстала_от_файла_верим_файлу():
    # Сервис упал между записью байтов и сохранением состояния: в записи 0,
    # в файле 2000. Продолжение идёт от файла.
    up = upload.begin(None, "a.zip", 5_000)
    upload.receive(up, 0, io.BytesIO(b"w" * 2_000))
    state = {"status": "uploading", "upload": {**up, "received": 0}}
    again = upload.begin(state, "a.zip", 5_000)
    assert again["received"] == 2_000


def test_больше_объявленного_отвергается():
    up = upload.begin(None, "a.zip", 1_000)
    with pytest.raises(upload.UploadError) as caught:
        upload.receive(up, 0, io.BytesIO(b"v" * 1_500))
    assert caught.value.status == 413


def test_потерянный_файл_это_410_а_не_повтор():
    up = upload.begin(None, "a.zip", 1_000)
    os.remove(upload.part_path(up["id"]))
    with pytest.raises(upload.UploadError) as caught:
        upload.receive(up, 0, io.BytesIO(b"v" * 100))
    assert caught.value.status == 410
