"""Project data: importing a YOLO archive and serving what came out of it.

The wizard is resumable, so its state lives on the volume next to the project's
binaries (`_import.json`), not in the browser. Progress of the two long phases
goes through the usual job files, so the front end polls `/api/jobs/<id>` the
same way it does for everything else.
"""
import os
import tempfile
import threading
import time
import uuid
import zipfile

from flask import Blueprint, jsonify, request, send_file
from sqlalchemy import func, select

from common import config, jobs
from common.auth import current_user, has_role, project_by_code, role_in
from common.db import SessionLocal
from common.models import (
    Annotation,
    Dataset,
    Image,
    LabelClass,
    Project,
    Superclass,
)
from common.storage import load_json, save_json, translit_slug
from datasets_svc import importer

bp = Blueprint("projects", __name__)

# Class colours the wizard offers when data.yaml brings none. Distinct at a
# glance on a photo, which rules out anything pale.
PALETTE = [
    "#e21a1a", "#1f6feb", "#e8590c", "#1a7f4b", "#8957e5", "#0b7285",
    "#c2255c", "#5c7cfa", "#f08c00", "#2b8a3e", "#862e9c", "#0c8599",
]
# Images written between commits: a batch keeps memory flat on a 100k dataset
# without making progress look frozen.
WRITE_BATCH = 200


def _manifest_file(project_id):
    return os.path.join(config.project_dir(project_id), "_manifest.json")


def _state(project_id):
    return load_json(config.project_import_file(project_id), None)


def _save_state(project_id, state):
    os.makedirs(config.project_dir(project_id), exist_ok=True)
    save_json(config.project_import_file(project_id), state)


def _get_by_uuid(db, model, raw):
    """db.get() raises on a malformed uuid in the URL; a 404 is the honest answer."""
    try:
        return db.get(model, uuid.UUID(str(raw)))
    except (ValueError, AttributeError):
        return None


def _free_identifier(db, project_id, base):
    """A Cyrillic name slugifies to nothing, so several imports into one project
    would collide on (project_id, identifier). Suffix until it is free."""
    base = base or "dataset"
    taken = set(db.execute(
        select(Dataset.identifier).where(Dataset.project_id == project_id)
    ).scalars())
    if base not in taken:
        return base
    n = 2
    while f"{base}_{n}" in taken:
        n += 1
    return f"{base}_{n}"


def _resolve(code, needed="viewer"):
    """(db, project, error_response). Caller closes db when it is not None."""
    db = SessionLocal()
    user = current_user(db)
    if user is None:
        db.close()
        return None, None, (jsonify({"error": "Не выполнен вход."}), 401)
    project = project_by_code(db, code)
    if project is None:
        db.close()
        return None, None, (jsonify({"error": "Проект не найден."}), 404)
    if not has_role(role_in(db, user, project), needed):
        db.close()
        return None, None, (jsonify({"error": "Недостаточно прав в проекте."}), 403)
    return db, project, None


def _role(db, project):
    """Роль текущего пользователя — интерфейсу, чтобы не предлагать лишнего."""
    return role_in(db, current_user(db), project)


# --------------------------------------------------------------------------- #
# Import: upload and scan
# --------------------------------------------------------------------------- #
def _run_scan_job(job_id, project_id, zip_path, archive_info):
    try:
        jobs.update(job_id, message="Читаю разметку", phase="scan")

        def progress(done, total):
            jobs.update(job_id, processed=done, total=total)

        report, manifest = importer.scan(zip_path, progress=progress)
        save_json(_manifest_file(project_id), manifest)
        _save_state(project_id, {
            "status": "classes",
            "archive": archive_info,
            "zip_path": zip_path,
            "report": report,
        })
        jobs.update(job_id, status="done", result={"images": report["images"]})
    except importer.ImportError_ as exc:
        _fail(project_id, job_id, str(exc), zip_path)
    except zipfile.BadZipFile:
        _fail(project_id, job_id, "Файл не является zip-архивом", zip_path)
    except Exception as exc:  # noqa: BLE001
        _fail(project_id, job_id, str(exc), zip_path)


def _fail(project_id, job_id, message, zip_path=None):
    if zip_path:
        try:
            os.remove(zip_path)
        except OSError:
            pass
    _save_state(project_id, {"status": "error", "error": message})
    jobs.update(job_id, status="error", error=message)


