"""Отрезки для Range и таблица пакетов — без базы, без сервера и без единого ролика.

Отрезок отдаётся клиенту вместе с тем, какие кадры в нём лежат и где их байты,
и клиент этому верит буквально. Значит, ошибка в границах — это не «съехала
полоса прокрутки», а бокс, уехавший на чужой кадр и молча попавший в датасет.
"""
import pytest

from datasets_svc.video_chunks import (
    LADDER,
    SEGMENT_FRAMES,
    SOURCE,
    SOURCE_DEFAULT_BPS,
    _cq,
    _params,
    codec_string,
    default_for,
    ladder_for,
    leftovers,
    pack_table,
    qualities,
    segments,
    unpack_table,
)


def table(count, keys, size=10, gap=0):
    """Таблица файла: кадры по ``size`` байт, перед каждым ``gap`` байт чужого."""
    return {
        "count": count,
        "keys": keys,
        "sizes": [size] * count,
        "pos": [gap + i * (size + gap) for i in range(count)],
    }


def src(height, bitrate=2_000_000, why=None):
    return {"height": height, "bitrate": bitrate, "range_why": why}


# --------------------------------------------------------------------------- #
# Отрезки
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("count, step", [(1, 50), (30, 50), (300, 50), (300, 120), (29_800, 50), (1000, 151)])
def test_отрезки_покрывают_ролик_без_дыр_и_нахлёстов(count, step):
    """Главное свойство: каждый кадр лежит ровно в одном отрезке."""
    seen = []
    for seg in segments(table(count, list(range(0, count, step)))):
        seen.extend(range(seg["first"], seg["first"] + seg["count"]))
    assert seen == list(range(count))


def test_отрезок_начинается_с_опорного_и_не_короче_120():
    keys = list(range(0, 1000, 50))
    segs = segments(table(1000, keys))
    assert all(s["first"] in keys for s in segs)
    assert all(s["count"] >= SEGMENT_FRAMES for s in segs[:-1])
    # «Искра»: группа 50 кадров — отрезок из трёх групп.
    assert [s["count"] for s in segs[:2]] == [150, 150]


def test_длинная_группа_даёт_отрезок_в_одну_группу():
    """Камеры H.264 ставят опорный через ~150: короче группы отрезок не бывает."""
    segs = segments(table(600, [0, 153, 306, 459]))
    assert [(s["first"], s["count"]) for s in segs] == [(0, 153), (153, 153), (306, 153), (459, 141)]


def test_байты_отрезка_от_первого_кадра_до_конца_последнего():
    t = table(300, [0, 120, 240], size=10, gap=4)  # кадр i — с 4+14i по 13+14i
    first, second, last = segments(t)
    assert (first["start"], first["end"]) == (4, 14 * 119 + 13)
    assert second["start"] == 14 * 120 + 4
    assert last["end"] == 14 * 299 + 13


def test_таблица_туда_и_обратно_сохраняет_смещения():
    """Хранятся размеры и зазоры, разворачиваются смещения — те же самые."""
    pos = [44, 80, 81, 200, 260]
    sizes = [36, 1, 100, 50, 7]
    index = {
        "version": "тест", "count": 5, "keys": [0, 3], "pos": pos, "sizes": sizes,
        "codec": "h264", "codec_string": "avc1.64001f", "extradata": b"\x01d\x00\x1f",
        "bitrate": 1000, "width": 320, "height": 240, "range_why": None,
    }
    back = unpack_table(pack_table(index))
    assert back["pos"] == pos
    assert [(s["first"], s["count"], s["start"], s["end"]) for s in back["segments"]] == [(0, 5, 44, 266)]
    assert back["by_start"][44]["n"] == 0


def test_без_range_пакеты_не_хранятся():
    index = {
        "version": "тест", "count": 2, "keys": [0], "pos": [0, 5], "sizes": [5, 5],
        "codec": "mpeg4", "codec_string": None, "extradata": b"",
        "bitrate": 1000, "width": 320, "height": 240, "range_why": "кодек mpeg4",
    }
    packed = pack_table(index)
    assert packed["sizes"] is None and packed["gaps"] is None
    assert "segments" not in unpack_table(packed)


# --------------------------------------------------------------------------- #
# Строка кодека для браузера
# --------------------------------------------------------------------------- #
def test_строка_кодека_h264_из_avcc():
    assert codec_string("h264", "avc1", bytes([1, 0x64, 0x00, 0x1F, 0xFF])) == "avc1.64001f"
    assert codec_string("h264", "avc1", bytes([1, 0x4D, 0x40, 0x29])) == "avc1.4d4029"


