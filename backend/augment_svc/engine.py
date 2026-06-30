"""Albumentations integration: transform registry, preview and dataset generation.

Everything that needs albumentations / opencv / numpy lives here and is imported
lazily, so imports stay cheap until augmentation is actually used.
"""
import base64
import inspect
import os
import random

# Albumentations prints an update-check banner on import unless disabled.
os.environ.setdefault("NO_ALBUMENTATIONS_UPDATE", "1")

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}


class Cancelled(Exception):
    """Raised inside generate() when the job has been cancelled by the user."""

# Curated whitelist of transforms exposed in the UI. All of them work with their
# default parameters so a freshly added transform previews without extra input.
PIXEL_TRANSFORMS = [
    "RandomBrightnessContrast", "HueSaturationValue", "RGBShift", "ColorJitter",
    "RandomGamma", "CLAHE", "Sharpen", "Emboss", "RandomToneCurve", "Posterize",
    "Equalize", "Solarize", "Blur", "GaussianBlur", "MotionBlur", "MedianBlur",
    "GaussNoise", "ISONoise", "MultiplicativeNoise", "ImageCompression",
    "Downscale", "ToGray", "ChannelShuffle", "InvertImg", "RandomFog",
    "RandomRain", "RandomSnow", "RandomSunFlare", "RandomShadow",
]
SPATIAL_TRANSFORMS = [
    "HorizontalFlip", "VerticalFlip", "RandomRotate90", "Transpose", "Rotate",
    "ShiftScaleRotate", "Affine", "Perspective", "ElasticTransform",
    "GridDistortion", "OpticalDistortion",
]

_REGISTRY = None  # name -> {"cls": class, "category": str, "params": [...]}


def is_available():
    try:
        import albumentations  # noqa: F401
        import cv2  # noqa: F401
        import numpy  # noqa: F401
        return True
    except Exception:
        return False


def _jsonable(value):
    if isinstance(value, (tuple, list)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (int, float, str, bool)) or value is None:
        return value
    return str(value)


def _infer_param(name, param):
    required = param.default is inspect.Parameter.empty
    default = None if required else param.default
    schema = {"name": name, "required": required}

    if isinstance(default, bool):
        schema.update(type="bool", default=default)
    elif isinstance(default, int):
        schema.update(type="int", default=default)
    elif isinstance(default, float):
        schema.update(type="float", default=default)
    elif (
        isinstance(default, (tuple, list))
        and len(default) == 2
        and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in default)
    ):
        is_int = all(isinstance(x, int) for x in default)
        schema.update(type="range", default=[default[0], default[1]], int=is_int)
    elif isinstance(default, str):
        schema.update(type="string", default=default)
    elif default is None:
        schema.update(type="optional", default=None)
    else:
        schema.update(type="json", default=_jsonable(default))
    return schema


def _build_registry():
    import albumentations as A

    registry = {}
    groups = [("pixel", PIXEL_TRANSFORMS), ("spatial", SPATIAL_TRANSFORMS)]
    for category, names in groups:
        for name in names:
            cls = getattr(A, name, None)
            if cls is None:
                continue
            try:
                sig = inspect.signature(cls.__init__)
            except (ValueError, TypeError):
                continue
            params = []
            for pname, p in sig.parameters.items():
                if pname in ("self", "always_apply"):
                    continue
                if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
                    continue
                params.append(_infer_param(pname, p))
            registry[name] = {"cls": cls, "category": category, "params": params}
    return registry


def get_registry():
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = _build_registry()
    return _REGISTRY


def registry_schema():
    """Public transform list (without the class objects) for the frontend."""
    reg = get_registry()
    out = []
    for name, info in reg.items():
        out.append({"name": name, "category": info["category"], "params": info["params"]})
    out.sort(key=lambda t: (t["category"], t["name"]))
    return out


def _coerce(value):
    if isinstance(value, list):
        return tuple(_coerce(v) for v in value)
    return value


