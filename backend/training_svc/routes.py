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
    INFERENCE_DIR,
    MODELS_DIR,
    MODELS_FILE,
    TRAININGS_DIR,
    VIDEO_EXTENSIONS,
    VIDEOS_DIR,
    kind_dir,
)
from common.storage import load_json, safe_name, save_json
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

    fname = safe_name(file.filename) + os.path.splitext(file.filename)[1].lower()
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
_train_lock = threading.Lock()
LIVE_DIR = os.path.join(tempfile.gettempdir(), "yolo-train")
os.makedirs(LIVE_DIR, exist_ok=True)
RUNNER = os.path.join(os.path.dirname(__file__), "runner.py")
RUNNING_STATES = {"preparing", "running"}


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
            if data.get("status") in ("running", "preparing"):
                data["status"] = "error"
                data["error"] = "прервано перезапуском сервера"
                save_json(_run_file(run_id), data)
            TRAININGS[run_id] = data


def _run_summary(state):
    return {
        "id": state["id"],
        "status": state["status"],
        "model_name": state.get("model_name"),
        "dataset_name": state.get("dataset_name"),
        "dataset_kind": state.get("dataset_kind"),
        "device": state.get("device", "cpu"),
        "epochs": state.get("epochs"),
        "current_epoch": state.get("current_epoch", 0),
        "has_weights": state.get("has_weights", False),
        "created_at": state.get("created_at"),
        "error": state.get("error"),
    }


def _build_training_yaml(dataset_dir, run_dir):
    """Write a YOLO data.yaml with an absolute path for the given dataset."""
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

    train = cfg.get("train") or "images/train"
    val = cfg.get("val") or train
    out = {"path": os.path.abspath(dataset_dir), "train": train, "val": val,
           "names": names}
    out_path = os.path.join(run_dir, "data.yaml")
    with open(out_path, "w", encoding="utf-8") as fh:
        yaml.safe_dump(out, fh, allow_unicode=True, sort_keys=False)
    return out_path


def _monitor(run_id, proc):
    """Wait for a training subprocess and finalize its state."""
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
    if run_id not in TRAININGS:
        return
    state = read_state(run_id)
    if state is None:
        return
    if state.get("status") in ("preparing", "running"):
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


@bp.get("/api/devices")
def list_devices():
    info = trainer.list_devices()
    info["available"] = trainer.is_available()
    return jsonify(info)


@bp.get("/api/trainings")
def list_trainings():
    runs = [read_state(rid) or TRAININGS[rid] for rid in list(TRAININGS)]
    runs.sort(key=lambda s: s.get("created_at", 0), reverse=True)
    return jsonify([_run_summary(s) for s in runs])


@bp.get("/api/trainings/<run_id>")
def get_training(run_id):
    state = read_state(run_id)
    if state is None:
        return jsonify({"error": "training not found"}), 404
    return jsonify(state)


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
            payload = json.dumps(state, ensure_ascii=False)
            if payload != last:
                last = payload
                idle = 0
                yield "event: state\ndata: " + payload + "\n\n"
            else:
                idle += 1
                if idle >= 20:
                    idle = 0
                    yield ": keepalive\n\n"
            if state.get("status") not in RUNNING_STATES:
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
        "model_id": model["id"],
        "model_name": model["name"],
        "dataset_kind": kind,
        "dataset_name": name,
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
    with _train_lock:
        TRAININGS[run_id] = state
    _save_run(state)

    proc = subprocess.Popen(
        [
            sys.executable, RUNNER,
            "--run-file", _run_file(run_id),
            "--live-file", _live_file(run_id),
            "--model-spec", model["spec"],
            "--data-yaml", data_yaml,
            "--project", run_dir,
        ],
        start_new_session=True,
    )
    TRAIN_PROCS[run_id] = proc
    threading.Thread(target=_monitor, args=(run_id, proc), daemon=True).start()
    return jsonify({"id": run_id}), 202


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
    _STOP_REQUESTED.add(run_id)
    _terminate(run_id, hard=True)
    TRAININGS.pop(run_id, None)
    TRAIN_PROCS.pop(run_id, None)
    shutil.rmtree(os.path.join(TRAININGS_DIR, run_id), ignore_errors=True)
    try:
        os.remove(_live_file(run_id))
    except OSError:
        pass
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
        "input_name": state.get("input_name"),
        "created_at": state.get("created_at"),
        "has_output": state.get("has_output", False),
        "total_detections": (state.get("stats") or {}).get("total_detections"),
        "error": state.get("error"),
    }


def _trained_models():
    out = []
    for rid in list(TRAININGS):
        state = read_state(rid) or TRAININGS[rid]
        best = os.path.join(TRAININGS_DIR, rid, "train", "weights", "best.pt")
        if state.get("has_weights") and os.path.isfile(best):
            out.append({
                "run_id": rid,
                "model_name": state.get("model_name"),
                "dataset_name": state.get("dataset_name"),
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
    runs = [_read_infer(i) or INFERENCES[i] for i in list(INFERENCES)]
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
    return jsonify(state)


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


def _video_dir(video_id):
    return os.path.join(VIDEOS_DIR, video_id)


def _video_meta_file(video_id):
    return os.path.join(_video_dir(video_id), "meta.json")


def _video_file(meta):
    return os.path.join(_video_dir(meta["id"]), "video" + meta.get("ext", ""))


def _save_video(meta):
    os.makedirs(_video_dir(meta["id"]), exist_ok=True)
    save_json(_video_meta_file(meta["id"]), meta)


def load_videos():
    if not os.path.isdir(VIDEOS_DIR):
        return
    for vid in os.listdir(VIDEOS_DIR):
        data = load_json(_video_meta_file(vid), None)
        if isinstance(data, dict):
            VIDEOS[vid] = data


def _catalog_name(raw):
    raw = (raw or "").strip()
    return raw[:80] if raw else DEFAULT_CATALOG


@bp.get("/api/videos")
def list_videos():
    items = sorted(VIDEOS.values(),
                   key=lambda v: v.get("created_at", 0), reverse=True)
    return jsonify(items)


@bp.get("/api/videos/catalogs")
def list_catalogs():
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


@bp.delete("/api/videos/<video_id>")
def delete_video(video_id):
    if video_id not in VIDEOS and not os.path.isdir(_video_dir(video_id)):
        return jsonify({"error": "видео не найдено"}), 404
    for iid in [i for i, s in list(INFERENCES.items())
                if s.get("video_id") == video_id]:
        INFERENCES.pop(iid, None)
        shutil.rmtree(_infer_dir(iid), ignore_errors=True)
        try:
            os.remove(_infer_live_file(iid))
        except OSError:
            pass
    VIDEOS.pop(video_id, None)
    shutil.rmtree(_video_dir(video_id), ignore_errors=True)
    return jsonify({"ok": True})


# Populate in-memory caches at import.
load_runs()
load_inferences()
load_videos()
