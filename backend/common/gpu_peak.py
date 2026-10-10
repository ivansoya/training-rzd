"""Пик своей видеопамяти у прогона — с пиком внутри вычисления.

Между кадрами `memory_allocated` уже опал: пик YOLOE на тайлах (3,8 ГБ, замер
10.10.2026) он не видел, и подсказка диспетчера выходила впятеро ниже правды.
Счётчик пика у torch общий на процесс, а прогонов агентов в процессе бывает
несколько, поэтому сбрасывается он, только когда прогон на карте один. С соседом
берётся вершина, поднятая при нас, вместе с его памятью: переоценка заставит
подождать, недооценка роняет прогон.

Без торча и базы: счётчики подменяются в тестах.
"""
import threading

MB = 1 << 20


def _torch_peak(device):
    import torch
    return int(torch.cuda.max_memory_allocated(device) / MB)


def _torch_allocated(device):
    import torch
    return int(torch.cuda.memory_allocated(device) / MB)


def _torch_reset(device):
    import torch
    torch.cuda.reset_peak_memory_stats(device)


class Registry:
    """Сколько прогонов меряют память на каждой карте этого процесса."""

    def __init__(self, peak=_torch_peak, allocated=_torch_allocated, reset=_torch_reset):
        self.lock = threading.Lock()
        self.active: dict[str, int] = {}
        self.peak, self.allocated, self.reset = peak, allocated, reset

    def watch(self, device, base):
        return PeakWatch(self, device, base)


class PeakWatch:
    """Пик памяти одного прогона сверх `base` (МБ); `measure` — после каждого кадра."""

    def __init__(self, registry, device, base):
        self.reg, self.device, self.base, self.top = registry, device, base, 0
        self.key = None if device in (None, "cpu") else str(device)
        self.mark = 0
        if self.key is None:
            return
        with self.reg.lock:
            self.reg.active[self.key] = self.reg.active.get(self.key, 0) + 1
            self._safe(self.reg.reset) if self.reg.active[self.key] == 1 else None
            self.mark = self._read(self.reg.peak)

    def measure(self):
        if self.key is None:
            return
        with self.reg.lock:
            high = self._read(self.reg.peak)
            if high > self.mark:
                self.top = max(self.top, high - self.base)
            self.top = max(self.top, self._read(self.reg.allocated) - self.base)
            if self.reg.active.get(self.key) == 1:
                self._safe(self.reg.reset)
                self.mark = self._read(self.reg.peak)

    def close(self):
        if self.key is None:
            return
        with self.reg.lock:
            self.reg.active[self.key] = max(0, self.reg.active.get(self.key, 1) - 1)
            self.key = None

    def _read(self, fn):
        try:
            return int(fn(self.device))
        except Exception:
            return 0

    def _safe(self, fn):
        try:
            fn(self.device)
        except Exception:
            pass


REGISTRY = Registry()
