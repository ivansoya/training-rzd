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
import copy
import logging
import os
import threading
import time
from contextlib import contextmanager

from sqlalchemy import select

from common import agent_graph, config, gpu, live, shapes, task_frames, video_frames, video_tracks
from common.db import SessionLocal
from common.models import (
    AgentRun, AgentWeights, Annotation, AugGraph, AugGraphVersion, GpuLease, Image, TaskVideo,
    VideoAnnotation, VideoScout, utcnow,
)

log = logging.getLogger("training")

# Прикидка памяти на одну сеть, пока нет замера. Средний yolo11 на входе 1280
# с запасом; по факту диспетчер запомнит свой.
NET_VRAM_MB = 1500
# SAM2 small на кадре 1920×1400 — около гигабайта; large вдвое больше.
SAM_VRAM_MB = 1500
# «Сеть по тексту» считается по числу промтов — agent_graph.text_vram_mb.
# Веса YOLOE-26 и кодировщик промтов лежат в образе (training_svc/fetch_yoloe.py).
YOLOE_DIR = os.environ.get("YOLOE_DIR", "/opt/yoloe")
# SAM 3 в ultralytics считает на квадрате 644 и растягивает в него кадр без
# сохранения пропорций (рамки уезжали до 20 px). Ужимаем длинную сторону до 644
# и добиваем до квадрата сами: растягивать становится нечего. Заодно маски — по
# размеру поданного кадра, а не 2688×1520 (десятки гигабайт на сотню масок).
SAM3_SIDE = 644
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


# Прогоны, которые сейчас ведут потоки этого процесса: строка не меняет статус
# до брони карты, и без этого два потока пула взяли бы один прогон.
_taken: set = set()
_taken_lock = threading.Lock()


def claim(db, worker_id):
    with _taken_lock:
        q = (select(AgentRun)
             .where(AgentRun.status.in_(("queued", "waiting_gpu")))
             .order_by(AgentRun.created_at)
             .limit(1)
             .with_for_update(skip_locked=True))
        if _taken:
            q = q.where(AgentRun.id.not_in(_taken))
        run = db.execute(q).scalar_one_or_none()
        if run is not None:
            run.worker_id = worker_id
            _taken.add(run.id)
            db.commit()
    return run


def release(run_id):
    with _taken_lock:
        _taken.discard(run_id)


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
    # Копия: зажатые в пределы числа не должны уйти обратно в версию.
    doc = copy.deepcopy(version.doc)
    from training_svc import examples

    sets = examples.rows_for(db, run.created_by, doc)
    try:
        # Версия уже сохранена — старые числа вне пределов зажимаем, а не отвергаем.
        order = agent_graph.check(doc, sam3=config.sam3_ready(), clamp=True,
                                  examples={k: r.status == "ready" for k, r in sets.items()})
    except agent_graph.AgentGraphError as exc:
        _finish(db, run, "error", str(exc))
        return True

    nets = [n for n in doc["nodes"] if n["type"] == "net"]
    texts = [n for n in doc["nodes"] if n["type"] == "text"]
    families = sorted("sam3" if agent_graph.text_model(n.get("params")) == "sam3" else "yoloe"
                      for n in texts)
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
    batch = max((len(agent_graph.variants(n.get("params") or {}))
                 * (8 if (n.get("params") or {}).get("tiles") else 1)
                 for n in nets + texts), default=1)
    # Число промтов и наборов — в подписи: SAM 3 на 40 промтов и на 1 — разные задачи.
    prompts = sorted(f"{len(agent_graph.text_prompts(n))}p{len(agent_graph.text_sets(n))}s"
                     for n in texts)
    sig = (f"agent:{len(nets)}:b{batch}:{','.join(sams)}:{','.join(families)}"
           f":{','.join(prompts)}")
    want, _ = gpu.estimate(db, "agent", sig, NET_VRAM_MB * len(nets) + SAM_VRAM_MB * len(sams)
                           + sum(agent_graph.text_vram_mb(n) for n in texts))
    # Бронь из очереди переиспользуем: новая на каждой попытке обнуляла время
    # ожидания, и защита от голодания (возраст брони) не срабатывала.
    lease = db.get(GpuLease, run.gpu_lease_id) if run.gpu_lease_id else None
    if lease is not None and lease.status == "queued" and lease.want_mb == want:
        gpu.try_grant(db, lease.id)
        db.refresh(lease)
    elif lease is None or lease.status != "held" or lease.want_mb != want:
        if lease is not None and lease.status in gpu.ACTIVE:
            gpu.cancel(db, lease.id, "Новая попытка")
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
        # Своя память — прирост от этого уровня: соседний прогон или превью в
        # том же процессе не должны попадать в замер (раньше 6740 вместо 3900).
        base = _allocated_mb(device)
        with _beating(lease.id):
            models = _load(weights)
            models.update({n["id"]: load_text(n, device, sets) for n in texts})
            # Разведке нужны где и что, а не контур: SAM не грузим вовсе.
            if mode != "scout":
                models.update({name: _load_sam(name, device) for name in sams})
        tick = _ticker(db, run, lease.id, device, base)
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
        peak = tick.peak()
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
    """Один кадр. Возвращает число поставленных рамок.

    Модель считает без замка: держать строку кадра секунды значило бы стопорить
    запись человека и ловить взаимную блокировку. Писать — под замком и только
    если за это время кадр не тронули (статус и версия разметки прежние)."""
    image = db.get(Image, image_id)
    if image is None or image.task_status != "new":
        db.rollback()
        return 0
    path, name, seen = os.path.join(config.DATA_DIR, image.file_path), image.file_name, image.annotations_rev
    db.rollback()
    predict, segment = frame_fns(path, name, models, weights, device)
    found = agent_graph.run(doc, predict, order, segment)
    image = db.execute(
        select(Image).where(Image.id == image_id).with_for_update()
    ).scalar_one_or_none()
    if image is None or image.task_status != "new" or image.annotations_rev != seen:
        db.rollback()
        return 0
    return _write(db, run, image, found, mapping)


