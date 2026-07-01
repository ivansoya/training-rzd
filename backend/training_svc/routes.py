import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid

import yaml
from flask import Blueprint, Response, jsonify, request, send_file

from common.config import (
    AUG_META_FILE,
    DATASETS_META_FILE,
    IMAGE_EXTENSIONS,
    INFERENCE_DIR,
    MODELS_DIR,
    MODELS_FILE,
    TRAIN_META_FILE,
    TRAININGS_DIR,
    VIDEO_EXTENSIONS,
    VIDEOS_DIR,
    kind_dir,
)
from common.storage import load_json, safe_name, save_json


def _dataset_label(kind, ds_id):
    """Pretty dataset name for display, resolved from the shared meta files."""
    meta_file = AUG_META_FILE if kind == "augmented" else DATASETS_META_FILE
    return load_json(meta_file, {}).get(ds_id, {}).get("display_name") or ds_id


def _train_meta():
    """run_id -> {display_name} registry for trained models (renamable names)."""
    return load_json(TRAIN_META_FILE, {})


def _model_display(run_id, state=None, meta=None):
    """The user-facing name of a trained model, resolved dynamically by id.

    Falls back to the base model name, and finally to the run id itself so a
    deleted/unknown model still shows *something* (its id) wherever referenced.
    """
    if not run_id:
        return None
    if meta is None:
        meta = _train_meta()
    name = (meta.get(run_id) or {}).get("display_name")
    if name:
        return name
    if state is None:
        state = TRAININGS.get(run_id)
    if state:
        return state.get("model_name") or run_id
    return run_id
from training_svc import infer, trainer

bp = Blueprint("training", __name__)


@bp.get("/api/health")
def health():
    # The frontend reads `ultralytics` here to enable training/inference.
    return jsonify({"status": "ok", "ultralytics": trainer.is_available()})


# --------------------------------------------------------------------------- #
# Model registry
# --------------------------------------------------------------------------- #
def load_models():
    custom = load_json(MODELS_FILE, [])
    return list(trainer.BUILTIN_MODELS) + custom


@bp.get("/api/models")
def list_models():
    models = load_models()
    builtin_ids = {b["id"] for b in trainer.BUILTIN_MODELS}
    for m in models:
        m["builtin"] = m["id"] in builtin_ids
    return jsonify({"available": trainer.is_available(), "models": models})


@bp.post("/api/models")
def add_model():
    if "file" not in request.files:
        return jsonify({"error": "no file part"}), 400
    file = request.files["file"]
    if not file.filename or not file.filename.lower().endswith((".pt", ".yaml", ".yml")):
        return jsonify({"error": "ожидается файл .pt или .yaml"}), 400

    stem, ext = os.path.splitext(file.filename)
    fname = safe_name(stem) + ext.lower()
    path = os.path.join(MODELS_DIR, fname)
    file.save(path)

    custom = load_json(MODELS_FILE, [])
    model = {
        "id": uuid.uuid4().hex[:12],
        "name": request.form.get("name") or os.path.basename(file.filename),
        "spec": path,
        "created_at": time.time(),
    }
    custom.append(model)
    save_json(MODELS_FILE, custom)
    model["builtin"] = False
    return jsonify(model), 201


@bp.delete("/api/models/<model_id>")
def delete_model(model_id):
    if model_id in {b["id"] for b in trainer.BUILTIN_MODELS}:
        return jsonify({"error": "встроенную модель нельзя удалить"}), 400
    custom = load_json(MODELS_FILE, [])
    model = next((m for m in custom if m["id"] == model_id), None)
    if model is None:
        return jsonify({"error": "model not found"}), 404
    try:
        if model.get("spec") and os.path.isfile(model["spec"]):
            os.remove(model["spec"])
    except OSError:
        pass
    save_json(MODELS_FILE, [m for m in custom if m["id"] != model_id])
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Training. Each run executes in its own subprocess (runner.py) so it can be
# terminated immediately. Live state is mirrored to a container-local file.
# --------------------------------------------------------------------------- #
TRAININGS = {}          # id -> last-known state dict (cache)
TRAIN_PROCS = {}        # id -> subprocess.Popen
_STOP_REQUESTED = set()
# Training runs sequentially — never two at once. `_ACTIVE` is the id currently
# training; `_QUEUE` holds ids waiting (FIFO); `_PENDING_LAUNCH` carries the
# subprocess launch args for a run until it actually starts. All guarded by
# `_train_lock`.
_QUEUE = []
_ACTIVE = None
_PENDING_LAUNCH = {}
_train_lock = threading.Lock()
LIVE_DIR = os.path.join(tempfile.gettempdir(), "yolo-train")
os.makedirs(LIVE_DIR, exist_ok=True)
RUNNER = os.path.join(os.path.dirname(__file__), "runner.py")
RUNNING_STATES = {"preparing", "running"}
# States for which the SSE stream stays open (a queued run will start soon).
STREAM_OPEN_STATES = {"preparing", "running", "queued"}


