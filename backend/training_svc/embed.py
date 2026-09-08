"""Признаки кадров: DINOv2 считает вектор, по которому кадры сходятся в группы.

Живёт здесь, а не в подготовке данных, по одной причине: torch стоит в этом
образе, и тащить его во второй ради одной работы значило бы удвоить три
гигабайта. Заказывает признаки подготовка, считает их этот воркер — очередь
одна, наборы работ разные.

Вход 224 пикселя, а не 518. Нам нужна близость сцен — «это тот же перегон», —
а не мелкие детали; на 518 счёт вчетверо дороже и даёт то же самое.

Веса качаются один раз и живут на томе (``TORCH_HOME``), как веса SAM2. Первый
запуск на машине без сети не заработает, и об этом надо сказать вслух, а не
молча повиснуть.

Скачивание весов — своё, а не ``torch.hub``. Его загрузчик не сверяет длину:
оборвалось соединение после первых килобайт — обрезок ложится в кеш под
настоящим именем и живёт там вечно, а каждый следующий запуск падает на
``torch.load`` с бессмысленным ``Errno 22``. Ровно так и было 07.09.2026:
15 КБ вместо 88 МБ. Здесь длина берётся с сервера, качается в ``.part`` с
докачкой, и в кеш попадает только файл верного размера.

Источников два. Первый — CDN Meta, откуда веса берёт сам dinov2; на той же
сети 07.09.2026 он отдавал 15 КБ и замолкал и с хоста, и из контейнера.
Второй — официальный репозиторий Meta на HuggingFace: те же веса, но в
раскладке ``transformers`` (q, k и v лежат порознь), поэтому ключи
переводятся здесь же, и ``load_state_dict(strict=True)`` не даст переводу
разойтись молча.
"""
import json
import logging
import os
import struct
import threading
import time
import zipfile
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from common import config

log = logging.getLogger("training.embed")

MODEL = os.environ.get("EMBED_MODEL", "dinov2_vits14")
REPO = os.environ.get("EMBED_REPO", "facebookresearch/dinov2")
SIDE = int(os.environ.get("EMBED_SIDE", "224"))
BATCH_GPU = int(os.environ.get("EMBED_BATCH", "64"))
BATCH_CPU = int(os.environ.get("EMBED_BATCH_CPU", "8"))
# Сколько видеопамяти просит счёт признаков. Модель маленькая, и почти всё
# уходит на батч.
VRAM_MB = int(os.environ.get("EMBED_VRAM_MB", "1800"))

# Официальные репозитории Meta на HuggingFace для моделей без регистров.
_HF_REPOS = {
    "dinov2_vits14": "facebook/dinov2-small",
    "dinov2_vitb14": "facebook/dinov2-base",
    "dinov2_vitl14": "facebook/dinov2-large",
    "dinov2_vitg14": "facebook/dinov2-giant",
}


def sources():
    """Откуда брать веса, по порядку. (адрес, раскладка, имя файла в кеше)."""
    out = []
    own = os.environ.get("EMBED_WEIGHTS_URL")
    if own:
        out.append((own, "hub", f"{MODEL}_pretrain.pth"))
    out.append((
        f"https://dl.fbaipublicfiles.com/dinov2/{MODEL}/{MODEL}_pretrain.pth",
        "hub", f"{MODEL}_pretrain.pth",
    ))
    hf = os.environ.get("EMBED_HF_REPO") or _HF_REPOS.get(MODEL)
    if hf:
        out.append((
            f"https://huggingface.co/{hf}/resolve/main/model.safetensors",
            "hf-safetensors", f"{MODEL}_hf.safetensors",
        ))
        out.append((
            f"https://huggingface.co/{hf}/resolve/main/pytorch_model.bin",
            "hf-bin", f"{MODEL}_hf.bin",
        ))
    return out


DOWNLOAD_ATTEMPTS = int(os.environ.get("EMBED_DOWNLOAD_ATTEMPTS", "6"))
# Сколько раз подряд источник может не дать ни байта, прежде чем идём к
# следующему: заблокированный CDN молчит до самого таймаута, и ждать его
# шесть раз по минуте — это те самые «нажал, и ничего».
STALL_LIMIT = int(os.environ.get("EMBED_STALL_LIMIT", "2"))
DOWNLOAD_TIMEOUT = int(os.environ.get("EMBED_DOWNLOAD_TIMEOUT", "40"))
_CHUNK = 1 << 20

