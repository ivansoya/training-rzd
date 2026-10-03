"""Пул воркеров и реестр сессий.

Сессия — это пользователь плюс модель. Модель грузится один раз на процесс, а
процесс обслуживает несколько сессий: веса SAM2 весят от 0,15 до 2,4 ГБ, и
процесс на каждого разметчика не пережил бы и пяти человек. Когда сессий на
процессе становится больше порога, поднимается следующий процесс.

Состояния диалога здесь нет: клиент присылает весь набор точек на каждый
запрос. Поэтому падение воркера или переезд сессии на другой процесс не теряют
начатое выделение — теряется только кэш эмбеддинга, который пересчитается.
"""
import logging
import multiprocessing as mp
import os
import threading
import time
import uuid

from autolabel_svc.worker import READY, worker_main

# Порог держим настройкой, а не константой: вынос воркеров в отдельные
# контейнеры запланирован, и к тому моменту число не должно быть вшито в код.
USERS_PER_WORKER = int(os.environ.get("AUTOLABEL_USERS_PER_WORKER", "5"))
# Потолок процессов с моделью: каждый держит 0,6–1,1 ГБ видеопамяти.
MAX_WORKERS = int(os.environ.get("AUTOLABEL_MAX_WORKERS", "3"))
SESSION_TTL = int(os.environ.get("AUTOLABEL_SESSION_TTL", "600"))
REQUEST_TIMEOUT = int(os.environ.get("AUTOLABEL_TIMEOUT", "180"))
SWEEP_EVERY = 30
# Сколько памяти держит прогретый воркер, если замер меньше: CUDA-контекст и
# кэш кадров в memory_reserved не видны (замер: пустой 0,6 ГБ, прогретый 1,1).
WORKER_MB = int(os.environ.get("AUTOLABEL_WORKER_MB", "1200"))
CONTEXT_MB = 500


log = logging.getLogger(__name__)


class WorkerError(RuntimeError):
    def __init__(self, message, code="worker"):
        super().__init__(message)
        self.code = code


class Worker:
    """Один процесс с загруженной моделью."""

    def __init__(self, model: str, params: dict, on_ready=None):
        self.model = model
        self.params = params
        self.id = uuid.uuid4().hex[:8]
        self.sessions: set[str] = set()
        # starting → ready | failed. Упавший на загрузке сессий не получает.
        self.state = "starting"
        self.gpu: dict = {}
        self.on_ready = on_ready
        # spawn, а не fork: CUDA-контекст не переживает fork.
        ctx = mp.get_context("spawn")
        self._requests = ctx.Queue()
        self._results = ctx.Queue()
        self._proc = ctx.Process(
            target=worker_main,
            args=(model, params, self._requests, self._results),
            daemon=True,
        )
        self._proc.start()
        # Ответы приходят вперемешку от разных потоков gunicorn — разбираем их
        # по req_id в один читающий поток, каждый ждущий будит своё событие.
        self._slots: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()

    def _pump(self):
        while True:
            try:
                item = self._results.get()
            except (EOFError, OSError, ValueError):
                return
            if item is None:  # stop() просит закончить
                return
            req_id, reply = item
            if req_id == READY:
                self.state = "ready" if reply.get("ok") else "failed"
                self.gpu = {k: reply.get(k) for k in ("uuid", "reserved_mb")}
                if not reply.get("ok"):
                    log.error("Воркер %s не поднял модель: %s %s", self.id,
                              reply.get("error"), reply.get("trace") or "")
                if self.on_ready:
                    self.on_ready(self)
                continue
            with self._lock:
                slot = self._slots.get(req_id)
                if slot is None:
                    continue
                slot["reply"] = reply
                slot["event"].set()

    def mem_mb(self) -> int:
        measured = self.gpu.get("reserved_mb") or 0
        return max(WORKER_MB, measured + CONTEXT_MB)

    def call(self, op: str, payload: dict, timeout: int = REQUEST_TIMEOUT) -> dict:
        if self.state == "failed":
            raise WorkerError("Модель не загрузилась. Подробности — в журнале сервиса.",
                              code="model_failed")
        if not self._proc.is_alive():
            raise WorkerError("Воркер разметки не запущен.")
        req_id = uuid.uuid4().hex
        event = threading.Event()
        with self._lock:
            self._slots[req_id] = {"event": event, "reply": None}
        self._requests.put((req_id, op, payload))
        got = event.wait(timeout)
        with self._lock:
            slot = self._slots.pop(req_id, None)
        if not got or slot is None or slot["reply"] is None:
            raise WorkerError("Модель не ответила вовремя.")
        reply = slot["reply"]
        if not reply.get("ok"):
            # Текст исключения и трасса — в журнал, человеку — фраза без путей и Python.
            log.error("Воркер %s: %s %s", op, reply.get("error"), reply.get("trace") or "")
            if "trace" not in reply:
                raise WorkerError("Модель не загрузилась. Подробности — в журнале сервиса.",
                                  code="model_failed")
            raise WorkerError("Модель не смогла обработать кадр.")
        return reply["data"]

    def stop(self):
        try:
            self._requests.put(None)
        except Exception:  # noqa: BLE001
            pass
        self._proc.join(timeout=10)
        if self._proc.is_alive():
            self._proc.terminate()
            self._proc.join(timeout=5)
        # Без этого каждый цикл «поднять/погасить» оставлял поток чтения,
        # фоновые потоки очередей и шесть дескрипторов.
        try:
            self._results.put(None)
        except Exception:  # noqa: BLE001
            pass
        self._reader.join(timeout=5)
        for q in (self._requests, self._results):
            try:
                q.close()
                q.join_thread()
            except Exception:  # noqa: BLE001
                pass