def _run_file(run_id):
    return os.path.join(TRAININGS_DIR, run_id, "run.json")


def _live_file(run_id):
    return os.path.join(LIVE_DIR, run_id + ".json")


def _save_live(state):
    save_json(_live_file(state["id"]), state)


def _save_run(state):
    os.makedirs(os.path.join(TRAININGS_DIR, state["id"]), exist_ok=True)
    save_json(_run_file(state["id"]), state)
    save_json(_live_file(state["id"]), state)


def read_state(run_id):
    """Return the freshest state: live file, then persisted file, then cache."""
    for path in (_live_file(run_id), _run_file(run_id)):
        data = load_json(path, None)
        if isinstance(data, dict):
            TRAININGS[run_id] = data
            return data
    return TRAININGS.get(run_id)


def load_runs():
    if not os.path.isdir(TRAININGS_DIR):
        return
    for run_id in os.listdir(TRAININGS_DIR):
        data = load_json(_run_file(run_id), None)
        if isinstance(data, dict):
            if data.get("status") in ("running", "preparing", "queued"):
                data["status"] = "error"
                data["error"] = "прервано перезапуском сервера"
                save_json(_run_file(run_id), data)
            TRAININGS[run_id] = data


def _run_summary(state, meta=None):
    return {
        "id": state["id"],
        "status": state["status"],
        "model_name": state.get("model_name"),
        "display_name": _model_display(state["id"], state, meta),
        "dataset_name": state.get("dataset_name"),
        "dataset_label": state.get("dataset_label") or state.get("dataset_name"),
        "dataset_kind": state.get("dataset_kind"),
        "device": state.get("device", "cpu"),
        "epochs": state.get("epochs"),
        "current_epoch": state.get("current_epoch", 0),
        "has_weights": state.get("has_weights", False),
        "created_at": state.get("created_at"),
        "error": state.get("error"),
    }


def _image_dirs_by_split(dataset_dir):
    """Discover, by scanning the dataset on disk, the relative path of the image
    directory that actually holds each split's images.

    This is authoritative over whatever the copied data.yaml claims: an augmented
    dataset's yaml is inherited from the source and its train/val paths may not
    match where images physically ended up (e.g. Roboflow's ``../train/images``,
    or a split folder the augmentation laid out differently). Label dirs are
    skipped naturally because they contain ``.txt``, not images.
    """
    found = {}
    for root, _dirs, files in os.walk(dataset_dir):
        if not any(os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS for f in files):
            continue
        rel = os.path.relpath(root, dataset_dir).replace("\\", "/")
        seg = "/" + rel.lower() + "/"
        if "/val/" in seg or "/valid/" in seg:
            split = "val"
        elif "/test/" in seg:
            split = "test"
        elif "/train/" in seg:
            split = "train"
        else:
            continue
        # Prefer the shallowest matching dir (the split root, not a nested dir).
        if split not in found or rel.count("/") < found[split].count("/"):
            found[split] = rel
    return found