def frame_fns(path, file_name, models, weights, device, picture=None, contour=True):
    """(predict, segment) для одного кадра — их зовёт `agent_graph.run`.

    Общие у прогона и превью: превью обязано показывать ровно то, что ляжет
    в разметку. `models` — {узел сети или «Сети по тексту»: модель, имя SAM:
    предиктор}, `weights` — {узел сети: строка полки}. `picture` — кадр ролика,
    уже распакованный декодером (PIL, RGB); тогда `path` не читается.
    `contour=False` — разведка: контур SAM 3 ей не нужен, и его не считаем."""
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
        text = node["type"] == "text"
        if text:
            rows = agent_graph.text_rows(node)
            if agent_graph.text_model(params) == "sam3":
                return _sam3(models[node["id"]], pixels, rows, node, contour)
            side = int(agent_graph.num(params.get("imgsz"), agent_graph.TEXT_IMGSZ))
            # Модель идёт с самым низким порогом строк, каждую дорезает `run`.
            conf = agent_graph.min_conf(node)
        else:
            side = int(agent_graph.num(params.get("imgsz"), weights[node["id"]].imgsz or 640))
            # Не `or`: уверенность 0 — это «всё подряд», а `0 or 0,25` молча
            # превращал её в умолчание (замер: 0 давал те же 15 рамок, что 0,25).
            conf = agent_graph.num(params.get("conf"), 0.25)

        def infer(jobs, scale):
            crops = []
            for (x0, y0, x1, y1), flip in jobs:
                crop = pixels[y0:y1, x0:x1]
                # Отрицательный шаг отражения cv2 внутри ultralytics не примет.
                crops.append(np.ascontiguousarray(crop[:, ::-1] if flip else crop))
            # IoU не передаём: встроенный NMS у yolo11 и v8 работает со своим
            # мягким 0,7, у yolo26 его нет вовсе. Строже — узел «NMS» в графе.
            results = models[node["id"]].predict(
                crops, verbose=False, device=device, conf=conf,
                # ultralytics требует кратность шагу сети — 32.
                imgsz=max(32, round(side * scale / 32) * 32),
            )
            return [
                [(c, p, x1, y1, x2 - x1, y2 - y1) for c, p, (x1, y1, x2, y2) in zip(
                    r.boxes.cls.tolist(), r.boxes.conf.tolist(), r.boxes.xyxy.tolist())]
                for r in results
            ]

        h, w = pixels.shape[:2]
        found = agent_graph.detect(params, w, h, side, infer)
        # У YOLOE номер класса — место промта среди включённых, а таблица узла
        # считает строки вместе с выключенными.
        return [(rows[c][0], *rest) for c, *rest in found] if text else found

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


class Sam3Text:
    """SAM 3 узла: предиктор и вырезки коллажа для каждой строки-образцов."""

    def __init__(self, predictor, crops):
        self.predictor = predictor
        self.crops = crops   # {id набора: [(вырезка BGR, рамка в вырезке)]}


