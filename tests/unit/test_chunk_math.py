"""Границы перегонов — без базы, без сервера и без единого ролика.

Перегон отдаётся клиенту вместе с тем, какие кадры в нём лежат, и клиент этому
верит буквально: i-й разжатый кадр он подписывает номером ``first + i``.
Значит, ошибка в границах — это не «съехала полоса прокрутки», а бокс,
уехавший на чужой кадр и молча попавший в датасет.
"""
import pytest

from datasets_svc.video_chunks import (
    CHUNK_FRAMES,
    LADDER,
    SOURCE,
    VideoError,
    _params,
    chunk_bounds,
    chunk_count,
    chunk_of,
    default_for,
    ladder_for,
    leftovers,
    manifest,
    qualities,
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


# --------------------------------------------------------------------------- #
# Лестница качества
# --------------------------------------------------------------------------- #
def test_лестница_не_спускается_ниже_480():
    """На 360 разметчик перестаёт различать мелкие объекты, а весь смысл
    ступеней — чтобы он мог работать, а не чтобы экономить байты."""
    assert min(LADDER) == 480


def test_ступени_выше_исходника_не_предлагаются():
    """Растянуть картинку вверх нельзя — можно только соврать про резкость."""
    assert [q["id"] for q in qualities(1024, 768)] == ["src", "720", "480"]
    assert [q["id"] for q in qualities(854, 480)] == ["src"]
    assert [q["id"] for q in qualities(320, 240)] == ["src"]


def test_ступень_по_умолчанию_есть_или_её_заменяет_исходное():
    assert default_for(768) == "720"
    assert default_for(1080) == "720"
    # Ролик мельче самой малой ступени: исходное и есть самое малое, что мы
    # умеем, и готовить копии ему не из чего.
    assert default_for(240) == SOURCE
    assert ladder_for(240) == []


def test_копии_делаются_только_для_ступеней_ниже_роста():
    assert ladder_for(768) == ["720", "480"]
    assert ladder_for(1080) == ["720", "480"]
    assert ladder_for(2160) == ["1080", "720", "480"]


@pytest.mark.parametrize("size", [(1024, 768), (2688, 1520), (1921, 1081), (641, 481)])
def test_стороны_копии_всегда_чётные(size):
    """yuv420p делит цветность пополам: нечётная сторона кодировщику не
    годится, и ловить это на первом же реальном ролике не хочется."""
    width, height = size
    for quality in ladder_for(height) + [SOURCE]:
        w, h = _params(quality, width, height)["size"]
        assert w % 2 == 0 and h % 2 == 0, f"{quality}: {w}×{h}"
        assert w >= 2 and h >= 2


def test_уборка_знает_про_перегоны_и_копии():
    """Перегоны и копии переживали удаление ролика и оставались на томе
    навсегда, а весят они больше самого исходника."""
    dirs, files = leftovers("/data/projects/p/tasks/t/abc.mp4")
    assert "/data/projects/p/tasks/t/abc_chunks" in dirs
    assert "/data/projects/p/tasks/t/abc_frames" in dirs
    assert "/data/projects/p/tasks/t/abc_strip.jpg" in files
    for step in LADDER:
        assert f"/data/projects/p/tasks/t/abc_v{step}.mp4" in files