def build_compose(transforms, with_bbox=True):
    """Build an albumentations Compose from a list of {name, params} dicts."""
    import albumentations as A

    reg = get_registry()
    ops = []
    for item in transforms or []:
        name = item.get("name")
        info = reg.get(name)
        if not info:
            continue
        valid = {p["name"] for p in info["params"]}
        kwargs = {}
        for key, val in (item.get("params") or {}).items():
            if key not in valid:
                continue
            if val is None or val == "":
                continue
            kwargs[key] = _coerce(val)
        try:
            ops.append(info["cls"](**kwargs))
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"transform '{name}': {exc}") from exc

    if with_bbox:
        return A.Compose(
            ops,
            bbox_params=A.BboxParams(
                format="yolo",
                label_fields=["class_labels"],
                min_visibility=0.0,
                clip=True,
            ),
        )
    return A.Compose(ops)


def _imread_rgb(path):
    import cv2
    import numpy as np

    data = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        return None
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def _encode_png(rgb):
    import cv2

    ok, buf = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    if not ok:
        return None
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode("ascii")


def _read_yolo_label(path):
    bboxes, labels = [], []
    if not os.path.isfile(path):
        return bboxes, labels
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.split()
            if len(parts) != 5:
                continue
            cls = int(float(parts[0]))
            coords = [min(max(float(x), 0.0), 1.0) for x in parts[1:]]
            bboxes.append(coords)
            labels.append(cls)
    return bboxes, labels


def _label_path_for_image(image_path):
    import re

    p = image_path.replace("\\", "/")
    p = re.sub(r"(^|/)images(/)", r"\1labels\2", p, count=1)
    return os.path.splitext(p)[0] + ".txt"


def _draw_boxes(rgb, bboxes, labels, names):
    import cv2

    img = rgb.copy()
    h, w = img.shape[:2]
    for (cx, cy, bw, bh), cls in zip(bboxes, labels):
        x1 = int((cx - bw / 2) * w)
        y1 = int((cy - bh / 2) * h)
        x2 = int((cx + bw / 2) * w)
        y2 = int((cy + bh / 2) * h)
        cv2.rectangle(img, (x1, y1), (x2, y2), (0, 220, 90), 2)
        label = names.get(cls, str(cls)) if names else str(cls)
        cv2.putText(img, label, (x1, max(12, y1 - 4)), cv2.FONT_HERSHEY_SIMPLEX,
                    0.5, (0, 220, 90), 1, cv2.LINE_AA)
    return img


def _list_images(dataset_dir):
    images = []
    for root, _dirs, files in os.walk(dataset_dir):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, dataset_dir).replace("\\", "/")
            if os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS and "/images/" in "/" + rel:
                images.append(rel)
    return images


def _find_yaml(dataset_dir):
    for root, _dirs, files in os.walk(dataset_dir):
        for f in files:
            if f.lower().endswith((".yaml", ".yml")):
                return os.path.join(root, f)
    return None


def _class_names(dataset_dir):
    import yaml

    path = _find_yaml(dataset_dir)
    if not path:
        return {}
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        cfg = yaml.safe_load(fh) or {}
    names = cfg.get("names")
    if isinstance(names, dict):
        return {int(k): str(v) for k, v in names.items()}
    if isinstance(names, list):
        return {i: str(v) for i, v in enumerate(names)}
    return {}


def preview(dataset_dir, transforms, seed=None):
    """Apply `transforms` to a random labelled image. Returns dict with data URLs."""
    if seed is not None:
        random.seed(seed)
    images = _list_images(dataset_dir)
    if not images:
        raise ValueError("в датасете нет изображений")

    names = _class_names(dataset_dir)
    random.shuffle(images)
    chosen, bboxes, labels = None, [], []
    for rel in images:
        b, l = _read_yolo_label(os.path.join(dataset_dir, _label_path_for_image(rel)))
        if b:
            chosen, bboxes, labels = rel, b, l
            break
    if chosen is None:
        chosen = images[0]

    rgb = _imread_rgb(os.path.join(dataset_dir, chosen))
    if rgb is None:
        raise ValueError(f"не удалось прочитать изображение {chosen}")

    compose = build_compose(transforms, with_bbox=True)
    result = compose(image=rgb, bboxes=bboxes, class_labels=labels)
    aug_img = result["image"]
    aug_boxes = result["bboxes"]
    aug_labels = result["class_labels"]

    return {
        "image": chosen,
        "original": _encode_png(_draw_boxes(rgb, bboxes, labels, names)),
        "augmented": _encode_png(_draw_boxes(aug_img, aug_boxes, aug_labels, names)),
    }


