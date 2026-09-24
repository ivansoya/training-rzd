"""Прогон агента по блокам таски — внутри процесса воркера.

Не отдельным процессом, как обучение: прогон короткий, падать ему нечему
кроме сети, а отдельный процесс стоил бы секунд на импорт torch на каждый
запуск. Тот же приём, что у счёта признаков (`worker.do_embed`).

Что пишется в базу — по решению владельца:

* только кадры `new`: размеченные, фоновые, отложенные и забракованные —
  это уже решение человека, агент их не трогает;
* на кадре заменяются только рамки агентов (`source='model'` с версией
  агента); рамки человека, в том числе поправленные после агента, остаются;
* кадр остаётся `new` — принятым его делает человек;
* автор рамки — владелец агента, `agent_version_id` — версия прогона.

Каждый кадр — своя транзакция, и статус кадра перечитывается под замком:
человек мог открыть и сохранить кадр, пока агент шёл к нему.
"""
import logging
import os
import threading
import time
from contextlib import contextmanager

from sqlalchemy import select

from common import agent_graph, config, gpu, live, shapes, task_frames, video_frames, video_tracks
from common.db import SessionLocal
from common.models import (
    AgentRun, AgentWeights, Annotation, AugGraph, AugGraphVersion, Image, TaskVideo,
    VideoAnnotation, VideoScout, utcnow,
)

log = logging.getLogger("training")

# Прикидка памяти на одну сеть, пока нет замера. Средний yolo11 на входе 1280
# с запасом; по факту диспетчер запомнит свой.
NET_VRAM_MB = 1500
# SAM2 small на кадре 1920×1400 — около гигабайта; large вдвое больше.
SAM_VRAM_MB = 1500
NOTIFY_EVERY = 1.0

# Файл и конфиг — как у полуавтомата (autolabel_svc/runners/sam2_runner.py);
# веса лежат там же на томе, так что скачанное одним годится другому.
# Качаем с HuggingFace, а не с CDN Meta: тот на этой сети отдаёт 15 КБ и
# молчит (см. training_svc/embed.py).
SAM_FILES = {
    "sam2.1_hiera_tiny": ("sam2.1_hiera_tiny.pt", "configs/sam2.1/sam2.1_hiera_t.yaml", "tiny"),
    "sam2.1_hiera_small": ("sam2.1_hiera_small.pt", "configs/sam2.1/sam2.1_hiera_s.yaml", "small"),
    "sam2.1_hiera_base_plus": ("sam2.1_hiera_base_plus.pt", "configs/sam2.1/sam2.1_hiera_b+.yaml", "base-plus"),
    "sam2.1_hiera_large": ("sam2.1_hiera_large.pt", "configs/sam2.1/sam2.1_hiera_l.yaml", "large"),
}


class Stopped(Exception):
    """Прогон сняли кнопкой."""