_model = None
_lock = threading.Lock()


class WeightsError(RuntimeError):
    """Веса не достать или они битые. Текст показывается человеку целиком."""


def available():
    try:
        import torch  # noqa: F401
        return True
    except Exception:
        return False


def checkpoints_dir():
    """Та же папка, куда клал бы файл torch.hub: уже скачанное не пропадает."""
    return os.path.join(config.EMBED_DIR, "hub", "checkpoints")


def _expected_size(url):
    """Длина файла на сервере. ``None`` — сервер не ответил."""
    try:
        with urlopen(
            Request(url, method="HEAD", headers={"User-Agent": "magistral"}),
            timeout=DOWNLOAD_TIMEOUT,
        ) as r:
            length = r.headers.get("Content-Length")
            return int(length) if length else None
    except (HTTPError, URLError, OSError, ValueError):
        return None


def _well_formed(path, kind):
    """Подпись формата на месте: zip у torch, разбираемый заголовок у safetensors."""
    try:
        if kind == "hf-safetensors":
            with open(path, "rb") as fh:
                (n,) = struct.unpack("<Q", fh.read(8))
                if n <= 0 or n > (1 << 26):
                    return False
                json.loads(fh.read(n))
            return True
        return zipfile.is_zipfile(path)
    except (OSError, ValueError, struct.error):
        return False


def _looks_whole(path, expected, kind):
    """Файл на месте, нужной длины и того формата — иначе это обрезок."""
    if not os.path.isfile(path):
        return False
    size = os.path.getsize(path)
    if expected is not None and size != expected:
        return False
    if expected is None and size < (1 << 20):
        return False
    return _well_formed(path, kind)


def _download(url, part, expected, kind, on_progress):
    """Скачать в ``part`` с докачкой. ``None`` — источник не отдал файл."""
    last = None
    stalls = 0
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        have = os.path.getsize(part) if os.path.exists(part) else 0
        if have > expected:
            os.remove(part)
            have = 0
        before = have
        try:
            if have < expected:
                headers = {"User-Agent": "magistral"}
                if have:
                    headers["Range"] = f"bytes={have}-"
                if on_progress is not None:
                    on_progress(have, expected)
                with urlopen(Request(url, headers=headers),
                             timeout=DOWNLOAD_TIMEOUT) as r:
                    # Сервер мог не понять Range и прислать всё с начала.
                    mode = "ab" if (have and r.status == 206) else "wb"
                    if mode == "wb":
                        have = 0
                    with open(part, mode) as fh:
                        while True:
                            buf = r.read(_CHUNK)
                            if not buf:
                                break
                            fh.write(buf)
                            have += len(buf)
                            if on_progress is not None:
                                on_progress(have, expected)
            if have == expected and _well_formed(part, kind):
                return part
            last = f"получено {have} байт из {expected}"
            if have == expected:
                # Длина сошлась, но формат не тот — сервер отдал не то. С нуля.
                os.remove(part)
                have = 0
        except (HTTPError, URLError, OSError) as exc:
            last = str(exc)
        stalls = stalls + 1 if have <= before else 0
        log.warning("веса %s, попытка %d/%d не удалась: %s",
                    url, attempt, DOWNLOAD_ATTEMPTS, last)
        if stalls >= STALL_LIMIT:
            log.warning("источник %s не отдаёт ни байта — идём к следующему", url)
            break
        time.sleep(min(30, 2 ** attempt))
    return None


