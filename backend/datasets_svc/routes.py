import os
import shutil
import tempfile
import threading
import time
import zipfile

from flask import Blueprint, jsonify, request

from common import jobs
from common.config import (
    AUG_META_FILE,
    AUGMENTED_DIR,
    DATA_DIR,
    DATASETS_META_FILE,
    HOST_STAT_PATH,
    TMP_DIR,
    UPLOADED_DIR,
    kind_dir,
)
from common.datasets import (
    cached_num_classes,
    compute_and_cache_stats,
    count_images,
    get_cached_stats,
    validate_archive,
)
from common.storage import load_json, make_id, safe_name, save_json

bp = Blueprint("datasets", __name__)


def load_aug_meta():
    return load_json(AUG_META_FILE, {})


def load_ds_meta():
    return load_json(DATASETS_META_FILE, {})


def display_name_of(ds_id):
    """Pretty name for an uploaded dataset id, falling back to the id itself."""
    return load_ds_meta().get(ds_id, {}).get("display_name") or ds_id


@bp.get("/api/health")
def health():
    return jsonify({"status": "ok", "service": "datasets"})


@bp.get("/api/datasets")
def list_datasets():
    meta = load_aug_meta()
    ds_meta = load_ds_meta()
    items = []
    for ds_id in sorted(os.listdir(UPLOADED_DIR)):
        full = os.path.join(UPLOADED_DIR, ds_id)
        if os.path.isdir(full):
            items.append({
                "name": ds_id,  # id is the canonical handle used by all requests
                "kind": "uploaded",
                "images": count_images(full),
                "num_classes": cached_num_classes(full),
                "display_name": ds_meta.get(ds_id, {}).get("display_name", ds_id),
            })
    for ds_id in sorted(os.listdir(AUGMENTED_DIR)):
        full = os.path.join(AUGMENTED_DIR, ds_id)
        if os.path.isdir(full):
            m = meta.get(ds_id, {})
            source = m.get("source")
            items.append({
                "name": ds_id,
                "kind": "augmented",
                "images": count_images(full),
                "num_classes": cached_num_classes(full),
                "display_name": m.get("display_name", ds_id),
                "source": source,
                "source_name": ds_meta.get(source, {}).get("display_name", source),
                "config_names": [s.get("name") for s in m.get("configs", [])],
            })
    return jsonify(items)


@bp.get("/api/datasets/<kind>/<name>")
def get_dataset(kind, name):
    root = kind_dir(kind)
    if root is None:
        return jsonify({"error": "unknown kind"}), 404
    name = safe_name(name)
    path = os.path.join(root, name)
    if not os.path.isdir(path):
        return jsonify({"error": "dataset not found"}), 404
    stats = get_cached_stats(path)
    if kind == "augmented":
        meta = load_aug_meta().get(name)
        if meta:
            meta = dict(meta)
            meta["source_name"] = display_name_of(meta.get("source"))
            stats["display_name"] = meta.get("display_name")
        stats["meta"] = meta
    else:
        stats["display_name"] = display_name_of(name)
    return jsonify(stats)


def _run_upload_job(job_id, tmp_path, dest, display_name):
    """Validate and extract an uploaded archive, reporting progress."""
    ds_id = os.path.basename(dest)
    try:
        jobs.update(job_id, message="Проверка архива")
        try:
            zf = zipfile.ZipFile(tmp_path)
        except zipfile.BadZipFile:
            jobs.update(job_id, status="error", error="file is not a valid zip archive")
            return
        with zf:
            try:
                _cfg, _members, warnings = validate_archive(zf)
            except ValueError as exc:
                jobs.update(job_id, status="error", error=f"validation failed: {exc}")
                return

            members = [m for m in zf.infolist() if not m.is_dir()]
            jobs.update(job_id, total=len(members), message="Распаковка", phase="unpack")
            os.makedirs(dest, exist_ok=True)
            done = last = 0
            for m in members:
                zf.extract(m, dest)
                done += 1
                if done - last >= 25:
                    jobs.update(job_id, processed=done)
                    last = done

        jobs.update(job_id, processed=len(members),
                    message="Подсчёт статистики", phase="stats")
        stats = compute_and_cache_stats(dest)
        stats["warnings"] = warnings

        # Persist the user-facing name keyed by the stable id.
        ds_meta = load_ds_meta()
        ds_meta[ds_id] = {"display_name": display_name, "created_at": time.time()}
        save_json(DATASETS_META_FILE, ds_meta)
        stats["display_name"] = display_name

        jobs.update(job_id, status="done", result=stats)
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(dest, ignore_errors=True)
        jobs.update(job_id, status="error", error=str(exc))
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