def _build_training_yaml(dataset_dir, run_dir):
    """Write a YOLO data.yaml with an absolute path for the given dataset.

    train/val are taken from the directories that actually contain images, so a
    dataset whose inherited data.yaml points at non-existent paths still trains.
    """
    yaml_path = None
    for root, _dirs, files in os.walk(dataset_dir):
        for f in files:
            if f.lower().endswith((".yaml", ".yml")):
                yaml_path = os.path.join(root, f)
                break
        if yaml_path:
            break
    cfg = {}
    if yaml_path:
        with open(yaml_path, "r", encoding="utf-8", errors="replace") as fh:
            cfg = yaml.safe_load(fh) or {}

    names = cfg.get("names")
    if isinstance(names, dict):
        names = {int(k): str(v) for k, v in names.items()}
    elif isinstance(names, list):
        names = {i: str(v) for i, v in enumerate(names)}
    else:
        names = {}

    abs_root = os.path.abspath(dataset_dir)
    detected = _image_dirs_by_split(dataset_dir)

    def _exists(rel):
        return isinstance(rel, str) and bool(rel) and os.path.isdir(
            os.path.join(abs_root, rel))

    def _pick(split, default):
        # 1) a real image directory found on disk wins; 2) the yaml's value if it
        # actually exists; 3) the conventional default if it exists.
        if split in detected:
            return detected[split]
        if _exists(cfg.get(split)):
            return cfg.get(split)
        if _exists(default):
            return default
        return None

    train = _pick("train", "images/train")
    val = _pick("val", "images/val")
    # YOLO requires a val set; reuse train when there's genuinely no val split.
    if val is None:
        val = train
    if train is None:
        train = val
    out = {"path": abs_root, "train": train, "val": val,
           "names": names}
    out_path = os.path.join(run_dir, "data.yaml")
    with open(out_path, "w", encoding="utf-8") as fh:
        yaml.safe_dump(out, fh, allow_unicode=True, sort_keys=False)
    return out_path


def _launch(run_id):
    """Start the subprocess for a run whose launch args are pending."""
    params = _PENDING_LAUNCH.pop(run_id, None)
    if params is None:
        return
    model_spec, data_yaml, run_dir = params
    proc = subprocess.Popen(
        [
            sys.executable, RUNNER,
            "--run-file", _run_file(run_id),
            "--live-file", _live_file(run_id),
            "--model-spec", model_spec,
            "--data-yaml", data_yaml,
            "--project", run_dir,
        ],
        start_new_session=True,
    )
    TRAIN_PROCS[run_id] = proc
    threading.Thread(target=_monitor, args=(run_id, proc), daemon=True).start()


def _advance_queue(finished_id):
    """Free the active slot held by ``finished_id`` and launch the next queued
    run, if any. Safe to call for a run that was never active."""
    global _ACTIVE
    nxt = None
    with _train_lock:
        if _ACTIVE == finished_id:
            _ACTIVE = None
        if _ACTIVE is None:
            while _QUEUE:
                cand = _QUEUE.pop(0)
                st = TRAININGS.get(cand)
                if st and st.get("status") == "queued":
                    _ACTIVE = cand
                    st["status"] = "preparing"
                    st["message"] = "Подготовка"
                    nxt = cand
                    break
                _PENDING_LAUNCH.pop(cand, None)
    if nxt:
        _save_run(TRAININGS[nxt])
        _launch(nxt)


def _monitor(run_id, proc):
    """Wait for a training subprocess, finalize its state, then start the next
    queued run."""
    try:
        pgid = os.getpgid(proc.pid)
    except Exception:  # noqa: BLE001
        pgid = None
    proc.wait()
    if pgid is not None:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except Exception:  # noqa: BLE001
            pass
    TRAIN_PROCS.pop(run_id, None)
    try:
        if run_id in TRAININGS:
            state = read_state(run_id)
            if state and state.get("status") in ("preparing", "running"):
                if run_id in _STOP_REQUESTED:
                    state["status"] = "stopped"
                    state["message"] = "Остановлено пользователем"
                else:
                    state["status"] = "error"
                    state["error"] = state.get("error") or "процесс обучения завершился неожиданно"
                    state["message"] = "Ошибка"
                state["finished_at"] = time.time()
                _save_run(state)
        _STOP_REQUESTED.discard(run_id)
    finally:
        _advance_queue(run_id)


@bp.get("/api/devices")
def list_devices():
    info = trainer.list_devices()
    info["available"] = trainer.is_available()
    return jsonify(info)


@bp.get("/api/trainings")
def list_trainings():
    runs = [read_state(rid) or TRAININGS[rid] for rid in list(TRAININGS)]
    runs.sort(key=lambda s: s.get("created_at", 0), reverse=True)
    meta = _train_meta()
    return jsonify([_run_summary(s, meta) for s in runs])


