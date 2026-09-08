"""Обвязка ultralytics: модели, параметры обучения, аугментации.

Тяжёлые зависимости (torch, ultralytics) берутся лениво, чтобы остальной
сервис работал и без них.

Три вещи решаются здесь, а не в бегуне.

**Встроенные модели — предобученные.** ``spec`` у каждой — файл ``.pt``;
описание сети ``.yaml`` лежит рядом в ``scratch`` и берётся только по явной
галочке «с нуля». До 08.09.2026 было наоборот, и никто этого не видел:
``pretrained: true`` в args.yaml при yaml-модели ничего не значит.

**Аугментации — либо графа, либо YOLO, но не обе.** Набор, собранный графом,
уже размножен и искажён на диске; поверх него встроенные аугментации YOLO
выключаются целиком. Набор без графа получает рекомендуемые значения
ultralytics — мозаику, цвет, отражение, масштаб, — и человек может их
подкрутить или выключить. Без них сто эпох на одних и тех же кадрах — это
запоминание: потери обучения падают в тридцать раз, а на проверке растут.

**Параметры проходят через спецификацию.** Что можно задать, какого типа и
в каких пределах — одно место; ручка и бегун берут отсюда, интерфейс
получает то же самое по API и не держит своих умолчаний.
"""
import contextlib
import os

# Keep ultralytics' writable config/cache off the data volume.
os.environ.setdefault("YOLO_CONFIG_DIR", "/tmp/ultralytics")
os.environ.setdefault("MPLCONFIGDIR", "/tmp/mpl")

# Все ручки аугментаций YOLO в положении «выключено». Применяется к наборам
# из графа и по выбору «без аугментаций».
DISABLED_AUG = {
    "hsv_h": 0.0, "hsv_s": 0.0, "hsv_v": 0.0,
    "degrees": 0.0, "translate": 0.0, "scale": 0.0, "shear": 0.0,
    "perspective": 0.0, "flipud": 0.0, "fliplr": 0.0, "bgr": 0.0,
    "mosaic": 0.0, "mixup": 0.0, "copy_paste": 0.0, "erasing": 0.0,
    "auto_augment": None, "close_mosaic": 0,
}

# Рекомендуемые значения ultralytics (default.yaml, 8.4) — то, с чем сама
# библиотека учит детекторы на COCO. `erasing` и `auto_augment` сюда не
# входят: они про классификацию.
YOLO_AUG_DEFAULTS = {
    "hsv_h": 0.015, "hsv_s": 0.7, "hsv_v": 0.4,
    "degrees": 0.0, "translate": 0.1, "scale": 0.5, "shear": 0.0,
    "perspective": 0.0, "flipud": 0.0, "fliplr": 0.5, "bgr": 0.0,
    "mosaic": 1.0, "mixup": 0.0, "copy_paste": 0.0, "close_mosaic": 10,
}
AUG_KEYS = tuple(YOLO_AUG_DEFAULTS)

