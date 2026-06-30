"""Shared storage layout. Every service mounts the same ``yolo-data`` volume at
/app/data, so all paths are defined here once.
"""
import os

DATA_DIR = os.environ.get("DATA_DIR", "/app/data")

UPLOADED_DIR = os.path.join(DATA_DIR, "uploaded")
AUGMENTED_DIR = os.path.join(DATA_DIR, "augmented")
CONFIGS_FILE = os.path.join(DATA_DIR, "configs.json")
AUG_META_FILE = os.path.join(DATA_DIR, "augmented.json")
TRAININGS_DIR = os.path.join(DATA_DIR, "trainings")
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
