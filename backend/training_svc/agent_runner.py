"""Прогон агента по блокам таски — внутри процесса воркера.

Не отдельным процессом, как обучение: прогон короткий, падать ему нечему
кроме сети, а отдельный процесс стоил бы секунд на импорт torch на каждый
запуск. Тот же приём, что у счёта признаков (`worker.do_embed`).

Что пишется в базу — по решению владельца:

* только кадры `new`: размеченные, фоновые, отложенные и забракованные —
  это уже решение человека, агент их не трогает;
* на кадре заменяются только непроверенные рамки ЭТОГО агента (любой его
  версии); рамки человека и проверенные рамки остаются, а находки, повторяющие
  их, отбрасываются (`agent_graph.drop_known`); с непроверенными рамками других
  агентов находка спорит по NMS — остаётся уверенная (`agent_graph.settle_agents`);
* новые рамки встают на проверку, кадр остаётся `new` — размеченным его
  делает человек, подтвердив кадр;
* автор рамки — владелец агента, `agent_version_id` — версия прогона;
* только на видеокарте: не дали карту — ждём, не влезет никогда — ошибка
  (решение 09.10.2026). Целиком не влезает, а по блокам да — модели грузятся
  по очереди на пачку кадров (`agent_memory`).

Каждый кадр — своя транзакция, и статус кадра перечитывается под замком:
человек мог открыть и сохранить кадр, пока агент шёл к нему.
"""
import logging
import os
import threading
import time
from contextlib import contextmanager

from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError

from common import (
    agent_graph, agent_memory, config, gpu, gpu_peak, live, settings, shapes, task_frames, video_frames, video_tracks,
)
from common.db import SessionLocal
from common.models import (
    AgentRun, AgentWeights, Annotation, AugGraph, AugGraphVersion, GpuDevice, GpuLease, Image,
    TaskVideo, VideoAnnotation, VideoScout, utcnow,
)

log = logging.getLogger("training")

# Прикидки памяти — `common.agent_memory`; по факту диспетчер запомнит свой замер.
# Веса YOLOE-26 и кодировщик промтов лежат в образе (training_svc/fetch_yoloe.py).
YOLOE_DIR = os.environ.get("YOLOE_DIR", "/opt/yoloe")
# SAM 3 в ultralytics растягивает кадр в квадрат входа (644 или 1008) без сохранения
# пропорций, поэтому `_sam3` ужимает длинную сторону и добивает до квадрата сам.
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


ORPHAN_TEXT = "Прерван: воркер обучения перезапущен или не отвечал."


