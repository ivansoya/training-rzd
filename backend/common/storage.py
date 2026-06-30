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
    # Keep the basename, drop a trailing extension, then replace only characters
    # that are unsafe in a path. ``\w`` is Unicode-aware in Python 3, so letters
    # from any alphabet (e.g. Cyrillic) are preserved — a name like "Проект РЖД"
    # becomes "Проект_РЖД" instead of being stripped to nothing.
    name = os.path.splitext(os.path.basename(name or ""))[0]
    name = re.sub(r"[^\w.-]+", "_", name, flags=re.UNICODE).strip("._")
    return name or "dataset"