@bp.get("/api/trainings/<run_id>")
def get_training(run_id):
    state = read_state(run_id)
    if state is None:
        return jsonify({"error": "training not found"}), 404
    out = dict(state)
    out["display_name"] = _model_display(run_id, state)
    return jsonify(out)


@bp.patch("/api/trainings/<run_id>")
def rename_training(run_id):
    """Rename a trained model (display name only; id/weights unchanged). Stored
    in a side registry so it survives the runner rewriting run.json mid-run."""
    if read_state(run_id) is None:
        return jsonify({"error": "training not found"}), 404
    body = request.get_json(silent=True) or {}
    display_name = (body.get("display_name") or "").strip()
    meta = _train_meta()
    if display_name:
        entry = meta.get(run_id) or {}
        entry["display_name"] = display_name
        meta[run_id] = entry
    else:
        meta.pop(run_id, None)  # empty reverts to the default (base model name)
    save_json(TRAIN_META_FILE, meta)
    return jsonify({"ok": True, "display_name": _model_display(run_id, meta=meta)})


@bp.get("/api/trainings/<run_id>/stream")
def stream_training(run_id):
    """Server-Sent Events: push live run state (epochs + per-batch progress)."""
    if read_state(run_id) is None:
        return jsonify({"error": "training not found"}), 404

    def gen():
        last = None
        idle = 0
        yield "retry: 2000\n\n"
        while True:
            state = read_state(run_id)
            if state is None:
                break
            enriched = dict(state)
            enriched["display_name"] = _model_display(run_id, state)
            payload = json.dumps(enriched, ensure_ascii=False)
            if payload != last:
                last = payload
                idle = 0
                yield "event: state\ndata: " + payload + "\n\n"
            else:
                idle += 1
                if idle >= 20:
                    idle = 0
                    yield ": keepalive\n\n"
            if state.get("status") not in STREAM_OPEN_STATES:
                yield "event: end\ndata: {}\n\n"
                break
            time.sleep(0.5)

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


@bp.post("/api/trainings")
def start_training():
    if not trainer.is_available():
        return jsonify({"error": "ultralytics недоступна на сервере"}), 503
    body = request.get_json(silent=True) or {}

    kind = body.get("dataset_kind")
    name = safe_name(body.get("dataset_name"))
    root = kind_dir(kind)
    if root is None or not os.path.isdir(os.path.join(root, name)):
        return jsonify({"error": "датасет не найден"}), 404
    dataset_dir = os.path.join(root, name)

    model = next((m for m in load_models() if m["id"] == body.get("model_id")), None)
    if model is None:
        return jsonify({"error": "модель не найдена"}), 404

    device = str(body.get("device", "cpu"))
    if device != "cpu" and not trainer.list_devices().get("cuda_available"):
        return jsonify({"error": "GPU недоступна на сервере"}), 400

    params = body.get("params", {}) or {}
    try:
        epochs = int(params.get("epochs", 50))
    except (TypeError, ValueError):
        epochs = 50

    run_id = uuid.uuid4().hex[:12]
    run_dir = os.path.join(TRAININGS_DIR, run_id)
    os.makedirs(run_dir, exist_ok=True)
    data_yaml = _build_training_yaml(dataset_dir, run_dir)

    state = {
        "id": run_id,
        "status": "preparing",
        "message": "Подготовка",
        "queued_at": time.time(),
        "model_id": model["id"],
        "model_name": model["name"],
        "dataset_kind": kind,
        "dataset_name": name,
        "dataset_label": _dataset_label(kind, name),
        "device": device,
        "params": params,
        "epochs": epochs,
        "current_epoch": 0,
        "metrics": [],
        "has_weights": False,
        "created_at": time.time(),
        "finished_at": None,
        "error": None,
    }
    global _ACTIVE
    with _train_lock:
        # Only one training runs at a time; if the slot is taken (or others are
        # already waiting) this run goes to the back of the queue.
        busy = _ACTIVE is not None or len(_QUEUE) > 0
        if busy:
            state["status"] = "queued"
            state["message"] = "В очереди"
            _QUEUE.append(run_id)
        else:
            _ACTIVE = run_id
        TRAININGS[run_id] = state
        _PENDING_LAUNCH[run_id] = (model["spec"], data_yaml, run_dir)
    _save_run(state)

    if not busy:
        _launch(run_id)
    return jsonify({"id": run_id, "queued": busy}), 202