def claim(db, worker_id):
    run = db.execute(
        select(AgentRun)
        .where(AgentRun.status.in_(("queued", "waiting_gpu")))
        .order_by(AgentRun.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    ).scalar_one_or_none()
    if run is not None:
        run.worker_id = worker_id
        db.commit()
    return run


def frames(db, run):
    """Кадры прогона: новые, из выбранных блоков, по имени файла."""
    ids = []
    for source in run.params.get("sources") or []:
        clause = task_frames.source_clause(run.task_id, source)
        q = select(Image.id).where(Image.task_id == run.task_id,
                                   Image.task_status == "new")
        if clause is not None:
            q = q.where(clause)
        ids.extend(db.execute(q.order_by(Image.file_name)).scalars())
    seen = set()
    return [i for i in ids if not (i in seen or seen.add(i))]


def _finish(db, run, status, error=None):
    run.status = status
    run.error = error
    run.finished_at = utcnow()
    db.commit()
    live.notify(db, "agent", run.id, run.project_id, s=status)


def execute(db, run):
    """Прогнать. Возвращает False, если карта занята и прогон вернулся в очередь."""
    if run.cancel_requested:
        if run.gpu_lease_id:
            gpu.cancel(db, run.gpu_lease_id, "Снято автором")
        _finish(db, run, "stopped")
        return True
    version = db.get(AugGraphVersion, run.version_id) if run.version_id else None
    if version is None:
        _finish(db, run, "error", "Версии агента больше нет.")
        return True
    doc = version.doc
    try:
        order = agent_graph.check(doc)
    except agent_graph.AgentGraphError as exc:
        _finish(db, run, "error", str(exc))
        return True

    nets = [n for n in doc["nodes"] if n["type"] == "net"]
    weights = {}
    for node in nets:
        row = db.get(AgentWeights, _uuid(node["params"].get("weights")))
        if row is None:
            _finish(db, run, "error", f"{agent_graph.title(node)}: весов нет на полке.")
            return True
        weights[node["id"]] = row

    sams = sorted({(n.get("params") or {}).get("model") or agent_graph.SAM_DEFAULTS["model"]
                   for n in doc["nodes"] if n["type"] == "sam"})
    # Плитки и TTA гонят вырезки пачкой — памяти нужно больше, и замер
    # диспетчера не должен смешиваться с замером одиночного прохода.
    batch = max(len(agent_graph.variants(n["params"])) * (8 if n["params"].get("tiles") else 1)
                for n in nets)
    sig = f"agent:{len(nets)}:b{batch}:{','.join(sams)}"
    want, _ = gpu.estimate(db, "agent", sig, NET_VRAM_MB * len(nets) + SAM_VRAM_MB * len(sams))
    # Прошлая бронь больше не нужна — та же причина, что у обучения: без
    # отмены каждая попытка оставляла в очереди ещё одну запись. А пока ждём,
    # бронь стоит в очереди: по её возрасту диспетчер придерживает место.
    if run.gpu_lease_id:
        gpu.cancel(db, run.gpu_lease_id, "Новая попытка")
    lease = gpu.request(
        db, holder="training", kind="agent", want_mb=want, ref_id=run.id,
        project_id=run.project_id, user_id=run.created_by, priority=35,
        allow_cpu=True, title="Агент разметки",
    )
    if lease.status != "held":
        run.status = "waiting_gpu"
        run.queue_reason = lease.reason
        run.gpu_lease_id = lease.id
        db.commit()
        live.notify(db, "agent", run.id, run.project_id, s="waiting_gpu")
        return False

    run.status = "running"
    run.gpu_lease_id = lease.id
    run.queue_reason = None
    run.started_at = run.started_at or utcnow()
    db.commit()
    live.notify(db, "agent", run.id, run.project_id, s="running")
    device = "cpu" if lease.device_id is None else 0
    peak = 0
    try:
        mode = run.params.get("mode") or "frames"
        ids = frames(db, run) if mode == "frames" else None
        plan = _video_plan(db, run, mode) if ids is None else None
        run.total = len(ids) if ids is not None else sum(len(f) for _, f in plan)
        db.commit()
        with _beating(lease.id):
            models = _load(weights)
            # Разведке нужны где и что, а не контур: SAM не грузим вовсе.
            if mode != "scout":
                models.update({name: _load_sam(name, device) for name in sams})
        tick = _ticker(db, run, lease.id)
        mapping = run.params.get("mapping") or {}
        if ids is not None:
            boxes = marked = 0
            for image_id in ids:
                put = _one(db, run, image_id, doc, order, models, weights, mapping, device)
                boxes += put
                marked += bool(put)
                tick({"boxes": boxes, "frames": marked})
        else:
            _videos(db, run, mode, plan, doc, order, models, weights, mapping, device, tick)
        peak = _peak_mb(device)
        _finish(db, run, "done")
    except Stopped:
        _finish(db, run, "stopped")
    except Exception as exc:  # noqa: BLE001 — человеку нужен текст, а не трасса
        log.exception("прогон агента %s не удался", run.id)
        db.rollback()
        _finish(db, run, "error", str(exc)[:500])
    finally:
        if peak:
            gpu.remember(db, "agent", sig, peak)
        gpu.release(db, lease.id)
        _free()
    return True


def _one(db, run, image_id, doc, order, models, weights, mapping, device):
    """Один кадр. Возвращает число поставленных рамок."""
    image = db.execute(
        select(Image).where(Image.id == image_id).with_for_update()
    ).scalar_one_or_none()
    if image is None or image.task_status != "new":
        db.rollback()
        return 0
    predict, segment = frame_fns(os.path.join(config.DATA_DIR, image.file_path),
                                 image.file_name, models, weights, device)
    found = agent_graph.run(doc, predict, order, segment)
    return _write(db, run, image, found, mapping)


def frame_fns(path, file_name, models, weights, device, picture=None):
    """(predict, segment) для одного кадра — их зовёт `agent_graph.run`.

    Общие у прогона и превью: превью обязано показывать ровно то, что ляжет
    в разметку. `models` — {узел сети: YOLO, имя SAM: предиктор}, `weights` —
    {узел сети: строка полки}. `picture` — кадр ролика, уже распакованный
    декодером (PIL, RGB); тогда `path` не читается."""
    frame = []

    def predict(node):
        import cv2
        import numpy as np

        if not frame:
            got = (np.ascontiguousarray(np.asarray(picture.convert("RGB"))[:, :, ::-1])
                   if picture is not None else cv2.imread(path))
            if got is None:
                raise RuntimeError(f"Кадр не читается: {file_name}")
            frame.append(got)
        pixels = frame[0]
        params = node.get("params") or {}
        side = int(params.get("imgsz") or weights[node["id"]].imgsz or 640)

        def infer(jobs, scale):
            crops = []
            for (x0, y0, x1, y1), flip in jobs:
                crop = pixels[y0:y1, x0:x1]
                # Отрицательный шаг отражения cv2 внутри ultralytics не примет.
                crops.append(np.ascontiguousarray(crop[:, ::-1] if flip else crop))
            # IoU не передаём: встроенный NMS у yolo11 и v8 работает со своим
            # мягким 0,7, у yolo26 его нет вовсе. Строже — узел «NMS» в графе.
            results = models[node["id"]].predict(
                crops, verbose=False, device=device,
                conf=float(params.get("conf") or 0.25),
                # ultralytics требует кратность шагу сети — 32.
                imgsz=max(32, round(side * scale / 32) * 32),
            )
            return [
                [(c, p, x1, y1, x2 - x1, y2 - y1) for c, p, (x1, y1, x2, y2) in zip(
                    r.boxes.cls.tolist(), r.boxes.conf.tolist(), r.boxes.xyxy.tolist())]
                for r in results
            ]

        h, w = pixels.shape[:2]
        return agent_graph.detect(params, w, h, side, infer)

    encoded = set()

    def segment(node, box):
        import numpy as np

        name = (node.get("params") or {}).get("model") or agent_graph.SAM_DEFAULTS["model"]
        predictor = models[name]
        # Кодировщик кадра — дорогая часть; считаем его один раз на кадр и
        # модель, а рамки декодируются за миллисекунды.
        if name not in encoded:
            if picture is not None:
                predictor.set_image(np.array(picture.convert("RGB")))
            else:
                from PIL import Image as PilImage
                with PilImage.open(path) as img:
                    predictor.set_image(np.array(img.convert("RGB")))
            encoded.add(name)
        x, y, w, h = box
        masks, scores, _ = predictor.predict(
            box=np.array([x, y, x + w, y + h], dtype=np.float32), multimask_output=True)
        return masks, scores

    return predict, segment


def _write(db, run, image, found, mapping):
    db.execute(
        Annotation.__table__.delete().where(
            Annotation.image_id == image.id,
            Annotation.source == "model",
            Annotation.agent_version_id.isnot(None),
        )
    )
    put = 0
    for det in found:
        class_id = mapping.get(det["cls"])
        if not class_id:
            continue  # класс агента сопоставлен с «не размечать»
        x, y, w, h = det["box"]
        wire = ({"kind": "polygon", "parts": det["parts"]} if det.get("parts")
                else {"kind": "bbox", "x": x, "y": y, "w": w, "h": h})
        parsed = shapes.from_wire(wire, image.width or 0, image.height or 0)
        if parsed is None:
            continue
        ann_type, geometry, area = parsed
        attributes = {"conf": round(float(det["conf"]), 3)}
        if "sam" in det:
            attributes["sam"] = det["sam"]
        db.add(Annotation(
            image_id=image.id, class_id=_uuid(class_id), ann_type=ann_type,
            geometry=geometry, area=area, source="model",
            attributes=attributes,
            agent_version_id=run.version_id, created_by=run.created_by,
        ))
        put += 1
    db.commit()
    return put


def _ticker(db, run, lease_id):
    """Шаг хода: +1 кадр, статистика, отмена кнопкой, пульс брони и живой связи."""
    last = [0.0]

    def tick(stats):
        db.refresh(run)
        if run.cancel_requested:
            raise Stopped()
        run.processed += 1
        run.stats = stats
        run.lease_until = utcnow()
        db.commit()
        now = time.monotonic()
        if now - last[0] >= NOTIFY_EVERY:
            gpu.beat(db, lease_id)
            live.notify(db, "agent", run.id, run.project_id, n=run.processed)
            last[0] = now

    return tick


# --------------------------------------------------------------------------- #
# Ролики: разметка каждого N-го кадра и разведка
#
# Решения владельца (24.09.2026). Разметка — одиночные рамки в
# `video_annotations` на каждый N-й кадр, кроме кадров, где уже поработал
# человек; повторный прогон заменяет только нетронутые рамки агентов. Разведка
# — информация, а не разметка: где и что нашлось, участки по классам агента,
# SAM не участвует. Кадры достаёт тот же декодер, что и закрытие разметки
# (`common.video_frames`): номер кадра обязан совпасть до единицы.
# --------------------------------------------------------------------------- #
def _last_frame(video):
    if video.frame_count:
        return max(0, int(video.frame_count) - 1)
    if video.duration_ms and video.fps:
        return max(0, video_tracks.ms_to_frame(video.duration_ms, video.fps) - 1)
    raise RuntimeError(f"У ролика «{video.file_name}» неизвестна длина — кадры не пересчитать.")


def _video_plan(db, run, mode):
    """[(ролик, [кадры])] в порядке, заданном при запуске."""
    step = int(run.params.get("step") or agent_graph.VIDEO_STEP)
    out = []
    for vid in run.params.get("videos") or []:
        video = db.get(TaskVideo, _uuid(vid))
        if video is None or video.task_id != run.task_id:
            continue
        last = _last_frame(video)
        every = agent_graph.sampled(last, step)
        if mode == "annotate":
            tracks, singles = task_frames.video_payload(db, video)
            busy = video_tracks.human_frames(tracks, singles, video.empty_frames, every)
            every = [f for f in every if f not in busy]
        out.append((video, every))
    return out


def _videos(db, run, mode, plan, doc, order, models, weights, mapping, device, tick):
    step = int(run.params.get("step") or agent_graph.VIDEO_STEP)
    gap_s = float(run.params.get("gap") if run.params.get("gap") is not None else agent_graph.SCOUT_GAP_S)
    version = db.get(AugGraphVersion, run.version_id)
    graph = db.get(AugGraph, version.graph_id) if version else None
    stats = {"videos": 0, "boxes": 0, "frames": 0}
    for video, wanted in plan:
        if mode == "annotate":
            db.execute(VideoAnnotation.__table__.delete().where(
                VideoAnnotation.video_id == video.id, VideoAnnotation.track_id.is_(None),
                VideoAnnotation.source == "model", VideoAnnotation.agent_version_id.isnot(None)))
            db.commit()
        hits, seen = {}, {}

        def on_frame(frame_no, _time_ms, picture):
            predict, segment = frame_fns(None, f"{video.file_name} #{frame_no}", models, weights,
                                         device, picture=picture)
            found = agent_graph.run(doc, predict, order, segment if mode == "annotate" else None)
            if mode == "annotate":
                put = _write_video(db, run, video, frame_no, found, mapping)
                stats["boxes"] += put
                stats["frames"] += bool(put)
            else:
                seen[str(frame_no)] = [[d["cls"], round(d["conf"], 3), *[round(v, 1) for v in d["box"]]]
                                       for d in found]
                if found:
                    hits[frame_no] = {d["cls"] for d in found}
                    stats["frames"] += 1
            tick(dict(stats))

        if wanted:
            video_frames.extract_frames(os.path.join(config.DATA_DIR, video.file_path), wanted, on_frame)
        if mode == "scout":
            last = _last_frame(video)
            db.execute(VideoScout.__table__.delete().where(VideoScout.video_id == video.id))
            db.add(VideoScout(
                video_id=video.id, run_id=run.id, version_id=run.version_id,
                agent_name=graph.name if graph else None, step=step, gap_s=gap_s, last_frame=last,
                frames=seen,
                segments=agent_graph.segments(hits, step, round(gap_s * (video.fps or 25)), last),
            ))
        stats["videos"] += 1
        run.stats = dict(stats)
        db.commit()


def _write_video(db, run, video, frame_no, found, mapping):
    put = 0
    for det in found:
        class_id = mapping.get(det["cls"])
        if not class_id:
            continue
        x, y, w, h = det["box"]
        wire = ({"kind": "polygon", "parts": det["parts"]} if det.get("parts")
                else {"kind": "bbox", "x": x, "y": y, "w": w, "h": h})
        parsed = shapes.from_wire(wire, video.width or 0, video.height or 0)
        if parsed is None:
            continue
        ann_type, geometry, _area = parsed
        db.add(VideoAnnotation(
            video_id=video.id, track_id=None, frame_no=frame_no, class_id=_uuid(class_id),
            ann_type=ann_type, geometry=geometry, source="model",
            agent_version_id=run.version_id, created_by=run.created_by,
        ))
        put += 1
    db.commit()
    return put


def _load(weights):
    from ultralytics import YOLO

    return {nid: YOLO(os.path.join(config.DATA_DIR, row.file_path))
            for nid, row in weights.items()}


@contextmanager
def _beating(lease_id):
    """Бронь живёт 120 с без пульса, а первая закачка SAM2 large — 900 МБ.
    Пока грузятся модели, аренду продлевает своя нить со своей сессией."""
    stop = threading.Event()

    def pulse():
        while not stop.wait(20):
            db = SessionLocal()
            try:
                gpu.beat(db, lease_id)
            except Exception:
                log.exception("пульс загрузки моделей агента")
            finally:
                db.close()

    threading.Thread(target=pulse, name="agent-pulse", daemon=True).start()
    try:
        yield
    finally:
        stop.set()


def _load_sam(name, device):
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    _, cfg, _ = SAM_FILES[name]
    model = build_sam2(cfg, sam_weights(name), device="cpu" if device == "cpu" else "cuda")
    return SAM2ImagePredictor(model)


def sam_weights(name):
    """Путь к целым весам SAM2 на томе; нет — качаем с HuggingFace с проверкой длины."""
    from training_svc import embed

    file_name, _, repo = SAM_FILES[name]
    folder = config.auto_weights_dir("sam2")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, file_name)
    url = f"https://huggingface.co/facebook/sam2.1-hiera-{repo}/resolve/main/{file_name}"
    expected = embed._expected_size(url)
    if embed._looks_whole(path, expected, "hub"):
        return path
    if expected is None:
        raise RuntimeError(f"Весов {file_name} нет на томе, а HuggingFace не отвечает. "
                           f"Положите файл руками в {folder}.")
    got = embed._download(url, path + ".part", expected, "hub", None)
    if got is None:
        raise RuntimeError(f"Не удалось скачать {file_name} с HuggingFace. "
                           f"Положите файл руками в {folder}.")
    os.replace(got, path)
    return path


def _peak_mb(device):
    if device == "cpu":
        return 0
    try:
        import torch
        return int(torch.cuda.max_memory_reserved() / (1 << 20))
    except Exception:
        return 0


def _free():
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
    except Exception:
        pass


def _uuid(value):
    import uuid
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None
