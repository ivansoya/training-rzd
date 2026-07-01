"""Shared storage layout. Every service mounts the same ``yolo-data`` volume at
/app/data, so all paths are defined here once.
"""
import os

DATA_DIR = os.environ.get("DATA_DIR", "/app/data")

# Path used to report *real host* disk usage in the sidebar meter. Inside the
# container, ``shutil.disk_usage(DATA_DIR)`` measures the Docker/WSL2 virtual
# disk (a sparse vhdx that advertises ~1 TB), not the physical drive. The
# compose file bind-mounts a host directory here so we can stat the actual
# drive Docker stores its data on. Falls back to DATA_DIR when unset.
HOST_STAT_PATH = os.environ.get("HOST_STAT_PATH")

UPLOADED_DIR = os.path.join(DATA_DIR, "uploaded")
AUGMENTED_DIR = os.path.join(DATA_DIR, "augmented")
CONFIGS_FILE = os.path.join(DATA_DIR, "configs.json")
AUG_META_FILE = os.path.join(DATA_DIR, "augmented.json")
# Maps an uploaded dataset's ASCII folder id -> {display_name, created_at}.
DATASETS_META_FILE = os.path.join(DATA_DIR, "datasets.json")
TRAININGS_DIR = os.path.join(DATA_DIR, "trainings")
# Maps a training run id -> {display_name}: the user-facing name of a trained
# model. Kept out of the run state so renames never race the training runner,
# which rewrites run.json from its own in-memory copy while a run is active.
TRAIN_META_FILE = os.path.join(DATA_DIR, "trainings.json")
MODELS_DIR = os.path.join(DATA_DIR, "models")
MODELS_FILE = os.path.join(DATA_DIR, "models.json")
INFERENCE_DIR = os.path.join(DATA_DIR, "inference")
VIDEOS_DIR = os.path.join(DATA_DIR, "videos")

# Transient job state lives on the shared volume too: it is a fast named volume
# (ext4), so atomic renames are reliably visible across service containers — the
# datasets service can serve a job created by the augmentation service.
JOBS_DIR = os.path.join(DATA_DIR, "_jobs")
TMP_DIR = os.path.join(DATA_DIR, "_tmp")

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
BASE_CONFIG_ID = "base"

_ALL_DIRS = (
    UPLOADED_DIR, AUGMENTED_DIR, TRAININGS_DIR, MODELS_DIR, INFERENCE_DIR,
    VIDEOS_DIR, JOBS_DIR, TMP_DIR,
)


def ensure_dirs():
    for d in _ALL_DIRS:
        os.makedirs(d, exist_ok=True)


def kind_dir(kind):
    if kind == "uploaded":
        return UPLOADED_DIR
    if kind == "augmented":
        return AUGMENTED_DIR
    return None
