"""Ultralytics YOLO training integration.

Heavy deps (torch, ultralytics) are imported lazily so the rest of the service
keeps working if they are missing. All YOLO data augmentations are forced off.
"""
import os

# Keep ultralytics' writable config/cache off the data volume.
os.environ.setdefault("YOLO_CONFIG_DIR", "/tmp/ultralytics")
os.environ.setdefault("MPLCONFIGDIR", "/tmp/mpl")

# Every augmentation knob set to its "disabled" value.
DISABLED_AUG = {
    "hsv_h": 0.0, "hsv_s": 0.0, "hsv_v": 0.0,
    "degrees": 0.0, "translate": 0.0, "scale": 0.0, "shear": 0.0,
    "perspective": 0.0, "flipud": 0.0, "fliplr": 0.0, "bgr": 0.0,
    "mosaic": 0.0, "mixup": 0.0, "copy_paste": 0.0, "erasing": 0.0,
    "auto_augment": None, "close_mosaic": 0,
}

# Hyperparameters the UI is allowed to set (everything else is fixed).
ALLOWED_PARAMS = {
    "epochs", "imgsz", "batch", "workers", "lr0", "lrf", "momentum",
    "weight_decay", "warmup_epochs", "optimizer", "patience", "cos_lr",
    "dropout", "label_smoothing", "single_cls", "seed",
}

BUILTIN_MODELS = [
    {"id": "yolov8n", "name": "YOLOv8n (scratch)", "spec": "yolov8n.yaml"},
    {"id": "yolov8s", "name": "YOLOv8s (scratch)", "spec": "yolov8s.yaml"},
    {"id": "yolov8m", "name": "YOLOv8m (scratch)", "spec": "yolov8m.yaml"},
    {"id": "yolo11n", "name": "YOLO11n (scratch)", "spec": "yolo11n.yaml"},
    {"id": "yolo11s", "name": "YOLO11s (scratch)", "spec": "yolo11s.yaml"},
]


def is_available():
    try:
        import torch  # noqa: F401
        import ultralytics  # noqa: F401
        return True
    except Exception:
        return False


def list_devices():
    """Report CPU + any available CUDA GPUs."""
    info = {"cuda_available": False, "gpus": []}
    try:
        import torch
        if torch.cuda.is_available():
            info["cuda_available"] = True
            for i in range(torch.cuda.device_count()):
                info["gpus"].append({"index": i, "name": torch.cuda.get_device_name(i)})
    except Exception:
        pass
    return info


def filter_params(params):
    out = {}
    for k, v in (params or {}).items():
        if k in ALLOWED_PARAMS and v is not None and v != "":
            out[k] = v
    return out


def _disable_builtin_albumentations():
    """Neutralize ultralytics' optional Albumentations block (Blur/CLAHE/…)."""
    try:
        from ultralytics.data import augment as _aug
        _aug.Albumentations.__call__ = lambda self, labels: labels
    except Exception:
        pass
