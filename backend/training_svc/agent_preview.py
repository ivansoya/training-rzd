"""Превью агента — нить `training-worker`: один кадр через черновик графа.

Решения владельца (24.09.2026): считать на карте с тёплыми моделями, живой
пересчёт; бронь отпускается после трёх минут тишины. С 09.10.2026 процессора
нет: карта занята — запрос отвечает «ждёт карту» с причиной, а бронь стоит в
очереди до следующего запроса; не влезет никогда — ошибка с вердиктом.

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

from common import agent_graph, agent_memory, config, gpu, settings, video_frames
from common.db import SessionLocal, engine
from common.models import AgentPreview, AgentWeights, GpuLease, Image, TaskVideo
from training_svc import agent_runner

log = logging.getLogger("training.preview")

CHANNEL = "agent_preview"
IDLE_RELEASE = 180
# Ждущая бронь превью без новых запросов снимается: человек ушёл из редактора.
WAIT_DROP = 60


class Waiting(Exception):
    """Карту превью пока не дали — текст причины для человека."""


class _Warm:
    """Тёплые модели и бронь карт под них: одна карта под весь агент или блоки
    по картам, как у прогона (решения 10.10.2026). Модель помнит свою карту в
    ключе: ultralytics садит модель на карту при первом вызове и больше не переносит."""

    def __init__(self):
        self.lease_id = None
        self.indices = []  # номера карт брони по частям
        self.keys = None   # ключи блоков по частям, если агент поделён
        self.parts = []    # сколько забронировано по частям
        self.nets = {}     # (id весов, карта) -> YOLO
        self.sams = {}     # (имя SAM, карта) -> предиктор
        self.texts = {}    # (agent_runner.text_key, карта) -> YOLOE с промтами или SAM 3
        self.sam3 = {}     # (вход, карта) -> общий предиктор SAM 3 узлов
        self.last = 0.0
        self.queued = None  # бронь, стоящая в очереди: следующий запрос ждёт её, а не новую

    def drop(self, db):
        if self.lease_id:
            gpu.release(db, self.lease_id)
        self.lease_id, self.indices, self.keys, self.parts = None, [], None, []
        self.nets, self.sams, self.texts, self.sam3 = {}, {}, {}, {}
        agent_runner._free()

    def unqueue(self, db):
        if self.queued:
            gpu.cancel(db, self.queued, "Превью больше не ждут")
            self.queued = None

    def ensure(self, db, verdict, units):
        """Карты под превью по вердикту или `Waiting` с причиной — процессора нет."""
        split = verdict["state"] == agent_memory.SPLIT
        parts = list(verdict["parts"]) if split else [verdict["want_mb"]]
        keys = [u["key"] for u in units] if split else None
        if self.lease_id and keys == self.keys and len(parts) == len(self.parts) \
                and all(have >= need for have, need in zip(self.parts, parts)):
            gpu.beat(db, self.lease_id)
            return
        if self.lease_id:
            # Граф стал прожорливее брони (SAM 3 с новыми промтами) или блоки другие — перебронируем.
            self.drop(db)
        lease = db.get(GpuLease, self.queued) if self.queued else None
        same = lease is not None and [p.want_mb for p in gpu.group_of(db, lease)] == parts
        if same and lease.status in gpu.ACTIVE:
            # Ждущую отмечаем и пробуем; выданную накачкой берём — раньше её отменяли,
            # и запрос вставал в хвост очереди заново.
            gpu.beat(db, lease.id)
            gpu.try_grant(db, lease.id)
            db.refresh(lease)
        else:
            self.unqueue(db)
            if split:
                lease = gpu.request_group(db, holder="training", kind="agent-preview", parts=parts, spread=False,
                                          labels=[u["label"] for u in units], priority=20, title="Превью агента")
            else:
                lease = gpu.request(db, holder="training", kind="agent-preview", want_mb=parts[0],
                                    priority=20, allow_cpu=False, title="Превью агента")
        if lease.status == "denied":
            raise agent_graph.AgentGraphError(lease.reason or "Видеокарту не дали.")
        if lease.status != "held":
            self.queued = lease.id
            raise Waiting(lease.reason or "карта занята")
        self.queued = None
        self.lease_id, self.parts, self.keys = lease.id, parts, keys
        self.indices = gpu.group_indices(db, lease)

    def unit_devices(self, units):
        """{ключ блока: карта}: поделённый агент — по частям брони, иначе всё на одной."""
        at = {key: i for i, key in enumerate(self.keys or [])}
        return {u["key"]: agent_runner._device(self.indices[at.get(u["key"], 0)]) for u in units}

    def models(self, doc, weights, sets, on):
        """Модели узлов на их картах; `on` — {узел: карта}."""
        out = {}
        # Каждая правка промта — новая YOLOE; держим только те, что в графе
        # сейчас, иначе за вечер правок карта забилась бы старыми.
        keys = {(agent_runner.text_key(n), on[n["id"]]): n for n in doc["nodes"] if n["type"] == "text"}
        self.texts = {k: m for k, m in self.texts.items() if k in keys}
        sides = {(agent_graph.sam3_side(n.get("params")), dev) for (_k, dev), n in keys.items()
                 if agent_graph.text_model(n.get("params")) == "sam3"}
        self.sam3 = {k: p for k, p in self.sam3.items() if k in sides}
        for key, node in keys.items():
            if key not in self.texts:
                dev = key[1]
                shared = {side: p for (side, d), p in self.sam3.items() if d == dev}
                self.texts[key] = agent_runner.load_text(node, dev, sets, shared)
                self.sam3.update({(side, dev): p for side, p in shared.items()})
        for node in doc["nodes"]:
            nid = node["id"]
            if node["type"] == "text":
                out[nid] = self.texts[(agent_runner.text_key(node), on[nid])]
            elif node["type"] == "net":
                key = (weights[nid].id, on[nid])
                if key not in self.nets:
                    from ultralytics import YOLO
                    self.nets[key] = YOLO(os.path.join(config.DATA_DIR, weights[nid].file_path))
                out[nid] = self.nets[key]
            elif node["type"] == "sam":
                name = (node.get("params") or {}).get("model") or agent_graph.SAM_DEFAULTS["model"]
                key = (name, on[nid])
                if key not in self.sams:
                    self.sams[key] = agent_runner._load_sam(name, on[nid])
                out[name] = self.sams[key]
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


class _NoTick:
    """Ход превью: отмены нет, пульс брони — сама нить превью."""

    def check(self):
        pass

    def measure(self):
        pass


def _answer(db, warm, row):
    from training_svc import examples

    doc = agent_graph.prepare(row.doc)
    # Веса и образцы — с полки владельца агента: подключённого к проекту агента
    # смотрит и запускает не только он. Веб кладёт владельца в запрос.
    owner = agent_runner._uuid(doc.get("owner")) or row.user_id
    sets = examples.rows_for(db, owner, doc)
    order = agent_graph.check(doc, sam3=config.sam3_ready(),
                              examples={k: r.status == "ready" for k, r in sets.items()})
    weights = {}
    for node in doc["nodes"]:
        if node["type"] == "net":
            got = db.get(AgentWeights, agent_runner._uuid(node["params"].get("weights")))
            if got is None or got.owner_id != owner:
                raise agent_graph.AgentGraphError(f"{agent_graph.title(node)}: весов нет на полке.")
            weights[node["id"]] = got
    cards = gpu.cards(db)
    mem = agent_memory.plan(doc, max((c["cap_mb"] for c in cards), default=0) or None,
                            nets=agent_memory.net_info(weights), sam3_cpu_half=settings.get(db, settings.SAM3_CPU_HALF))
    verdict = agent_memory.verdict(mem["total_mb"], mem["heaviest"], cards, mem["units"])
    if verdict["state"] == agent_memory.NEVER:
        raise agent_graph.AgentGraphError(verdict["reason"])
    agent_memory.fix_words(doc, mem["words"])
    sequential = verdict["state"] == agent_memory.SEQUENTIAL
    warm.ensure(db, verdict, mem["units"])
    devices = warm.unit_devices(mem["units"])
    on = {nid: devices[u["key"]] for u in mem["units"] for nid in u["nodes"]}
    agent_runner._device(warm.indices[0])  # текущая карта нити — первая из брони
    started = time.monotonic()
    if sequential:
        # Целиком не влезает — тёплых моделей нет: блоки грузятся по очереди на каждый ответ.
        warm.nets, warm.sams, warm.texts, warm.sam3 = {}, {}, {}, {}
        agent_runner._free()
        models = None
    else:
        # SAM 3 грузится десятки секунд — бронь продлевает своя нить, иначе истекла бы под загрузкой.
        with agent_runner._beating(warm.lease_id):
            models = warm.models(doc, weights, sets, on)

    def frames_out(items):
        """[(путь, картинка, имя)] → [(находки, трасса)] — целиком или поочерёдно."""
        got = [None] * len(items)
        if models is not None:
            for i, (path, picture, name) in enumerate(items):
                predict, segment = agent_runner.frame_fns(path, name, models, weights, on, picture=picture)
                trace = {}
                got[i] = (agent_graph.run(doc, predict, order, segment, trace), trace)
            return got
        work = agent_runner._Work(doc, order, mem["units"], weights, sets, devices, warm.lease_id, True, _NoTick())
        for i, (path, picture, name) in enumerate(items):
            trace = {}
            work.frame(i, path, picture, name, True,
                       lambda key, found, trace=trace: got.__setitem__(key, (found, trace)), trace)
        work.flush()
        return got

    def trace_of(image):
        return frames_out([(os.path.join(config.DATA_DIR, image.file_path), None, image.file_name)])[0][1]

    out = {"device": "cuda", "sequential": sequential, "verdict": verdict}
    apply = doc.get("apply")
    if apply:
        # Агент из редактора на одном кадре: нужен только «Выход», пишет веб.
        if apply.get("video"):
            video = db.get(TaskVideo, agent_runner._uuid(apply["video"]))
            if video is None:
                raise agent_graph.AgentGraphError("Ролик не найден.")
            got = []
            video_frames.extract_frames(os.path.join(config.DATA_DIR, video.file_path), [int(apply["frame"])],
                                        lambda _n, _t, pic: got.append(pic),
                                        pts=video_frames.unpack_pts(video.frame_index))
            if not got:
                raise agent_graph.AgentGraphError("Кадр ролика не достался декодеру.")
            item = (None, got[0], f"{video.file_name} #{apply['frame']}")
        else:
            image = db.get(Image, row.image_id)
            item = (os.path.join(config.DATA_DIR, image.file_path), None, image.file_name)
        found = frames_out([item])[0][0]
        return {**out, "found": found, "ms": round((time.monotonic() - started) * 1000)}
    batch = doc.get("batch")
    if batch:
        # Несколько кадров разом: модели те же, отдаём только «Выход» каждого.
        exit_id = next(n["id"] for n in doc["nodes"] if n["type"] == "output")
        images = [im for im in (db.get(Image, agent_runner._uuid(i)) for i in batch) if im is not None]
        got = frames_out([(os.path.join(config.DATA_DIR, im.file_path), None, im.file_name) for im in images])
        frames = [{"id": str(im.id), "out": trace[exit_id]["out"]} for im, (_found, trace) in zip(images, got)]
        return {**out, "frames": frames, "ms": round((time.monotonic() - started) * 1000)}
    # Вход и выход каждого узла целиком — обнаружений десятки, а смена
    # выбранного узла в редакторе тогда ничего не пересчитывает.
    trace = trace_of(db.get(Image, row.image_id))
    return {**out, "nodes": trace, "ms": round((time.monotonic() - started) * 1000)}


def _trim(warm):
    """После ответа кэш распределителя сверх брони отдаём: превью SAM 3 на 80
    промтов оставляло занятыми 15 ГБ из 16 при брони в 3."""
    if not warm.indices:
        return
    try:
        import torch
        reserved = sum(torch.cuda.memory_reserved(i) for i in set(warm.indices)) / (1 << 20)
        if reserved > sum(warm.parts):
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
                except Waiting as exc:
                    # Не процессор: человек видит причину, бронь ждёт в очереди следующего запроса.
                    row.status, row.error = "waiting_gpu", f"Ждёт карту: {exc}"
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
            if warm.queued and time.monotonic() - warm.last > WAIT_DROP:
                warm.unqueue(db)
        except Exception:
            log.exception("нить превью агента")
            db.rollback()
        finally:
            db.close()
