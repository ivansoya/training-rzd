"""Веса DINOv2: в кеш попадает только целый файл, источников два.

Без torch — проверяется загрузчик, а не сеть. Сервер подменён: он умеет
рвать соединение на середине, не понимать Range, отдавать не то и молчать
до таймаута. Ровно эти случаи и рождали обрезок в 15 КБ, с которым умное
деление стояло на нуле без единого слова.
"""
import io
import json
import os
import struct
import zipfile

import pytest

from training_svc import embed


def zip_bytes(size):
    """Настоящий zip нужной длины: проверка целости смотрит на подпись."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("data.pkl", b"p" * max(0, size - 200))
    data = buf.getvalue()
    if len(data) < size:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("data.pkl", b"p" * max(0, size - 200))
            zf.comment = b"c" * (size - len(data))
        data = buf.getvalue()
    assert len(data) == size, (len(data), size)
    return data


def safetensors_bytes(size):
    header = json.dumps({"x": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}).encode()
    body = struct.pack("<Q", len(header)) + header
    return body + b"\0" * (size - len(body))


class FakeResponse:
    def __init__(self, body, status):
        self._body = io.BytesIO(body)
        self.status = status

    def read(self, n):
        return self._body.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class FakeServer:
    """Сервер весов на несколько адресов.

    ``files`` — адрес → байты; ``cuts`` — адрес → на каких байтах рвать
    соединение в очередные заходы; ``mute`` — адреса, молчащие до таймаута.
    """

    def __init__(self, files, cuts=None, ranges=True, mute=()):
        self.files = files
        self.cuts = {k: list(v) for k, v in (cuts or {}).items()}
        self.ranges = ranges
        self.mute = set(mute)
        self.calls = []

    def __call__(self, req, timeout=None):
        url = req.full_url
        if url in self.mute:
            self.calls.append((url, "timeout"))
            raise OSError("The read operation timed out")
        rng = req.headers.get("Range")
        start = 0
        status = 200
        if rng and self.ranges:
            start = int(rng.split("=")[1].rstrip("-"))
            status = 206
        body = self.files[url][start:]
        if self.cuts.get(url):
            body = body[: self.cuts[url].pop(0)]
        self.calls.append((url, start, status, len(body)))
        return FakeResponse(body, status)

    def size_of(self, url):
        return len(self.files[url]) if url in self.files else None


HUB = "https://cdn.test/dinov2_vits14_pretrain.pth"
HF = "https://hf.test/model.safetensors"


@pytest.fixture(autouse=True)
def quiet(tmp_path, monkeypatch):
    monkeypatch.setattr(embed.config, "EMBED_DIR", str(tmp_path))
    monkeypatch.setattr(embed.time, "sleep", lambda *_: None)
    monkeypatch.setattr(embed, "DOWNLOAD_ATTEMPTS", 4)
    monkeypatch.setattr(embed, "STALL_LIMIT", 2)
    yield


def serve(monkeypatch, server, srcs):
    monkeypatch.setattr(embed, "urlopen", server)
    monkeypatch.setattr(embed, "_expected_size", server.size_of)
    monkeypatch.setattr(embed, "sources", lambda: srcs)


def hub_only(server_files, **kw):
    return FakeServer(server_files, **kw), [(HUB, "hub", "dinov2_vits14_pretrain.pth")]


def hub_path():
    return os.path.join(embed.checkpoints_dir(), "dinov2_vits14_pretrain.pth")


def put(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


def test_обрезок_в_кеше_заменяется_целым_файлом(monkeypatch):
    data = zip_bytes(50_000)
    put(hub_path(), data[:15_778])          # ровно то, что лежало на томе
    server, srcs = hub_only({HUB: data})
    serve(monkeypatch, server, srcs)

    assert embed.ensure_weights() == (hub_path(), "hub")
    assert os.path.getsize(hub_path()) == len(data)
    assert server.calls, "битый файл должны были перекачать"


def test_целый_файл_берётся_из_кеша_без_сети(monkeypatch):
    data = zip_bytes(2 << 20)
    put(hub_path(), data)
    server, srcs = hub_only({HUB: data})
    serve(monkeypatch, server, srcs)
    monkeypatch.setattr(embed, "_expected_size", lambda url: (_ for _ in ()).throw(AssertionError("сеть не нужна")))

    assert embed.ensure_weights() == (hub_path(), "hub")
    assert server.calls == []


def test_оборванное_соединение_докачивается_с_места(monkeypatch):
    data = zip_bytes(100_000)
    server, srcs = hub_only({HUB: data}, cuts={HUB: [10_000, 30_000]})
    serve(monkeypatch, server, srcs)
    seen = []

    path, kind = embed.ensure_weights(on_progress=lambda have, total: seen.append(have))
    with open(path, "rb") as fh:
        assert fh.read() == data
    # Первый заход с нуля, второй — с 10 000, третий — с 40 000.
    assert [c[1] for c in server.calls] == [0, 10_000, 40_000]
    assert seen[0] == 0 and seen[-1] == len(data)


def test_сервер_без_range_начинает_с_нуля_и_всё_равно_сходится(monkeypatch):
    data = zip_bytes(60_000)
    server, srcs = hub_only({HUB: data}, cuts={HUB: [20_000]}, ranges=False)
    serve(monkeypatch, server, srcs)

    path, _ = embed.ensure_weights()
    with open(path, "rb") as fh:
        assert fh.read() == data


def test_вечно_рвущийся_источник_это_понятная_ошибка_а_не_обрезок(monkeypatch):
    data = zip_bytes(60_000)
    server, srcs = hub_only({HUB: data}, cuts={HUB: [1_000] * 10})
    serve(monkeypatch, server, srcs)

    with pytest.raises(embed.WeightsError) as caught:
        embed.ensure_weights()
    assert "ни с одного источника" in str(caught.value)
    assert "положить файл руками" in str(caught.value)
    assert not os.path.exists(hub_path())


def test_не_zip_нужной_длины_не_принимается(monkeypatch):
    junk = b"<html>not found</html>" * 1000
    server, srcs = hub_only({HUB: junk})
    serve(monkeypatch, server, srcs)

    with pytest.raises(embed.WeightsError):
        embed.ensure_weights()
    assert not os.path.exists(hub_path())


def test_без_сети_и_без_файла_говорим_прямо(monkeypatch):
    server, srcs = hub_only({})
    serve(monkeypatch, server, srcs)
    with pytest.raises(embed.WeightsError) as caught:
        embed.ensure_weights()
    assert "не отвечает" in str(caught.value)
    assert "руками" in str(caught.value)


def test_молчащий_cdn_уступает_второму_источнику_после_двух_заходов(monkeypatch):
    """Ровно случай 07.09.2026: HEAD отвечает, GET молчит до таймаута."""
    hub = zip_bytes(70_000)
    hf = safetensors_bytes(80_000)
    server = FakeServer({HUB: hub, HF: hf}, mute={HUB})
    srcs = [(HUB, "hub", "dinov2_vits14_pretrain.pth"), (HF, "hf-safetensors", "dinov2_vits14_hf.safetensors")]
    serve(monkeypatch, server, srcs)

    path, kind = embed.ensure_weights()
    assert kind == "hf-safetensors"
    assert os.path.getsize(path) == len(hf)
    # CDN дёрнули дважды, не шесть раз.
    assert sum(1 for c in server.calls if c[0] == HUB) == 2


def test_кеш_второго_источника_годится_без_сети(monkeypatch):
    hf = safetensors_bytes(2 << 20)
    path = os.path.join(embed.checkpoints_dir(), "dinov2_vits14_hf.safetensors")
    put(path, hf)
    server = FakeServer({})
    srcs = [(HUB, "hub", "dinov2_vits14_pretrain.pth"), (HF, "hf-safetensors", "dinov2_vits14_hf.safetensors")]
    serve(monkeypatch, server, srcs)
    assert embed.ensure_weights() == (path, "hf-safetensors")
    assert server.calls == []


def test_перевод_ключей_huggingface_в_раскладку_dinov2():
    torch = pytest.importorskip("torch")
    d, layers = 8, 2
    state = {
        "embeddings.cls_token": torch.zeros(1, 1, d),
        "embeddings.mask_token": torch.zeros(1, d),
        "embeddings.position_embeddings": torch.zeros(1, 5, d),
        "embeddings.patch_embeddings.projection.weight": torch.zeros(d, 3, 2, 2),
        "embeddings.patch_embeddings.projection.bias": torch.zeros(d),
        "layernorm.weight": torch.ones(d),
        "layernorm.bias": torch.zeros(d),
    }
    for i in range(layers):
        p = f"encoder.layer.{i}."
        for name in ("query", "key", "value"):
            state[p + f"attention.attention.{name}.weight"] = torch.full((d, d), float("qkv".index(name[0])))
            state[p + f"attention.attention.{name}.bias"] = torch.zeros(d)
        state[p + "attention.output.dense.weight"] = torch.zeros(d, d)
        state[p + "attention.output.dense.bias"] = torch.zeros(d)
        state[p + "layer_scale1.lambda1"] = torch.ones(d)
        state[p + "layer_scale2.lambda1"] = torch.ones(d)
        for part in ("norm1", "norm2"):
            state[p + part + ".weight"] = torch.ones(d)
            state[p + part + ".bias"] = torch.zeros(d)
        state[p + "mlp.fc1.weight"] = torch.zeros(4 * d, d)
        state[p + "mlp.fc1.bias"] = torch.zeros(4 * d)
        state[p + "mlp.fc2.weight"] = torch.zeros(d, 4 * d)
        state[p + "mlp.fc2.bias"] = torch.zeros(d)

    out = embed._from_hf(state)
    qkv = out["blocks.1.attn.qkv.weight"]
    assert qkv.shape == (3 * d, d)
    # Порядок склейки — q, k, v: ровно так их режет обратный скрипт HF.
    assert qkv[0, 0] == 0 and qkv[d, 0] == 1 and qkv[2 * d, 0] == 2
    assert "blocks.1.ls2.gamma" in out and "norm.weight" in out
    assert not any(k.startswith("encoder.") for k in out)
