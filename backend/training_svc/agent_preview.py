"""Превью агента — нить `training-worker`: один кадр через черновик графа.

Решения владельца (24.09.2026): считать на карте с тёплыми моделями, живой
пересчёт; бронь отпускается после трёх минут тишины; нет места на карте —
считаем на процессоре и говорим об этом, а не ждём часами.

Запрос — строка `agent_previews`: веб кладёт и шлёт NOTIFY, нить просыпается,
берёт самый свежий запрос человека, а более старые помечает `superseded` —
пока считали прежний, человек уже поправил граф. Ответ пишется в ту же строку,
веб его ждёт.

Считается тем же `agent_runner.frame_fns`, что и прогон: превью показывает
ровно то, что ляжет в разметку.
"""
import logging
import os
import select as selectlib
import time

from sqlalchemy import select, update

from common import agent_graph, config, gpu
from common.db import SessionLocal, engine
from common.models import AgentPreview, AgentWeights, Image
from training_svc import agent_runner

log = logging.getLogger("training.preview")

CHANNEL = "agent_preview"
IDLE_RELEASE = 180
# Бронь превью — сеть или две плюс SAM2 small; по замеру диспетчер поправит.
# SAM 3 в «Сети по тексту» сюда не влезает — на тесной карте превью с ним
# уйдёт на процессор.
# ponytail: одна прикидка на любой граф; больше сетей — считать по графу.
VRAM_MB = 3000


class _Warm:
    """Тёплые модели и бронь карты под них."""

    def __init__(self):
        self.lease_id = None
        self.device = None
        self.nets = {}     # id весов -> YOLO
        self.sams = {}     # имя SAM -> предиктор
        self.texts = {}    # agent_runner.text_key -> YOLOE с промтами или SAM 3
        self.last = 0.0
        self.note = None   # почему на процессоре
        self.want = 0      # сколько забронировано

    def drop(self, db):
        if self.lease_id:
            gpu.release(db, self.lease_id)
        self.lease_id, self.device, self.nets, self.sams, self.texts, self.note = None, None, {}, {}, {}, None
        agent_runner._free()

    def ensure_device(self, db, want=VRAM_MB):
        """Карта, если дают; иначе процессор и причина словами."""
        if self.lease_id and self.want >= want:
            gpu.beat(db, self.lease_id)
            return
        if self.lease_id:
            # Граф стал прожорливее брони (SAM 3 с новыми промтами) — перебронируем.
            self.drop(db)
        lease = gpu.request(db, holder="training", kind="agent-preview", want_mb=want,
                            priority=20, allow_cpu=True, title="Превью агента")
        self.want = want
        if lease.status == "held":
            self.lease_id = lease.id
            device, note = ("cpu" if lease.device_id is None else 0), None
        else:
            gpu.cancel(db, lease.id, "Превью считает на процессоре")
            device, note = "cpu", lease.reason or "карта занята"
        if device != self.device:
            self.nets, self.sams, self.texts = {}, {}, {}
        self.device, self.note = device, note

    def models(self, doc, weights, sets):
        out = {}
        # Каждая правка промта — новая YOLOE; держим только те, что в графе
        # сейчас, иначе за вечер правок карта забилась бы старыми.
        keys = {agent_runner.text_key(n): n for n in doc["nodes"] if n["type"] == "text"}
        self.texts = {k: m for k, m in self.texts.items() if k in keys}
        for key, node in keys.items():
            if key not in self.texts:
                self.texts[key] = agent_runner.load_text(node, self.device, sets)
        for node in doc["nodes"]:
            if node["type"] == "text":
                out[node["id"]] = self.texts[agent_runner.text_key(node)]
            elif node["type"] == "net":
                row = weights[node["id"]]
                if row.id not in self.nets:
                    from ultralytics import YOLO
                    self.nets[row.id] = YOLO(os.path.join(config.DATA_DIR, row.file_path))
                out[node["id"]] = self.nets[row.id]
            elif node["type"] == "sam":
                name = (node.get("params") or {}).get("model") or agent_graph.SAM_DEFAULTS["model"]
                if name not in self.sams:
                    self.sams[name] = agent_runner._load_sam(name, self.device)
                out[name] = self.sams[name]
        return out