def _sam3(model, pixels, rows, node, contour):
    """«Сеть по тексту» на SAM 3: [(строка, уверенность, x, y, w, h, контур)].

    Слова — одним вызовом. Каждая строка-образцы — свой вызов с коллажем:
    SAM 3 берёт рамки-образцы только на том же кадре, поэтому над кадром
    кладётся полоса вырезок, образцы обводятся рамками в ней, а находки
    ниже полосы — это находки в кадре (FSS-SAM3, замер 25.09.2026)."""
    import cv2
    import numpy as np

    from common import agent_examples as ax

    params = node.get("params") or {}
    predictor = model.predictor
    predictor.args.conf = agent_graph.min_conf(node)
    h, w = pixels.shape[:2]
    out = []

    def collect(r, k, top, row_of):
        if r.boxes is None or not len(r.boxes):
            return
        masks = r.masks.data.cpu().numpy() if contour and r.masks is not None else None
        cut = round(top * k)
        for j, (c, p, (x1, y1, x2, y2)) in enumerate(zip(
                r.boxes.cls.tolist(), r.boxes.conf.tolist(), r.boxes.xyxy.tolist())):
            y1, y2 = y1 / k - top, y2 / k - top
            if y2 <= 0:
                continue          # находка в полосе образцов
            y1 = max(0.0, y1)
            box = (x1 / k, y1, (x2 - x1) / k, y2 - y1)
            shape = (agent_graph.text_outline(box, masks[j][cut:], p, params, k)
                     if masks is not None else None)
            out.append((row_of(c), p, *box, shape))

    def shrink(image):
        k = min(1.0, SAM3_SIDE / max(image.shape[:2]))
        if k < 1:
            image = cv2.resize(image, (round(image.shape[1] * k), round(image.shape[0] * k)),
                               interpolation=cv2.INTER_AREA)
        # Поля справа и снизу: координаты рамок от них не меняются.
        square = np.zeros((SAM3_SIDE, SAM3_SIDE, 3), np.uint8)
        square[:image.shape[0], :image.shape[1]] = image[:SAM3_SIDE, :SAM3_SIDE]
        return square, k

    words = [(i, r) for i, r in rows if not agent_graph.is_examples(r)]
    if words:
        small, k = shrink(pixels)
        predictor.set_image(small)
        collect(predictor(text=[str(r["prompt"]).strip() for _, r in words])[0], k, 0,
                lambda c: words[int(c)][0])
    for i, r in rows:
        if not agent_graph.is_examples(r):
            continue
        crops = model.crops[str(r["set"])]
        top, places = ax.strip_layout([(c.shape[1], c.shape[0]) for c, _ in crops], w, len(crops))
        strip = np.zeros((top, w, 3), np.uint8)
        boxes = []
        for (img, (bx, by, bw, bh)), (px, py, sc) in zip(crops, places):
            fit = cv2.resize(img, (max(1, round(img.shape[1] * sc)), max(1, round(img.shape[0] * sc))))
            x0, y0 = int(px), int(py)
            part = fit[:top - y0, :w - x0]
            strip[y0:y0 + part.shape[0], x0:x0 + part.shape[1]] = part
            boxes.append([px + bx * sc, py + by * sc, px + (bx + bw) * sc, py + (by + bh) * sc])
        small, k = shrink(np.vstack([strip, pixels]))
        predictor.set_image(small)
        found = predictor(bboxes=np.array(boxes, np.float32) * k, labels=np.ones(len(boxes)))[0]
        collect(found, k, top, lambda _c, row=i: row)
    return out


