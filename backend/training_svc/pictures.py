"""Свои картинки на полке — источник образцов, когда объекта в проекте нет (решения 23.10.2026).

Повод — борщевик «Искры»: SAM 3 текстом его не находит, кадров с ним в роликах
нет, а снимков в открытом доступе много. Картинка ложится на личную полку
владельца, на «полку» по имени класса; рамки на ней рисует человек в окне
«Образцы класса», дальше рамки набираются в набор, как рамки кадров проекта.

Файл при приёме разворачивается по EXIF и пересохраняется JPEG: браузер
показывает картинку развёрнутой, cv2 читает пиксели как есть — без этого рамка
с фото телефона легла бы на повёрнутый кадр. Заодно уходят метаданные снимка.
"""
import hashlib
import io
import os
import uuid

from sqlalchemy import Text, cast, select

from common import agent_graph, config
from common.models import AgentExamples, AgentPicture, AugGraph, AugGraphVersion

SHELF = os.path.join(config.DATA_DIR, "_weights", "users")
MAX_BYTES = 20 << 20
# Больше — почти наверняка не фотография, а развёртка или бомба распаковки.
MAX_PIXELS = 80_000_000
# Хранимая сторона: SAM 3 видит вырезку не больше клетки ряда, YOLOE — вход 640;
# мегапиксели сверх этого только занимают место.
MAX_SIDE = 4096


class PictureError(ValueError):
    """Картинку не принять. Текст — для человека; `code="duplicate"` — тот же файл уже на полке."""

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def folder(owner_id):
    return os.path.join(SHELF, str(owner_id), "pictures")


def view(row, lock=None):
    return {
        "id": str(row.id),
        "shelf": row.shelf,
        "file_name": row.file_name,
        "width": row.width,
        "height": row.height,
        "boxes": row.boxes,
        # Почему удалить нельзя; None — можно.
        "locked": lock,
        "created_at": row.created_at.isoformat(),
    }


def decode(raw):
    """Байты файла → (RGB-картинка Pillow, развёрнутая по EXIF и ужатая до MAX_SIDE)."""
    from PIL import Image, ImageOps

    try:
        img = Image.open(io.BytesIO(raw))
        if img.format not in ("JPEG", "PNG", "WEBP"):
            raise PictureError("Это не JPEG, PNG или WebP.")
        if img.width * img.height > MAX_PIXELS:
            raise PictureError("Картинка больше 80 мегапикселей — уменьшите её.")
        img.load()
    except PictureError:
        raise
    except Exception:  # noqa: BLE001 — Pillow бросает что угодно на битом файле
        raise PictureError("Файл не открывается как картинка.") from None
    img = ImageOps.exif_transpose(img).convert("RGB")
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE))
    return img


def shelve(db, user, raw, name, shelf):
    """Положить картинку на полку. Тот же файл второй раз — PictureError с тем, что уже лежит."""
    if not raw:
        raise PictureError("Файл пустой.")
    if len(raw) > MAX_BYTES:
        raise PictureError("Больше 20 МБ — уменьшите и загрузите снова.")
    sha = hashlib.sha256(raw).hexdigest()
    same = db.execute(select(AgentPicture).where(AgentPicture.owner_id == user.id,
                                                 AgentPicture.sha256 == sha)).scalar_one_or_none()
    if same is not None:
        raise PictureError(f"Уже на полке «{same.shelf}»: {same.file_name}", "duplicate")
    img = decode(raw)
    pid = uuid.uuid4()
    os.makedirs(folder(user.id), exist_ok=True)
    path = os.path.join(folder(user.id), f"{pid}.jpg")
    img.save(path, "JPEG", quality=93)
    row = AgentPicture(id=pid, owner_id=user.id, shelf=shelf[:255], file_name=name[:255], sha256=sha,
                       file_path=os.path.relpath(path, config.DATA_DIR), width=img.width, height=img.height,
                       boxes=[], created_by=user.id)
    db.add(row)
    db.commit()
    return row


def locks(db, picture_ids):
    """{id картинки: почему её нельзя удалить} — её рамки в наборе сохранённой версии агента.

    Набор неизменяем, и версия агента должна работать так же через месяц. Черновик
    не держит: набор хранит свою вырезку, а векторы уже посчитаны."""
    wanted = {str(p) for p in picture_ids}
    if not wanted:
        return {}
    in_set = {}
    for set_id, items in db.execute(select(AgentExamples.id, AgentExamples.items).where(
            cast(AgentExamples.items, Text).like('%"picture_id"%'))):
        pics = {str(it.get("picture_id")) for it in items or []} & wanted
        if pics:
            in_set[str(set_id)] = pics
    if not in_set:
        return {}
    out = {}
    for name, version, doc in db.execute(
            select(AugGraph.name, AugGraphVersion.version, AugGraphVersion.doc)
            .join(AugGraph, AugGraph.id == AugGraphVersion.graph_id)
            .where(AugGraph.kind == "agent").order_by(AugGraphVersion.version.desc())):
        for node in (doc or {}).get("nodes") or []:
            if not isinstance(node, dict) or node.get("type") != "text":
                continue
            for set_id in agent_graph.all_sets(node):
                for pid in in_set.get(set_id, ()):
                    out.setdefault(pid, f"Рамки в наборе версии {version} агента «{name}» — удалить нельзя.")
    return out