def _take(db):
    """Самый свежий запрос; старые запросы того же человека — устарели."""
    row = db.execute(
        select(AgentPreview).where(AgentPreview.status == "queued")
        .order_by(AgentPreview.created_at.desc()).limit(1).with_for_update(skip_locked=True)
    ).scalar_one_or_none()
    if row is not None:
        db.execute(update(AgentPreview).where(
            AgentPreview.user_id == row.user_id, AgentPreview.status == "queued",
            AgentPreview.id != row.id).values(status="superseded"))
        db.commit()
    return row


def _answer(db, warm, row):
    from training_svc import examples

    doc = row.doc
    sets = examples.rows_for(db, row.user_id, doc)
    order = agent_graph.check(doc, sam3=config.sam3_ready(),
                              examples={k: r.status == "ready" for k, r in sets.items()})
    weights = {}
    for node in doc["nodes"]:
        if node["type"] == "net":
            got = db.get(AgentWeights, agent_runner._uuid(node["params"].get("weights")))
            if got is None or got.owner_id != row.user_id:
                raise agent_graph.AgentGraphError(f"{agent_graph.title(node)}: весов нет на полке.")
            weights[node["id"]] = got
    sam3 = [n for n in doc["nodes"] if n["type"] == "text"
            and agent_graph.text_model(n.get("params")) == "sam3"]
    warm.ensure_device(db, VRAM_MB + sum(agent_graph.text_vram_mb(n) for n in sam3))
    started = time.monotonic()
    models = warm.models(doc, weights, sets)

    def trace_of(image):
        predict, segment = agent_runner.frame_fns(
            os.path.join(config.DATA_DIR, image.file_path), image.file_name, models, weights, warm.device)
        trace = {}
        agent_graph.run(doc, predict, order, segment, trace)
        return trace

    out = {"device": "cpu" if warm.device == "cpu" else "cuda", "note": warm.note}
    batch = doc.get("batch")
    if batch:
        # Несколько кадров разом: модели те же, отдаём только «Выход» каждого.
        exit_id = next(n["id"] for n in doc["nodes"] if n["type"] == "output")
        frames = []
        for image_id in batch:
            image = db.get(Image, agent_runner._uuid(image_id))
            if image is not None:
                frames.append({"id": str(image.id), "out": trace_of(image)[exit_id]["out"]})
        return {**out, "frames": frames, "ms": round((time.monotonic() - started) * 1000)}
    # Вход и выход каждого узла целиком — обнаружений десятки, а смена
    # выбранного узла в редакторе тогда ничего не пересчитывает.
    trace = trace_of(db.get(Image, row.image_id))
    return {**out, "nodes": trace, "ms": round((time.monotonic() - started) * 1000)}


def _trim(warm):
    """После ответа кэш распределителя сверх брони отдаём: превью SAM 3 на 80
    промтов оставляло занятыми 15 ГБ из 16 при брони в 3."""
    if warm.device in (None, "cpu"):
        return
    try:
        import torch
        if torch.cuda.memory_reserved() / (1 << 20) > warm.want:
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def loop(stop):
    """Нить воркера. `stop` — общее событие остановки."""
    warm = _Warm()
    conn = engine.raw_connection()
    conn.set_isolation_level(0)   # LISTEN вне транзакции
    conn.cursor().execute(f"LISTEN {CHANNEL}")
    while not stop.is_set():
        selectlib.select([conn], [], [], 5)
        conn.poll()
        conn.notifies.clear()
        db = SessionLocal()
        try:
            while (row := _take(db)) is not None:
                try:
                    row.result = _answer(db, warm, row)
                    row.status = "done"
                except agent_graph.AgentGraphError as exc:
                    row.status, row.error = "error", str(exc)
                except Exception as exc:  # noqa: BLE001 — человеку нужен текст
                    log.exception("превью агента не удалось")
                    db.rollback()
                    row = db.get(AgentPreview, row.id)
                    row.status, row.error = "error", str(exc)[:500]
                db.commit()
                warm.last = time.monotonic()
                _trim(warm)
            if warm.lease_id and time.monotonic() - warm.last > IDLE_RELEASE:
                warm.drop(db)
            elif warm.lease_id:
                gpu.beat(db, warm.lease_id)
        except Exception:
            log.exception("нить превью агента")
            db.rollback()
        finally:
            db.close()