def reap_orphans(db, worker_id, fresh_start=False):
    """Закрыть прогоны «идёт», которые никто не ведёт.

    Признак жизни — бронь карты: её продлевают и пульс загрузки моделей, и шаг
    хода. Истекла — ведущего нет. На старте свои прогоны закрываются сразу."""
    closed = 0
    for run in db.execute(select(AgentRun).where(AgentRun.status == "running")).scalars().all():
        with _taken_lock:
            if run.id in _taken:
                continue
        lease = db.get(GpuLease, run.gpu_lease_id) if run.gpu_lease_id else None
        alive = lease is not None and lease.status in gpu.ACTIVE
        if alive and not (fresh_start and run.worker_id == worker_id):
            continue
        log.warning("прогон агента %s без исполнителя — ошибка", run.id)
        _finish(db, run, "error", ORPHAN_TEXT)
        if alive:
            gpu.cancel(db, lease.id, ORPHAN_TEXT)
        closed += 1
    return closed


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
    # `prepare` отдаёт копию: зажатые в пределы числа не уйдут обратно в версию.
    doc = agent_graph.prepare(version.doc)
    from training_svc import examples

    # Образцы — с полки владельца агента: подключённого к проекту агента
    # запускает не только он. Владелец удалён — наборы ищутся просто по id.
    graph = db.get(AugGraph, version.graph_id)
    sets = examples.rows_for(db, graph.owner_id if graph is not None else None, doc)
    try:
        # Версия уже сохранена — старые числа вне пределов зажимаем, а не отвергаем.
        order = agent_graph.check(doc, sam3=config.sam3_ready(), clamp=True,
                                  examples={k: r.status == "ready" for k, r in sets.items()})
    except agent_graph.AgentGraphError as exc:
        _finish(db, run, "error", str(exc))
        return True

    weights = {}
    for node in (n for n in doc["nodes"] if n["type"] == "net"):
        row = db.get(AgentWeights, _uuid(node["params"].get("weights")))
        if row is None:
            _finish(db, run, "error", f"{agent_graph.title(node)}: весов нет на полке.")
            return True
        weights[node["id"]] = row

    mode = run.params.get("mode") or "frames"
    scout = mode == "scout"
    cards = gpu.cards(db)
    cpu_half = settings.get(db, settings.SAM3_CPU_HALF)
    mem = agent_memory.plan(doc, max((c["cap_mb"] for c in cards), default=0) or None, scout,
                            nets=agent_memory.net_info(weights), sam3_cpu_half=cpu_half)
    sig = agent_memory.signature(doc, mem["words"], scout=scout, sam3_cpu_half=cpu_half)
    total, _ = gpu.estimate(db, "agent", sig, mem["total_mb"])
    verdict = agent_memory.verdict(total, mem["heaviest"], cards)
    if verdict["state"] == agent_memory.NEVER:
        if run.gpu_lease_id:
            gpu.cancel(db, run.gpu_lease_id, verdict["reason"])
        _finish(db, run, "error", verdict["reason"])
        return True
    sequential = verdict["state"] == agent_memory.SEQUENTIAL
    agent_memory.fix_words(doc, mem["words"])
    want = total
    if sequential:
        sig = agent_memory.signature(doc, mem["words"], sequential=True, scout=scout, sam3_cpu_half=cpu_half)
        want, _ = gpu.estimate(db, "agent", sig, mem["heaviest"]["mb"])
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
            allow_cpu=False, title="Агент разметки",
        )
    if lease.status == "denied":
        _finish(db, run, "error", lease.reason or "Видеокарту не дали.")
        return True
    if lease.status != "held":
        run.status = "waiting_gpu"
        run.queue_reason = lease.reason
        run.gpu_lease_id = lease.id
        db.commit()
        live.notify(db, "agent", run.id, run.project_id, s="waiting_gpu")
        return False

    card = db.get(GpuDevice, lease.device_id)
    # Что прогон занял — для журнала агентов проекта; ход пишет счётчики рядом.
    info = {"card": card.name if card else None, "want_mb": want, "sequential": sequential,
            "words": mem["words"] or None, "waited_s": _waited(lease)}
    run.status = "running"
    run.gpu_lease_id = lease.id
    run.queue_reason = None
    run.started_at = run.started_at or utcnow()
    run.stats = {"res": info}
    db.commit()
    live.notify(db, "agent", run.id, run.project_id, s="running")
    peak = 0
    tick = None
    try:
        device = _device(gpu.torch_index(db, lease))
        ids = frames(db, run) if mode == "frames" else None
        plan = _video_plan(db, run, mode) if ids is None else None
        run.total = len(ids) if ids is not None else sum(len(f) for _, f in plan)
        db.commit()
        # Своя память — прирост от этого уровня: соседний прогон или превью в
        # том же процессе не должны попадать в замер (раньше 6740 вместо 3900).
        base = _allocated_mb(device)
        tick = _ticker(db, run, lease.id, device, base, info)
        work = _Work(doc, order, mem["units"], weights, sets, device, lease.id, sequential, tick)
        mapping = run.params.get("mapping") or {}
        if ids is not None:
            _frames(db, run, ids, work, mapping, tick)
        else:
            _videos(db, run, mode, plan, work, mapping, tick)
        peak = tick.peak()
        _finish(db, run, "done")
    except Stopped:
        _finish(db, run, "stopped")
    except Exception as exc:  # noqa: BLE001 — человеку нужен текст, а не трасса
        log.exception("прогон агента %s не удался", run.id)
        db.rollback()
        message = str(exc)[:500]
        if _is_oom(exc):
            # Оценка соврала — следующий запуск попросит больше, а не упадёт так же.
            peak = max(tick.peak() if tick else 0, int(want * 1.25))
            message = (f"Не хватило памяти карты{' ' + info['card'] if info['card'] else ''}: "
                       f"просили {_gb(want)}. Следующий запуск попросит {_gb(peak)}.")
        _finish(db, run, "error", message)
    finally:
        if tick is not None:
            tick.close()
        if peak:
            gpu.remember(db, "agent", sig, peak)
        gpu.release(db, lease.id, peak_mb=peak or None)
        _free()
    return True


