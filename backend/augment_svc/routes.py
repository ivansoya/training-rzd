import os
import shutil
import threading
import time
import uuid

from flask import Blueprint, jsonify, request

from common import jobs
from common.config import (
    AUG_META_FILE,
    AUGMENTED_DIR,
    BASE_CONFIG_ID,
    CONFIGS_FILE,
    UPLOADED_DIR,
)
from common.datasets import compute_stats, stats_cache_path
from common.storage import load_json, safe_name, save_json
from augment_svc import engine

bp = Blueprint("augmentation", __name__)


def load_configs():
    configs = load_json(CONFIGS_FILE, [])
    if not any(c["id"] == BASE_CONFIG_ID for c in configs):
        configs.insert(0, {
            "id": BASE_CONFIG_ID,
            "name": "Базовая (без аугментаций)",
            "transforms": [],
            "builtin": True,
            "created_at": time.time(),
        })
        save_json(CONFIGS_FILE, configs)
    return configs


def load_aug_meta():
    return load_json(AUG_META_FILE, {})


@bp.get("/api/health")
def health():
    return jsonify({"status": "ok", "service": "augmentation",
                    "albumentations": engine.is_available()})


@bp.get("/api/aug/transforms")
def list_transforms():
    if not engine.is_available():
        return jsonify({"available": False, "transforms": []})
    return jsonify({"available": True, "transforms": engine.registry_schema()})


@bp.get("/api/aug/configs")
def list_configs():
    return jsonify(load_configs())


@bp.post("/api/aug/configs")
def create_config():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    configs = load_configs()
    config = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "transforms": body.get("transforms", []),
        "builtin": False,
        "created_at": time.time(),
    }
    configs.append(config)
    save_json(CONFIGS_FILE, configs)
    return jsonify(config), 201


@bp.put("/api/aug/configs/<config_id>")
def update_config(config_id):
    body = request.get_json(silent=True) or {}
    configs = load_configs()
    config = next((c for c in configs if c["id"] == config_id), None)
    if config is None:
        return jsonify({"error": "config not found"}), 404
    if config.get("builtin"):
        return jsonify({"error": "базовую конфигурацию нельзя изменить"}), 400
    if "name" in body and body["name"].strip():
        config["name"] = body["name"].strip()
    if "transforms" in body:
        config["transforms"] = body["transforms"]
    save_json(CONFIGS_FILE, configs)
    return jsonify(config)


@bp.delete("/api/aug/configs/<config_id>")
def delete_config(config_id):
    configs = load_configs()
    config = next((c for c in configs if c["id"] == config_id), None)
    if config is None:
        return jsonify({"error": "config not found"}), 404
    if config.get("builtin"):
        return jsonify({"error": "базовую конфигурацию нельзя удалить"}), 400
    configs = [c for c in configs if c["id"] != config_id]
    save_json(CONFIGS_FILE, configs)
    return jsonify({"ok": True})


@bp.post("/api/aug/preview")
def preview_config():
    if not engine.is_available():
        return jsonify({"error": "albumentations недоступна на сервере"}), 503
    body = request.get_json(silent=True) or {}
    source = safe_name(body.get("source"))
    transforms = body.get("transforms", [])
    source_dir = os.path.join(UPLOADED_DIR, source)
    if not os.path.isdir(source_dir):
        return jsonify({"error": "выберите загруженный датасет для превью"}), 404
    try:
        result = engine.preview(source_dir, transforms, seed=body.get("seed"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(result)


def _run_augment_job(job_id, source_dir, dest, folder, source, display_name,
                     snapshots, scope):
    """Generate an augmented dataset in the background, reporting progress."""
    try:
        state = {"t": 0.0}

        def progress(done, total):
            now = time.time()
            if now - state["t"] >= 0.3 or done >= total:
                jobs.update(job_id, processed=done, total=total)
                state["t"] = now

        total = engine.count_images(source_dir, scope) * max(1, len(snapshots))
        jobs.update(job_id, total=total, message="Генерация аугментаций",
                    phase="generate")

        written = engine.generate(source_dir, dest, snapshots, scope=scope,
                                  progress=progress)

        meta = load_aug_meta()
        meta[folder] = {
            "display_name": display_name,
            "source": source,
            "configs": snapshots,
            "scope": scope,
            "created_at": time.time(),
            "images": written,
        }
        save_json(AUG_META_FILE, meta)

        jobs.update(job_id, message="Подсчёт статистики", phase="stats")
        stats = compute_stats(dest)
        stats["meta"] = meta[folder]
        try:
            save_json(stats_cache_path(dest), stats)
        except OSError:
            pass
        jobs.update(job_id, status="done", result=stats)
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(dest, ignore_errors=True)
        jobs.update(job_id, status="error", error=f"augmentation failed: {exc}")


@bp.post("/api/aug/generate")
def create_augmented():
    if not engine.is_available():
        return jsonify({"error": "albumentations недоступна на сервере"}), 503
    body = request.get_json(silent=True) or {}
    source = safe_name(body.get("source"))
    display_name = (body.get("display_name") or "").strip()
    scope = body.get("scope", "all")
    if scope not in ("all", "train"):
        scope = "all"

    config_ids = body.get("config_ids")
    if not config_ids and body.get("config_id"):
        config_ids = [body["config_id"]]
    if not config_ids:
        return jsonify({"error": "выберите хотя бы одну конфигурацию"}), 400

    source_dir = os.path.join(UPLOADED_DIR, source)
    if not os.path.isdir(source_dir):
        return jsonify({"error": "source dataset not found"}), 404

    all_configs = {c["id"]: c for c in load_configs()}
    snapshots = []
    for cid in config_ids:
        cfg = all_configs.get(cid)
        if cfg is None:
            return jsonify({"error": f"config '{cid}' not found"}), 404
        snapshots.append({
            "config_id": cid,
            "name": cfg["name"],
            "transforms": cfg.get("transforms", []),
        })

    if not display_name:
        names = ", ".join(s["name"] for s in snapshots)
        display_name = f"{source} · {names}"

    folder = safe_name(display_name)
    dest = os.path.join(AUGMENTED_DIR, folder)
    suffix = 1
    while os.path.exists(dest):
        suffix += 1
        folder = f"{safe_name(display_name)}_{suffix}"
        dest = os.path.join(AUGMENTED_DIR, folder)
    os.makedirs(dest, exist_ok=True)

    job_id = jobs.create("augment", message="Подготовка")
    threading.Thread(
        target=_run_augment_job,
        args=(job_id, source_dir, dest, folder, source, display_name, snapshots, scope),
        daemon=True,
    ).start()
    return jsonify({"job_id": job_id}), 202