@bp.post("/api/projects/<code>/import")
def start_import(code):
    db, project, err = _resolve(code, "admin")
    if err:
        return err
    try:
        if "file" not in request.files:
            return jsonify({"error": "Файл не передан."}), 400
        file = request.files["file"]
        if not file.filename or not file.filename.lower().endswith(".zip"):
            return jsonify({"error": "Нужен .zip архив."}), 400

        project_id = project.id
        existing = _state(project_id)
        if existing and existing.get("status") in ("scanning", "writing"):
            return jsonify({"error": "Импорт уже идёт."}), 409
        # Второй архив в проект пока не поддержан: его class_index столкнётся с
        # уже заведёнными классами. Отказываем явно, а не падаем на записи.
        if db.execute(
            select(func.count()).select_from(LabelClass)
            .where(LabelClass.project_id == project_id)
        ).scalar_one():
            return jsonify({
                "error": "В проекте уже есть классы. Импорт второго архива "
                         "появится позже — вместе со сверкой классов."
            }), 409

        os.makedirs(config.TMP_DIR, exist_ok=True)
        fd, zip_path = tempfile.mkstemp(suffix=".zip", dir=config.TMP_DIR)
        os.close(fd)
        started = time.time()
        file.save(zip_path)
        archive_info = {
            "name": file.filename,
            "size_bytes": os.path.getsize(zip_path),
            "upload_seconds": round(time.time() - started, 1),
        }

        project.status = "importing"
        db.commit()

        job_id = jobs.create("import-scan", message="Подготовка")
        _save_state(project_id, {
            "status": "scanning",
            "archive": archive_info,
            "zip_path": zip_path,
            "job_id": job_id,
        })
        threading.Thread(
            target=_run_scan_job,
            args=(job_id, project_id, zip_path, archive_info),
            daemon=True,
        ).start()
        return jsonify({"job_id": job_id}), 202
    finally:
        db.close()


@bp.get("/api/projects/<code>/import")
def get_import(code):
    db, project, err = _resolve(code)
    if err:
        return err
    try:
        state = _state(project.id) or {"status": "none"}
        # zip_path is a server detail; the wizard never needs it.
        return jsonify({k: v for k, v in state.items() if k != "zip_path"})
    finally:
        db.close()