def _terminate(run_id, hard=False):
    """Kill the training subprocess and its whole process group (children)."""
    proc = TRAIN_PROCS.get(run_id)
    if not proc or proc.poll() is not None:
        return
    sig = signal.SIGKILL if hard else signal.SIGTERM
    try:
        os.killpg(os.getpgid(proc.pid), sig)
    except Exception:  # noqa: BLE001
        try:
            proc.kill() if hard else proc.terminate()
        except Exception:  # noqa: BLE001
            pass


@bp.post("/api/trainings/<run_id>/stop")
def stop_training(run_id):
    if run_id not in TRAININGS:
        return jsonify({"error": "training not found"}), 404
    state = TRAININGS.get(run_id)
    # A queued run has no process — just drop it from the queue.
    if state and state.get("status") == "queued":
        with _train_lock:
            if run_id in _QUEUE:
                _QUEUE.remove(run_id)
            _PENDING_LAUNCH.pop(run_id, None)
        state["status"] = "stopped"
        state["message"] = "Убрано из очереди"
        state["finished_at"] = time.time()
        _save_run(state)
        return jsonify({"ok": True})
    _STOP_REQUESTED.add(run_id)
    _terminate(run_id)
    state = read_state(run_id)
    if state:
        state["message"] = "Останавливается…"
        _save_live(state)
    return jsonify({"ok": True})


@bp.delete("/api/trainings/<run_id>")
def delete_training(run_id):
    if run_id not in TRAININGS and not os.path.isdir(os.path.join(TRAININGS_DIR, run_id)):
        return jsonify({"error": "training not found"}), 404
    with _train_lock:
        if run_id in _QUEUE:
            _QUEUE.remove(run_id)
        _PENDING_LAUNCH.pop(run_id, None)
        was_active = _ACTIVE == run_id
    _STOP_REQUESTED.add(run_id)
    _terminate(run_id, hard=True)
    TRAININGS.pop(run_id, None)
    TRAIN_PROCS.pop(run_id, None)
    shutil.rmtree(os.path.join(TRAININGS_DIR, run_id), ignore_errors=True)
    try:
        os.remove(_live_file(run_id))
    except OSError:
        pass
    meta = _train_meta()
    if run_id in meta:
        del meta[run_id]
        save_json(TRAIN_META_FILE, meta)
    # When we kill the active run its _monitor thread advances the queue; for a
    # run that had no process (queued, or already finished) do it here.
    if not was_active:
        _advance_queue(run_id)
    return jsonify({"ok": True})


@bp.delete("/api/trainings/<run_id>/weights")
def delete_weights(run_id):
    state = read_state(run_id)
    if state is None:
        return jsonify({"error": "training not found"}), 404
    weights_dir = os.path.join(TRAININGS_DIR, run_id, "train", "weights")
    shutil.rmtree(weights_dir, ignore_errors=True)
    state["has_weights"] = False
    state.pop("weights_path", None)
    _save_run(state)
    return jsonify({"ok": True})


@bp.get("/api/trainings/<run_id>/weights")
def download_weights(run_id):
    best = os.path.join(TRAININGS_DIR, run_id, "train", "weights", "best.pt")
    if not os.path.isfile(best):
        return jsonify({"error": "веса не найдены"}), 404
    return send_file(best, as_attachment=True, download_name=f"{run_id}_best.pt")


# --------------------------------------------------------------------------- #
# Inference (run a trained model over a library video).
# --------------------------------------------------------------------------- #
INFERENCES = {}
INFER_LIVE_DIR = os.path.join(tempfile.gettempdir(), "yolo-infer")
os.makedirs(INFER_LIVE_DIR, exist_ok=True)


def _infer_dir(infer_id):
    return os.path.join(INFERENCE_DIR, infer_id)


def _infer_run_file(infer_id):
    return os.path.join(_infer_dir(infer_id), "run.json")


def _infer_live_file(infer_id):
    return os.path.join(INFER_LIVE_DIR, infer_id + ".json")


