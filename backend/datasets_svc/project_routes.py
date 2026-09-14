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
from sqlalchemy import func, or_, select, update

from common import config, jobs, live, tags
from common.auth import current_user, has_role, project_by_code, role_in
from common.db import SessionLocal
from common.models import (
    Annotation,
    Dataset,
    Image,
    ImageTag,
    LabelClass,
    Project,
    Superclass,
    Tag,
    Task,
    TaskEvent,
    TaskVideo,
    TrainSet,
    VideoAnnotation,
    VideoTrack,
)
from common.storage import load_json, save_json, translit_slug
from datasets_svc import importer, upload
from common import shapes

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

        blocked = _import_blocked(db, project)
        if blocked:
            return blocked

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
        job_id = _begin_scan(db, project, zip_path, archive_info)
        return jsonify({"job_id": job_id}), 202
    finally:
        db.close()


def _import_blocked(db, project):
    """Почему в проект нельзя грузить архив, или ``None``."""
    existing = _state(project.id)
    if existing and existing.get("status") in ("scanning", "writing"):
        return jsonify({"error": "Импорт уже идёт."}), 409
    # Второй архив в проект пока не поддержан: его class_index столкнётся с
    # уже заведёнными классами. Отказываем явно, а не падаем на записи.
    if db.execute(
        select(func.count()).select_from(LabelClass)
        .where(LabelClass.project_id == project.id)
    ).scalar_one():
        return jsonify({
            "error": "В проекте уже есть классы. Импорт второго архива "
                     "появится позже — вместе со сверкой классов."
        }), 409
    return None


def _begin_scan(db, project, zip_path, archive_info, upload_id=None):
    """Архив на месте — запустить разбор. Возвращает номер работы.

    Номер загрузки пишется сюда же, одной записью: разбор маленького архива
    кончается за миллисекунды, и вторая запись состояния следом успевала бы
    затереть его «classes» обратно на «scanning».
    """
    project.status = "importing"
    db.commit()
    job_id = jobs.create("import-scan", message="Подготовка")
    _save_state(project.id, {
        "status": "scanning",
        "archive": archive_info,
        "zip_path": zip_path,
        "job_id": job_id,
        # Ради повторного «finish» после потерянного ответа.
        **({"upload": {"id": upload_id}} if upload_id else {}),
    })
    threading.Thread(
        target=_run_scan_job,
        args=(job_id, project.id, zip_path, archive_info),
        daemon=True,
    ).start()
    return job_id


# --------------------------------------------------------------------------- #
# Import: кусочная загрузка архива (см. upload.py, почему не одним запросом)
# --------------------------------------------------------------------------- #
@bp.post("/api/projects/<code>/import/upload")
def begin_upload(code):
    db, project, err = _resolve(code, "admin")
    if err:
        return err
    try:
        blocked = _import_blocked(db, project)
        if blocked:
            return blocked
        data = request.get_json(silent=True) or {}
        name = str(data.get("name") or "")
        try:
            size = int(data.get("size"))
        except (TypeError, ValueError):
            size = 0
        if not name.lower().endswith(".zip") or size <= 0:
            return jsonify({"error": "Нужен .zip архив."}), 400
        up = upload.begin(_state(project.id), name, size)
        _save_state(project.id, {
            "status": "uploading",
            "upload": up,
            "started": time.time(),
        })
        return jsonify({
            "upload_id": up["id"],
            "chunk_bytes": upload.CHUNK_BYTES,
            "received": up["received"],
            "size": up["size"],
        })
    finally:
        db.close()


@bp.put("/api/projects/<code>/import/upload/<upload_id>")
def put_chunk(code, upload_id):
    db, project, err = _resolve(code, "admin")
    if err:
        return err
    try:
        state = _state(project.id) or {}
        up = state.get("upload")
        if state.get("status") != "uploading" or not up or up["id"] != upload_id:
            return jsonify({"error": "Эта загрузка уже не идёт."}), 410
        try:
            offset = int(request.args.get("offset", "0"))
        except ValueError:
            return jsonify({"error": "Позиция куска не число."}), 400
        try:
            received = upload.receive(up, offset, request.stream)
        except upload.UploadError as exc:
            return jsonify({"error": str(exc), "received": exc.received}), exc.status
        up["received"] = received
        _save_state(project.id, state)
        return jsonify({"received": received})
    finally:
        db.close()