# Спецификация параметров: тип, пределы, умолчание. Единственный источник и
# для проверки на входе, и для формы запуска (уезжает в /api/models).
# `group` — только для формы; `ultralytics: False` — параметр наш, а не
# библиотеки, и в model.train() не передаётся.
PARAM_SPEC = {
    # --- основное ---
    "epochs": {"type": "int", "min": 1, "max": 1000, "default": 100,
               "group": "main"},
    "imgsz": {"type": "int", "min": 64, "max": 2048, "default": 640,
              "step": 32, "group": "main"},
    "batch": {"type": "int", "min": 1, "max": 128, "default": 16,
              "group": "main"},
    "pretrained": {"type": "bool", "default": True, "group": "main",
                   "ultralytics": False},
    # --- остановка ---
    # Сколько эпох ждать улучшения. У ultralytics умолчание 100 — на
    # стоэпоховом обучении это «никогда». Тридцать: пик на «Варане» был на
    # 24-й эпохе, а дальше два часа ушли впустую. Ноль — не останавливать.
    "patience": {"type": "int", "min": 0, "max": 1000, "default": 30,
                 "group": "stop"},
    # --- оптимизация ---
    "optimizer": {"type": "str", "default": "auto", "group": "optim",
                  "choices": ["auto", "SGD", "Adam", "AdamW", "NAdam",
                              "RAdam", "RMSProp"]},
    "lr0": {"type": "float", "min": 1e-6, "max": 1.0, "default": 0.01,
            "group": "optim"},
    "lrf": {"type": "float", "min": 1e-4, "max": 1.0, "default": 0.01,
            "group": "optim"},
    "momentum": {"type": "float", "min": 0.0, "max": 0.999, "default": 0.937,
                 "group": "optim"},
    "weight_decay": {"type": "float", "min": 0.0, "max": 0.1,
                     "default": 0.0005, "group": "optim"},
    "warmup_epochs": {"type": "float", "min": 0.0, "max": 20.0,
                      "default": 3.0, "group": "optim"},
    "cos_lr": {"type": "bool", "default": False, "group": "optim"},
    # --- регуляризация и дообучение ---
    "freeze": {"type": "int", "min": 0, "max": 30, "default": 0,
               "group": "reg"},
    "dropout": {"type": "float", "min": 0.0, "max": 0.9, "default": 0.0,
                "group": "reg"},
    "label_smoothing": {"type": "float", "min": 0.0, "max": 0.5,
                        "default": 0.0, "group": "reg"},
    # --- прочее ---
    "seed": {"type": "int", "min": 0, "max": 2**31 - 1, "default": 0,
             "group": "misc"},
    "workers": {"type": "int", "min": 0, "max": 16, "default": None,
                "group": "misc"},
    # --- аугментации YOLO ---
    "augment_mode": {"type": "str", "default": "yolo", "group": "aug",
                     "choices": ["yolo", "off"], "ultralytics": False},
    "hsv_h": {"type": "float", "min": 0.0, "max": 1.0, "group": "aug"},
    "hsv_s": {"type": "float", "min": 0.0, "max": 1.0, "group": "aug"},
    "hsv_v": {"type": "float", "min": 0.0, "max": 1.0, "group": "aug"},
    "degrees": {"type": "float", "min": 0.0, "max": 180.0, "group": "aug"},
    "translate": {"type": "float", "min": 0.0, "max": 1.0, "group": "aug"},
    "scale": {"type": "float", "min": 0.0, "max": 1.0, "group": "aug"},
    "shear": {"type": "float", "min": 0.0, "max": 180.0, "group": "aug"},
    "perspective": {"type": "float", "min": 0.0, "max": 0.001, "group": "aug"},
    "flipud": {"type": "float", "min": 0.0, "max": 1.0, "group": "aug"},
    "fliplr": {"type": "float", "min": 0.0, "max": 1.0, "group": "aug"},
    "bgr": {"type": "float", "min": 0.0, "max": 1.0, "group": "aug"},
    "mosaic": {"type": "float", "min": 0.0, "max": 1.0, "group": "aug"},
    "mixup": {"type": "float", "min": 0.0, "max": 1.0, "group": "aug"},
    "copy_paste": {"type": "float", "min": 0.0, "max": 1.0, "group": "aug"},
    "close_mosaic": {"type": "int", "min": 0, "max": 1000, "group": "aug"},
}
for _key in AUG_KEYS:
    PARAM_SPEC[_key]["default"] = YOLO_AUG_DEFAULTS[_key]

ALLOWED_PARAMS = frozenset(PARAM_SPEC)
# Что уходит в model.train() как есть. Аугментации идут отдельно — через
# aug_overrides, где решается, включать ли их вообще.
TRAIN_KEYS = tuple(
    k for k, s in PARAM_SPEC.items()
    if s.get("ultralytics", True) and k not in AUG_KEYS
)


# Встроенные модели. `spec` — предобученные веса (COCO), `scratch` — описание
# сети для обучения с нуля. Вид набора решает, какие показать: набор боксов
# и сегментационная модель — несовместимая пара, и выбрать её должно быть
# просто невозможно, а не «можно, но потом не обучится».
#
# YOLO26 — новое семейство ultralytics (конец 2025): без NMS, с той же
# обвязкой обучения; веса лежат в том же выпуске, что и yolo11.
def _family(prefix, title, sizes, note=""):
    out = []
    for letter, size in sizes:
        for suffix, task in (("", "detect"), ("-seg", "segment")):
            ident = f"{prefix}{letter}{suffix}"
            out.append({
                "id": ident,
                "name": f"{title}{letter}{suffix}",
                "spec": f"{ident}.pt",
                "scratch": f"{ident}.yaml",
                "task": task,
                "size": size,
                "note": note,
            })
    return out