def test_строка_кодека_hevc_из_hvcc():
    """Сверено с mp4box на перегоне NVENC «Искры»: hvc1.1.6.H150.90."""
    hvcc = bytes([1, 0x21, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 150]) + bytes(10)
    assert codec_string("hevc", "hvc1", hvcc) == "hvc1.1.6.H150.90"
    main_l120 = bytes([1, 0x01, 0x60, 0, 0, 0, 0xB0, 0, 0, 0, 0, 0, 120]) + bytes(10)
    assert codec_string("hevc", "hev1", main_l120) == "hev1.1.6.L120.B0"


def test_описание_не_avcc_или_чужой_кодек_не_годятся():
    """mkv/ts кладут описание иначе (Annex B), mpeg4 браузер не разжимает."""
    assert codec_string("h264", "", bytes([0, 0, 0, 1, 0x67])) is None
    assert codec_string("mpeg4", "mp4v", bytes([1, 2, 3, 4])) is None
    assert codec_string("hevc", "hvc1", bytes([1, 2, 3])) is None


# --------------------------------------------------------------------------- #
# Лестница качества
# --------------------------------------------------------------------------- #
def test_лестница_не_спускается_ниже_480():
    """На 360 разметчик перестаёт различать мелкие объекты, а весь смысл
    ступеней — чтобы он мог работать, а не чтобы экономить байты."""
    assert min(LADDER) == 480


def test_ступени_выше_исходника_не_предлагаются():
    """Растянуть картинку вверх нельзя — можно только соврать про резкость."""
    assert [q["id"] for q in qualities(src(768))] == ["src", "720", "480"]
    assert [q["id"] for q in qualities(src(480))] == ["src"]
    assert ladder_for(src(2160)) == ["1080", "720", "480"]


def test_мелкий_ролик_без_range_получает_копию_в_рост():
    """Ступеней ниже 480 нет, а оригинал браузеру не отдать — иначе ролик не открыть вовсе."""
    assert ladder_for(src(240, why="кодек mpeg4")) == ["240"]
    assert ladder_for(src(241, why="кодек mpeg4")) == ["240"]
    assert ladder_for(src(240)) == []


def test_по_умолчанию_лёгкий_оригинал_а_тяжёлый_720():
    """Решение 11 (22.10.2026): «Искра» 2 Мбит/с — в оригинале, камеры H.264 26 Мбит/с — в 720p."""
    assert default_for(src(1080, bitrate=2_100_000)) == SOURCE
    assert default_for(src(1080, bitrate=SOURCE_DEFAULT_BPS + 1)) == "720"
    assert default_for(src(1080, why="кодек mpeg4")) == "720"
    assert default_for(src(600, bitrate=30_000_000)) == "480"
    assert default_for(src(240, why="кодек mpeg4")) == "240"


def test_тяжёлому_оригиналу_ступени_на_карте_жмутся_слабее():
    """Решение 22.10.2026: у монтажа 20-26 Мбит/с потолок не режет — cq 26 вместо 21."""
    assert _cq(720, 26_000_000) == "26"
    assert _cq(480, SOURCE_DEFAULT_BPS + 1) == "26"
    assert _cq(720, 2_100_000) == "21"
    assert _cq(480, 2_100_000) == "22"
    assert _cq(720) == "21"


@pytest.mark.parametrize("size", [(1024, 768), (2688, 1520), (1921, 1081), (641, 481)])
def test_стороны_копии_всегда_чётные(size):
    """yuv420p делит цветность пополам: нечётная сторона кодировщику не
    годится, и ловить это на первом же реальном ролике не хочется."""
    width, height = size
    for quality in ladder_for(src(height)) + [SOURCE]:
        w, h = _params(quality, width, height)["size"]
        assert w % 2 == 0 and h % 2 == 0, f"{quality}: {w}×{h}"
        assert w >= 2 and h >= 2


def test_уборка_знает_про_ступени_и_прежние_перегоны(tmp_path):
    """Ступени переживали удаление ролика и оставались на томе навсегда."""
    video = tmp_path / "abc.mp4"
    for name in ("abc_v720.mp4", "abc_v240.mp4", "abcd_v720.mp4"):
        (tmp_path / name).write_bytes(b"")
    dirs, files = leftovers(str(video))
    assert str(tmp_path / "abc_chunks") in dirs
    assert str(tmp_path / "abc_frames") in dirs
    assert str(tmp_path / "abc_strip.jpg") in files
    assert str(tmp_path / "abc_v720.mp4") in files
    assert str(tmp_path / "abc_v240.mp4") in files
    assert str(tmp_path / "abcd_v720.mp4") not in files
