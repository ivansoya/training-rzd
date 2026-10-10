"""Пик памяти прогона агента: пик внутри кадра виден, сосед не сбивает замер."""
from common.gpu_peak import Registry


class Card:
    """Ненастоящая карта: занятое сейчас и вершина с последнего сброса, МБ."""

    def __init__(self, allocated=0):
        self.allocated = allocated
        self.high = allocated
        self.resets = 0

    def spike(self, mb):
        """Кадр: память поднялась до `mb` и опала обратно."""
        self.high = max(self.high, mb)

    def hold(self, mb):
        self.allocated = mb
        self.high = max(self.high, mb)

    def reg(self):
        def reset(_device):
            self.high = self.allocated
            self.resets += 1
        return Registry(peak=lambda _d: self.high, allocated=lambda _d: self.allocated, reset=reset)


def test_пик_внутри_кадра_попадает_в_замер():
    card = Card(allocated=500)
    reg = card.reg()
    watch = reg.watch("cuda:0", base=500)
    card.hold(700)          # модели загружены
    card.spike(4400)        # YOLOE на восьми тайлах
    watch.measure()
    assert watch.top == 3900, "раньше видели только 200 — занятое между кадрами"


def test_один_на_карте_пик_точный_после_каждого_кадра():
    card = Card(allocated=0)
    reg = card.reg()
    watch = reg.watch("cuda:0", base=0)
    card.spike(3000)
    watch.measure()
    card.spike(1000)        # счётчик сброшен — следующий кадр меряется сам по себе
    watch.measure()
    assert watch.top == 3000 and card.resets >= 2


def test_с_соседом_счётчик_не_сбрасывается():
    card = Card(allocated=0)
    reg = card.reg()
    first = reg.watch("cuda:0", base=0)
    resets = card.resets
    second = reg.watch("cuda:0", base=0)
    card.spike(2500)
    first.measure()
    second.measure()
    assert card.resets == resets, "сброс сбил бы замер соседа"
    # Вершину поднял кто-то из двоих — оба берут её: переоценка, а не недооценка.
    assert first.top == 2500 and second.top == 2500


def test_сосед_ушёл_и_замер_снова_точный():
    card = Card(allocated=0)
    reg = card.reg()
    mine, other = reg.watch("cuda:0", base=0), reg.watch("cuda:0", base=0)
    card.spike(6000)        # сосед поднял вершину до нашего
    other.close()
    mine.measure()          # первый замер в одиночку: вершина соседа ещё в счётчике
    card.spike(1200)
    mine.measure()
    assert mine.top == 6000  # с запасом — но дальше счётчик сброшен
    card.hold(0)
    card.spike(800)
    before = mine.top
    mine.measure()
    assert mine.top == before


def test_без_карты_ничего_не_меряет():
    card = Card()
    watch = card.reg().watch("cpu", base=0)
    card.spike(9000)
    watch.measure()
    watch.close()
    assert watch.top == 0 and card.resets == 0


def test_закрытие_освобождает_карту():
    card = Card()
    reg = card.reg()
    reg.watch("cuda:0", base=0).close()
    assert reg.active["cuda:0"] == 0
    reg.watch("cuda:0", base=0)
    assert reg.active["cuda:0"] == 1
