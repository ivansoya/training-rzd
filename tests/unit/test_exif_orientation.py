"""EXIF-поворот применяется к пикселям на входе: размеры и превью — повёрнутые."""
import io
import zipfile

import pytest

PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

from datasets_svc import importer  # noqa: E402


def _jpeg(w, h, orientation=None):
    buf = io.BytesIO()
    exif = Image.Exif()
    if orientation:
        exif[0x0112] = orientation
    Image.new("RGB", (w, h), (90, 120, 150)).save(buf, "JPEG", exif=exif)
    return buf.getvalue()


def _extract(tmp_path, data):
    zbuf = io.BytesIO()
    with zipfile.ZipFile(zbuf, "w") as z:
        z.writestr("images/train/a.jpg", data)
    with zipfile.ZipFile(zbuf) as z:
        return importer.extract_image(z, "images/train/a.jpg",
                                      str(tmp_path / "a.jpg"), str(tmp_path / "t.jpg"))


def test_повёрнутый_тегом_кадр_ложится_как_видит_человек(tmp_path):
    w, h, _ = _extract(tmp_path, _jpeg(200, 100, orientation=6))
    assert (w, h) == (100, 200)
    with Image.open(tmp_path / "a.jpg") as img:
        assert img.size == (100, 200)
        assert img.getexif().get(0x0112, 1) == 1
    with Image.open(tmp_path / "t.jpg") as thumb:
        assert thumb.size[1] > thumb.size[0]


def test_кадр_без_поворота_пишется_байт_в_байт(tmp_path):
    data = _jpeg(200, 100)
    _extract(tmp_path, data)
    assert (tmp_path / "a.jpg").read_bytes() == data