@bp.delete("/api/projects/<code>/import")
def cancel_import(code):
    db, project, err = _resolve(code, "admin")
    if err:
        return err
    try:
        state = _state(project.id) or {}
        zip_path = state.get("zip_path")
        if zip_path:
            try:
                os.remove(zip_path)
            except OSError:
                pass
        for path in (_manifest_file(project.id), config.project_import_file(project.id)):
            try:
                os.remove(path)
            except OSError:
                pass
        project.status = "ready"
        db.commit()
        return jsonify({"ok": True})
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Import: writing to the database
# --------------------------------------------------------------------------- #
def _run_write_job(job_id, project_id, plan, zip_path, manifest, user_id):
    db = SessionLocal()
    try:
        jobs.update(job_id, message="Записываю изображения", phase="write",
                    total=len(manifest))
        images_dir = config.project_images_dir(project_id)
        thumbs_dir = config.project_thumbs_dir(project_id)
        os.makedirs(images_dir, exist_ok=True)
        os.makedirs(thumbs_dir, exist_ok=True)

        dataset = Dataset(
            project_id=project_id,
            name=plan["dataset_name"],
            identifier=_free_identifier(db, project_id, plan["dataset_identifier"]),
            created_by=user_id,
        )
        db.add(dataset)
        db.flush()

        superclass_ids = {}
        for sc in plan["superclasses"]:
            row = Superclass(
                project_id=project_id, name=sc["name"], color=sc["color"],
                created_by=user_id,
            )
            db.add(row)
            db.flush()
            superclass_ids[sc["name"]] = row.id

        class_ids = {}
        for cls in plan["classes"]:
            row = LabelClass(
                project_id=project_id,
                superclass_id=superclass_ids.get(cls.get("superclass")),
                class_index=cls["class_index"],
                name=cls["name"],
                color=cls["color"],
                created_by=user_id,
            )
            db.add(row)
            db.flush()
            class_ids[cls["class_index"]] = row.id
        db.commit()

        written = unreadable = orphan_boxes = 0
        with zipfile.ZipFile(zip_path) as zf:
            for i, entry in enumerate(manifest):
                image = Image(
                    project_id=project_id,
                    dataset_id=dataset.id,
                    file_name=os.path.basename(entry["image"]),
                    file_path="",
                    split=entry["split"],
                    created_by=user_id,
                )
                db.add(image)
                db.flush()

                dest = os.path.join(images_dir, f"{image.id}.jpg")
                thumb = os.path.join(thumbs_dir, f"{image.id}.jpg")
                info = importer.extract_image(zf, entry["image"], dest, thumb)
                if info is None:
                    # Damage inside the pixel data — the header parsed during
                    # the scan, so it is only visible now. Drop the image whole.
                    db.delete(image)
                    unreadable += 1
                    continue

                width, height, size_bytes = info
                image.file_path = os.path.relpath(dest, config.DATA_DIR)
                image.width = width
                image.height = height
                image.size_bytes = size_bytes

                for box in entry["boxes"]:
                    class_id = class_ids.get(box[0])
                    if class_id is None:
                        orphan_boxes += 1
                        continue
                    geometry, area = importer.to_pixels(box, width, height)
                    db.add(Annotation(
                        image_id=image.id,
                        class_id=class_id,
                        ann_type="bbox",
                        geometry=geometry,
                        area=round(area, 2),
                        created_by=user_id,
                    ))
                written += 1

                if (i + 1) % WRITE_BATCH == 0:
                    db.commit()
                    jobs.update(job_id, processed=i + 1)
        db.commit()

        project = db.get(Project, project_id)
        project.status = "ready"
        db.commit()

        result = {
            "dataset_id": str(dataset.id),
            "images": written,
            "unreadable": unreadable,
            "orphan_boxes": orphan_boxes,
        }
        _save_state(project_id, {"status": "done", "result": result})
        jobs.update(job_id, processed=len(manifest), status="done", result=result)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        _fail(project_id, job_id, str(exc))
    finally:
        db.close()
        for path in (zip_path, _manifest_file(project_id)):
            try:
                os.remove(path)
            except OSError:
                pass


@bp.post("/api/projects/<code>/import/commit")
def commit_import(code):
    db, project, err = _resolve(code, "admin")
    if err:
        return err
    try:
        state = _state(project.id)
        if not state or state.get("status") != "classes":
            return jsonify({"error": "Импорт не готов к записи."}), 409
        manifest = load_json(_manifest_file(project.id), None)
        if manifest is None:
            return jsonify({"error": "Список файлов потерян, начните импорт заново."}), 409

        data = request.get_json(silent=True) or {}
        plan, error = _build_plan(data, state)
        if error:
            return jsonify({"error": error}), 400

        user = current_user(db)
        job_id = jobs.create("import-write", message="Подготовка",
                             total=len(manifest))
        state["status"] = "writing"
        state["job_id"] = job_id
        _save_state(project.id, state)
        threading.Thread(
            target=_run_write_job,
            args=(job_id, project.id, plan, state["zip_path"], manifest, user.id),
            daemon=True,
        ).start()
        return jsonify({"job_id": job_id}), 202
    finally:
        db.close()


def _build_plan(data, state):
    """Validate what the class step sent back. Names are required, superclasses
    are not: a class without one simply drops out of superclass export."""
    dataset_name = (data.get("dataset_name") or "").strip()
    if not dataset_name:
        return None, "Укажите название датасета."

    known = {c["class_index"] for c in state["report"]["classes"]}
    superclasses = []
    seen_sc = set()
    for i, sc in enumerate(data.get("superclasses") or []):
        name = (sc.get("name") or "").strip()
        if not name or name in seen_sc:
            continue
        seen_sc.add(name)
        superclasses.append({
            "name": name,
            "color": sc.get("color") or PALETTE[i % len(PALETTE)],
        })

    classes = []
    seen_idx = set()
    for i, cls in enumerate(data.get("classes") or []):
        try:
            class_index = int(cls["class_index"])
        except (KeyError, TypeError, ValueError):
            return None, "Класс без идентификатора."
        if class_index not in known:
            return None, f"Класс {class_index} не встречался в архиве."
        if class_index in seen_idx:
            return None, f"Класс {class_index} указан дважды."
        seen_idx.add(class_index)
        name = (cls.get("name") or "").strip()
        if not name:
            return None, f"Класс {class_index} без названия."
        superclass = (cls.get("superclass") or "").strip() or None
        if superclass and superclass not in seen_sc:
            return None, f"Суперкласс «{superclass}» не объявлен."
        classes.append({
            "class_index": class_index,
            "name": name,
            "color": cls.get("color") or PALETTE[i % len(PALETTE)],
            "superclass": superclass,
        })
    if not classes:
        return None, "Не заполнен ни один класс."

    return {
        "dataset_name": dataset_name,
        "dataset_identifier": translit_slug(dataset_name) or "dataset",
        "superclasses": superclasses,
        "classes": classes,
    }, None