class Session:
    def __init__(self, user_id: str, model: str, params: dict, worker: Worker):
        self.id = uuid.uuid4().hex
        self.user_id = user_id
        self.model = model
        self.params = params
        self.worker = worker
        self.touched = time.time()


class Manager:
    def __init__(self):
        self._lock = threading.Lock()
        self._workers: list[Worker] = []
        self._sessions: dict[str, Session] = {}
        threading.Thread(target=self._sweep_loop, daemon=True).start()

    # -- размещение ------------------------------------------------------- #
    def _place(self, model: str, params: dict) -> Worker:
        """Свободный воркер под эту модель или новый, если все полны."""
        for w in self._workers:
            if w.model != model or w.params != params or w.state == "failed":
                continue
            if len(w.sessions) < USERS_PER_WORKER:
                return w
        if len(self._workers) >= MAX_WORKERS:
            raise WorkerError("Полуавтомат занят: все места заняты. Попробуйте через пару минут.")
        worker = Worker(model, params, on_ready=self._worker_ready)
        self._workers.append(worker)
        return worker

    def _worker_ready(self, worker: Worker):
        if worker.state == "failed":
            # Сломанный воркер гасим сразу: его сессии получат 503 model_failed,
            # а следующая попытка поднимет новый процесс.
            with self._lock:
                for sid in list(worker.sessions):
                    s = self._sessions.get(sid)
                    if s is not None:
                        self._forget(s)
                if worker in self._workers:
                    self._workers.remove(worker)
                    threading.Thread(target=worker.stop, daemon=True).start()
        self._note_memory(worker.gpu.get("uuid"))

    def _note_memory(self, device_uuid=None):
        """Сколько видеопамяти держат живые воркеры — диспетчер GPU не раздаст её задачам."""
        with self._lock:
            live = [w for w in self._workers if w.state != "failed"]
            mb = sum(w.mem_mb() for w in live)
            device_uuid = device_uuid or next((w.gpu.get("uuid") for w in live if w.gpu), None)
        try:
            from common import gpu
            from common.db import SessionLocal

            with SessionLocal() as db:
                gpu.note_sam2(db, device_uuid, mb)
        except Exception:  # noqa: BLE001
            log.exception("не удалось записать память полуавтомата")

    def open(self, user_id: str, model: str, params: dict) -> Session:
        with self._lock:
            # Один пользователь — одна сессия на модель: повторный вход в
            # редактор не должен плодить копии.
            for s in self._sessions.values():
                if s.user_id == user_id and s.model == model and s.params == params:
                    s.touched = time.time()
                    return s
            worker = self._place(model, params)
            session = Session(user_id, model, params, worker)
            worker.sessions.add(session.id)
            self._sessions[session.id] = session
            return session

    def get(self, session_id: str, user_id: str) -> Session | None:
        with self._lock:
            s = self._sessions.get(session_id)
            if s is None or s.user_id != user_id:
                return None
            s.touched = time.time()
            return s

    def close(self, session_id: str, user_id: str) -> bool:
        with self._lock:
            s = self._sessions.get(session_id)
            if s is None or s.user_id != user_id:
                return False
            self._forget(s)
            return True

    def _forget(self, session: Session):
        """Снять сессию; опустевший воркер гасим — он держит веса."""
        self._sessions.pop(session.id, None)
        worker = session.worker
        worker.sessions.discard(session.id)
        if not worker.sessions and worker in self._workers:
            self._workers.remove(worker)
            threading.Thread(target=worker.stop, daemon=True).start()
            threading.Thread(target=self._note_memory, args=(worker.gpu.get("uuid"),),
                             daemon=True).start()

    # -- уборка ----------------------------------------------------------- #
    def _sweep_loop(self):
        while True:
            time.sleep(SWEEP_EVERY)
            try:
                self.sweep()
            except Exception:  # noqa: BLE001
                pass

    def sweep(self):
        """Закрытая вкладка не пришлёт «стоп» — снимаем по молчанию."""
        deadline = time.time() - SESSION_TTL
        with self._lock:
            for s in [x for x in self._sessions.values() if x.touched < deadline]:
                self._forget(s)

    def stats(self) -> dict:
        with self._lock:
            return {
                "workers": [
                    {"id": w.model + ":" + w.id, "sessions": len(w.sessions),
                     "alive": w._proc.is_alive(), "state": w.state, "mem_mb": w.mem_mb()}
                    for w in self._workers
                ],
                "sessions": len(self._sessions),
                "users_per_worker": USERS_PER_WORKER,
                "max_workers": MAX_WORKERS,
                "session_ttl": SESSION_TTL,
            }


manager = Manager()