@bp.post("/api/projects/<code>/import/upload/<upload_id>/finish")
def finish_upload(code, upload_id):
    db, project, err = _resolve(code, "admin")
    if err:
        return err
    try:
        state = _state(project.id) or {}
        # Повтор после потерянного ответа: разбор уже идёт — отвечаем тем же.
        if (
            state.get("status") == "scanning"
            and (state.get("upload") or {}).get("id") == upload_id
        ):
            return jsonify({"job_id": state.get("job_id")}), 202
        up = state.get("upload")
        if state.get("status") != "uploading" or not up or up["id"] != upload_id:
            return jsonify({"error": "Эта загрузка уже не идёт."}), 410
        try:
            zip_path = upload.finish(up)
        except upload.UploadError as exc:
            return jsonify({"error": str(exc), "received": exc.received}), exc.status
        archive_info = {
            "name": up["name"],
            "size_bytes": up["size"],
            "upload_seconds": round(time.time() - float(state.get("started") or time.time()), 1),
        }
        job_id = _begin_scan(db, project, zip_path, archive_info, up["id"])
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
        return jsonify({k: v for k, v in state.items() if k not in ("zip_path", "started")})
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
        upload.discard(state.get("upload"))
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
        # Номера пришли из архива, а не от счётчика проекта: двигаем отметку
        # за ними, иначе следующий класс, созданный руками, налетит на занятый.
        if plan["classes"]:
            db.get(Project, project_id).next_class_index = max(
                cls["class_index"] for cls in plan["classes"]
            ) + 1
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

                # `boxes` — манифест, записанный прежней версией: он лежит
                # файлом между разбором архива и записью, и импорт, начатый до
                # обновления, дописывается уже после него.
                for shape in entry.get("shapes", entry.get("boxes") or []):
                    class_id = class_ids.get(importer.class_of(shape))
                    if class_id is None:
                        orphan_boxes += 1
                        continue
                    parsed = importer.to_pixels(shape, width, height)
                    if parsed is None:
                        # Контур, от которого после пересчёта в пиксели ничего
                        # не осталось. Кадр из-за одного объекта не роняем.
                        orphan_boxes += 1
                        continue
                    ann_type, geometry, area = parsed
                    db.add(Annotation(
                        image_id=image.id,
                        class_id=class_id,
                        ann_type=ann_type,
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


def _wanted_classes(project_id, db, raw):
    """Номера классов из запроса → их id в проекте.

    Список, а не одно значение: «покажи кадры, где есть вагон или столб» —
    обычный вопрос, а до 08.09.2026 фильтр брал ровно один класс, и такой
    вопрос приходилось задавать в два захода и складывать глазами.
    """
    numbers = []
    for piece in (raw or "").split(","):
        piece = piece.strip()
        if not piece:
            continue
        try:
            numbers.append(int(piece))
        except ValueError:
            continue
    if not numbers:
        return []
    return list(db.execute(
        select(LabelClass.id).where(
            LabelClass.project_id == project_id,
            LabelClass.class_index.in_(numbers),
        )
    ).scalars())


def _image_query(db, project, *, dataset_ids, split, class_ids, only_empty):
    """Запрос кадров проекта под общий набор фильтров."""
    q = select(Image).where(Image.project_id == project.id)
    if dataset_ids:
        q = q.where(Image.dataset_id.in_(dataset_ids))
    if split:
        q = q.where(Image.split == split)
    if only_empty:
        q = q.where(~Image.id.in_(select(Annotation.image_id)))
    if class_ids:
        # Кадр подходит, если на нём есть хоть один из выбранных классов.
        q = q.where(
            Image.id.in_(
                select(Annotation.image_id)
                .where(Annotation.class_id.in_(class_ids))
            )
        )
    return q


def _ordered(q, order):
    if order == "objects":
        # Кадры с аномальным числом объектов — первые кандидаты на проверку.
        counts = (
            select(Annotation.image_id.label("iid"), func.count().label("n"))
            .group_by(Annotation.image_id)
            .subquery()
        )
        return (
            q.outerjoin(counts, counts.c.iid == Image.id)
            .order_by(func.coalesce(counts.c.n, 0).desc(), Image.file_name)
        )
    return q.order_by(Image.file_name, Image.id)


def _shapes_by_image(db, ids):
    """Геометрия пачкой: отдельный запрос на кадр — это шестьдесят поездок."""
    by_image = {i: [] for i in ids}
    if not ids:
        return by_image
    for ann, idx, name, color in db.execute(
        select(Annotation, LabelClass.class_index, LabelClass.name, LabelClass.color)
        .join(LabelClass, LabelClass.id == Annotation.class_id)
        .where(Annotation.image_id.in_(ids))
    ).all():
        wire = shapes.to_wire(ann.ann_type, ann.geometry)
        if not wire:
            continue
        by_image[ann.image_id].append({
            **wire, "class_index": idx, "name": name, "color": color,
        })
    return by_image


def _image_row(img, boxes, dataset=None):
    row = {
        "id": str(img.id),
        "file_name": img.file_name,
        "split": img.split,
        "width": img.width,
        "height": img.height,
        "size_bytes": img.size_bytes,
        "annotations": len(boxes),
        "boxes": boxes,
    }
    if dataset is not None:
        row["dataset_id"] = str(dataset.id)
        row["dataset_name"] = dataset.name
    return row


@bp.get("/api/projects/<code>/images")
def project_images(code):
    """Кадры всего проекта разом, с пометкой, из какого они датасета.

    Отдельная ручка, а не «датасет со звёздочкой»: у проекта нет ни одного
    паспорта датасета, зато есть свой — какие датасеты вообще выбирать. Ходить
    за кадрами по одному датасету, когда смотрят все, значило бы склеивать
    страницы на клиенте и врать в счётчике.
    """
    db, project, err = _resolve(code)
    if err:
        return err
    try:
        picked = [
            d for d in db.execute(
                select(Dataset).where(Dataset.project_id == project.id)
                .order_by(Dataset.created_at)
            ).scalars()
        ]
        by_id = {d.id: d for d in picked}
        raw = (request.args.get("datasets") or "").strip()
        chosen = []
        for piece in raw.split(","):
            row = _get_by_uuid(db, Dataset, piece.strip()) if piece.strip() else None
            if row is not None and row.project_id == project.id:
                chosen.append(row.id)

        split = request.args.get("split") or None
        only_empty = request.args.get("empty") == "1"
        order = request.args.get("sort", "name")
        class_ids = _wanted_classes(project.id, db, request.args.get("classes"))
        try:
            limit = min(max(int(request.args.get("limit", 60)), 1), 200)
            offset = max(int(request.args.get("offset", 0)), 0)
        except ValueError:
            limit, offset = 60, 0

        q = _image_query(
            db, project, dataset_ids=chosen, split=split,
            class_ids=class_ids, only_empty=only_empty,
        )
        matched = db.execute(
            select(func.count()).select_from(q.subquery())
        ).scalar_one()
        images = db.execute(_ordered(q, order).limit(limit).offset(offset)).scalars().all()
        by_image = _shapes_by_image(db, [i.id for i in images])

        splits = dict(db.execute(
            select(Image.split, func.count(Image.id))
            .where(Image.project_id == project.id)
            .group_by(Image.split)
        ).all())
        per_dataset = dict(db.execute(
            select(Image.dataset_id, func.count(Image.id))
            .where(Image.project_id == project.id)
            .group_by(Image.dataset_id)
        ).all())
        return jsonify({
            "datasets": [
                {"id": str(d.id), "name": d.name, "identifier": d.identifier,
                 "images": per_dataset.get(d.id, 0)}
                for d in picked
            ],
            "splits": splits,
            "total": sum(splits.values()),
            "matched": matched,
            "my_role": _role(db, project),
            "images": [
                _image_row(img, by_image[img.id], by_id.get(img.dataset_id))
                for img in images
            ],
        })
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
        only_empty = request.args.get("empty") == "1"
        order = request.args.get("sort", "name")
        try:
            limit = min(max(int(request.args.get("limit", 60)), 1), 200)
            offset = max(int(request.args.get("offset", 0)), 0)
        except ValueError:
            limit, offset = 60, 0
        # `class_index` — прежнее имя на один класс; понимаем оба, потому что
        # ссылку с ним человек мог сохранить.
        wanted = request.args.get("classes")
        if not wanted and request.args.get("class_index"):
            wanted = request.args.get("class_index")
        class_ids = _wanted_classes(project.id, db, wanted)

        q = _image_query(
            db, project, dataset_ids=[dataset.id], split=split,
            class_ids=class_ids, only_empty=only_empty,
        )
        matched = db.execute(
            select(func.count()).select_from(q.subquery())
        ).scalar_one()
        q = _ordered(q, order)

        images = db.execute(q.limit(limit).offset(offset)).scalars().all()
        by_image = _shapes_by_image(db, [i.id for i in images])

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
                _image_row(img, by_image[img.id]) for img in images
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

        role = role_in(db, current_user(db), project)
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
            "can_edit": has_role(role, "editor"),
            # Судьба класса — уровня владельца проекта: удаление и перенос
            # разметки трогают работу всех разметчиков сразу и необратимы.
            # Создание, переименование и цвет остаются у редактора.
            "can_manage": has_role(role, "admin"),
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
        # Номер выдаём сами и НИКОГДА не переиспользуем освободившийся:
        # `class_index` уходит в мету выгрузки, и «3 = Шпала» из прошлого
        # экспорта не должно однажды означать «3 = Опора». Дырки в нумерации
        # ничего не стоят — `export_id` в выгрузке всё равно считается заново
        # от нуля (common/selection.py), а номер здесь лишь опознавательный.
        #
        # Отметка у проекта, а не `max + 1` по живым классам: удаление самого
        # верхнего класса снова освобождало бы его номер, а это тот же случай.
        class_index = db.execute(
            update(Project)
            .where(Project.id == project.id)
            .values(next_class_index=Project.next_class_index + 1)
            .returning(Project.next_class_index)
        ).scalar_one() - 1
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
        # Открытые редакторы держат список классов в памяти и адресуют боксы
        # номером класса: без этого нового класса там не будет до перезагрузки.
        live.notify(db, "classes", project.id, project.id)
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
        live.notify(db, "classes", project.id, project.id)
        count = db.execute(
            select(func.count()).select_from(Annotation)
            .where(Annotation.class_id == row.id)
        ).scalar_one()
        sc = db.get(Superclass, row.superclass_id) if row.superclass_id else None
        return jsonify(_class_json(row, count, sc))
    finally:
        db.close()


# Наборы, до которых сборка ещё не дошла: их `spec` читается в момент сборки,
# а не создания, поэтому удалённый класс успевает исчезнуть у них из-под ног.
UNBUILT_SETS = ("draft", "queued", "building")


def _track_ids(db, cls_id):
    return db.execute(
        select(VideoTrack.id).where(VideoTrack.class_id == cls_id)
    ).scalars().all()


def _video_cond(cls_id, track_ids):
    """Разметка ролика, которую утащит за собой этот класс.

    Через ИЛИ, а не по одному полю: ключ трека гибнет двумя путями — своим
    `class_id` и каскадом от трека. Классы у ключа и у его трека обязаны
    совпадать, но условие, полагающееся на это, врало бы ровно там, где они
    разошлись.
    """
    cond = VideoAnnotation.class_id == cls_id
    if track_ids:
        cond = or_(cond, VideoAnnotation.track_id.in_(track_ids))
    return cond


def _class_usage(db, project, cls, target=None):
    """Всё, что класс держит на себе, — по трём таблицам, которые на него
    ссылаются каскадом.

    Считать одни `annotations` было мало: на `classes.id` висят ещё
    `video_tracks` и `video_annotations`. Класс, размеченный только в несданных
    роликах, показывал «0 разметок», а удаление молча уносило чужие треки
    целиком — вместе с ключевыми кадрами, которые ставили руками.
    """
    track_ids = _track_ids(db, cls.id)
    cond = _video_cond(cls.id, track_ids)

    def count(model, *where):
        return db.execute(
            select(func.count()).select_from(model).where(*where)
        ).scalar_one()

    videos = set(db.execute(
        select(VideoTrack.video_id).where(VideoTrack.class_id == cls.id).distinct()
    ).scalars())
    videos |= set(db.execute(
        select(VideoAnnotation.video_id).where(cond).distinct()
    ).scalars())

    tasks = []
    if videos:
        rows = db.execute(
            select(Task.id, Task.name, Task.status)
            .join(TaskVideo, TaskVideo.task_id == Task.id)
            .where(TaskVideo.id.in_(videos))
            .distinct()
        ).all()
        tasks = [
            {"id": str(tid), "name": name, "status": status}
            for tid, name, status in rows
        ]

    # Наборы держат отбор списком uuid в `spec`; наборов в проекте десятки,
    # поэтому читаем их и сверяем на месте, а не выражением по JSON, которое
    # разошлось бы между PostgreSQL и SQLite в тестах.
    in_sets, unbuilt = 0, []
    for tset in db.execute(
        select(TrainSet).where(TrainSet.project_id == project.id)
    ).scalars():
        picked = {str(x) for x in ((tset.spec or {}).get("classes") or [])}
        if str(cls.id) not in picked:
            continue
        in_sets += 1
        if tset.status in UNBUILT_SETS:
            unbuilt.append(tset.name)

    out = {
        "class_id": str(cls.id),
        "name": cls.name,
        "annotations": count(Annotation, Annotation.class_id == cls.id),
        "video_tracks": len(track_ids),
        "video_keys": count(
            VideoAnnotation, cond, VideoAnnotation.track_id.isnot(None)
        ),
        "video_singles": count(
            VideoAnnotation, cond, VideoAnnotation.track_id.is_(None)
        ),
        "tasks": tasks,
        "train_sets": in_sets,
        "unbuilt_sets": unbuilt,
    }
    if target is not None:
        # Кадры, где разметка обоих классов уже есть: после слияния там будут
        # дубли. Только изображения — у ролика «кадр с обоими классами» без
        # прогона интерполяции не сосчитать, и число вышло бы заниженным,
        # то есть врущим.
        mine = select(Annotation.image_id).where(
            Annotation.class_id == cls.id
        ).distinct()
        theirs = select(Annotation.image_id).where(
            Annotation.class_id == target.id
        ).distinct()
        out["overlap_images"] = db.execute(
            select(func.count()).select_from(mine.intersect(theirs).subquery())
        ).scalar_one()
        out["target_id"] = str(target.id)
    return out


def _target_arg(db, project, raw):
    """Целевой класс переноса: (класс, ошибка)."""
    target = _get_by_uuid(db, LabelClass, raw) if raw else None
    if target is None or target.project_id != project.id:
        return None, (jsonify({"error": "Целевой класс не найден."}), 404)
    return target, None


@bp.get("/api/projects/<code>/classes/<class_id>/usage")
def class_usage(code, class_id):
    """Чем занят класс — до того, как человек решит его судьбу.

    Отдельной ручкой, а не полем в списке классов: список зовётся при каждом
    открытии вкладки, а эти счётчики лезут во все таски проекта и нужны раз в
    месяц. И не через 409 у DELETE: чтобы узнать, стоит ли НЕ удалять, звать
    удаление — странный способ спрашивать.
    """
    db, project, err = _resolve(code)
    if err:
        return err
    try:
        row = _get_by_uuid(db, LabelClass, class_id)
        if row is None or row.project_id != project.id:
            return jsonify({"error": "Класс не найден."}), 404
        target = None
        raw = request.args.get("target")
        if raw:
            target, bad = _target_arg(db, project, raw)
            if bad:
                return bad
        return jsonify(_class_usage(db, project, row, target))
    finally:
        db.close()


@bp.post("/api/projects/<code>/classes/<class_id>/move")
def move_class(code, class_id):
    """Отдать разметку класса другому классу.

    Одна ручка на два применения: слияние (`delete_source`) и переназначение,
    оставляющее класс пустым. Это один и тот же `UPDATE`, и разделять его на
    два кода незачем.

    Синхронно и одной транзакцией: три `UPDATE` по индексированным полям — это
    секунды даже на полумиллионе строк, а транзакция даёт то, чего воркер даром
    не даст, — либо переехали все три таблицы, либо ни одна. Класс, переехавший
    наполовину, был бы хуже любого ожидания.
    """
    db, project, err = _resolve(code, "admin")
    if err:
        return err
    try:
        row = _get_by_uuid(db, LabelClass, class_id)
        if row is None or row.project_id != project.id:
            return jsonify({"error": "Класс не найден."}), 404
        data = request.get_json(silent=True) or {}
        target, bad = _target_arg(db, project, data.get("target_id"))
        if bad:
            return bad
        if target.id == row.id:
            return jsonify({"error": "Класс совпадает с целевым."}), 400

        usage = _class_usage(db, project, row, target)
        user = current_user(db)

        # Порядок важен: список треков берём ДО того, как у них сменится класс,
        # и ключи двигаем по номеру трека, а не по классу. Иначе ключ, у
        # которого класс разошёлся с треком, остался бы висеть на исходном
        # классе — и удаление этого класса снесло бы ключевые кадры только что
        # перенесённого трека.
        track_ids = _track_ids(db, row.id)
        if track_ids:
            db.execute(
                update(VideoAnnotation)
                .where(VideoAnnotation.track_id.in_(track_ids))
                .values(class_id=target.id)
            )
        db.execute(
            update(VideoAnnotation)
            .where(VideoAnnotation.class_id == row.id)
            .values(class_id=target.id)
        )
        db.execute(
            update(VideoTrack)
            .where(VideoTrack.class_id == row.id)
            .values(class_id=target.id)
        )
        db.execute(
            update(Annotation)
            .where(Annotation.class_id == row.id)
            .values(class_id=target.id)
        )

        # В ленту затронутых тасок: разметчик увидит, почему его треки вдруг
        # называются иначе. У датасетных разметок такой ленты нет, и следа от
        # переноса там не останется — это названная цена, а не недосмотр.
        for task in usage["tasks"]:
            if task["status"] == "closed":
                continue
            db.add(TaskEvent(
                task_id=uuid.UUID(task["id"]),
                user_id=user.id if user else None,
                kind="class_moved",
                payload={
                    "from": row.name,
                    "to": target.name,
                    "tracks": usage["video_tracks"],
                    "keys": usage["video_keys"],
                },
            ))

        deleted = bool(data.get("delete_source"))
        if deleted:
            db.delete(row)
        db.commit()
        live.notify(db, "classes", project.id, project.id)
        return jsonify({
            "ok": True,
            "moved": {k: usage[k] for k in
                      ("annotations", "video_tracks", "video_keys",
                       "video_singles")},
            "overlap_images": usage.get("overlap_images", 0),
            "source_deleted": deleted,
            "target_id": str(target.id),
        })
    finally:
        db.close()


@bp.delete("/api/projects/<code>/classes/<class_id>")
def delete_class(code, class_id):
    db, project, err = _resolve(code, "admin")
    if err:
        return err
    try:
        row = _get_by_uuid(db, LabelClass, class_id)
        if row is None or row.project_id != project.id:
            return jsonify({"error": "Класс не найден."}), 404
        usage = _class_usage(db, project, row)
        total = (usage["annotations"] + usage["video_tracks"]
                 + usage["video_keys"] + usage["video_singles"])
        # У класса CASCADE на все три таблицы: без явного подтверждения молча
        # стёрлись бы и боксы, и чужие треки. Числа возвращаем, чтобы тот, кто
        # ходит в API мимо интерфейса, тоже услышал цену.
        if total and request.args.get("confirm") != "1":
            return jsonify({
                "error": (
                    f"Вместе с классом будет удалено: разметок "
                    f"{usage['annotations']}, треков {usage['video_tracks']}, "
                    f"ключевых кадров {usage['video_keys']}."
                ),
                "code": "confirm_required",
                **usage,
            }), 409
        db.delete(row)
        db.commit()
        live.notify(db, "classes", project.id, project.id)
        return jsonify({
            "ok": True,
            "deleted_annotations": usage["annotations"],
            "deleted_tracks": usage["video_tracks"],
            "deleted_keys": usage["video_keys"],
            "deleted_singles": usage["video_singles"],
        })
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Таги
# --------------------------------------------------------------------------- #
@bp.get("/api/projects/<code>/tags")
def list_tags(code):
    db, project, err = _resolve(code)
    if err:
        return err
    try:
        rows = tags.project_tags(db, project.id)
        counts = dict(db.execute(
            select(ImageTag.tag_id, func.count(ImageTag.image_id))
            .where(ImageTag.tag_id.in_([r.id for r in rows] or [None]))
            .group_by(ImageTag.tag_id)
        ).all()) if rows else {}
        return jsonify({
            "tags": [
                {**tags.view(r), "images": counts.get(r.id, 0)} for r in rows
            ],
            "can_edit": has_role(_role(db, project), "editor"),
        })
    finally:
        db.close()


@bp.post("/api/projects/<code>/tags")
def create_tag(code):
    db, project, err = _resolve(code, "editor")
    if err:
        return err
    try:
        name = ((request.get_json(silent=True) or {}).get("name") or "").strip()
        if not name:
            return jsonify({"error": "Укажите название тага."}), 400
        if len(name) > 64:
            return jsonify({"error": "Название тага длиннее 64 символов."}), 400
        # Тот же таг, заведённый дважды из двух окон, — обычное дело: чип-пикер
        # создаёт таг по ходу разметки. Отдаём существующий, а не ошибку.
        row = db.execute(
            select(Tag).where(Tag.project_id == project.id, Tag.name == name)
        ).scalar_one_or_none()
        if row is None:
            row = Tag(project_id=project.id, name=name,
                      created_by=current_user(db).id)
            db.add(row)
            db.commit()
        return jsonify(tags.view(row)), 201
    finally:
        db.close()


@bp.patch("/api/projects/<code>/tags/<tag_id>")
def rename_tag(code, tag_id):
    db, project, err = _resolve(code, "editor")
    if err:
        return err
    try:
        row = _get_by_uuid(db, Tag, tag_id)
        if row is None or row.project_id != project.id:
            return jsonify({"error": "Таг не найден."}), 404
        name = ((request.get_json(silent=True) or {}).get("name") or "").strip()
        if not name:
            return jsonify({"error": "Укажите название тага."}), 400
        if db.execute(
            select(Tag.id).where(Tag.project_id == project.id, Tag.name == name,
                                 Tag.id != row.id)
        ).first():
            return jsonify({"error": "Таг с таким названием уже есть."}), 409
        row.name = name
        db.commit()
        return jsonify(tags.view(row))
    finally:
        db.close()


@bp.get("/api/projects/<code>/tags/<tag_id>/usage")
def tag_usage(code, tag_id):
    db, project, err = _resolve(code)
    if err:
        return err
    try:
        row = _get_by_uuid(db, Tag, tag_id)
        if row is None or row.project_id != project.id:
            return jsonify({"error": "Таг не найден."}), 404
        return jsonify(tags.usage(db, row.id))
    finally:
        db.close()


@bp.delete("/api/projects/<code>/tags/<tag_id>")
def delete_tag(code, tag_id):
    db, project, err = _resolve(code, "editor")
    if err:
        return err
    try:
        row = _get_by_uuid(db, Tag, tag_id)
        if row is None or row.project_id != project.id:
            return jsonify({"error": "Таг не найден."}), 404
        used = tags.usage(db, row.id)
        # Таг с CASCADE уносит только свои связи — кадры целы. Но набор,
        # собранный по этому тагу, после удаления соберётся из пустоты, и это
        # надо услышать заранее, а не по нулям в отчёте.
        if used["images"] + used["videos"] and request.args.get("confirm") != "1":
            return jsonify({
                "error": (
                    f"Таг снимется с кадров — {used['images']}, "
                    f"с роликов — {used['videos']}. Строки сборки, которые "
                    "брали кадры по нему, останутся пустыми."
                ),
                "code": "confirm_required",
                **used,
            }), 409
        db.delete(row)
        db.commit()
        return jsonify({"ok": True, **used})
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
