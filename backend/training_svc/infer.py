"""Run a YOLO model over a video and write an annotated copy + statistics.

Heavy deps (torch/ultralytics/opencv) are imported lazily. The annotated output
is encoded as H.264 (via ffmpeg when available) so it plays in the browser.
"""
import shutil
import subprocess


def is_available():
    try:
        import cv2  # noqa: F401
        import torch  # noqa: F401
        import ultralytics  # noqa: F401
        return True
    except Exception:
        return False


def _open_encoder(output_path, width, height, fps):
    """Return (writer, kind). Prefer ffmpeg H.264; fall back to OpenCV mp4v."""
    if shutil.which("ffmpeg"):
        proc = subprocess.Popen(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-f", "rawvideo", "-pix_fmt", "bgr24",
                "-s", f"{width}x{height}", "-r", f"{fps:.4f}",
                "-i", "-", "-an",
                "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", output_path,
            ],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return proc, "ffmpeg"

    import cv2
    writer = cv2.VideoWriter(output_path, cv2.VideoWriter_fourcc(*"mp4v"),
                             fps, (width, height))
    return writer, "cv2"


def run(weights_path, input_path, output_path, on_progress=None):
    """Process `input_path` with `weights_path`, write `output_path`, return stats."""
    import cv2
    import torch
    from ultralytics import YOLO

    device = 0 if torch.cuda.is_available() else "cpu"
    model = YOLO(weights_path)
    names = model.names if isinstance(model.names, dict) else dict(enumerate(model.names))

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise ValueError("не удалось открыть видео")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

    encoder, kind = _open_encoder(output_path, width, height, fps)

    per_class = {}  # cls -> [count, conf_sum]
    total_det = 0
    frames_with = 0
    processed = 0

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            res = model.predict(frame, verbose=False, device=device)[0]
            boxes = res.boxes
            n = len(boxes) if boxes is not None else 0
            if n:
                frames_with += 1
            for b in boxes or []:
                cls = int(b.cls[0])
                conf = float(b.conf[0])
                total_det += 1
                slot = per_class.setdefault(cls, [0, 0.0])
                slot[0] += 1
                slot[1] += conf

            annotated = res.plot()  # BGR, same size as frame
            if kind == "ffmpeg":
                encoder.stdin.write(annotated.tobytes())
            else:
                encoder.write(annotated)

            processed += 1
            if on_progress and processed % 5 == 0:
                on_progress(processed, total)
    finally:
        cap.release()
        if kind == "ffmpeg":
            try:
                encoder.stdin.close()
            except Exception:
                pass
            encoder.wait()
        else:
            encoder.release()

    if on_progress:
        on_progress(processed, total or processed)

    per_class_list = [
        {
            "id": cls,
            "name": names.get(cls, str(cls)),
            "count": cnt,
            "avg_conf": (conf_sum / cnt) if cnt else 0.0,
        }
        for cls, (cnt, conf_sum) in sorted(per_class.items())
    ]

    return {
        "total_frames": total or processed,
        "processed_frames": processed,
        "fps": round(fps, 2),
        "width": width,
        "height": height,
        "duration": round((processed / fps), 2) if fps else 0,
        "total_detections": total_det,
        "frames_with_detections": frames_with,
        "avg_detections_per_frame": round(total_det / processed, 3) if processed else 0,
        "device": "gpu" if device != "cpu" else "cpu",
        "per_class": per_class_list,
    }