def ensure_weights(on_progress=None):
    """(путь, раскладка) целых весов. Сперва кеш, потом источники по порядку."""
    folder = checkpoints_dir()
    os.makedirs(folder, exist_ok=True)
    todo = sources()

    # Уже скачанное — любой раскладки — годится без сети.
    for url, kind, name in todo:
        path = os.path.join(folder, name)
        if os.path.isfile(path) and os.path.getsize(path) >= (1 << 20) \
                and _well_formed(path, kind):
            return path, kind

    silent = []
    failed = []
    for url, kind, name in todo:
        path = os.path.join(folder, name)
        expected = _expected_size(url)
        if expected is None:
            silent.append(url)
            continue
        if _looks_whole(path, expected, kind):
            return path, kind
        if os.path.exists(path):
            log.warning("веса %s битые (%d байт, ждали %d) — качаю заново",
                        path, os.path.getsize(path), expected)
            os.remove(path)
        got = _download(url, path + ".part", expected, kind, on_progress)
        if got is not None:
            os.replace(got, path)
            log.info("веса DINOv2 скачаны: %s (%d байт) из %s", path, expected, url)
            return path, kind
        failed.append(url)

    where = folder
    if silent and not failed:
        raise WeightsError(
            "Сервер весов DINOv2 не отвечает, а на диске целых весов нет. "
            f"Нужен доступ с сервера к одному из адресов: {', '.join(silent)} — "
            f"или положите файл руками в {where}."
        )
    raise WeightsError(
        "Не удалось скачать веса DINOv2 ни с одного источника: "
        f"{', '.join(failed + silent)}. Можно положить файл руками в {where}."
    )


# --------------------------------------------------------------------------- #
# Раскладка HuggingFace → раскладка dinov2
# --------------------------------------------------------------------------- #
_SAFETENSORS_DTYPES = {
    "F32": "float32", "F16": "float16", "BF16": "bfloat16",
    "F64": "float64", "I64": "int64", "I32": "int32",
}


def _read_safetensors(path):
    """Тензоры safetensors без самой библиотеки: её нет в образе, а формат —
    восемь байт длины, JSON-заголовок и сырые байты подряд."""
    import numpy as np
    import torch

    out = {}
    with open(path, "rb") as fh:
        (n,) = struct.unpack("<Q", fh.read(8))
        header = json.loads(fh.read(n))
        base = 8 + n
        for key, meta in header.items():
            if key == "__metadata__":
                continue
            start, end = meta["data_offsets"]
            fh.seek(base + start)
            raw = fh.read(end - start)
            dtype = meta["dtype"]
            if dtype == "BF16":
                # numpy не знает bfloat16: читаем как uint16 и сдвигаем в float32.
                arr = np.frombuffer(raw, dtype=np.uint16).astype(np.uint32) << 16
                tensor = torch.from_numpy(arr.view(np.float32).copy())
            else:
                tensor = torch.from_numpy(
                    np.frombuffer(raw, dtype=_SAFETENSORS_DTYPES[dtype]).copy()
                )
            out[key] = tensor.reshape(meta["shape"])
    return out


def _from_hf(state):
    """Ключи transformers → ключи dinov2. Обратно тому, что делает скрипт
    конвертации HF: там qkv режется на три, здесь три склеиваются в qkv."""
    import torch

    out = {
        "cls_token": state["embeddings.cls_token"],
        "mask_token": state["embeddings.mask_token"],
        "pos_embed": state["embeddings.position_embeddings"],
        "patch_embed.proj.weight": state["embeddings.patch_embeddings.projection.weight"],
        "patch_embed.proj.bias": state["embeddings.patch_embeddings.projection.bias"],
        "norm.weight": state["layernorm.weight"],
        "norm.bias": state["layernorm.bias"],
    }
    i = 0
    while f"encoder.layer.{i}.norm1.weight" in state:
        src = f"encoder.layer.{i}."
        dst = f"blocks.{i}."
        att = src + "attention.attention."
        out[dst + "attn.qkv.weight"] = torch.cat(
            [state[att + "query.weight"], state[att + "key.weight"],
             state[att + "value.weight"]], dim=0)
        out[dst + "attn.qkv.bias"] = torch.cat(
            [state[att + "query.bias"], state[att + "key.bias"],
             state[att + "value.bias"]], dim=0)
        out[dst + "attn.proj.weight"] = state[src + "attention.output.dense.weight"]
        out[dst + "attn.proj.bias"] = state[src + "attention.output.dense.bias"]
        out[dst + "ls1.gamma"] = state[src + "layer_scale1.lambda1"]
        out[dst + "ls2.gamma"] = state[src + "layer_scale2.lambda1"]
        for part in ("norm1", "norm2"):
            for p in ("weight", "bias"):
                out[f"{dst}{part}.{p}"] = state[f"{src}{part}.{p}"]
        for part in ("fc1", "fc2"):
            for p in ("weight", "bias"):
                out[f"{dst}mlp.{part}.{p}"] = state[f"{src}mlp.{part}.{p}"]
        i += 1
    if i == 0:
        raise WeightsError("В файле HuggingFace не нашлось ни одного слоя DINOv2.")
    return out


