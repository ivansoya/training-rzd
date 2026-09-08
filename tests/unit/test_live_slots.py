"""Растущий пул мест под живую связь и потолок уведомления.

Обе проверки чистые: ни базы, ни сети. Ловят они ровно то, что иначе
обнаружилось бы в проде — молчаливый отказ живой связи и упавшую транзакцию
из-за слишком длинного уведомления.
"""
import json

import pytest

from common.live import MAX_PAYLOAD, Slots, Subscriber, payload


# --------------------------------------------------------------------------- #
# Пул мест
# --------------------------------------------------------------------------- #
def test_пул_растёт_вдвое_потом_шагом():
    pool = Slots(hard=40, soft=8, step=8)
    for _ in range(8):
        assert pool.take()
    assert pool.view()["soft"] == 8

    assert pool.take()          # девятый расширяет: 8 → 16
    assert pool.view()["soft"] == 16
    for _ in range(7):
        assert pool.take()      # добираем до 16

    assert pool.take()          # 16 → 32
    assert pool.view()["soft"] == 32
    for _ in range(15):
        assert pool.take()

    assert pool.take()          # 32 × 2 = 64 больше жёсткого, значит шагом
    assert pool.view()["soft"] == 40


def test_жёсткий_потолок_не_переходится():
    """Поток gunicorn занят на всё время висящего ответа. Раздать больше, чем
    есть потоков, нельзя никаким ростом."""
    pool = Slots(hard=10, soft=2, step=4)
    given = sum(1 for _ in range(50) if pool.take())
    assert given == 10
    assert pool.take() is False


def test_освобождённое_место_выдаётся_снова():
    pool = Slots(hard=4, soft=4)
    assert all(pool.take() for _ in range(4))
    assert pool.take() is False
    pool.give()
    assert pool.take() is True


def test_мягкий_потолок_не_превышает_жёсткий_с_самого_начала():
    pool = Slots(hard=3, soft=16)
    assert pool.view()["soft"] == 3


def test_пик_запоминается():
    pool = Slots(hard=8, soft=8)
    for _ in range(5):
        pool.take()
    for _ in range(5):
        pool.give()
    assert pool.view()["peak"] == 5
    assert pool.view()["used"] == 0


# --------------------------------------------------------------------------- #
# Уведомление
# --------------------------------------------------------------------------- #
def test_уведомление_это_указатель_а_не_состояние():
    body = payload("run", "8f3a21c4", project_id="p1", e=42)
    assert len(body) < MAX_PAYLOAD
    assert json.loads(body) == {"k": "run", "id": "8f3a21c4", "p": "p1", "e": 42}


def test_длинное_уведомление_падает_сразу():
    """У NOTIFY предел восемь тысяч байт, и переполнение откатывает
    транзакцию — то есть теряется запись метрики, а не уведомление. Ронять
    надо здесь, при написании кода, а не в проде на сорок второй эпохе."""
    with pytest.raises(ValueError):
        payload("run", "x", note="д" * MAX_PAYLOAD)


# --------------------------------------------------------------------------- #
# Подписчик
# --------------------------------------------------------------------------- #
def test_чужой_проект_не_приходит():
    sub = Subscriber("p1")
    sub.offer({"k": "run", "id": "a", "p": "p2"})
    assert sub.take(timeout=0) is None
    sub.offer({"k": "run", "id": "b", "p": "p1"})
    assert sub.take(timeout=0)["id"] == "b"


def test_отставший_получает_пометку_а_не_тормозит_соседей():
    sub = Subscriber(None)
    for i in range(200):
        sub.offer({"k": "run", "id": str(i)})
    assert sub.missed is True
    # Очередь не разбухла до двухсот: у неё есть потолок.
    assert sub.queue.qsize() <= 64