BUILTIN_MODELS = (
    _family("yolo11", "YOLO11", [("n", "самая лёгкая"), ("s", "лёгкая"),
                                 ("m", "средняя")])
    + _family("yolo26", "YOLO26", [("n", "самая лёгкая"), ("s", "лёгкая"),
                                   ("m", "средняя")],
              note="без NMS, новее")
    + _family("yolov8", "YOLOv8", [("n", "самая лёгкая"), ("s", "лёгкая")])
)

# Задача набора → задача модели.
TASK_OF_KIND = {"bbox": "detect", "polygon": "segment"}

# Сколько видеопамяти просить, пока нет ни одного замера. Числа сняты с
# RTX 4090 и умножены на полтора: недооценка стоит нехватки памяти посреди
# трёхчасового обучения, переоценка — минут ожидания.
FALLBACK_VRAM_MB = {
    ("detect", "n"): 3200, ("detect", "s"): 5200,
    ("detect", "m"): 8600, ("detect", "l"): 12800,
    ("segment", "n"): 4200, ("segment", "s"): 6800,
    ("segment", "m"): 11000, ("segment", "l"): 16000,
}


def estimate_vram(model_id, task, imgsz, batch):
    """Прикидка расхода видеопамяти до первого замера.

    Растёт с площадью кадра и линейно с батчем: и то, и другое множит размер
    промежуточных карт признаков.
    """
    letter = "s"
    for mark in ("n", "s", "m", "l", "x"):
        if model_id.replace("-seg", "").endswith(mark):
            letter = mark
            break
    base = FALLBACK_VRAM_MB.get((task, letter), 6000)
    area = (float(imgsz or 640) / 640.0) ** 2
    return int(base * area * (float(batch or 16) / 16.0))


def is_available():
    try:
        import torch  # noqa: F401
        import ultralytics  # noqa: F401
        return True
    except Exception:
        return False


def list_devices():
    """Report CPU + any available CUDA GPUs."""
    info = {"cuda_available": False, "gpus": []}
    try:
        import torch
        if torch.cuda.is_available():
            info["cuda_available"] = True
            for i in range(torch.cuda.device_count()):
                info["gpus"].append({"index": i, "name": torch.cuda.get_device_name(i)})
    except Exception:
        pass
    return info


# --------------------------------------------------------------------------- #
# Параметры
# --------------------------------------------------------------------------- #
_TRUE = ("1", "true", "yes", "on", "да")


def _coerce(spec, value):
    """Значение по спецификации — или None, если не привести."""
    kind = spec["type"]
    try:
        if kind == "bool":
            if isinstance(value, str):
                return value.strip().lower() in _TRUE
            return bool(value)
        if kind == "int":
            got = int(round(float(value)))
        elif kind == "float":
            got = float(value)
        else:
            got = str(value).strip()
            if "choices" in spec and got not in spec["choices"]:
                return None
            return got
    except (TypeError, ValueError):
        return None
    if got != got:   # NaN
        return None
    lo, hi = spec.get("min"), spec.get("max")
    if lo is not None and got < lo:
        got = lo
    if hi is not None and got > hi:
        got = hi
    return got


def filter_params(params):
    """Только известные ключи, приведённые к типу и зажатые в пределы.

    Зажимаем, а не отвергаем: форма и так не даст выйти за пределы, а
    запрос по API с `lr0: 5` пусть учится с единицей, чем падает с 400 на
    сороковой минуте очереди.
    """
    out = {}
    for key, value in (params or {}).items():
        spec = PARAM_SPEC.get(key)
        if spec is None or value is None or value == "":
            continue
        got = _coerce(spec, value)
        if got is not None:
            out[key] = got
    return out


def param_spec_view():
    """Спецификация для формы: те же пределы и умолчания, что и здесь."""
    return {
        key: {k: v for k, v in spec.items() if k != "ultralytics"}
        for key, spec in PARAM_SPEC.items()
    }