def read_state(path, kind):
    """Словарь весов в раскладке dinov2 из файла любой поддержанной раскладки."""
    import torch

    if kind == "hub":
        return torch.load(path, map_location="cpu", weights_only=True)
    if kind == "hf-safetensors":
        return _from_hf(_read_safetensors(path))
    if kind == "hf-bin":
        return _from_hf(torch.load(path, map_location="cpu", weights_only=True))
    raise WeightsError(f"Неизвестная раскладка весов: {kind}")


def load(device="cpu", on_progress=None):
    """Модель. Один раз на процесс — она маленькая, но грузится секунды.

    Код сети берёт torch.hub (он умеет кешировать репозиторий), а веса —
    ``ensure_weights``: hub с ``pretrained=False`` сеть строит, но ничего не
    качает, и обрезок в его кеше оказаться не может.
    """
    global _model
    with _lock:
        if _model is None:
            import torch

            os.environ.setdefault("TORCH_HOME", config.EMBED_DIR)
            os.makedirs(config.EMBED_DIR, exist_ok=True)
            path, kind = ensure_weights(on_progress)
            try:
                net = torch.hub.load(REPO, MODEL, pretrained=False, trust_repo=True)
            except Exception as exc:  # noqa: BLE001
                raise WeightsError(
                    f"Не удалось получить код DINOv2 ({REPO}) с GitHub: {exc}"
                ) from exc
            try:
                net.load_state_dict(read_state(path, kind), strict=True)
            except Exception as exc:  # noqa: BLE001
                # Файл прошёл проверку длины, но не читается — не верим ему
                # больше и не оставляем следующему запуску.
                try:
                    os.remove(path)
                except OSError:
                    pass
                raise WeightsError(
                    "Веса DINOv2 не читаются и удалены, следующий запуск "
                    f"скачает их заново: {exc}"
                ) from exc
            net.eval()
            _model = net
        model = _model
    import torch

    return model.to(torch.device(device))


def _prepare(paths, device):
    """Кадры в тензор: короткая сторона в 224, центральный кроп, нормировка."""
    import numpy as np
    import torch
    from PIL import Image

    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)

    batch = []
    for path in paths:
        with Image.open(path) as raw:
            img = raw.convert("RGB")
            w, h = img.size
            scale = SIDE / min(w, h)
            img = img.resize(
                (max(SIDE, int(round(w * scale))),
                 max(SIDE, int(round(h * scale)))),
                Image.BILINEAR,
            )
            w, h = img.size
            left, top = (w - SIDE) // 2, (h - SIDE) // 2
            img = img.crop((left, top, left + SIDE, top + SIDE))
            arr = np.asarray(img, dtype=np.float32) / 255.0
        arr = (arr - mean) / std
        batch.append(arr.transpose(2, 0, 1))
    return torch.from_numpy(np.stack(batch)).to(torch.device(device))


def vectors_for(paths, device="cpu", on_progress=None, on_download=None):
    """Векторы кадров. Возвращает список numpy-массивов в том же порядке."""
    import torch

    model = load(device, on_download)
    size = BATCH_GPU if str(device) != "cpu" else BATCH_CPU
    out = []
    with torch.inference_mode():
        for start in range(0, len(paths), size):
            chunk = paths[start:start + size]
            tensor = _prepare(chunk, device)
            if str(device) != "cpu":
                tensor = tensor.half()
                model_half = model.half()
                got = model_half(tensor)
            else:
                got = model(tensor)
            out.extend(got.float().cpu().numpy())
            if on_progress is not None:
                on_progress(min(start + size, len(paths)), len(paths))
    return out
