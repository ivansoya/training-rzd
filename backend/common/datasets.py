"""Проверка YOLO-архива при импорте. Ни Flask, ни тяжёлых зависимостей.

От прежнего файла остался разбор архива и ничего сверх: подсчёт статистики
папки-датасета уехал вместе со старым приложением на /tools. Датасет теперь
принадлежит проекту, и всё, что о нём можно спросить, спрашивается у базы, а
не обходом каталога.
"""
import os
import re

import yaml

from common.config import IMAGE_EXTENSIONS

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
