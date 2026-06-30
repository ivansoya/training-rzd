import os
import shutil
import tempfile
import threading
import zipfile

from flask import Blueprint, jsonify, request

from common import jobs
from common.config import (
    AUG_META_FILE,
    AUGMENTED_DIR,
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
from common.storage import load_json, safe_name, save_json

bp = Blueprint("datasets", __name__)


def load_aug_meta():
    return load_json(AUG_META_FILE, {})


@bp.get("/api/health")
def health():
    return jsonify({"status": "ok", "service": "datasets"})


@bp.get("/api/datasets")
def list_datasets():
    meta = load_aug_meta()
    items = []
    for name in sorted(os.listdir(UPLOADED_DIR)):
        full = os.path.join(UPLOADED_DIR, name)
        if os.path.isdir(full):
            items.append({
                "name": name,
                "kind": "uploaded",
                "images": count_images(full),
                "num_classes": cached_num_classes(full),
            })
    for name in sorted(os.listdir(AUGMENTED_DIR)):
        full = os.path.join(AUGMENTED_DIR, name)
        if os.path.isdir(full):
            m = meta.get(name, {})
            items.append({
                "name": name,
                "kind": "augmented",
                "images": count_images(full),
                "num_classes": cached_num_classes(full),
                "display_name": m.get("display_name", name),
                "source": m.get("source"),
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
        stats["meta"] = load_aug_meta().get(name)
    return jsonify(stats)


def _run_upload_job(job_id, tmp_path, dest):
    """Validate and extract an uploaded archive, reporting progress."""
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

    name = safe_name(request.form.get("name") or file.filename)
    dest = os.path.join(UPLOADED_DIR, name)
    if os.path.exists(dest):
        return jsonify({"error": f"dataset '{name}' already exists"}), 409

    os.makedirs(TMP_DIR, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(suffix=".zip", dir=TMP_DIR)
    os.close(fd)
    file.save(tmp_path)

    job_id = jobs.create("upload", message="Подготовка")
    threading.Thread(
        target=_run_upload_job, args=(job_id, tmp_path, dest), daemon=True
    ).start()
    return jsonify({"job_id": job_id}), 202


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
    return jsonify({"ok": True})


@bp.get("/api/jobs/<job_id>")
def get_job(job_id):
    job = jobs.get(job_id)
    if job is None:
        return jsonify({"error": "job not found"}), 404
    return jsonify(job)
