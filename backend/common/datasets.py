"""YOLO dataset validation and statistics (no Flask, no heavy deps besides PyYAML).

Shared by the datasets service (upload/validate/stats) and the augmentation
service (it computes stats for generated datasets).
"""
import os
import re

import yaml

from common.config import IMAGE_EXTENSIONS
from common.storage import load_json, save_json

STATS_CACHE_FILE = ".stats.json"


def is_image(path):
    return os.path.splitext(path)[1].lower() in IMAGE_EXTENSIONS


def find_yaml_member(names):
    candidates = [n for n in names if n.lower().endswith((".yaml", ".yml"))]
    if not candidates:
        return None
    candidates.sort(key=lambda n: (n.count("/"), len(n)))
    return candidates[0]


def validate_label_file(text):
    rows = []
    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 5:
            return False, f"line {lineno}: expected 5 values, got {len(parts)}", rows
        try:
            cls = int(float(parts[0]))
            coords = [float(p) for p in parts[1:]]
        except ValueError:
            return False, f"line {lineno}: non-numeric value", rows
        if cls < 0:
            return False, f"line {lineno}: negative class id {cls}", rows
        for c in coords:
            if not (0.0 <= c <= 1.0):
                return False, f"line {lineno}: coordinate {c} out of [0,1]", rows
        rows.append((cls, coords))
    return True, None, rows


def parse_yaml_config(text):
    cfg = yaml.safe_load(text)
    if not isinstance(cfg, dict):
        raise ValueError("YAML root is not a mapping")
    names = cfg.get("names")
    if isinstance(names, dict):
        names = {int(k): str(v) for k, v in names.items()}
    elif isinstance(names, list):
        names = {i: str(v) for i, v in enumerate(names)}
    else:
        raise ValueError("`names` must be a list or mapping")
    nc = cfg.get("nc", len(names))
    return {"train": cfg.get("train"), "val": cfg.get("val"), "names": names, "nc": int(nc)}


def validate_archive(zf):
    members = [m for m in zf.namelist() if not m.endswith("/")]
    for m in members:
        if m.startswith("/") or ".." in m.replace("\\", "/").split("/"):
            raise ValueError(f"unsafe path in archive: {m}")
    yaml_member = find_yaml_member(members)
    if not yaml_member:
        raise ValueError("no .yaml config found in archive")
    cfg = parse_yaml_config(zf.read(yaml_member).decode("utf-8", "replace"))
    if not any("/images/" in ("/" + m) or m.startswith("images/") for m in members):
        raise ValueError("no `images` directory found in archive")
    if not any("/labels/" in ("/" + m) or m.startswith("labels/") for m in members):
        raise ValueError("no `labels` directory found in archive")
    label_members = [m for m in members if "/labels/" in ("/" + m) and m.endswith(".txt")]
    if not label_members:
        raise ValueError("no .txt label files found under `labels`")
    warnings = []
    for m in label_members:
        ok, err, rows = validate_label_file(zf.read(m).decode("utf-8", "replace"))
        if not ok:
            raise ValueError(f"invalid label file {m}: {err}")
        for cls, _ in rows:
            if cls >= cfg["nc"]:
                warnings.append(f"{m}: class id {cls} >= nc ({cfg['nc']})")
    return cfg, members, warnings[:50]


def split_of(rel_path):
    low = rel_path.replace("\\", "/").lower()
    for split in ("train", "val", "valid", "test"):
        if f"/{split}/" in "/" + low or f"/{split}." in low or low.startswith(split + "/"):
            return "val" if split == "valid" else split
    return "other"


def label_path_for_image(image_path):
    p = image_path.replace("\\", "/")
    p = re.sub(r"(^|/)images(/)", r"\1labels\2", p, count=1)
    return os.path.splitext(p)[0] + ".txt"


def compute_stats(dataset_dir):
    yaml_path = None
    for root, _dirs, files in os.walk(dataset_dir):
        for f in files:
            if f.lower().endswith((".yaml", ".yml")):
                yaml_path = os.path.join(root, f)
                break
        if yaml_path:
            break

    cfg = {"names": {}, "nc": 0}
    if yaml_path:
        with open(yaml_path, "r", encoding="utf-8", errors="replace") as fh:
            cfg = parse_yaml_config(fh.read())
    names = cfg["names"]

    image_files, label_files = [], []
    for root, _dirs, files in os.walk(dataset_dir):
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), dataset_dir).replace("\\", "/")
            if is_image(rel) and "/images/" in "/" + rel:
                image_files.append(rel)
            elif rel.endswith(".txt") and "/labels/" in "/" + rel:
                label_files.append(rel)

    per_split = {}
    per_class = {int(k): 0 for k in names}
    images_per_class = {int(k): set() for k in names}
    unknown_class = {}
    total_instances = 0

    label_set = set(label_files)
    for img in image_files:
        bucket = per_split.setdefault(
            split_of(img), {"images": 0, "labeled": 0, "background": 0, "instances": 0}
        )
        bucket["images"] += 1
        lbl = label_path_for_image(img)
        if lbl in label_set:
            with open(os.path.join(dataset_dir, lbl), "r", encoding="utf-8", errors="replace") as fh:
                _ok, _err, rows = validate_label_file(fh.read())
            bucket["labeled" if rows else "background"] += 1
            for cls, _coords in rows:
                total_instances += 1
                bucket["instances"] += 1
                if cls in per_class:
                    per_class[cls] += 1
                    images_per_class[cls].add(img)
                else:
                    unknown_class[cls] = unknown_class.get(cls, 0) + 1
        else:
            bucket["background"] += 1

    classes = [
        {"id": cid, "name": names[cid], "instances": per_class.get(cid, 0),
         "images": len(images_per_class.get(cid, set()))}
        for cid in sorted(names)
    ]
    splits = [{"split": s, **per_split[s]} for s in sorted(per_split)]

    return {
        "name": os.path.basename(dataset_dir.rstrip("/\\")),
        "nc": cfg["nc"],
        "num_classes": len(names),
        "total_images": len(image_files),
        "total_label_files": len(label_files),
        "total_instances": total_instances,
        "unknown_class_instances": sum(unknown_class.values()),
        "splits": splits,
        "classes": classes,
    }


def count_images(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        if os.sep + "images" + os.sep in root + os.sep or root.endswith("images"):
            total += sum(1 for f in files if is_image(f))
    return total


# Datasets are immutable once created, so stats are computed once and cached.
def stats_cache_path(dataset_dir):
    return os.path.join(dataset_dir, STATS_CACHE_FILE)


def compute_and_cache_stats(dataset_dir):
    stats = compute_stats(dataset_dir)
    try:
        save_json(stats_cache_path(dataset_dir), stats)
    except OSError:
        pass
    return stats


def get_cached_stats(dataset_dir):
    cached = load_json(stats_cache_path(dataset_dir), None)
    if isinstance(cached, dict):
        return cached
    return compute_and_cache_stats(dataset_dir)


def cached_num_classes(dataset_dir):
    """Class count from cached stats only (never recompute — keeps lists fast)."""
    cached = load_json(stats_cache_path(dataset_dir), None)
    if isinstance(cached, dict):
        return cached.get("num_classes") or cached.get("nc")
    return None
