"""Метрики обучения: таблица по классам, матрица ошибок, итоги.

Ни torch, ни ultralytics — на вход простые списки. Ловится здесь то, что
иначе видно только глазами на готовом обучении: класс, которого нет в
проверке, показанный нулём вместо прочерка, и пустая матрица, выданная за
настоящую.
"""
from training_svc.metrics import (
    confusion_of, curves_of, per_class_rows, totals_of, worst,
)

NAMES = {0: "вагон", 1: "столб", 2: "рельс"}


def rows_for(ap_class_index=(0, 1, 2), nt=(10, 20, 30)):
    n = len(ap_class_index)
    return per_class_rows(
        NAMES,
        ap_class_index,
        p=[0.9, 0.5, 0.7][:n],
        r=[0.8, 0.4, 0.6][:n],
        f1=[0.85, 0.44, 0.65][:n],
        ap50=[0.95, 0.45, 0.75][:n],
        ap=[0.7, 0.3, 0.5][:n],
        nt_per_class=nt,
    )


def test_строка_на_каждый_класс_в_порядке_номеров():
    rows = rows_for()
    assert [r["class_index"] for r in rows] == [0, 1, 2]
    assert [r["name"] for r in rows] == ["вагон", "столб", "рельс"]
    assert rows[0]["precision"] == 0.9 and rows[0]["map50"] == 0.95


def test_число_объектов_берётся_по_номеру_класса():
    rows = rows_for(nt=(10, 20, 30))
    assert [r["instances"] for r in rows] == [10, 20, 30]


def test_класс_без_проверки_это_прочерк_а_не_ноль():
    # Класс 1 в разбор не попал: в проверочной части его нет ни на одном кадре.
    rows = per_class_rows(
        NAMES, [0, 2],
        p=[0.9, 0.7], r=[0.8, 0.6], f1=[0.85, 0.65],
        ap50=[0.95, 0.75], ap=[0.7, 0.5],
        nt_per_class=[10, 0, 30],
    )
    missing = rows[1]
    assert missing["class_index"] == 1 and missing["measured"] is False
    assert missing["precision"] is None and missing["map50"] is None
    assert missing["instances"] == 0
    # А измеренные не съехали: массивы идут по ap_class_index, а не по номеру.
    assert rows[2]["precision"] == 0.7 and rows[2]["measured"] is True


def test_итоги_считаются_только_по_измеренным():
    rows = per_class_rows(
        NAMES, [0, 2],
        p=[0.9, 0.7], r=[0.8, 0.6], f1=[0.85, 0.65],
        ap50=[0.95, 0.75], ap=[0.7, 0.5],
        nt_per_class=[10, 0, 30],
    )
    got = totals_of(rows)
    assert got["classes"] == 3 and got["measured"] == 2
    assert got["instances"] == 40
    assert got["precision"] == 0.8          # (0.9 + 0.7) / 2, без класса 1
    assert got["map50"] == 0.85


def test_худшие_классы_это_измеренные_с_наименьшей_mAP50():
    rows = rows_for()
    assert [r["name"] for r in worst(rows, limit=2)] == ["столб", "рельс"]


def test_худшие_не_включают_неизмеренные():
    rows = per_class_rows(
        NAMES, [0, 2],
        p=[0.9, 0.7], r=[0.8, 0.6], f1=[0.85, 0.65],
        ap50=[0.95, 0.75], ap=[0.7, 0.5], nt_per_class=[10, 0, 30],
    )
    assert [r["name"] for r in worst(rows)] == ["рельс", "вагон"]


def test_матрица_получает_фон_последней_строкой():
    matrix = [[5, 1, 0, 2], [0, 7, 1, 1], [0, 0, 9, 0], [1, 2, 0, 0]]
    got = confusion_of(matrix, NAMES)
    assert got["names"] == ["вагон", "столб", "рельс", "фон"]
    assert got["matrix"][0][0] == 5.0


def test_пустая_матрица_это_none_а_не_нули():
    # Ровно то, что приходило до 08.09.2026: размер верный, а внутри нули.
    assert confusion_of([[0, 0], [0, 0]], {0: "вагон"}) is None
    assert confusion_of(None, NAMES) is None
    assert confusion_of([], NAMES) is None


def test_матрица_без_фона_остаётся_как_есть():
    got = confusion_of([[1, 0], [0, 2]], {0: "вагон", 1: "столб"})
    assert got["names"] == ["вагон", "столб"]


def test_кривые_прореживаются_и_держат_подписи():
    x = list(range(1000))
    y = [[i / 1000 for i in range(1000)]]
    got = curves_of([(x, y, "Recall", "Precision")], points=101)
    assert len(got) == 1
    assert got[0]["x_label"] == "Recall" and got[0]["y_label"] == "Precision"
    assert 90 <= len(got[0]["x"]) <= 120
    assert len(got[0]["y"][0]) == len(got[0]["x"])


def test_кривая_одной_линией_тоже_принимается():
    got = curves_of([([0, 1, 2], [0.1, 0.2, 0.3], "x", "y")])
    assert got[0]["y"] == [[0.1, 0.2, 0.3]]


def test_битая_кривая_пропускается_а_не_роняет():
    assert curves_of([("мусор",)]) is None
    assert curves_of([]) is None


# --------------------------------------------------------------------------- #
# Настоящие массивы, а не списки
# --------------------------------------------------------------------------- #
def test_numpy_массивы_принимаются_как_есть():
    """Ultralytics отдаёт numpy, и `if массив or []` — это ValueError.

    Первый же настоящий прогон 08.09.2026 упал ровно на этом: «The truth value
    of an array with more than one element is ambiguous». Списки такую ошибку
    не ловят, поэтому проверка идёт настоящими массивами.
    """
    np = __import__("numpy")
    rows = per_class_rows(
        NAMES,
        np.array([0, 2]),
        p=np.array([0.9, 0.7]), r=np.array([0.8, 0.6]), f1=np.array([0.85, 0.65]),
        ap50=np.array([0.95, 0.75]), ap=np.array([0.7, 0.5]),
        nt_per_class=np.array([10, 0, 30]),
    )
    assert [r["measured"] for r in rows] == [True, False, True]
    assert rows[0]["precision"] == 0.9 and rows[2]["map50"] == 0.75
    assert totals_of(rows)["measured"] == 2


def test_матрица_из_numpy_разбирается():
    np = __import__("numpy")
    got = confusion_of(np.array([[5.0, 1.0], [0.0, 7.0]]), {0: "вагон"})
    assert got["matrix"] == [[5.0, 1.0], [0.0, 7.0]]
    assert got["names"] == ["вагон", "фон"]


def test_кривые_из_numpy_прореживаются():
    np = __import__("numpy")
    got = curves_of([(np.linspace(0, 1, 1000), np.zeros((2, 1000)), "Recall", "Precision")])
    assert len(got[0]["y"]) == 2 and len(got[0]["x"]) == len(got[0]["y"][0])