@bp.post("/api/datasets")
def upload_dataset():
    if "file" not in request.files:
        return jsonify({"error": "no file part"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "empty filename"}), 400
    if not file.filename.lower().endswith(".zip"):
        return jsonify({"error": "only .zip archives are supported"}), 400

    # The display name is whatever the user typed (Cyrillic, dots, spaces…);
    # the folder is addressed by a stable ASCII id derived from it.
    display_name = (request.form.get("name") or "").strip()
    if not display_name:
        display_name = os.path.splitext(file.filename)[0]
    os.makedirs(UPLOADED_DIR, exist_ok=True)
    ds_id = make_id(display_name, UPLOADED_DIR)
    dest = os.path.join(UPLOADED_DIR, ds_id)
    os.makedirs(dest, exist_ok=True)  # reserve the id

    os.makedirs(TMP_DIR, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(suffix=".zip", dir=TMP_DIR)
    os.close(fd)
    file.save(tmp_path)

    job_id = jobs.create("upload", message="Подготовка")
    threading.Thread(
        target=_run_upload_job,
        args=(job_id, tmp_path, dest, display_name),
        daemon=True,
    ).start()
    return jsonify({"job_id": job_id}), 202


@bp.patch("/api/datasets/<kind>/<name>")
def rename_dataset(kind, name):
    """Change only the user-facing display name; the id/folder stays the same."""
    root = kind_dir(kind)
    if root is None:
        return jsonify({"error": "unknown kind"}), 404
    name = safe_name(name)
    if not os.path.isdir(os.path.join(root, name)):
        return jsonify({"error": "dataset not found"}), 404
    body = request.get_json(silent=True) or {}
    display_name = (body.get("display_name") or "").strip()
    if not display_name:
        return jsonify({"error": "название не может быть пустым"}), 400

    meta_file = AUG_META_FILE if kind == "augmented" else DATASETS_META_FILE
    meta = load_json(meta_file, {})
    entry = meta.get(name) or {}
    entry["display_name"] = display_name
    meta[name] = entry
    save_json(meta_file, meta)
    return jsonify({"ok": True, "display_name": display_name})


@bp.delete("/api/datasets/<kind>/<name>")
def delete_dataset(kind, name):
    root = kind_dir(kind)
    if root is None:
        return jsonify({"error": "unknown kind"}), 404
    name = safe_name(name)
    path = os.path.join(root, name)
    if not os.path.isdir(path):
        return jsonify({"error": "dataset not found"}), 404
    shutil.rmtree(path, ignore_errors=True)
    if kind == "augmented":
        meta = load_aug_meta()
        if name in meta:
            del meta[name]
            save_json(AUG_META_FILE, meta)
    else:
        ds_meta = load_ds_meta()
        if name in ds_meta:
            del ds_meta[name]
            save_json(DATASETS_META_FILE, ds_meta)
    return jsonify({"ok": True})


@bp.get("/api/jobs/<job_id>")
def get_job(job_id):
    job = jobs.get(job_id)
    if job is None:
        return jsonify({"error": "job not found"}), 404
    return jsonify(job)


# Disk usage for the sidebar meter. Walking the (large) uploaded tree is a bit
# costly, so the result is cached briefly.
_storage_cache = {"t": 0.0, "data": None}


def _dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


@bp.get("/api/storage")
def storage():
    now = time.time()
    cached = _storage_cache["data"]
    if cached and now - _storage_cache["t"] < 3:
        return jsonify(cached)
    # Stat the real host drive when a bind-mount is provided, otherwise fall
    # back to the (virtual) container filesystem.
    stat_path = DATA_DIR
    if HOST_STAT_PATH and os.path.isdir(HOST_STAT_PATH):
        stat_path = HOST_STAT_PATH
    du = shutil.disk_usage(stat_path)
    uploaded = _dir_size(UPLOADED_DIR)
    augmented = _dir_size(AUGMENTED_DIR)
    data = {
        "uploaded_bytes": uploaded,
        "augmented_bytes": augmented,
        # Everything the app stores on the shared volume (datasets, augmented,
        # videos, models, trainings, inference). This is the figure that drops
        # when anything is deleted, regardless of the host's vhdx not shrinking.
        "data_bytes": _dir_size(DATA_DIR),
        "disk_total": du.total,
        "disk_free": du.free,
        "disk_used": du.used,
    }
    _storage_cache.update(t=now, data=data)
    return jsonify(data)
