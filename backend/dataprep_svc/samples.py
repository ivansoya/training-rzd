"""Что лежит в собранном наборе — построчно, с отбором по классам и части.

Набор — это папка на томе, а не строки в базе ([[trainset-build]]): сто тысяч
кадров при графе ×6 дали бы шестьсот тысяч строк, которые ни с чем не
соединяются. Поэтому смотреть набор — значит читать ``manifest.jsonl``, а не
делать запрос.

Отбор по классу манифест сам не переживает: в нём есть число объектов, но не
их классы. Разметка лежит рядом, в ``labels/<часть>/<имя>.txt``, и класс —
первое число строки. Читать сто тысяч мелких файлов на каждый показ страницы
нельзя, поэтому классы приписываются к строке манифеста один раз:

* новые сборки пишут ``classes`` прямо в манифест (``builder._note``);
* у наборов, собранных раньше, классы дочитываются из разметки один раз и
  ложатся в ``samples-index.jsonl`` рядом с манифестом.

Указатель привязан к времени правки манифеста: пересобрали набор — указатель
считается заново, а не показывает вчерашнее.

Считающая часть — ``pick`` и ``boxes_of`` — не знает ни базы, ни файлов, и
закрыта числами в ``tests/unit/test_samples_view.py``.
"""
import json
import os

from common import config

INDEX_NAME = "samples-index.jsonl"


# --------------------------------------------------------------------------- #
# Чистая часть
# --------------------------------------------------------------------------- #
def pick(rows, *, split=None, classes=None, without=False, offset=0, limit=60):
    """Отобранные строки и сколько их всего. Возвращает (всего, срез).

    ``classes`` — набор номеров класса в наборе (тех, что стоят в разметке).
    Кадр подходит, если на нём есть хоть один из них: человек спрашивает
    «покажи, где эти классы», а не «где ровно эти и никаких больше».

    ``without`` — только кадры без разметки. Они в наборе бывают: кадр-фон
    попадает в обучение осознанно, и посмотреть на них надо отдельно.
    """
    want = set(classes or ())
    out = []
    for row in rows:
        if split and row.get("split") != split:
            continue
        if without and row.get("objects"):
            continue
        if want and not (want & set(row.get("classes") or ())):
            continue
        out.append(row)
    return len(out), out[offset:offset + limit]


def boxes_of(text, palette, width=1.0, height=1.0):
    """Строки разметки YOLO → фигуры для превью, в пикселях кадра.

    Именно в пикселях, а не в долях. Доли были дешевле — размер собранного
    образца нигде не записан, — но слою превью нужен не масштаб, а
    **соотношение сторон**: на плитке картинка обрезается по `cover`, и слой
    обязан обрезаться так же. С квадратным кадром 1×1 он этого сделать не мог
    и растягивал рамки. Размер берётся из заголовка файла — это дёшево,
    декодировать картинку не нужно.
    """
    out = []
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            cls = int(float(parts[0]))
            nums = [float(v) for v in parts[1:]]
        except ValueError:
            continue
        look = palette.get(cls) or {"name": f"класс {cls}", "color": "#8a8f94"}
        if len(nums) == 4:
            cx, cy, w, h = nums
            out.append({
                "kind": "bbox",
                "x": round((cx - w / 2) * width, 2),
                "y": round((cy - h / 2) * height, 2),
                "w": round(w * width, 2), "h": round(h * height, 2),
                "class_index": cls, **look,
            })
        elif len(nums) >= 6 and len(nums) % 2 == 0:
            ring = [
                [round(nums[i] * width, 2), round(nums[i + 1] * height, 2)]
                for i in range(0, len(nums), 2)
            ]
            xs = [p[0] for p in ring]
            ys = [p[1] for p in ring]
            out.append({
                "kind": "polygon",
                "parts": [ring],
                "x": round(min(xs), 2), "y": round(min(ys), 2),
                "w": round(max(xs) - min(xs), 2),
                "h": round(max(ys) - min(ys), 2),
                "class_index": cls, **look,
            })
    return out


def classes_in(text):
    """Номера классов, встреченные в разметке. Порядок — по возрастанию."""
    found = set()
    for line in (text or "").splitlines():
        head = line.split(maxsplit=1)
        if not head:
            continue
        try:
            found.add(int(float(head[0])))
        except ValueError:
            continue
    return sorted(found)


def label_path(root, row):
    stem = os.path.splitext(os.path.basename(row.get("file") or ""))[0]
    return os.path.join(root, "labels", row.get("split") or "train", f"{stem}.txt")


def inside(root, relative):
    """Путь внутри набора — или ``None``. Защита от «..» в запросе."""
    root = os.path.realpath(root)
    full = os.path.realpath(os.path.join(root, relative or ""))
    if full != root and not full.startswith(root + os.sep):
        return None
    return full


# --------------------------------------------------------------------------- #
# Чтение с диска
# --------------------------------------------------------------------------- #
def _read_jsonl(path):
    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def index(project_id, set_id):
    """Строки набора с классами. Строит указатель, если его ещё нет."""
    root = config.trainset_dir(project_id, set_id)
    manifest = config.trainset_manifest(project_id, set_id)
    if not os.path.isfile(manifest):
        return root, []
    cache = os.path.join(root, INDEX_NAME)
    if os.path.isfile(cache) and os.path.getmtime(cache) >= os.path.getmtime(manifest):
        return root, _read_jsonl(cache)

    rows = _read_jsonl(manifest)
    need = [r for r in rows if "classes" not in r]
    for row in need:
        try:
            with open(label_path(root, row), "r", encoding="utf-8") as fh:
                row["classes"] = classes_in(fh.read())
        except OSError:
            row["classes"] = []
    if need:
        # Дочитали — записываем, чтобы следующий показ не открывал файлы снова.
        try:
            tmp = cache + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                for row in rows:
                    fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            os.replace(tmp, cache)
        except OSError:
            pass
    return root, rows


def size_of(root, row):
    """Размер образца в пикселях. Читается заголовок, а не вся картинка.

    ``(None, None)`` — файла нет или он не читается: слой тогда рисовать не по
    чему, и лучше не рисовать вовсе, чем нарисовать мимо.
    """
    from PIL import Image

    try:
        with Image.open(os.path.join(root, row.get("file") or "")) as img:
            return img.size
    except Exception:  # noqa: BLE001
        return (None, None)


def read_label(root, row):
    try:
        with open(label_path(root, row), "r", encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""