def _gb(mb):
    return f"{mb / 1024:.1f} ГБ".replace(".", ",")


def _waited(lease):
    """Сколько прогон ждал карту, секунд: от постановки брони до выдачи."""
    if lease.granted_at is None or lease.created_at is None:
        return None
    return max(0, int((lease.granted_at - lease.created_at).total_seconds()))


def _is_oom(exc):
    return type(exc).__name__ == "OutOfMemoryError" or "out of memory" in str(exc).lower()


def _device(index):
    """Карта брони для torch в этой нити.

    Только объектом `torch.device`: ultralytics 8.4 на строку «1» или «cuda:1»
    переписывает CUDA_VISIBLE_DEVICES на весь процесс и всё равно отдаёт
    cuda:0. `set_device` — для кода, который берёт «текущую» карту нити."""
    import torch

    if index is None:
        raise RuntimeError("Бронь без видеокарты — агенты на процессоре не считают.")
    torch.cuda.set_device(index)
    return torch.device(f"cuda:{index}")


class _Work:
    """Как прогон считает кадры: целиком — все модели в памяти, — или поочерёдно:
    кадры копятся пачкой, и модели грузятся по одному блоку `agent_memory` на пачку."""

    def __init__(self, doc, order, units, weights, sets, device, lease_id, sequential, tick):
        self.doc, self.order, self.units = doc, order, units
        self.weights, self.sets, self.device = weights, sets, device
        self.lease_id, self.sequential, self.tick = lease_id, sequential, tick
        self.byid = {n["id"]: n for n in doc["nodes"]}
        self.buffer = []
        self.models = None

    def frame(self, key, path, picture, name, segment, handle, trace=None):
        """Посчитать кадр и отдать находки в `handle(key, found)`; поочерёдно —
        позже, на `flush` пачки. `segment=False` — разведка: SAM не грузится.
        `trace` — словарь превью: вход и выход каждого узла."""
        if not self.sequential:
            if self.models is None:
                self.models = self._load([u for u in self.units if segment or u["kind"] != "sam"])
            predict, seg = frame_fns(path, name, self.models, self.weights, self.device,
                                     picture=picture, contour=segment)
            handle(key, agent_graph.run(self.doc, predict, self.order, seg if segment else None, trace))
            return
        self.buffer.append((key, path, picture, name, segment, handle, trace))
        if len(self.buffer) >= agent_memory.SEQ_BATCH:
            self.flush()

    def flush(self):
        items, self.buffer = self.buffer, []
        if not items:
            return
        cache = [{} for _ in items]
        for unit in (u for u in self.units if u["kind"] != "sam"):
            self.tick.check()
            models = self._load([unit])
            for i, (_key, path, picture, name, segment, _handle, _trace) in enumerate(items):
                predict, _ = frame_fns(path, name, models, self.weights, self.device,
                                       picture=picture, contour=segment)
                for nid in unit["nodes"]:
                    cache[i][nid] = predict(self.byid[nid])
            self.tick.measure()
            del models
            _free()
        need_sam = any(item[4] for item in items)
        sams = self._load([u for u in self.units if u["kind"] == "sam"]) if need_sam else {}
        try:
            for i, (key, path, picture, name, segment, handle, trace) in enumerate(items):
                _, seg = frame_fns(path, name, sams, self.weights, self.device, picture=picture, contour=segment)
                found = agent_graph.run(self.doc, lambda node, c=cache[i]: c[node["id"]], self.order,
                                        seg if segment else None, trace)
                handle(key, found)
        finally:
            del sams
            _free()

    def _load(self, units):
        """Модели блоков: {узел сети или «Сети по тексту»: модель, имя SAM: предиктор}.
        Узлы SAM 3 одного блока делят одну модель — у них разные только промты."""
        out = {}
        with _beating(self.lease_id):
            for unit in units:
                if unit["kind"] == "net":
                    out.update(_load({nid: self.weights[nid] for nid in unit["nodes"]}))
                elif unit["kind"] in ("yoloe", "sam3"):
                    shared = {}
                    for nid in unit["nodes"]:
                        out[nid] = load_text(self.byid[nid], self.device, self.sets, shared)
                elif unit["kind"] == "sam":
                    for nid in unit["nodes"]:
                        name = (self.byid[nid].get("params") or {}).get("model") or agent_graph.SAM_DEFAULTS["model"]
                        if name not in out:
                            out[name] = _load_sam(name, self.device)
        self.tick.measure()
        return out


