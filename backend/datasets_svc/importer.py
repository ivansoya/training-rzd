"""Importing a YOLO archive into a project.

Two passes, with a human in between:

  scan()   reads every label file straight out of the zip, works out which
           images survive and which class ids exist, and returns a report.
  write()  extracts the surviving images to their final path, makes thumbnails
           and writes images + annotations to the database.

Nothing is unpacked to disk in between: labels are small enough to read from
the archive, and images go straight from the zip to their final name, so the
volume never holds two copies of a 16 GB dataset.

Rules agreed for the import:
  * detection only — a label line is `class cx cy w h`, five values;
  * an image is atomic — one bad line drops the image with all its boxes;
  * coordinates up to TOLERANCE outside [0,1] are converter noise: clipped
    and counted, not rejected;
  * a box with zero width or height is rejected;
  * an image without a label file is a negative example, not an error.
"""
import io
import os
import zipfile

from PIL import Image as PilImage

from common import config
from common.datasets import find_yaml_member, parse_yaml_config, split_of

# How far outside [0,1] a coordinate may land before we call it broken.
# 0.001 of a 1920-wide frame is two pixels — rounding noise from a converter,
# not a mistake a human made.
TOLERANCE = 0.001
# Corrupt files listed back to the UI; the counter reports the real total.
MAX_EXAMPLES = 20


class ImportError_(Exception):
    """Archive cannot be imported at all (as opposed to partly broken)."""


def _is_image(name):
    return os.path.splitext(name)[1].lower() in config.IMAGE_EXTENSIONS


def _label_member_for(image_member):
    """`a/images/train/x.jpg` -> `a/labels/train/x.txt`, matching YOLO layout."""
    parts = image_member.replace("\\", "/").split("/")
    for i in range(len(parts) - 1, -1, -1):
        if parts[i] == "images":
            parts[i] = "labels"
            break
    else:
        return None
    return os.path.splitext("/".join(parts))[0] + ".txt"


def _parse_label_text(text):
    """Return (boxes, clipped, error). Boxes are normalized (cx, cy, w, h).

    error is set on the first unusable line — the caller drops the whole image.
    """
    boxes = []
    clipped = 0
    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 5:
            return None, 0, f"строка {lineno}: ожидалось 5 значений, получено {len(parts)}"
        try:
            class_index = int(float(parts[0]))
            coords = [float(p) for p in parts[1:]]
        except ValueError:
            return None, 0, f"строка {lineno}: нечисловое значение"
        if class_index < 0:
            return None, 0, f"строка {lineno}: отрицательный id класса {class_index}"
        fixed = []
        for c in coords:
            if c < -TOLERANCE or c > 1 + TOLERANCE:
                return None, 0, f"строка {lineno}: координата {c} вне [0,1]"
            if c < 0.0 or c > 1.0:
                clipped += 1
                c = min(max(c, 0.0), 1.0)
            fixed.append(c)
        cx, cy, w, h = fixed
        if w <= 0.0 or h <= 0.0:
            return None, 0, f"строка {lineno}: вырожденный бокс ({w}×{h})"
        boxes.append((class_index, cx, cy, w, h))
    return boxes, clipped, None


