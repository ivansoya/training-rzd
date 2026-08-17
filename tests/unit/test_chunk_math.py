"""Границы перегонов — без базы, без сервера и без единого ролика.

Перегон отдаётся клиенту вместе с тем, какие кадры в нём лежат, и клиент этому
верит буквально: i-й разжатый кадр он подписывает номером ``first + i``.
Значит, ошибка в границах — это не «съехала полоса прокрутки», а бокс,
уехавший на чужой кадр и молча попавший в датасет.
"""
import pytest

from datasets_svc.video_chunks import (
    CHUNK_FRAMES,
    VideoError,
    chunk_bounds,
    chunk_count,
    chunk_of,
    manifest,
)


def index(count):
    """Столько от индекса, сколько нужно перечню перегонов."""
    return {
        "count": count,
        "version": "тест",
        "width": 320,
        "height": 240,
        "rate": [25, 1],
    }


def test_ролик_короче_перегона_даёт_один_перегон():
    assert chunk_count(30) == 1
    assert chunk_bounds(0, 30) == (0, 29)


def test_ролик_ровно_в_перегон_не_даёт_пустого_хвоста():
    assert chunk_count(CHUNK_FRAMES) == 1
    assert chunk_bounds(0, CHUNK_FRAMES) == (0, CHUNK_FRAMES - 1)


def test_неполный_последний_перегон_короче_остальных():
    assert chunk_count(300) == 3
    assert chunk_bounds(2, 300) == (240, 299)


def test_за_концом_ролика_перегона_нет():
    with pytest.raises(VideoError):
        chunk_bounds(3, 300)


def test_кадр_знает_свой_перегон():
    assert chunk_of(0) == 0
    assert chunk_of(CHUNK_FRAMES - 1) == 0
    assert chunk_of(CHUNK_FRAMES) == 1
    assert chunk_of(299) == 2


@pytest.mark.parametrize("count", [1, 30, 119, 120, 121, 300, 1500, 90_000])
def test_перегоны_покрывают_ролик_без_дыр_и_нахлёстов(count):
    """Главное свойство: каждый кадр лежит ровно в одном перегоне.

    Проверяется склейкой, а не арифметикой: перечень перегонов — это то, что
    уедет клиенту, и сходиться должен именно он.
    """
    chunks = manifest(index(count))["chunks"]
    seen = []
    for chunk in chunks:
        seen.extend(range(chunk["first"], chunk["first"] + chunk["count"]))
    assert seen == list(range(count))


def test_манифест_несёт_отпечаток_и_размер_перегона():
    body = manifest(index(300))
    assert body["frame_count"] == 300
    assert body["version"] == "тест"
    assert body["chunk_frames"] == CHUNK_FRAMES
    assert [c["n"] for c in body["chunks"]] == [0, 1, 2]
