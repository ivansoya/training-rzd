"""JSON persistence + filename helpers shared by all services."""
import json
import os
import re


def load_json(path, default):
    if not os.path.isfile(path):
        return default
    with open(path, "r", encoding="utf-8") as fh:
        try:
            return json.load(fh)
        except json.JSONDecodeError:
            return default


def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def safe_name(name):
    name = os.path.splitext(os.path.basename(name or ""))[0]
    name = re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("._")
    return name or "dataset"