def aug_overrides(params, has_graph):
    """Ручки аугментаций для model.train() и словом — какой режим вышел.

    Граф побеждает всё: его набор уже размножен и искажён на диске, и
    аугментации YOLO поверх него дали бы двойное искажение и потерю
    воспроизводимости — граф обещает те же картинки по тому же зерну.
    """
    if has_graph:
        return dict(DISABLED_AUG), "graph"
    mode = (params or {}).get("augment_mode") or "yolo"
    if mode != "yolo":
        return dict(DISABLED_AUG), "off"
    out = dict(DISABLED_AUG)
    out.update(YOLO_AUG_DEFAULTS)
    for key in AUG_KEYS:
        if key in params:
            out[key] = params[key]
    return out, "yolo"


def train_overrides(params):
    """Параметры, которые уходят в model.train() как есть."""
    return {k: params[k] for k in TRAIN_KEYS if k in params}


def resolve_weights(spec, on_progress=None):
    """Что отдать в ``YOLO(...)``: путь к весам на томе или описание сети.

    Порядок: готовый путь → файл под DATA_DIR (свои модели) → голое имя
    ``.pt`` (встроенная предобученная, качается на том) → всё остальное
    как есть (``.yaml`` — сеть с нуля).
    """
    from common import config
    from training_svc import weights

    spec = str(spec or "").strip()
    if os.path.isabs(spec) and os.path.isfile(spec):
        return spec
    under = os.path.join(config.DATA_DIR, spec)
    if spec and os.path.isfile(under):
        return under
    bare = os.path.basename(spec) == spec
    if bare and spec.endswith(".pt"):
        return weights.ensure(spec, on_progress)
    return spec


def _disable_builtin_albumentations():
    """Neutralize ultralytics' optional Albumentations block (Blur/CLAHE/…)."""
    try:
        from ultralytics.data import augment as _aug
        _aug.Albumentations.__call__ = lambda self, labels: labels
    except Exception:
        pass


# Закреплённая память загрузчиков. По умолчанию выключена — и это не вкус.
# 07.09.2026 на этом стенде (Docker Desktop, WSL2) измерено: закрепить
# получается ровно 1 ГиБ, дальше «CUDA error: out of memory» — при
# одиннадцати свободных гигабайтах на карте. Обучение доходило до первой
# проверки и падало в потоке закрепления: проверочный загрузчик берёт
# батч вдвое больше, и с четырьмя воркерами их буферы через гигабайт
# переваливают. Ultralytics 8.4 переключателя не даёт — ``build_dataloader``
# принимает ``pin_memory`` доводом, но трейнер и валидатор его не передают,
# поэтому довод подставляется здесь. Цена — чуть медленнее копирование на
# карту; на настоящем железе можно вернуть: ``TRAIN_PIN_MEMORY=true``.
PIN_MEMORY = os.environ.get("TRAIN_PIN_MEMORY", "false").strip().lower() in (
    "1", "true", "yes", "да",
)


def pin_memory_policy():
    if PIN_MEMORY:
        return
    import functools

    from ultralytics.data import build as build_mod

    original = build_mod.build_dataloader
    if getattr(original, "_magistral_pinned_off", False):
        return

    @functools.wraps(original)
    def unpinned(*args, **kwargs):
        kwargs["pin_memory"] = False
        return original(*args, **kwargs)

    unpinned._magistral_pinned_off = True
    # Имя привязано в каждом модуле при импорте — подменяем везде, где оно
    # уже взято, иначе трейнер продолжит звать оригинал.
    import ultralytics.data as data_pkg
    from ultralytics.models.yolo.detect import train as det_train
    from ultralytics.models.yolo.detect import val as det_val

    for mod in (build_mod, data_pkg, det_train, det_val):
        setattr(mod, "build_dataloader", unpinned)


# Матрица ошибок считается только при `plots=True` — тот же довод включает
# отрисовку png через matplotlib. Нам нужны числа: картинку сайт рисует сам,
# своей палитрой, с наведением и рядом со вторым обучением. Поэтому на время
# проверки рисование подменяется пустышкой, а счёт остаётся.
#
# Это и есть причина, по которой матрица всегда приходила пустой: обучение
# идёт с `plots=False` ради скорости, и `process_batch` за ним не звался.
@contextlib.contextmanager
def confusion_enabled():
    from ultralytics.utils.metrics import ConfusionMatrix

    original = ConfusionMatrix.plot
    ConfusionMatrix.plot = lambda self, *a, **k: None
    try:
        yield
    finally:
        ConfusionMatrix.plot = original
