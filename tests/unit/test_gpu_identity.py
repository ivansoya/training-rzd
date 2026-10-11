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


def test_uuid_torch_27_без_приставки_узнаёт_запись_от_nvidia_smi():
    # 11.10.2026: torch 2.7 дал «0cc67fd8-…», запись хранила «GPU-0cc67fd8-…» — карта
    # подхватила выключенного призрака без UUID, и живая карта оказалась выключенной.
    real = Row("old", 0, "RTX 3060", uuid="GPU-0cc67fd8-fb04-d70a-3165-56a21c973d01", seen=NOW)
    ghost = Row("older", 0, "RTX 3060", seen=NOW - timedelta(days=9), enabled=False)
    item = dict(CARD, uuid="0cc67fd8-fb04-d70a-3165-56a21c973d01")
    assert gpu.choose_row([ghost, real], item, "new") is real


def test_из_двойников_по_uuid_берётся_включённый():
    on = Row("a", 0, "RTX 3060", uuid="GPU-abc", seen=NOW - timedelta(days=1))
    off = Row("b", 0, "RTX 3060", uuid="abc", seen=NOW, enabled=False)
    assert gpu.choose_row([off, on], CARD, "c") is on
    # Включённый двойник, который не выбран, — призрак той же карты.
    assert gpu.ghosts_of([on, Row("d", 0, "RTX 3060", uuid="ABC", seen=NOW)], on, CARD)[0].host == "d"


def test_текст_ошибки_nvml_вместо_uuid_это_отсутствие_uuid():
    # Так на voran запись хранила «Failed to initialize NVML: Unknown Error» вместо UUID.
    assert gpu.norm_uuid("Failed to initialize NVML: Unknown Error") is None
    assert gpu.norm_uuid("GPU-9C68DAA8-84e8") == gpu.norm_uuid("9c68daa8-84e8") == "9c68daa8-84e8"
    broken = Row("c1", 0, "RTX 3060", uuid="Failed to initialize NVML: Unknown Error", seen=NOW)
    assert gpu.choose_row([broken], dict(CARD, uuid="GPU-new"), "c2") is broken


def test_карта_которую_давно_не_видели_не_считается_живой():
    assert gpu.fresh_enough(NOW - timedelta(seconds=299), NOW, 300)
    assert not gpu.fresh_enough(NOW - timedelta(seconds=301), NOW, 300)
    assert not gpu.fresh_enough(None, NOW, 300)
    # Наивное время из базы считается UTC, а не отбрасывается.
    assert gpu.fresh_enough(NOW.replace(tzinfo=None), NOW, 300)
