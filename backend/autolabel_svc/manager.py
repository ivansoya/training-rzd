"""Пул воркеров и реестр сессий.

Сессия — это пользователь плюс модель. Модель грузится один раз на процесс, а
процесс обслуживает несколько сессий: веса SAM2 весят от 0,15 до 2,4 ГБ, и
процесс на каждого разметчика не пережил бы и пяти человек. Когда сессий на
процессе становится больше порога, поднимается следующий процесс.

Состояния диалога здесь нет: клиент присылает весь набор точек на каждый
запрос. Поэтому падение воркера или переезд сессии на другой процесс не теряют
начатое выделение — теряется только кэш эмбеддинга, который пересчитается.
"""
import multiprocessing as mp
import os
import threading
import time
import uuid

from autolabel_svc.worker import worker_main

# Порог держим настройкой, а не константой: вынос воркеров в отдельные
# контейнеры запланирован, и к тому моменту число не должно быть вшито в код.
USERS_PER_WORKER = int(os.environ.get("AUTOLABEL_USERS_PER_WORKER", "5"))
SESSION_TTL = int(os.environ.get("AUTOLABEL_SESSION_TTL", "600"))
REQUEST_TIMEOUT = int(os.environ.get("AUTOLABEL_TIMEOUT", "180"))
SWEEP_EVERY = 30


class WorkerError(RuntimeError):
    pass


class Worker:
    """Один процесс с загруженной моделью."""

    def __init__(self, model: str, params: dict):
        self.model = model
        self.params = params
        self.id = uuid.uuid4().hex[:8]
        self.sessions: set[str] = set()
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
                req_id, reply = self._results.get()
            except (EOFError, OSError):
                return
            with self._lock:
                slot = self._slots.get(req_id)
                if slot is None:
                    continue
                slot["reply"] = reply
                slot["event"].set()

    def call(self, op: str, payload: dict, timeout: int = REQUEST_TIMEOUT) -> dict:
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
            raise WorkerError(reply.get("error") or "Ошибка модели.")
        return reply["data"]

    def stop(self):
        try:
            self._requests.put(None)
        except Exception:  # noqa: BLE001
            pass
        self._proc.join(timeout=10)
        if self._proc.is_alive():
            self._proc.terminate()


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
            if w.model != model or w.params != params:
                continue
            if len(w.sessions) < USERS_PER_WORKER:
                return w
        worker = Worker(model, params)
        self._workers.append(worker)
        return worker

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
        if not worker.sessions:
            self._workers.remove(worker)
            threading.Thread(target=worker.stop, daemon=True).start()

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
                     "alive": w._proc.is_alive()}
                    for w in self._workers
                ],
                "sessions": len(self._sessions),
                "users_per_worker": USERS_PER_WORKER,
                "session_ttl": SESSION_TTL,
            }


manager = Manager()