def _frames(db, run, ids, work, mapping, tick):
    """Кадры таски. Модель считает без замка: держать строку кадра секунды значило
    бы стопорить запись человека и ловить взаимную блокировку. Писать — под замком
    и только если кадр за это время не тронули (статус и версия разметки прежние)."""
    seen = {}
    stats = {"boxes": 0, "frames": 0}

    def handle(image_id, found):
        image = db.execute(select(Image).where(Image.id == image_id).with_for_update()).scalar_one_or_none()
        if image is None or image.task_status != "new" or image.annotations_rev != seen[image_id]:
            db.rollback()
            put = 0
        else:
            put = _write(db, run, image, found, mapping)
        stats["boxes"] += put
        stats["frames"] += bool(put)
        tick(dict(stats))

    for image_id in ids:
        image = db.get(Image, image_id)
        if image is None or image.task_status != "new":
            db.rollback()
            tick(dict(stats))
            continue
        seen[image_id] = image.annotations_rev
        path, name = os.path.join(config.DATA_DIR, image.file_path), image.file_name
        db.rollback()
        work.frame(image_id, path, None, name, True, handle)
    work.flush()


def frame_fns(path, file_name, models, weights, device, picture=None, contour=True):
    """(predict, segment) для одного кадра — их зовёт `agent_graph.run`.

    Общие у прогона и превью: превью обязано показывать ровно то, что ляжет
    в разметку. `models` — {узел сети или «Сети по тексту»: модель, имя SAM:
    предиктор}, `weights` — {узел сети: строка полки}. `picture` — кадр ролика,
    уже распакованный декодером (PIL, RGB); тогда `path` не читается.
    `contour=False` — разведка: контур SAM 3 ей не нужен, отдаём только рамку по маске."""
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
        h, w = pixels.shape[:2]

        def crop(view):
            x0, y0, x1, y1 = view
            return np.ascontiguousarray(pixels[y0:y1, x0:x1])

        if text:
            rows = agent_graph.text_rows(node)
            if agent_graph.text_model(params) == "sam3":
                whole = (0, 0, w, h)
                return agent_graph.detect(
                    params, w, h, agent_graph.tile_side(node),
                    lambda views: [_sam3(models[node["id"]], crop(v), rows, node, contour, grow=v != whole)
                                   for v in views])
            side = int(agent_graph.num(params.get("imgsz"), agent_graph.TEXT_IMGSZ))
            # Модель идёт с самым низким порогом строк, каждую дорезает `run`.
            conf = agent_graph.min_conf(node)
        else:
            side = int(agent_graph.num(params.get("imgsz"), weights[node["id"]].imgsz or 640))
            # Не `or`: уверенность 0 — это «всё подряд», а `0 or 0,25` молча
            # превращал её в умолчание (замер: 0 давал те же 15 рамок, что 0,25).
            conf = agent_graph.num(params.get("conf"), 0.25)

        half = text and agent_graph.text_half(params)

        def infer(views):
            # IoU не передаём: встроенный NMS у yolo11 и v8 работает со своим
            # мягким 0,7, у yolo26 его нет вовсе. Строже — узел «NMS» в графе.
            # Тайл другого размера ultralytics сам растянет или ужмёт до входа.
            try:
                results = models[node["id"]].predict(
                    [crop(v) for v in views], verbose=False, device=device, conf=conf,
                    # ultralytics требует кратность шагу сети — 32.
                    imgsz=max(32, round(side / 32) * 32), **({"quantize": 16} if half else {}),
                )
            except RuntimeError as e:
                if half and ("Half" in str(e) or "dtype" in str(e)):
                    raise RuntimeError(f"{agent_graph.title(node)}: YOLOE в fp16 не работает с этой версией "
                                       f"ultralytics — переключите «Точность» узла на fp32.") from e
                raise
            return [
                [(c, p, x1, y1, x2 - x1, y2 - y1) for c, p, (x1, y1, x2, y2) in zip(
                    r.boxes.cls.tolist(), r.boxes.conf.tolist(), r.boxes.xyxy.tolist())]
                for r in results
            ]

        found = agent_graph.detect(params, w, h, agent_graph.tile_side(node, side), infer)
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
    """SAM 3 узла: предиктор и образцы коллажа для каждой строки-образцов."""

    def __init__(self, predictor, crops):
        self.predictor = predictor
        self.crops = crops   # {id набора: examples.Crops}


