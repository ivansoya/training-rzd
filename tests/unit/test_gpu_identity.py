"""Одна карта — одна запись, сколько бы раз ни пересоздавали контейнер.

07.09.2026 одна RTX 3060 значилась в таблице тремя: у torch 2.3 нет UUID
карты, а имя контейнера меняется при каждом пересоздании. Диспетчер честно
считал, что карт три, и был готов пустить на неё три обучения. Здесь
проверяется чистая часть: какая запись — эта карта, и кто из остальных
призрак.
"""
from datetime import datetime, timedelta, timezone

from common import gpu_rules as gpu


class Row:
    def __init__(self, host, index, name, uuid=None, seen=None, enabled=True):
        self.host = host
        self.device_index = index
        self.name = name
        self.uuid_str = uuid
        self.seen_at = seen
        self.enabled = enabled

    def __repr__(self):
        return f"Row({self.host}, {self.uuid_str}, {self.seen_at})"


NOW = datetime(2026, 9, 7, 12, 0, tzinfo=timezone.utc)
CARD = {"index": 0, "name": "RTX 3060", "total_mb": 12287, "uuid": "GPU-abc"}


def test_по_uuid_находится_своя_запись_независимо_от_имени_контейнера():
    mine = Row("old-container", 0, "RTX 3060", uuid="GPU-abc", seen=NOW)
    other = Row("new-container", 0, "RTX 3060", uuid="GPU-xyz", seen=NOW)
    assert gpu.choose_row([other, mine], CARD, "new-container") is mine


def test_без_uuid_у_старых_записей_берётся_самая_свежая_той_же_модели():
    stale = Row("c1", 0, "RTX 3060", seen=NOW - timedelta(hours=1))
    fresh = Row("c2", 0, "RTX 3060", seen=NOW - timedelta(minutes=5))
    unseen = Row("c3", 0, "RTX 3060", seen=None)
    assert gpu.choose_row([stale, unseen, fresh], CARD, "c4") is fresh


def test_другая_модель_или_номер_не_подхватывается():
    other_model = Row("c1", 0, "RTX 4090", seen=NOW)
    other_index = Row("c1", 1, "RTX 3060", seen=NOW)
    assert gpu.choose_row([other_model, other_index], CARD, "c9") is None


def test_призраки_это_старые_записи_той_же_карты_без_uuid():
    chosen = Row("c3", 0, "RTX 3060", seen=NOW)
    ghost1 = Row("c1", 0, "RTX 3060", seen=NOW - timedelta(hours=2))
    ghost2 = Row("c2", 0, "RTX 3060", seen=NOW - timedelta(hours=1))
    real_other = Row("c1", 0, "RTX 3060", uuid="GPU-other", seen=NOW)
    off = Row("c0", 0, "RTX 3060", seen=None, enabled=False)
    got = gpu.ghosts_of([chosen, ghost1, ghost2, real_other, off], chosen, CARD)
    assert got == [ghost1, ghost2]


def test_карта_которую_давно_не_видели_не_считается_живой():
    assert gpu.fresh_enough(NOW - timedelta(seconds=299), NOW, 300)
    assert not gpu.fresh_enough(NOW - timedelta(seconds=301), NOW, 300)
    assert not gpu.fresh_enough(None, NOW, 300)
    # Наивное время из базы считается UTC, а не отбрасывается.
    assert gpu.fresh_enough(NOW.replace(tzinfo=None), NOW, 300)