def scan(zip_path, progress=None):
    """Read the archive and decide what can be imported.

    Returns (report, manifest). The manifest is the per-image work list for
    write(); the report is what the wizard shows on the class step.
    """
    with zipfile.ZipFile(zip_path) as zf:
        members = [m for m in zf.namelist() if not m.endswith("/")]
        for m in members:
            if m.startswith("/") or ".." in m.replace("\\", "/").split("/"):
                raise ImportError_(f"Небезопасный путь в архиве: {m}")

        yaml_member = find_yaml_member(members)
        if not yaml_member:
            raise ImportError_("В архиве нет .yaml конфигурации")
        try:
            cfg = parse_yaml_config(zf.read(yaml_member).decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001
            raise ImportError_(f"Не разобран {yaml_member}: {exc}") from exc

        image_members = [m for m in members if _is_image(m)]
        if not image_members:
            raise ImportError_("В архиве нет изображений")
        image_members.sort()

        label_members = {m for m in members if m.endswith(".txt")}

        manifest = []
        counts = {}                 # class_index -> annotations found
        splits = {"train": 0, "val": 0, "test": 0, "other": 0}
        annotations = 0
        clipped = 0
        skipped = []
        without_labels = 0

        total = len(image_members)
        for i, member in enumerate(image_members):
            if progress and i % 50 == 0:
                progress(i, total)

            # Header only — parsing it catches a file that is not an image at
            # all without reading 16 GB twice. Damage inside the pixel data
            # surfaces at write time and is counted there.
            try:
                with zf.open(member) as fh:
                    with PilImage.open(fh) as probe:
                        probe.size
            except Exception:  # noqa: BLE001
                _note(skipped, member, "файл не читается как изображение")
                continue

            label_member = _label_member_for(member)
            if label_member is None or label_member not in label_members:
                without_labels += 1
                manifest.append({"image": member, "split": split_of(member), "boxes": []})
                splits[split_of(member)] += 1
                continue

            text = zf.read(label_member).decode("utf-8", "replace")
            boxes, box_clipped, error = _parse_label_text(text)
            if error is not None:
                _note(skipped, label_member, error)
                continue

            clipped += box_clipped
            annotations += len(boxes)
            for class_index, *_ in boxes:
                counts[class_index] = counts.get(class_index, 0) + 1
            split = split_of(member)
            splits[split] += 1
            manifest.append({"image": member, "split": split, "boxes": boxes})

        if progress:
            progress(total, total)

    # The class list is the union of what data.yaml declares and what the
    # labels actually use: archives assembled from two sources routinely
    # contain ids that were never declared.
    yaml_names = cfg.get("names") or {}
    classes = [
        {
            "class_index": idx,
            "yaml_name": yaml_names.get(idx),
            "annotations": counts.get(idx, 0),
        }
        for idx in sorted(set(yaml_names) | set(counts))
    ]

    report = {
        "archive_members": len(members),
        "images": len(manifest),
        "annotations": annotations,
        "images_without_labels": without_labels,
        "splits": splits,
        "clipped": clipped,
        "skipped": len(skipped),
        "skipped_examples": skipped[:MAX_EXAMPLES],
        "classes": classes,
    }
    return report, manifest


def _note(skipped, member, reason):
    if len(skipped) < MAX_EXAMPLES:
        skipped.append({"file": member, "reason": reason})
    else:
        skipped.append(None)  # counted only


def to_pixels(box, width, height):
    """YOLO normalized (cx, cy, w, h) -> COCO pixel {x, y, w, h}."""
    _, cx, cy, w, h = box
    pw = w * width
    ph = h * height
    return {
        "x": round((cx - w / 2) * width, 2),
        "y": round((cy - h / 2) * height, 2),
        "w": round(pw, 2),
        "h": round(ph, 2),
    }, pw * ph


def extract_image(zf, member, dest_path, thumb_path):
    """Write the image to its final name and build its thumbnail.

    Returns (width, height, size_bytes) or None if the file turned out to be
    unreadable after all.
    """
    try:
        data = zf.read(member)
        with PilImage.open(io.BytesIO(data)) as img:
            img.load()
            width, height = img.size
            thumb = img.convert("RGB")
            thumb.thumbnail(
                (config.THUMB_MAX_SIDE, config.THUMB_MAX_SIDE), PilImage.LANCZOS
            )
            thumb.save(thumb_path, "JPEG", quality=config.THUMB_QUALITY)
    except Exception:  # noqa: BLE001
        return None
    with open(dest_path, "wb") as fh:
        fh.write(data)
    return width, height, len(data)