def _sam3(model, pixels, rows, node, contour, grow=False):
    """«Сеть по тексту» на SAM 3: [(строка, уверенность, x, y, w, h, контур)].

    Слова — порциями (на 1008 по 4: память растёт с каждым). Каждая строка-образцы —
    свои вызовы с коллажем: SAM 3 берёт рамки-образцы только на том же кадре, поэтому
    над кадром кладутся ряды вырезок по 6, а находки ниже рядов — это находки в кадре
    (FSS-SAM3). Второй ряд — в тот же проход, если влезает; дальше — ещё проходы.
    `pixels` — кадр или тайл; `grow` — тайл меньше входа растянуть до него."""
    import numpy as np

    from common import agent_examples as ax

    params = node.get("params") or {}
    side = agent_graph.sam3_side(params)
    predictor = model.predictor
    predictor.args.conf = agent_graph.min_conf(node)
    h, w = pixels.shape[:2]
    out = []

    def collect(r, k, top, row_of):
        found = []
        if r.boxes is None or not len(r.boxes):
            return found
        # Маска нужна и разведке: рамка SAM 3 короче его маски, и рамку
        # находки даёт маска (см. `agent_graph.text_outline`).
        masks = r.masks.data.cpu().numpy() if r.masks is not None else None
        cut = round(top * k)
        for j, (c, p, (x1, y1, x2, y2)) in enumerate(zip(
                r.boxes.cls.tolist(), r.boxes.conf.tolist(), r.boxes.xyxy.tolist())):
            y1, y2 = y1 / k - top, y2 / k - top
            if ax.in_rows(y1, y2):
                continue
            y1 = max(0.0, y1)
            box = (x1 / k, y1, (x2 - x1) / k, y2 - y1)
            shape = (agent_graph.text_outline(box, masks[j][cut:], p, params, k)
                     if masks is not None else None)
            if shape:
                box = shape["box"]
            found.append((row_of(c), p, *box, shape if contour else None))
        return found

    def shrink(image):
        return ax.model_square(image, side, grow)

    words = [(i, r) for i, r in rows if not agent_graph.is_examples(r)]
    if words:
        small, k = shrink(pixels)
        predictor.set_image(small)
        per = agent_graph.sam3_words_per_call(params)
        for at in range(0, len(words), per):
            part = words[at:at + per]
            out += collect(predictor(text=[str(r["prompt"]).strip() for _, r in part])[0], k, 0,
                           lambda c, part=part: part[int(c)][0])
    for i, r in rows:
        if not agent_graph.is_examples(r):
            continue
        crops = [c for c in model.crops[str(r["set"])].for_view(w) if c[0] is not None]
        plan = ax.collage_passes(len(crops), w, h)
        found = []
        for chunk in plan:
            strip, boxes = ax.collage_strip(crops, chunk, w)
            top = strip.shape[0]
            small, k = shrink(np.vstack([strip, pixels]))
            predictor.set_image(small)
            found += collect(predictor(bboxes=np.array(boxes, np.float32) * k, labels=np.ones(len(boxes)))[0],
                             k, top, lambda _c, row=i: row)
        # Проходы смотрят на один кадр: дубль одного предмета гасим, остаётся уверенный.
        out += _merge_passes(found) if len(plan) > 1 else found
    return out


