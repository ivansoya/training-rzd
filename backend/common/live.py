"""Живая связь: одно соединение на вкладку, и поток внутри спит.

Раньше экран обучения держал SSE на каждый ран, а поток внутри читал файл
состояния дважды в секунду. Сто вкладок — двести чтений в секунду на пустом
месте и сто занятых потоков из тридцати двух, какие были.

Теперь иначе, и разница не в числе потоков, а в том, что поток делает.

**Поток спит на ``LISTEN``.** Соединение к базе одно на процесс, а не одно на
подписчика: слушатель разбирает уведомления и раскладывает их по очередям.
В покое запросов к базе ноль.

**Уведомление говорит, ЧТО изменилось, а не что стало.** У ``NOTIFY`` предел
восемь тысяч байт, и переполнение — это ошибка транзакции, то есть упавшая
запись метрики, а не потерянное уведомление. Поэтому полезная нагрузка
крошечная, а подписчик дочитывает нужную строку сам.

**Медленный подписчик никого не задерживает.** Раскладка идёт через
``put_nowait`` в очередь с потолком: захлебнулся — теряет свои события и
получает пометку «пересчитай всё», а не тормозит соседей. Пул рассылки для
этого не нужен вовсе.
"""
import json
import os
import select
import threading
from queue import Empty, Full, Queue

CHANNEL = "mag_events"
# Потолок полезной нагрузки. Держим с большим запасом от предела PostgreSQL:
# уведомление обязано остаться указателем, а не состоянием.
MAX_PAYLOAD = 200
# Сколько событий копится у отставшего подписчика, прежде чем мы признаем, что
# он безнадёжно отстал.
QUEUE_DEPTH = 64
# Как часто молчащий поток шлёт двоеточие. Без этого прокси и браузер рвут
# соединение, на котором ничего не происходит.
# Раз в десять секунд, а не в двадцать: прокси vite на стенде рвал молчащий
# ответ на пятнадцатой секунде, и живая связь в деве переподключалась каждые
# семнадцать. Десять секунд — ниже любого ходового простоя прокси.
PING_EVERY = float(os.environ.get("LIVE_PING", "10"))


def dsn() -> str:
    """DSN для psycopg2 из того же адреса, что у SQLAlchemy."""
    url = os.environ.get(
        "DATABASE_URL", "postgresql+psycopg2://app:app@db:5432/app"
    )
    return url.replace("postgresql+psycopg2://", "postgresql://")


# --------------------------------------------------------------------------- #
# Отправка
# --------------------------------------------------------------------------- #
def payload(kind, obj_id, project_id=None, **extra) -> str:
    body = {"k": kind, "id": str(obj_id)}
    if project_id is not None:
        body["p"] = str(project_id)
    body.update(extra)
    text = json.dumps(body, separators=(",", ":"))
    if len(text) > MAX_PAYLOAD:
        # Лучше уронить здесь и сейчас, чем в проде посреди записи метрики:
        # переполнение NOTIFY откатывает транзакцию целиком.
        raise ValueError(
            f"Уведомление длиннее {MAX_PAYLOAD} байт: {len(text)}. "
            "Оно должно говорить, что изменилось, а не что стало."
        )
    return text


def notify(db, kind, obj_id, project_id=None, **extra) -> None:
    """Сказать всем процессам, что вот эта строка изменилась."""
    from sqlalchemy import text as sql_text

    db.execute(
        sql_text("SELECT pg_notify(:ch, :body)"),
        {"ch": CHANNEL, "body": payload(kind, obj_id, project_id, **extra)},
    )
    db.commit()


# --------------------------------------------------------------------------- #
# Приём: один слушатель на процесс
# --------------------------------------------------------------------------- #
class Subscriber:
    """Очередь одной вкладки.

    ``missed`` взводится, когда очередь переполнилась: клиенту говорят
    «пересчитай всё», и он делает один полный запрос вместо десятка пропущенных
    указателей. Честнее, чем молча потерять событие.
    """

    __slots__ = ("queue", "project_id", "missed")

    def __init__(self, project_id):
        self.queue = Queue(maxsize=QUEUE_DEPTH)
        self.project_id = str(project_id) if project_id else None
        self.missed = False

    def offer(self, event):
        if self.project_id and event.get("p") not in (None, self.project_id):
            return
        try:
            self.queue.put_nowait(event)
        except Full:
            self.missed = True

    def take(self, timeout):
        try:
            return self.queue.get(timeout=timeout)
        except Empty:
            return None