def _save_infer(state):
    os.makedirs(_infer_dir(state["id"]), exist_ok=True)
    save_json(_infer_run_file(state["id"]), state)
    save_json(_infer_live_file(state["id"]), state)


def _read_infer(infer_id):
    for path in (_infer_live_file(infer_id), _infer_run_file(infer_id)):
        data = load_json(path, None)
        if isinstance(data, dict):
            INFERENCES[infer_id] = data
            return data
    return INFERENCES.get(infer_id)


def load_inferences():
    if not os.path.isdir(INFERENCE_DIR):
        return
    for infer_id in os.listdir(INFERENCE_DIR):
        data = load_json(_infer_run_file(infer_id), None)
        if isinstance(data, dict):
            if data.get("status") == "processing":
                data["status"] = "error"
                data["error"] = "прервано перезапуском сервера"
                save_json(_infer_run_file(infer_id), data)
            INFERENCES[infer_id] = data


def _infer_summary(state):
    return {
        "id": state["id"],
        "status": state["status"],
        "video_id": state.get("video_id"),
        "catalog": state.get("catalog"),
        "model_run_id": state.get("model_run_id"),
        "model_name": state.get("model_name"),
        # Resolved live from the training registry, so a rename shows everywhere
        # and a deleted model falls back to its id.
        "model_display": _model_display(state.get("model_run_id")),
        "input_name": state.get("input_name"),
        "created_at": state.get("created_at"),
        "has_output": state.get("has_output", False),
        "processed_frames": state.get("processed_frames", 0),
        "total_frames": state.get("total_frames", 0),
        "total_detections": (state.get("stats") or {}).get("total_detections"),
        "error": state.get("error"),
    }


def _trained_models():
    out = []
    meta = _train_meta()
    for rid in list(TRAININGS):
        state = read_state(rid) or TRAININGS[rid]
        best = os.path.join(TRAININGS_DIR, rid, "train", "weights", "best.pt")
        if state.get("has_weights") and os.path.isfile(best):
            out.append({
                "run_id": rid,
                "model_name": state.get("model_name"),
                "display_name": _model_display(rid, state, meta),
                "dataset_name": state.get("dataset_name"),
                "dataset_label": state.get("dataset_label") or state.get("dataset_name"),
                "created_at": state.get("created_at"),
                "weights": best,
            })
    out.sort(key=lambda m: m.get("created_at") or 0, reverse=True)
    return out


def _infer_thread(state, weights, input_path, output_path):
    state["status"] = "processing"
    state["message"] = "Обработка видео"
    _save_infer(state)
    last = {"t": 0.0}

    def on_progress(done, total):
        now = time.time()
        if now - last["t"] >= 0.4 or (total and done >= total):
            state["processed_frames"] = done
            state["total_frames"] = total
            _save_infer(state)
            last["t"] = now

    try:
        stats = infer.run(weights, input_path, output_path, on_progress)
        state["stats"] = stats
        state["total_frames"] = stats.get("total_frames")
        state["processed_frames"] = stats.get("processed_frames")
        state["has_output"] = os.path.isfile(output_path)
        state["status"] = "done"
        state["message"] = "Готово"
        state["finished_at"] = time.time()
        _save_infer(state)
    except Exception as exc:  # noqa: BLE001
        state["status"] = "error"
        state["error"] = str(exc)
        state["finished_at"] = time.time()
        _save_infer(state)


@bp.get("/api/inference/models")
def inference_models():
    return jsonify({"available": infer.is_available(), "models": _trained_models()})


@bp.get("/api/inference")
def list_inferences():
    with _VIDEOS_LOCK:
        ids = list(INFERENCES)
    runs = [r for r in (_read_infer(i) for i in ids) if r]
    video_id = request.args.get("video_id")
    if video_id:
        runs = [r for r in runs if r.get("video_id") == video_id]
    runs.sort(key=lambda s: s.get("created_at", 0), reverse=True)
    return jsonify([_infer_summary(s) for s in runs])


@bp.get("/api/inference/<infer_id>")
def get_inference(infer_id):
    state = _read_infer(infer_id)
    if state is None:
        return jsonify({"error": "inference not found"}), 404
    out = dict(state)
    out["model_display"] = _model_display(state.get("model_run_id"))
    return jsonify(out)