def _merge_passes(found, threshold=agent_graph.NMS_IOU):
    kept = []
    for det in sorted(found, key=lambda d: -d[1]):
        if all(agent_graph.iou(det[2:6], k[2:6]) < threshold for k in kept):
            kept.append(det)
    return kept


def load_text(node, device, sets=None, shared=None):
    """Модель «Сети по тексту»: YOLOE с вшитыми классами — векторы слов и
    средние векторы наборов образцов по порядку строк, — или SAM 3 с
    вырезками коллажа. `sets` — {id набора: строка agent_examples}.
    `shared` — {вход: предиктор SAM 3}: узлы SAM 3 на одном входе делят модель
    (3,45 ГБ весов), своё у каждого — только промты и вырезки."""
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
        side = agent_graph.sam3_side(params)
        predictor = (shared or {}).get(side)
        if predictor is None:
            predictor = sam3_predictor_class()(overrides=dict(
                task="segment", mode="predict", model=config.SAM3_WEIGHTS, save=False, verbose=False,
                imgsz=side, quantize=16, device=device))
            if shared is not None:
                shared[side] = predictor
        return Sam3Text(predictor, {s: examples.Crops(sets[s]) for _, s in agent_graph.text_sets(node)})

    import torch
    from ultralytics import YOLOE
    from ultralytics.nn.text_model import MobileCLIPTS

    if agent_graph.text_half(params):
        _half_masks()
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


def _half_masks():
    """Заплатка ultralytics 8.4: у YOLOE-seg в fp16 протомаски float, а коэффициенты half —
    matmul в `process_mask` падает. Переименуют функцию — fp16-узел упадёт с понятным текстом."""
    from ultralytics.utils import ops

    original = getattr(ops, "process_mask", None)
    if original is None or getattr(original, "half_safe", False):
        return

    def process_mask(protos, masks_in, *args, **kwargs):
        return original(protos.float(), masks_in.float(), *args, **kwargs)

    process_mask.half_safe = True
    ops.process_mask = process_mask


def sam3_predictor_class():
    """Предиктор SAM 3: с настройкой «ужимать до карты» модель становится fp16 ещё на
    процессоре — иначе ultralytics везёт на карту fp32-копию (пик 3,24 ГБ вместо 1,64)."""
    from ultralytics.models.sam import SAM3SemanticPredictor

    if not settings.get_fresh(settings.SAM3_CPU_HALF):
        return SAM3SemanticPredictor

    class CpuHalf(SAM3SemanticPredictor):
        def get_model(self):
            return super().get_model().half()

    return CpuHalf


def text_key(node):
    """Чем отличаются загруженные модели узла: у YOLOE классы вшиты в веса,
    у SAM 3 — вырезки коллажа."""
    params = node.get("params") or {}
    model = agent_graph.text_model(params)
    sets = tuple(s for _, s in agent_graph.text_sets(node))
    if model == "sam3":
        return (model, agent_graph.sam3_side(params), *sets)
    return (model, agent_graph.text_half(params), *(p for _, p in agent_graph.text_prompts(node)), *sets)