# --------------------------------------------------------------------------- #
# Reading project data
# --------------------------------------------------------------------------- #
@bp.get("/api/projects/<code>/datasets")
def list_datasets(code):
    db, project, err = _resolve(code)
    if err:
        return err
    try:
        rows = db.execute(
            select(
                Dataset,
                func.count(Image.id),
            )
            .outerjoin(Image, Image.dataset_id == Dataset.id)
            .where(Dataset.project_id == project.id)
            .group_by(Dataset.id)
            .order_by(Dataset.created_at)
        ).all()
        return jsonify({"datasets": [
            {
                "id": str(ds.id),
                "name": ds.name,
                "identifier": ds.identifier,
                "images_count": count,
                "created_at": ds.created_at.isoformat(),
            }
            for ds, count in rows
        ]})
    finally:
        db.close()


@bp.get("/api/projects/<code>/datasets/<dataset_id>")
def dataset_detail(code, dataset_id):
    db, project, err = _resolve(code)
    if err:
        return err
    try:
        dataset = _get_by_uuid(db, Dataset, dataset_id)
        if dataset is None or dataset.project_id != project.id:
            return jsonify({"error": "Датасет не найден."}), 404

        splits = dict(db.execute(
            select(Image.split, func.count(Image.id))
            .where(Image.dataset_id == dataset.id)
            .group_by(Image.split)
        ).all())
        images_total = sum(splits.values())
        annotations = db.execute(
            select(func.count(Annotation.id))
            .join(Image, Annotation.image_id == Image.id)
            .where(Image.dataset_id == dataset.id)
        ).scalar_one()
        # Здоровье датасета: сколько кадров вообще без объектов и один ли у
        # него размер. Разнобой разрешений ломает обучение, и увидеть его
        # надо раньше, чем начнётся тренировка.
        empty_total = db.execute(
            select(func.count(Image.id)).where(
                Image.dataset_id == dataset.id,
                ~Image.id.in_(select(Annotation.image_id)),
            )
        ).scalar_one()
        sizes = db.execute(
            select(Image.width, Image.height, func.count(Image.id))
            .where(Image.dataset_id == dataset.id)
            .group_by(Image.width, Image.height)
            .order_by(func.count(Image.id).desc())
            .limit(4)
        ).all()

        split = request.args.get("split")
        class_index = request.args.get("class_index")
        only_empty = request.args.get("empty") == "1"
        order = request.args.get("sort", "name")
        limit = min(int(request.args.get("limit", 60)), 200)
        offset = int(request.args.get("offset", 0))

        q = select(Image).where(Image.dataset_id == dataset.id)
        if split:
            q = q.where(Image.split == split)
        if only_empty:
            q = q.where(~Image.id.in_(select(Annotation.image_id)))
        if class_index is not None and class_index != "":
            # «Покажи все кадры с этим классом» — основной способ проверить,
            # как размечен конкретный класс.
            q = q.where(
                Image.id.in_(
                    select(Annotation.image_id)
                    .join(LabelClass, LabelClass.id == Annotation.class_id)
                    .where(
                        LabelClass.project_id == project.id,
                        LabelClass.class_index == int(class_index),
                    )
                )
            )
        matched = db.execute(
            select(func.count()).select_from(q.subquery())
        ).scalar_one()

        if order == "objects":
            # Кадры с аномальным числом объектов — первые кандидаты на проверку.
            counts = (
                select(Annotation.image_id.label("iid"), func.count().label("n"))
                .group_by(Annotation.image_id)
                .subquery()
            )
            q = (
                q.outerjoin(counts, counts.c.iid == Image.id)
                .order_by(func.coalesce(counts.c.n, 0).desc(), Image.file_name)
            )
        else:
            q = q.order_by(Image.file_name)

        images = db.execute(q.limit(limit).offset(offset)).scalars().all()

        # Геометрия приходит вместе со списком: отдельный запрос на кадр — это
        # шестьдесят запросов на страницу.
        ids = [i.id for i in images]
        by_image = {i: [] for i in ids}
        if ids:
            for ann, idx, name, color in db.execute(
                select(Annotation, LabelClass.class_index, LabelClass.name, LabelClass.color)
                .join(LabelClass, LabelClass.id == Annotation.class_id)
                .where(Annotation.image_id.in_(ids))
            ).all():
                g = ann.geometry or {}
                by_image[ann.image_id].append({
                    "x": g.get("x", 0), "y": g.get("y", 0),
                    "w": g.get("w", 0), "h": g.get("h", 0),
                    "class_index": idx, "name": name, "color": color,
                })

        return jsonify({
            "dataset": {
                "id": str(dataset.id),
                "name": dataset.name,
                "identifier": dataset.identifier,
                "created_at": dataset.created_at.isoformat(),
            },
            "stats": {
                "images": images_total,
                "annotations": annotations,
                "splits": splits,
                "without_annotations": empty_total,
                "per_image": round(annotations / images_total, 2) if images_total else 0,
                "resolutions": [
                    {"width": w, "height": h, "count": n} for w, h, n in sizes
                ],
            },
            "matched": matched,
            "my_role": _role(db, project),
            "images": [
                {
                    "id": str(img.id),
                    "file_name": img.file_name,
                    "split": img.split,
                    "width": img.width,
                    "height": img.height,
                    "size_bytes": img.size_bytes,
                    "annotations": len(by_image[img.id]),
                    "boxes": by_image[img.id],
                }
                for img in images
            ],
        })
    finally:
        db.close()


