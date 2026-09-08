"""Допуск к видеокарте: таблица случаев.

Ради этих проверок ``fits`` и вынесена отдельно от SQL. Видеокарты здесь нет,
базы тоже — вся политика допуска закрывается числами за миллисекунды.
"""
from common.gpu_rules import fits

# Карта на 24 ГБ: 2 ГБ неприкосновенный запас, 4 ГБ держит полуавтомат.
BIG = dict(total_mb=24564, reserved_mb=2048, sam2_mb=4096, max_heavy=1)
# Карта на 12 ГБ без полуавтомата.
SMALL = dict(total_mb=12288, reserved_mb=1024, sam2_mb=0, max_heavy=1)


def ask(card, *, held=0, pledged=0, heavy=0, want, heavy_request=True):
    return fits(
        total_mb=card["total_mb"],
        reserved_mb=card["reserved_mb"],
        sam2_mb=card["sam2_mb"],
        held_mb=held,
        pledged_mb=pledged,
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


def test_придержанное_место_не_отдаётся_обгоняющему():
    """Без этого крупное обучение не стартует никогда: мелкие работы будут
    пролезать вперёд бесконечно, и каждая по отдельности будет права."""
    # Место есть, но оно обещано тому, кто ждёт дольше.
    why = ask(BIG, pledged=9200, want=12000, heavy_request=False)
    assert why is not None
    assert "придержано" in why
    # А то, что помещается рядом с придержанным, проходит.
    assert ask(BIG, pledged=9200, want=9000, heavy_request=False) is None


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