def _own_versions(db, version_id):
    """Версии того же агента: перезапуск после правки заменяет и рамки прежних версий."""
    graph_id = db.execute(select(AugGraphVersion.graph_id).where(AugGraphVersion.id == version_id)).scalar()
    return select(AugGraphVersion.id).where(AugGraphVersion.graph_id == graph_id)


def _settle(db, model, rows, found, mapping):
    """Находки против того, что лежит на кадре: повторы рамок человека и
    проверенных отбрасываются; с непроверенными рамками других агентов — NMS,
    вытесненные удаляются."""
    known = [(a.class_id, agent_graph.geometry_box(a.ann_type, a.geometry)) for a in rows if not a.pending]
    others = [(a.id, a.class_id, agent_graph.geometry_box(a.ann_type, a.geometry),
               (a.attributes or {}).get("conf") or 0) for a in rows if a.pending]
    found = agent_graph.drop_known(found, [k for k in known if k[1]], mapping)
    found, gone = agent_graph.settle_agents(found, [o for o in others if o[2]], mapping)
    if gone:
        db.execute(model.__table__.delete().where(model.id.in_(gone)))
    return found


def _write(db, run, image, found, mapping):
    db.execute(
        Annotation.__table__.delete().where(
            Annotation.image_id == image.id, Annotation.pending.is_(True),
            Annotation.agent_version_id.in_(_own_versions(db, run.version_id)))
    )
    rows = db.execute(select(Annotation).where(Annotation.image_id == image.id)).scalars().all()
    found = _settle(db, Annotation, rows, found, mapping)
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
            geometry=geometry, area=area, source="model", pending=True,
            attributes=attributes,
            agent_version_id=run.version_id, created_by=run.created_by,
        ))
        put += 1
    # Открытый у человека редактор увидит 409, а не перезапишет рамки агента молча.
    image.annotations_rev += 1
    db.commit()
    return put


def _ticker(db, run, lease_id, device=None, base=0, info=None):
    """Шаг хода: +1 кадр, статистика, отмена кнопкой, пульс брони и живой связи.

    Заодно держит пик своей памяти сверх `base` — см. `common.gpu_peak`.
    `info` — что прогон занял (карта, память, режим), лежит рядом в `stats.res`."""
    last = [0.0]
    watch = gpu_peak.REGISTRY.watch(device, base)

    def measure():
        watch.measure()

    def check():
        # Поочерёдно модели грузятся минутами — отмена и пульс между блоками.
        db.refresh(run)
        if run.cancel_requested:
            raise Stopped()
        gpu.beat(db, lease_id)

    def tick(stats):
        measure()
        db.refresh(run)
        if run.cancel_requested:
            raise Stopped()
        run.processed += 1
        run.stats = {**stats, "res": info} if info else stats
        run.lease_until = utcnow()
        db.commit()
        now = time.monotonic()
        if now - last[0] >= NOTIFY_EVERY:
            gpu.beat(db, lease_id)
            live.notify(db, "agent", run.id, run.project_id, n=run.processed)
            last[0] = now

    # Запас 15 %: allocated не видит кэш распределителя.
    tick.peak = lambda: int(watch.top * 1.15) if watch.top > 0 else 0
    tick.measure = measure
    tick.close = watch.close
    tick.check = check
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