_PREVIEW_LOCKS = {}
_PREVIEW_GUARD = threading.Lock()


def _make_preview(image_id, src, dest):
    """Промежуточный размер под режим просмотра — делаем при первом запросе.

    Оригинал в 670 КБ там избыточен, а превью в 320 px мало. Ленивая
    генерация избавляет от перегона уже импортированных датасетов.
    """
    with _PREVIEW_GUARD:
        lock = _PREVIEW_LOCKS.setdefault(str(image_id), threading.Lock())
    with lock:
        if os.path.exists(dest):
            return dest
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        try:
            from PIL import Image as PilImage

            with PilImage.open(src) as img:
                small = img.convert("RGB")
                small.thumbnail(
                    (config.PREVIEW_MAX_SIDE, config.PREVIEW_MAX_SIDE),
                    PilImage.LANCZOS,
                )
                small.save(dest, "JPEG", quality=config.PREVIEW_QUALITY)
        except Exception:  # noqa: BLE001
            return None
        return dest


def _serve(image_id, kind):
    db = SessionLocal()
    try:
        user = current_user(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        image = _get_by_uuid(db, Image, image_id)
        if image is None:
            return jsonify({"error": "Изображение не найдено."}), 404
        project = db.get(Project, image.project_id)
        if not has_role(role_in(db, user, project), "viewer"):
            return jsonify({"error": "Нет доступа к проекту."}), 403

        # Кадр таски лежит под её каталогом и остаётся там после принятия.
        base = config.image_base_dir(image.project_id, image.task_id)
        original = os.path.join(base, "images", f"{image.id}.jpg")
        if kind == "thumb":
            path = os.path.join(base, "thumbs", f"{image.id}.jpg")
        elif kind == "preview":
            path = os.path.join(base, "preview", f"{image.id}.jpg")
            if not os.path.exists(path):
                fits = (
                    (image.width or 0) <= config.PREVIEW_MAX_SIDE
                    and (image.height or 0) <= config.PREVIEW_MAX_SIDE
                )
                # Мельче промежуточного размера пережимать нечего.
                if fits or _make_preview(image.id, original, path) is None:
                    path = original
        else:
            path = original

        if not os.path.exists(path):
            return jsonify({"error": "Файл не найден."}), 404
        resp = send_file(path, mimetype="image/jpeg", conditional=True)
        # Файл назван по uuid и никогда не меняется, поэтому переспрашивать
        # сервер незачем. Без этого заголовка браузер ходит за каждым превью
        # при каждой прокрутке галереи.
        resp.headers["Cache-Control"] = "private, max-age=31536000, immutable"
        return resp
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Классы и суперклассы проекта
#
# class_index не редактируется: это номер класса в выгруженном data.yaml, и
# менять его задним числом значит рассогласовать проект с уже обученными
# моделями. Порядок для экспорта задаётся при выгрузке (блок 4).
# --------------------------------------------------------------------------- #
def _class_json(row, annotations, superclass):
    return {
        "id": str(row.id),
        "class_index": row.class_index,
        "name": row.name,
        "color": row.color,
        "superclass_id": str(row.superclass_id) if row.superclass_id else None,
        "superclass_name": superclass.name if superclass is not None else None,
        "annotations": annotations,
    }


@bp.get("/api/projects/<code>/classes")
def list_classes(code):
    db, project, err = _resolve(code)
    if err:
        return err
    try:
        supers = db.execute(
            select(Superclass).where(Superclass.project_id == project.id)
            .order_by(Superclass.name)
        ).scalars().all()
        by_id = {s.id: s for s in supers}

        rows = db.execute(
            select(LabelClass).where(LabelClass.project_id == project.id)
            .order_by(LabelClass.class_index)
        ).scalars().all()
        counts = dict(db.execute(
            select(Annotation.class_id, func.count(Annotation.id))
            .where(Annotation.class_id.in_([r.id for r in rows] or [None]))
            .group_by(Annotation.class_id)
        ).all()) if rows else {}

        return jsonify({
            "classes": [
                _class_json(r, counts.get(r.id, 0), by_id.get(r.superclass_id))
                for r in rows
            ],
            "superclasses": [
                {
                    "id": str(s.id),
                    "name": s.name,
                    "color": s.color,
                    "classes": sum(1 for r in rows if r.superclass_id == s.id),
                }
                for s in supers
            ],
            "can_edit": has_role(role_in(db, current_user(db), project), "editor"),
        })
    finally:
        db.close()


@bp.post("/api/projects/<code>/classes")
def create_class(code):
    db, project, err = _resolve(code, "editor")
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Укажите название класса."}), 400
        # Номер выдаём сами — следующий свободный, чтобы не столкнуться с уже
        # занятым и не заставлять человека его выдумывать.
        used = set(db.execute(
            select(LabelClass.class_index).where(LabelClass.project_id == project.id)
        ).scalars())
        class_index = next(i for i in range(len(used) + 1) if i not in used)
        superclass_id = _superclass_arg(db, project, data)

        row = LabelClass(
            project_id=project.id,
            superclass_id=superclass_id,
            class_index=class_index,
            name=name,
            color=data.get("color") or PALETTE[class_index % len(PALETTE)],
            created_by=current_user(db).id,
        )
        db.add(row)
        db.commit()
        sc = db.get(Superclass, superclass_id) if superclass_id else None
        return jsonify(_class_json(row, 0, sc)), 201
    finally:
        db.close()


def _superclass_arg(db, project, data):
    """superclass_id из тела: пустая строка и null одинаково значат «без группы»."""
    raw = data.get("superclass_id")
    if not raw:
        return None
    try:
        sid = uuid.UUID(str(raw))
    except ValueError:
        return None
    sc = db.get(Superclass, sid)
    return sc.id if sc is not None and sc.project_id == project.id else None


@bp.patch("/api/projects/<code>/classes/<class_id>")
def update_class(code, class_id):
    db, project, err = _resolve(code, "editor")
    if err:
        return err
    try:
        row = _get_by_uuid(db, LabelClass, class_id)
        if row is None or row.project_id != project.id:
            return jsonify({"error": "Класс не найден."}), 404
        data = request.get_json(silent=True) or {}
        if "name" in data:
            name = (data.get("name") or "").strip()
            if not name:
                return jsonify({"error": "Название не может быть пустым."}), 400
            row.name = name
        if "color" in data and data["color"]:
            row.color = data["color"]
        if "superclass_id" in data:
            row.superclass_id = _superclass_arg(db, project, data)
        db.commit()
        count = db.execute(
            select(func.count()).select_from(Annotation)
            .where(Annotation.class_id == row.id)
        ).scalar_one()
        sc = db.get(Superclass, row.superclass_id) if row.superclass_id else None
        return jsonify(_class_json(row, count, sc))
    finally:
        db.close()


@bp.delete("/api/projects/<code>/classes/<class_id>")
def delete_class(code, class_id):
    db, project, err = _resolve(code, "editor")
    if err:
        return err
    try:
        row = _get_by_uuid(db, LabelClass, class_id)
        if row is None or row.project_id != project.id:
            return jsonify({"error": "Класс не найден."}), 404
        count = db.execute(
            select(func.count()).select_from(Annotation)
            .where(Annotation.class_id == row.id)
        ).scalar_one()
        # У класса CASCADE на аннотации: без явного подтверждения молча стёрлись
        # бы размеченные объекты. Число возвращаем, чтобы UI назвал цену.
        if count and request.args.get("confirm") != "1":
            return jsonify({
                "error": f"Вместе с классом будет удалено разметок: {count}.",
                "code": "confirm_required",
                "annotations": count,
            }), 409
        db.delete(row)
        db.commit()
        return jsonify({"ok": True, "deleted_annotations": count})
    finally:
        db.close()


@bp.post("/api/projects/<code>/superclasses")
def create_superclass(code):
    db, project, err = _resolve(code, "editor")
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Укажите название суперкласса."}), 400
        if db.execute(
            select(Superclass.id).where(
                Superclass.project_id == project.id, Superclass.name == name
            )
        ).first():
            return jsonify({"error": "Такой суперкласс уже есть."}), 409
        taken = db.execute(
            select(func.count()).select_from(Superclass)
            .where(Superclass.project_id == project.id)
        ).scalar_one()
        row = Superclass(
            project_id=project.id,
            name=name,
            color=data.get("color") or PALETTE[taken % len(PALETTE)],
            created_by=current_user(db).id,
        )
        db.add(row)
        db.commit()
        return jsonify({"id": str(row.id), "name": row.name, "color": row.color,
                        "classes": 0}), 201
    finally:
        db.close()


@bp.patch("/api/projects/<code>/superclasses/<sc_id>")
def update_superclass(code, sc_id):
    db, project, err = _resolve(code, "editor")
    if err:
        return err
    try:
        row = _get_by_uuid(db, Superclass, sc_id)
        if row is None or row.project_id != project.id:
            return jsonify({"error": "Суперкласс не найден."}), 404
        data = request.get_json(silent=True) or {}
        if "name" in data:
            name = (data.get("name") or "").strip()
            if not name:
                return jsonify({"error": "Название не может быть пустым."}), 400
            row.name = name
        if "color" in data and data["color"]:
            row.color = data["color"]
        db.commit()
        return jsonify({"id": str(row.id), "name": row.name, "color": row.color})
    finally:
        db.close()


@bp.delete("/api/projects/<code>/superclasses/<sc_id>")
def delete_superclass(code, sc_id):
    db, project, err = _resolve(code, "editor")
    if err:
        return err
    try:
        row = _get_by_uuid(db, Superclass, sc_id)
        if row is None or row.project_id != project.id:
            return jsonify({"error": "Суперкласс не найден."}), 404
        # Классы не удаляются — им проставляется NULL (SET NULL в схеме),
        # то есть они просто выпадают из схлопывания при экспорте.
        freed = db.execute(
            select(func.count()).select_from(LabelClass)
            .where(LabelClass.superclass_id == row.id)
        ).scalar_one()
        db.delete(row)
        db.commit()
        return jsonify({"ok": True, "classes_ungrouped": freed})
    finally:
        db.close()


@bp.get("/api/images/<image_id>/thumb")
def image_thumb(image_id):
    return _serve(image_id, "thumb")


@bp.get("/api/images/<image_id>/preview")
def image_preview(image_id):
    return _serve(image_id, "preview")


@bp.get("/api/images/<image_id>/file")
def image_file(image_id):
    return _serve(image_id, "file")
