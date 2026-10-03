"""JSON persistence + filename helpers shared by all services."""
import json
import os
import re
import tempfile


# Управляющие символы и переводы строк Юникода: в однострочном поле они ломают
# YAML и CSV, а перевод строки в data.yaml давал инъекцию ключей (в том числе download).
_CONTROL = re.compile(r"[\x00-\x1f\x7f\x85  ]")


def has_control(text):
    return bool(_CONTROL.search(text or ""))


def one_line(text):
    """Строка без управляющих символов — для вставки в YAML, CSV, заголовки."""
    return _CONTROL.sub(" ", text or "")


def load_json(path, default):
    if not os.path.isfile(path):
        return default
    with open(path, "r", encoding="utf-8") as fh:
        try:
            return json.load(fh)
        except json.JSONDecodeError:
            return default


def save_json(path, data):
    # Свой временный файл на каждую запись: общий «.tmp» ронял параллельные записи.
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", suffix=".tmp")
    try:
        os.chmod(tmp, 0o644)  # mkstemp даёт 0600
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def safe_name(name):
    # Sanitize an identifier taken from a request path: strip any directory
    # parts and unsafe characters, but DON'T strip a trailing ".ext" — datasets
    # are addressed by a stable ASCII id, and this must be idempotent so the id
    # round-trips unchanged (e.g. "data.2026" stays "data.2026", not "data").
    name = os.path.basename(name or "")
    name = re.sub(r"[^\w.-]+", "_", name, flags=re.UNICODE).strip("._")
    return name or "dataset"


def slugify(text):
    """ASCII-only slug used as a stable, URL-safe folder id."""
    return re.sub(r"[^A-Za-z0-9]+", "_", text or "").strip("_")


_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def translit_slug(text):
    """Slug that survives a Cyrillic name: «Варан КЗТ» -> varan_kzt.

    Plain slugify() would return an empty string for it, so every dataset in a
    project would end up named "dataset", "dataset_2"…
    """
    out = []
    for ch in (text or "").lower():
        out.append(_TRANSLIT.get(ch, ch))
    return slugify("".join(out))


def make_id(display_name, parent, fallback="ds"):
    """Build a unique ASCII id for a new folder under ``parent``.

    The display name may be arbitrary (Cyrillic, dots, spaces); the id derived
    from it is always filesystem- and URL-safe. Uniqueness is guaranteed by
    appending a numeric suffix when the slug is already taken.
    """
    base = slugify(display_name) or fallback
    candidate = base
    n = 1
    while os.path.exists(os.path.join(parent, candidate)):
        n += 1
        candidate = f"{base}_{n}"
    return candidate