def _with_suffix(path, suffix):
    root, ext = os.path.splitext(path)
    return f"{root}.{suffix}{ext}"


def _split_of(rel):
    low = rel.replace("\\", "/").lower()
    for s in ("train", "val", "valid", "test"):
        if f"/{s}/" in "/" + low or low.startswith(s + "/") or f"/{s}." in low:
            return "val" if s == "valid" else s
    return "other"


def count_images(source_dir, scope="all"):
    images = _list_images(source_dir)
    if scope == "train":
        images = [r for r in images if _split_of(r) == "train"]
    return len(images)


def generate(source_dir, dest_dir, passes, scope="all", progress=None,
             should_cancel=None):
    """Create an augmented copy of `source_dir` at `dest_dir`.

    `passes` is a list of {name, transforms}. Each pass is a full cycle over
    every image with its own transform set; outputs from different passes get a
    distinct filename suffix so they coexist in one dataset. Returns the number
    of written images.

    `should_cancel`, if given, is polled between images; when it returns true the
    generation aborts with `Cancelled` so the caller can clean up.
    """
    def _cancelled():
        return bool(should_cancel and should_cancel())

    import shutil

    import cv2

    composes = [
        (i, build_compose(p.get("transforms", []), with_bbox=True))
        for i, p in enumerate(passes)
    ]
    all_images = _list_images(source_dir)
    if scope == "train":
        # Only the train split is augmented; val/test are carried over untouched
        # so the augmented dataset keeps clean validation data from the source.
        images = [r for r in all_images if _split_of(r) == "train"]
        clean = [r for r in all_images if _split_of(r) != "train"]
    else:
        images = all_images
        clean = []
    total = len(images) * max(1, len(composes))

    yaml_path = _find_yaml(source_dir)
    if yaml_path:
        rel = os.path.relpath(yaml_path, source_dir)
        dst = os.path.join(dest_dir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(yaml_path, dst)

    written = 0

    # Copy the non-augmented splits (val/test) verbatim — same paths, same
    # filenames, no suffix — so they remain identical to the original dataset.
    for rel in clean:
        if _cancelled():
            raise Cancelled()
        src_img = os.path.join(source_dir, rel)
        dst_img = os.path.join(dest_dir, rel)
        os.makedirs(os.path.dirname(dst_img), exist_ok=True)
        shutil.copy2(src_img, dst_img)
        lbl_rel = _label_path_for_image(rel)
        src_lbl = os.path.join(source_dir, lbl_rel)
        if os.path.isfile(src_lbl):
            dst_lbl = os.path.join(dest_dir, lbl_rel)
            os.makedirs(os.path.dirname(dst_lbl), exist_ok=True)
            shutil.copy2(src_lbl, dst_lbl)
        written += 1

    aug_done = 0
    for rel in images:
        if _cancelled():
            raise Cancelled()
        rgb = _imread_rgb(os.path.join(source_dir, rel))
        if rgb is None:
            continue
        lbl_rel = _label_path_for_image(rel)
        bboxes, labels = _read_yolo_label(os.path.join(source_dir, lbl_rel))

        for idx, compose in composes:
            result = compose(image=rgb, bboxes=bboxes, class_labels=labels)
            suffix = f"aug{idx + 1}"

            out_img = _with_suffix(os.path.join(dest_dir, rel), suffix)
            os.makedirs(os.path.dirname(out_img), exist_ok=True)
            cv2.imwrite(out_img, cv2.cvtColor(result["image"], cv2.COLOR_RGB2BGR))

            out_lbl = _with_suffix(os.path.join(dest_dir, lbl_rel), suffix)
            os.makedirs(os.path.dirname(out_lbl), exist_ok=True)
            with open(out_lbl, "w", encoding="utf-8") as fh:
                for (cx, cy, bw, bh), cls in zip(result["bboxes"], result["class_labels"]):
                    fh.write(f"{int(cls)} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n")
            written += 1
            aug_done += 1
            if progress:
                progress(aug_done, total)
    return written
