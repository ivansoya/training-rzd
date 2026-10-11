"""Допуск к видеокарте: таблица случаев.

Ради этих проверок ``fits`` и вынесена отдельно от SQL. Видеокарты здесь нет,
базы тоже — вся политика допуска закрывается числами за миллисекунды.
"""
from common.gpu_rules import fits, for_tasks_mb

# Карта на 24 ГБ: 2 ГБ неприкосновенный запас, 4 ГБ держит полуавтомат.
BIG = dict(total_mb=24564, reserved_mb=2048, sam2_mb=4096, max_heavy=1)
# Карта на 12 ГБ без полуавтомата.
SMALL = dict(total_mb=12288, reserved_mb=1024, sam2_mb=0, max_heavy=1)


def ask(card, *, held=0, heavy=0, want, heavy_request=True):
    return fits(
        total_mb=card["total_mb"],
        reserved_mb=card["reserved_mb"],
        sam2_mb=card["sam2_mb"],
        held_mb=held,
        heavy=heavy,
        max_heavy=card["max_heavy"],
        want_mb=want,
        heavy_request=heavy_request,
    )


def test_пустая_карта_пускает_то_что_влезает():
    assert ask(BIG, want=12600) is None


def test_запас_и_бронь_полуавтомата_не_раздаются():
    # 24564 − 2048 запаса − 4096 полуавтомата = 18420 МБ под задачи.
    assert ask(BIG, want=18420) is None
    assert ask(BIG, want=18421) is not None


def test_занятое_место_вычитается():
    assert ask(BIG, held=12600, want=5800, heavy_request=False) is None
    assert ask(BIG, held=12600, want=5900, heavy_request=False) is not None


def test_потолок_тяжёлых_держит_второе_обучение():
    # По памяти второе обучение влезло бы, но станут вдвое медленнее оба.
    assert ask(BIG, held=4000, heavy=1, want=4000) is not None
    # Нетяжёлая работа под этот потолок не попадает.
    assert ask(BIG, held=4000, heavy=1, want=4000, heavy_request=False) is None


def test_потолок_можно_поднять():
    card = dict(BIG, max_heavy=2)
    assert ask(card, held=4000, heavy=1, want=4000) is None


def test_невозможное_называется_невозможным():
    """«Не поместится никогда» и «сейчас занято» человек чинит по-разному:
    первое — уменьшением батча, второе — ожиданием."""
    why = ask(SMALL, want=20000)
    assert why is not None
    assert "никогда" in why

    why = ask(SMALL, held=10000, want=2000, heavy_request=False)
    assert why is not None
    assert "никогда" not in why
    assert "свободно" in why


def test_причина_написана_для_человека():
    """Причину показывают целиком, поэтому в ней гигабайты и запятая, а не
    мегабайты и точка."""
    why = ask(BIG, held=16000, want=9000, heavy_request=False)
    assert "ГБ" in why
    assert "," in why
    assert "МБ" not in why


def test_ровно_по_границе_проходит():
    assert ask(SMALL, held=1000, want=10264, heavy_request=False) is None
    assert ask(SMALL, held=1000, want=10265, heavy_request=False) is not None


# --------------------------------------------------------------------------- #
# Потолок карты: по нему диспетчер отличает «подожди» от «никогда»
# --------------------------------------------------------------------------- #
def test_потолок_совпадает_с_приговором_допуска():
    """Если эти двое разойдутся, диспетчер станет ставить в очередь заявки,
    которые сам же считает невыполнимыми, — и та встанет навсегда."""
    for card in (BIG, SMALL):
        top = for_tasks_mb(card["total_mb"], card["reserved_mb"], card["sam2_mb"])
        assert "никогда" not in (ask(card, want=top) or "")
        assert "никогда" in ask(card, want=top + 1)


def test_потолок_не_зависит_от_занятого():
    """Потолок — свойство карты. Занятое сейчас двигает «подожди», но не его:
    иначе большое обучение то отвергалось бы, то вставало в очередь."""
    top = for_tasks_mb(SMALL["total_mb"], SMALL["reserved_mb"], SMALL["sam2_mb"])
    assert "никогда" in ask(SMALL, want=top + 1, held=0)
    assert "никогда" in ask(SMALL, want=top + 1, held=4096)


# --------------------------------------------------------------------------- #
# Какую из подходящих карт отдать
# --------------------------------------------------------------------------- #
from common.gpu_rules import pick_device  # noqa: E402


def test_тяжёлое_идёт_на_наименее_загруженную():
    # (id, свободно после выдачи, живых броней): на «a» висят превью и образцы.
    cards = [("a", 9000, 2), ("b", 3000, 0)]
    assert pick_device(cards, heavy_request=True) == "b"


def test_тяжёлое_при_равной_загрузке_берёт_где_просторнее():
    assert pick_device([("a", 3000, 1), ("b", 9000, 1)], heavy_request=True) == "b"


def test_лёгкое_укладывается_плотно():
    # Превью на 3 ГБ — туда, где после него меньше всего останется: дыра в 9 ГБ ждёт обучение.
    assert pick_device([("a", 9000, 0), ("b", 1000, 3)], heavy_request=False) == "b"


def test_ничья_и_пустой_список():
    assert pick_device([("a", 5000, 0), ("b", 5000, 0)], heavy_request=True) == "a"
    assert pick_device([], heavy_request=False) is None


# --------------------------------------------------------------------------- #
# Задача на нескольких картах: все части разом или никуда (решения 10.10.2026)
# --------------------------------------------------------------------------- #
from common.gpu_rules import place  # noqa: E402


def card(i, total=24564, held=0, heavy=0, busy=0, max_heavy=1, reserved=1024, sam2=0):
    return dict(id=f"c{i}", index=i, total=total, reserved=reserved, sam2=sam2, held=held,
                heavy=heavy, max_heavy=max_heavy, busy=busy)


def test_одиночная_бронь_выбирает_как_раньше():
    # Одна часть — тот же выбор, что у pick_device: тяжёлое на наименее загруженную.
    got, why = place([4000], [card(0, held=8000, busy=2), card(1)], spread=False,
                     heavy_request=True, busy_kind=True)
    assert got == ["c1"] and why is None


def test_обучение_на_двух_картах_ложится_на_разные():
    got, why = place([6000, 6000], [card(0), card(1), card(2)], spread=True,
                     heavy_request=True, busy_kind=True)
    assert why is None and len(set(got)) == 2


def test_обучение_на_двух_картах_не_ляжет_на_одну():
    # Свободная карта одна, на второй уже идёт обучение (потолок тяжёлых 1) — ждём обе.
    got, why = place([6000, 6000], [card(0), card(1, held=5000, heavy=1, busy=1)], spread=True,
                     heavy_request=True, busy_kind=True)
    assert got is None
    assert "2 карты сразу" in why


def test_всё_или_ничего():
    # Первая часть влезла бы — но без второй не выдаётся ни одна.
    got, _ = place([15000, 9000], [card(0), card(1, held=20000, busy=1)], spread=False,
                   heavy_request=False, busy_kind=True)
    assert got is None


def test_агент_по_блокам_занимает_меньше_карт():
    # SAM 3 15,6 ГБ, YOLOE-x 6,5 и SAM2 1,5 — вместе больше карты в 23 ГБ:
    # ложатся на две карты, а не на три.
    got, why = place([15960, 6650, 1480], [card(0), card(1), card(2)], spread=False,
                     heavy_request=False, busy_kind=True)
    assert why is None
    assert len(set(got)) == 2