@bp.post("/api/inference")
def start_inference():
    if not infer.is_available():
        return jsonify({"error": "ultralytics недоступна на сервере"}), 503
    body = request.get_json(silent=True) or {}

    video = VIDEOS.get(body.get("video_id"))
    if video is None:
        return jsonify({"error": "видео не найдено"}), 404
    input_path = _video_file(video)
    if not os.path.isfile(input_path):
        return jsonify({"error": "файл видео не найден"}), 404

    run_id = body.get("model_run_id")
    model = next((m for m in _trained_models() if m["run_id"] == run_id), None)
    if model is None:
        return jsonify({"error": "обученная модель не найдена"}), 404

    infer_id = uuid.uuid4().hex[:12]
    d = _infer_dir(infer_id)
    os.makedirs(d, exist_ok=True)
    output_path = os.path.join(d, "output.mp4")

    state = {
        "id": infer_id,
        "status": "processing",
        "message": "Подготовка",
        "video_id": video["id"],
        "catalog": video.get("catalog"),
        "model_run_id": run_id,
        "model_name": model["model_name"],
        "dataset_name": model["dataset_name"],
        "input_name": video.get("name"),
        "total_frames": 0,
        "processed_frames": 0,
        "has_output": False,
        "stats": None,
        "created_at": time.time(),
        "finished_at": None,
        "error": None,
    }
    with _VIDEOS_LOCK:
        INFERENCES[infer_id] = state
    _save_infer(state)

    threading.Thread(
        target=_infer_thread, args=(state, model["weights"], input_path, output_path),
        daemon=True,
    ).start()
    return jsonify({"id": infer_id}), 202


@bp.delete("/api/inference/<infer_id>")
def delete_inference(infer_id):
    if infer_id not in INFERENCES and not os.path.isdir(_infer_dir(infer_id)):
        return jsonify({"error": "inference not found"}), 404
    with _VIDEOS_LOCK:
        INFERENCES.pop(infer_id, None)
    shutil.rmtree(_infer_dir(infer_id), ignore_errors=True)
    try:
        os.remove(_infer_live_file(infer_id))
    except OSError:
        pass
    return jsonify({"ok": True})


@bp.get("/api/inference/<infer_id>/video")
def inference_video(infer_id):
    path = os.path.join(_infer_dir(infer_id), "output.mp4")
    if not os.path.isfile(path):
        return jsonify({"error": "видео не найдено"}), 404
    return send_file(path, mimetype="video/mp4", conditional=True)


# --------------------------------------------------------------------------- #
# Video library (catalogs / projects).
# --------------------------------------------------------------------------- #
VIDEOS = {}
DEFAULT_CATALOG = "Общий"
# Guards the in-memory VIDEOS map. The gthread worker serves requests on a pool
# of threads, so concurrent uploads/deletes/lists must not mutate-while-iterate.
_VIDEOS_LOCK = threading.Lock()
# Serialises lazy thumbnail generation per video so two parallel tile requests
# don't spawn duplicate ffmpeg processes for the same file.
_THUMB_LOCKS = {}
_THUMB_LOCKS_GUARD = threading.Lock()


def _video_dir(video_id):
    return os.path.join(VIDEOS_DIR, video_id)


def _video_meta_file(video_id):
    return os.path.join(_video_dir(video_id), "meta.json")


def _video_file(meta):
    return os.path.join(_video_dir(meta["id"]), "video" + meta.get("ext", ""))


def _video_thumb_file(video_id):
    return os.path.join(_video_dir(video_id), "thumb.jpg")


def _thumb_lock_for(video_id):
    with _THUMB_LOCKS_GUARD:
        lock = _THUMB_LOCKS.get(video_id)
        if lock is None:
            lock = _THUMB_LOCKS[video_id] = threading.Lock()
        return lock