def _videos(db, run, mode, plan, work, mapping, tick):
    step = int(run.params.get("step") or agent_graph.VIDEO_STEP)
    gap_s = float(run.params.get("gap") if run.params.get("gap") is not None else agent_graph.SCOUT_GAP_S)
    version = db.get(AugGraphVersion, run.version_id)
    graph = db.get(AugGraph, version.graph_id) if version else None
    stats = {"videos": 0, "boxes": 0, "frames": 0}
    for video, wanted in plan:
        hits, seen = {}, {}

        def handle(frame_no, found, video=video, hits=hits, seen=seen):
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

        def on_frame(frame_no, _time_ms, picture, video=video, handle=handle):
            work.frame(frame_no, None, picture, f"{video.file_name} #{frame_no}", mode == "annotate", handle)

        try:
            if wanted:
                # Номера — по таблице кадров ролика, как у разметки и закрытия.
                video_frames.extract_frames(os.path.join(config.DATA_DIR, video.file_path), wanted,
                                            on_frame, pts=video_frames.unpack_pts(video.frame_index))
            # Поочерёдно хвост ролика ещё в пачке — досчитать до итогов ролика.
            work.flush()
            if mode == "annotate":
                # Ролик пройден целиком: прежние рамки этого агента вне плана больше не нужны.
                _lock_open(db, video)
                db.execute(_agent_rows(video, _own_versions(db, run.version_id))
                           .where(VideoAnnotation.frame_no.notin_(wanted or [-1])))
        except VideoClosed:
            log.warning("прогон %s: разметку ролика %s закрыли — дальше без него", run.id, video.id)
            stats["closed"] = stats.get("closed", 0) + 1
            continue
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
        run.stats = {**stats, "res": (run.stats or {}).get("res")}
        db.commit()


def _agent_rows(video, own):
    """Непроверенные рамки этого агента на ролике — то, что повторный прогон
    заменяет. `own` — его версии (`_own_versions`)."""
    return VideoAnnotation.__table__.delete().where(
        VideoAnnotation.video_id == video.id, VideoAnnotation.track_id.is_(None),
        VideoAnnotation.pending.is_(True), VideoAnnotation.agent_version_id.in_(own))


class VideoClosed(Exception):
    """Разметку ролика закрыли посреди прогона — писать в него больше нельзя."""


def _lock_open(db, video):
    """Замок на ролик; VideoClosed, если разметка закрыта, закрывается или ролика нет.

    Закрытие держит этот же замок до коммита. Ждать его до конца нельзя — это
    минуты, за них истечёт бронь карты; а дописать рамки мимо снятого плана —
    потерять их. Короткие правки строки (пометки, таги) укладываются в 5 с."""
    try:
        db.execute(text("SET LOCAL lock_timeout = '5s'"))
        row = db.execute(select(TaskVideo.annotation_closed_at)
                         .where(TaskVideo.id == video.id).with_for_update()).first()
    except OperationalError as exc:
        db.rollback()
        if getattr(exc.orig, "pgcode", None) == "55P03":  # lock_not_available — идёт закрытие
            raise VideoClosed() from exc
        raise
    if row is None or row[0] is not None:
        db.rollback()
        raise VideoClosed()


def _write_video(db, run, video, frame_no, found, mapping):
    # Замена по кадру в одной транзакции: остановка на середине не теряет прежние рамки.
    _lock_open(db, video)
    db.execute(_agent_rows(video, _own_versions(db, run.version_id)).where(VideoAnnotation.frame_no == frame_no))
    rows = db.execute(select(VideoAnnotation).where(
        VideoAnnotation.video_id == video.id, VideoAnnotation.track_id.is_(None),
        VideoAnnotation.frame_no == frame_no)).scalars().all()
    found = _settle(db, VideoAnnotation, rows, found, mapping)
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
        attributes = {"conf": round(float(det["conf"]), 3)}
        if "sam" in det:
            attributes["sam"] = det["sam"]
        db.add(VideoAnnotation(
            video_id=video.id, track_id=None, frame_no=frame_no, class_id=_uuid(class_id),
            ann_type=ann_type, geometry=geometry, source="model", pending=True,
            attributes=attributes,
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
    model = build_sam2(cfg, sam_weights(name), device=str(device))
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
        return int(torch.cuda.memory_allocated(device) / (1 << 20))
    except Exception:
        return 0


def _free():
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
