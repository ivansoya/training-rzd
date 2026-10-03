"""Общая загрузка весов: целый файл берётся без сети, обрезок перекачивается."""
import io
import os
import zipfile

import pytest

from common import download


def _zip_bytes():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("data.pkl", b"x" * 4096)
    return buf.getvalue()


class Resp(io.BytesIO):
    def __init__(self, body, status=200):
        super().__init__(body)
        self.status = status
        self.headers = {"Content-Length": str(len(body))}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_целый_файл_без_сети(tmp_path):
    path = str(tmp_path / "w.pt")
    open(path, "wb").write(_zip_bytes())

    def no_net(*a, **k):
        raise AssertionError("сеть не нужна")

    assert download.ensure_file("http://x/w.pt", path, zipfile.is_zipfile, opener=no_net) == path


def test_обрезок_перекачивается(tmp_path):
    body = _zip_bytes()
    path = str(tmp_path / "w.pt")
    open(path, "wb").write(body[:100])
    got = download.ensure_file("http://x/w.pt", path, zipfile.is_zipfile,
                               opener=lambda req, timeout=None: Resp(body),
                               sleep=lambda *_: None)
    assert got == path and open(path, "rb").read() == body
    assert not os.path.exists(path + ".part")


def test_молчащий_источник_это_ошибка_а_не_пустой_файл(tmp_path):
    def mute(*a, **k):
        raise OSError("timed out")

    with pytest.raises(RuntimeError):
        download.ensure_file("http://x/w.pt", str(tmp_path / "w.pt"), zipfile.is_zipfile,
                             opener=mute, sleep=lambda *_: None)