def _make_thumb(meta):
    """Render a small JPEG poster frame with ffmpeg (best-effort, idempotent).

    Storing one tiny image per video lets the library grid load instantly
    instead of opening every full video to grab its first frame.
    """
    dst = _video_thumb_file(meta["id"])
    if os.path.isfile(dst):
        return True
    src = _video_file(meta)
    if not os.path.isfile(src) or not shutil.which("ffmpeg"):
        return False
    with _thumb_lock_for(meta["id"]):
        if os.path.isfile(dst):
            return True
        # Seek to ~1s for a representative frame; fall back to frame 0 for very
        # short clips where the seek lands past the end.
        for ss in ("1", "0"):
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-ss", ss, "-i", src,
                 "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", dst],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=60, check=False,
            )
            if os.path.isfile(dst):
                return True
        return False


def _save_video(meta):
    os.makedirs(_video_dir(meta["id"]), exist_ok=True)
    save_json(_video_meta_file(meta["id"]), meta)


def load_videos():
    if not os.path.isdir(VIDEOS_DIR):
        return
    for vid in os.listdir(VIDEOS_DIR):
        data = load_json(_video_meta_file(vid), None)
        if isinstance(data, dict):
            with _VIDEOS_LOCK:
                VIDEOS[vid] = data


def _catalog_name(raw):
    raw = (raw or "").strip()
    return raw[:80] if raw else DEFAULT_CATALOG


@bp.get("/api/videos")
def list_videos():
    with _VIDEOS_LOCK:
        snapshot = list(VIDEOS.values())
    items = sorted(snapshot, key=lambda v: v.get("created_at", 0), reverse=True)
    return jsonify(items)


@bp.get("/api/videos/catalogs")
def list_catalogs():
    with _VIDEOS_LOCK:
        names = sorted({v.get("catalog", DEFAULT_CATALOG) for v in VIDEOS.values()})
    return jsonify(names)


@bp.post("/api/videos")
def upload_video():
    if "file" not in request.files:
        return jsonify({"error": "no file part"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "empty filename"}), 400
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in VIDEO_EXTENSIONS:
        return jsonify({"error": "ожидается видеофайл"}), 400

    video_id = uuid.uuid4().hex[:12]
    meta = {
        "id": video_id,
        "name": file.filename,
        "ext": ext,
        "catalog": _catalog_name(request.form.get("catalog")),
        "created_at": time.time(),
        "size": 0,
    }
    os.makedirs(_video_dir(video_id), exist_ok=True)
    path = _video_file(meta)
    file.save(path)
    try:
        meta["size"] = os.path.getsize(path)
    except OSError:
        pass
    meta["has_thumb"] = _make_thumb(meta)
    with _VIDEOS_LOCK:
        VIDEOS[video_id] = meta
    _save_video(meta)
    return jsonify(meta), 201


@bp.get("/api/videos/<video_id>/file")
def video_file(video_id):
    meta = VIDEOS.get(video_id)
    if meta is None:
        return jsonify({"error": "видео не найдено"}), 404
    path = _video_file(meta)
    if not os.path.isfile(path):
        return jsonify({"error": "файл не найден"}), 404
    return send_file(path, conditional=True)


@bp.get("/api/videos/<video_id>/thumb")
def video_thumb(video_id):
    meta = VIDEOS.get(video_id)
    if meta is None:
        return jsonify({"error": "видео не найдено"}), 404
    path = _video_thumb_file(video_id)
    if not os.path.isfile(path):
        # Lazily build a thumbnail for videos uploaded before thumbs existed.
        _make_thumb(meta)
    if not os.path.isfile(path):
        return jsonify({"error": "превью недоступно"}), 404
    resp = send_file(path, mimetype="image/jpeg", conditional=True)
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


@bp.delete("/api/videos/<video_id>")
def delete_video(video_id):
    if video_id not in VIDEOS and not os.path.isdir(_video_dir(video_id)):
        return jsonify({"error": "видео не найдено"}), 404
    with _VIDEOS_LOCK:
        infer_ids = [i for i, s in list(INFERENCES.items())
                     if s.get("video_id") == video_id]
        for iid in infer_ids:
            INFERENCES.pop(iid, None)
        VIDEOS.pop(video_id, None)
    for iid in infer_ids:
        shutil.rmtree(_infer_dir(iid), ignore_errors=True)
        try:
            os.remove(_infer_live_file(iid))
        except OSError:
            pass
    shutil.rmtree(_video_dir(video_id), ignore_errors=True)
    return jsonify({"ok": True})


# Populate in-memory caches at import.
load_runs()
load_inferences()
load_videos()