def load_text(node, device, sets=None):
    """Модель «Сети по тексту»: YOLOE с вшитыми классами — векторы слов и
    средние векторы наборов образцов по порядку строк, — или SAM 3 с
    вырезками коллажа. `sets` — {id набора: строка agent_examples}."""
    from training_svc import examples

    params = node.get("params") or {}
    model = agent_graph.text_model(params)
    sets = sets or {}
    missing = [s for _, s in agent_graph.text_sets(node) if s not in sets]
    if missing:
        raise RuntimeError("Набора образцов нет на полке владельца агента.")
    if model == "sam3":
        if not config.sam3_ready():
            raise RuntimeError(f"Нет весов SAM 3: положите sam3.pt в {config.SAM3_WEIGHTS}.")
        from ultralytics.models.sam import SAM3SemanticPredictor

        return Sam3Text(SAM3SemanticPredictor(overrides=dict(
            task="segment", mode="predict", model=config.SAM3_WEIGHTS, save=False, verbose=False,
            imgsz=SAM3_SIDE, quantize=16 if device != "cpu" else None,
            device="cpu" if device == "cpu" else 0)),
            {s: examples.collage_crops(sets[s]) for _, s in agent_graph.text_sets(node)})

    import torch
    from ultralytics import YOLOE
    from ultralytics.nn.text_model import MobileCLIPTS

    yoloe = YOLOE(os.path.join(YOLOE_DIR, f"yoloe-26{model}-seg.pt"))
    rows = agent_graph.text_rows(node)
    words = [str(r["prompt"]).strip() for _, r in rows if not agent_graph.is_examples(r)]
    text = {}
    if words:
        # Кодировщик нужен один раз — перевести промты в векторы. Сам ultralytics
        # ищет его файл по имени в текущей папке, поэтому даём его сами, на
        # процессоре, и потом выбрасываем: держать 254 МБ ради готовых векторов незачем.
        yoloe.model.clip_model = MobileCLIPTS(torch.device("cpu"),
                                              weight=os.path.join(YOLOE_DIR, "mobileclip2_b.ts"))
        pe = yoloe.model.get_text_pe(words, cache_clip_model=True)[0].float()
        del yoloe.model.clip_model
        text = dict(zip(words, pe))
    names, vectors = [], []
    for _, r in rows:
        if agent_graph.is_examples(r):
            names.append(f"examples:{r['set']}")
            vectors.append(torch.from_numpy(examples.mean_vector(sets[str(r["set"])], model)))
        else:
            names.append(str(r["prompt"]).strip())
            vectors.append(text[names[-1]])
    yoloe.set_classes(names, torch.stack(vectors)[None])
    return yoloe


def text_key(node):
    """Чем отличаются загруженные модели узла: у YOLOE классы вшиты в веса,
    у SAM 3 — вырезки коллажа."""
    params = node.get("params") or {}
    model = agent_graph.text_model(params)
    sets = tuple(s for _, s in agent_graph.text_sets(node))
    if model == "sam3":
        return (model, *sets)
    return (model, *(p for _, p in agent_graph.text_prompts(node)), *sets)


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
    # Открытый у человека редактор увидит 409, а не перезапишет рамки агента молча.
    image.annotations_rev += 1
    db.commit()
    return put


def _ticker(db, run, lease_id, device=None, base=0):
    """Шаг хода: +1 кадр, статистика, отмена кнопкой, пульс брони и живой связи.

    Заодно держит пик своей памяти: прирост `memory_allocated` от `base`."""
    last = [0.0]
    top = [0]

    def tick(stats):
        top[0] = max(top[0], _allocated_mb(device) - base)
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

    # Запас 15 %: allocated не видит кэш распределителя.
    tick.peak = lambda: int(top[0] * 1.15) if top[0] > 0 else 0
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
        hits, seen = {}, {}

        def on_frame(frame_no, _time_ms, picture):
            predict, segment = frame_fns(None, f"{video.file_name} #{frame_no}", models, weights,
                                         device, picture=picture, contour=mode == "annotate")
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
            # Номера — по таблице кадров ролика, как у разметки и закрытия.
            video_frames.extract_frames(os.path.join(config.DATA_DIR, video.file_path), wanted,
                                        on_frame, pts=video_frames.unpack_pts(video.frame_index))
        if mode == "annotate":
            # Ролик пройден целиком: прежние рамки агента вне плана больше не нужны.
            db.execute(_agent_rows(video).where(VideoAnnotation.frame_no.notin_(wanted or [-1])))
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


def _agent_rows(video):
    """Одиночные рамки агентов на ролике — то, что повторный прогон заменяет."""
    return VideoAnnotation.__table__.delete().where(
        VideoAnnotation.video_id == video.id, VideoAnnotation.track_id.is_(None),
        VideoAnnotation.source == "model", VideoAnnotation.agent_version_id.isnot(None))


def _write_video(db, run, video, frame_no, found, mapping):
    # Замена по кадру в одной транзакции: остановка на середине не теряет прежние рамки.
    db.execute(_agent_rows(video).where(VideoAnnotation.frame_no == frame_no))
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


def _allocated_mb(device):
    if device in (None, "cpu"):
        return 0
    try:
        import torch
        return int(torch.cuda.memory_allocated() / (1 << 20))
    except Exception:
        return 0


def _free():
    # Без reset_peak_memory_stats: общий на процесс сброс сбивал замер соседа.
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _uuid(value):
    import uuid
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None