class Listener:
    """Одно соединение к базе на весь процесс.

    Держится вне пула SQLAlchemy нарочно: пул отдаёт соединение обратно после
    запроса, а это должно висеть на ``LISTEN`` неделями.
    """

    def __init__(self):
        self._subs = set()
        self._lock = threading.Lock()
        self._thread = None
        self._stop = threading.Event()

    def start(self):
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run, name="live-listener", daemon=True
            )
            self._thread.start()

    def stop(self):
        self._stop.set()

    def subscribe(self, project_id=None) -> Subscriber:
        sub = Subscriber(project_id)
        with self._lock:
            self._subs.add(sub)
        self.start()
        return sub

    def unsubscribe(self, sub):
        with self._lock:
            self._subs.discard(sub)

    def _fanout(self, event):
        with self._lock:
            subs = tuple(self._subs)
        for sub in subs:
            sub.offer(event)

    def _run(self):
        import psycopg2

        backoff = 1.0
        while not self._stop.is_set():
            conn = None
            try:
                conn = psycopg2.connect(dsn())
                conn.autocommit = True
                with conn.cursor() as cur:
                    cur.execute(f"LISTEN {CHANNEL}")
                backoff = 1.0
                while not self._stop.is_set():
                    # Спим на сокете, а не на базе. Двадцать секунд — просто
                    # шаг, на котором мы проверяем флаг остановки.
                    if select.select([conn], [], [], 20) == ([], [], []):
                        continue
                    conn.poll()
                    while conn.notifies:
                        note = conn.notifies.pop(0)
                        try:
                            self._fanout(json.loads(note.payload))
                        except (ValueError, TypeError):
                            continue
            except Exception:
                # База перезапустилась или сеть моргнула. Отступаем и приходим
                # снова: подписчики этого не замечают, они просто получают
                # пометку «пересчитай» на следующем событии.
                with self._lock:
                    for sub in self._subs:
                        sub.missed = True
                if self._stop.wait(backoff):
                    break
                backoff = min(backoff * 2, 30.0)
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass


LISTENER = Listener()


# --------------------------------------------------------------------------- #
# Растущий пул мест под живую связь
# --------------------------------------------------------------------------- #
class Slots:
    """Сколько вкладок разом держат живую связь в этом процессе.

    Растёт ×2 до мягкого потолка, дальше шагом, и никогда не переходит
    жёсткий: поток gunicorn занят на всё время висящего ответа, и раздать
    больше, чем есть потоков, нельзя никаким способом.

    Цену называю вслух: сам по себе рост ничего не ускоряет — все места можно
    было бы раздать сразу. Он даёт другое. Всплеск переподключений (выкатили
    сборку, и все вкладки пришли разом) не съедает мгновенно все потоки
    процесса: чтобы место расширилось, спрос должен продержаться, а не
    мигнуть. И когда мест не хватает, отказ приходит с числом, а не молчанием.
    """

    def __init__(self, hard, soft=8, step=8):
        self.hard = max(1, int(hard))
        self.soft = min(max(1, int(soft)), self.hard)
        self.step = max(1, int(step))
        self.used = 0
        self.peak = 0
        self._lock = threading.Lock()

    def take(self) -> bool:
        with self._lock:
            if self.used >= self.soft:
                if self.soft >= self.hard:
                    return False
                self.soft = min(
                    self.hard,
                    self.soft * 2 if self.soft * 2 <= self.hard
                    else self.soft + self.step,
                )
                if self.used >= self.soft:
                    return False
            self.used += 1
            self.peak = max(self.peak, self.used)
            return True

    def give(self):
        with self._lock:
            self.used = max(0, self.used - 1)

    def view(self):
        with self._lock:
            return {
                "used": self.used, "soft": self.soft,
                "hard": self.hard, "peak": self.peak,
            }


def slots_from_env() -> Slots:
    """Жёсткий потолок — потоки gunicorn минус запас под обычные запросы.

    Запас обязателен: без него последняя открытая вкладка съедает поток, на
    котором должен был обслужиться чей-то щелчок по кнопке.
    """
    threads = int(os.environ.get("GUNICORN_THREADS", "32"))
    reserve = int(os.environ.get("LIVE_RESERVE", "8"))
    return Slots(hard=max(1, threads - reserve))


SLOTS = slots_from_env()


# --------------------------------------------------------------------------- #
# Поток событий для одного клиента
# --------------------------------------------------------------------------- #
def sse(sub: Subscriber, *, stop_after=None):
    """Генератор тела SSE.

    Первое сообщение — всегда ``hello``: клиент по нему понимает, что связь
    живая, и снимает полосу «обновляю опросом».
    """
    import time

    yield "retry: 3000\n\n"
    yield "event: hello\ndata: {}\n\n"
    last = time.monotonic()
    started = last
    while True:
        if stop_after is not None and time.monotonic() - started > stop_after:
            yield "event: bye\ndata: {}\n\n"
            return
        event = sub.take(timeout=1.0)
        if event is not None:
            yield f"event: change\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            last = time.monotonic()
            continue
        if sub.missed:
            sub.missed = False
            yield "event: resync\ndata: {}\n\n"
            last = time.monotonic()
            continue
        if time.monotonic() - last >= PING_EVERY:
            yield ": ping\n\n"
            last = time.monotonic()
