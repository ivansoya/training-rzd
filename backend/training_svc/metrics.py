"""Метрики обучения в вид, пригодный для показа.

Отдельный модуль и чистые функции: на вход — простые списки, на выход — то,
что уедет в базу и на экран. Ни torch, ни ultralytics здесь нет, поэтому всё
закрывается числами в ``tests/unit/test_train_metrics.py``, а образ тестов
по-прежнему обходится без трёх гигабайт торча.

Почему это вообще понадобилось. До 08.09.2026 обучение отдавало четыре числа
на весь набор — точность, полноту и две mAP — и рисовало по ним график. На
вопрос «какой класс модель не выучила» ответить было нечем, а именно он и
решает, что делать дальше: доразмечать, добавить кадров или менять модель.
Матрица ошибок при этом всегда была пустой, и причина оказалась не в коде,
а в доводе: ultralytics заполняет её только при ``plots=True``, а обучение
шло с ``plots=False`` — ради скорости и чтобы не сыпать png на том.
"""

# Классы, которых в проверочной части нет вовсе, ultralytics в разбор не
# включает. Показать их всё равно надо: «ноль кадров на проверке» — это не
# «плохо выучен», а «измерить нечем», и путать их нельзя.
UNSEEN = "нет в проверке"


def per_class_rows(names, ap_class_index, p, r, f1, ap50, ap, nt_per_class):
    """Табличка по классам: имя, сколько объектов и четыре метрики.

    ``names`` — {номер: имя} по всему набору; ``ap_class_index`` — номера тех
    классов, по которым метрики вообще считались, в порядке массивов ``p``,
    ``r`` и прочих. Порядок ответа — по номеру класса, как в файлах разметки:
    так строка таблицы совпадает со строкой матрицы ошибок.
    """
    # Никаких `or []` на массивах: ultralytics отдаёт numpy, а у него булев
    # смысл многоэлементного массива — это ValueError, а не «пусто».
    # Первая же настоящая проверка на этом и споткнулась.
    order = [] if ap_class_index is None else [int(i) for i in ap_class_index]
    at = {cls: i for i, cls in enumerate(order)}

    def take(seq, i):
        try:
            value = float(seq[i])
        except (TypeError, ValueError, IndexError):
            return None
        return round(value, 6)

    rows = []
    for cls in sorted(int(k) for k in (names or {})):
        i = at.get(cls)
        instances = 0
        try:
            instances = int(nt_per_class[cls])
        except (TypeError, ValueError, IndexError):
            instances = 0
        rows.append({
            "class_index": cls,
            "name": str((names or {}).get(cls, f"класс {cls}")),
            "instances": instances,
            "precision": take(p, i) if i is not None else None,
            "recall": take(r, i) if i is not None else None,
            "f1": take(f1, i) if i is not None else None,
            "map50": take(ap50, i) if i is not None else None,
            "map": take(ap, i) if i is not None else None,
            "measured": i is not None,
        })
    return rows


def confusion_of(matrix, names):
    """Матрица ошибок числами: строка — что сказала модель, столбец — что было.

    Последняя строка и столбец — фон: пропущенный объект и ложное срабатывание
    на пустом месте. Без них матрица врёт — по ней нельзя отличить «спутал с
    соседом» от «не увидел вовсе», а это разные беды с разным лечением.

    ``None`` — матрицы нет или она пустая: заполняется она только тогда, когда
    проверку просили считать её, и молча показывать нули нельзя.
    """
    if matrix is None:
        return None
    rows = [[float(v) for v in row] for row in matrix]  # numpy тоже подойдёт
    if not rows or not rows[0]:
        return None
    if not any(any(v for v in row) for row in rows):
        return None
    labels = [str((names or {}).get(i, f"класс {i}")) for i in sorted(int(k) for k in (names or {}))]
    # Библиотека добавляет фон отдельной строкой и столбцом: размер на единицу
    # больше числа классов.
    if len(rows) == len(labels) + 1:
        labels = labels + ["фон"]
    return {"matrix": rows, "names": labels}


def totals_of(rows):
    """Итоги по таблице классов — их же средние, но по измеренным.

    Считаем сами, а не берём готовое: ultralytics усредняет по классам, что
    попали в разбор, и если этого не сказать, «средняя точность» будет
    средним по неполному списку, а таблица рядом — полной.
    """
    seen = [r for r in rows if r.get("measured")]
    def avg(key):
        values = [r[key] for r in seen if isinstance(r.get(key), (int, float))]
        return round(sum(values) / len(values), 6) if values else None
    return {
        "classes": len(rows),
        "measured": len(seen),
        "instances": sum(int(r.get("instances") or 0) for r in rows),
        "precision": avg("precision"),
        "recall": avg("recall"),
        "f1": avg("f1"),
        "map50": avg("map50"),
        "map": avg("map"),
    }


def worst(rows, limit=3):
    """Классы, за которые стоит взяться первыми: измеренные и с худшей mAP50."""
    seen = [r for r in rows if r.get("measured") and isinstance(r.get("map50"), (int, float))]
    return sorted(seen, key=lambda r: r["map50"])[:limit]


def curves_of(raw, points=101):
    """Точки кривых PR и F1, прореженные до сотни на класс.

    Целиком они занимают мегабайты на пустом месте: у ultralytics это тысяча
    точек на класс, а глазом отличимы сто.
    """
    out = []
    for item in [] if raw is None else raw:
        try:
            x, y, xlabel, ylabel = item
        except (TypeError, ValueError):
            continue
        xs = list(x)
        step = max(1, len(xs) // points)
        series = y if hasattr(y[0], "__iter__") else [y]
        out.append({
            "x": [round(float(v), 4) for v in xs[::step]],
            "y": [[round(float(v), 4) for v in list(row)[::step]] for row in series],
            "x_label": str(xlabel),
            "y_label": str(ylabel),
        })
    return out or None


def from_validator(validator):
    """Всё, что можно снять с валидатора ultralytics, — одним словарём.

    Единственное место, которое знает про его устройство. Ошибки здесь не
    роняют обучение: веса уже посчитаны, и потерять их из-за неудачного
    разбора метрик было бы обидно вдвойне.
    """
    got = {"per_class": None, "confusion": None, "curves": None, "summary": None}
    metrics = getattr(validator, "metrics", None)
    if metrics is None:
        return got

    names = getattr(metrics, "names", None)
    if not names:
        names = getattr(validator, "names", None) or {}
    box = getattr(metrics, "box", None)
    if box is not None:
        rows = per_class_rows(
            names,
            getattr(box, "ap_class_index", None),
            getattr(box, "p", None),
            getattr(box, "r", None),
            getattr(box, "f1", None),
            getattr(box, "ap50", None),
            getattr(box, "ap", None),
            getattr(metrics, "nt_per_class", None),
        )
        got["per_class"] = {
            "rows": rows,
            "totals": totals_of(rows),
            # За что взяться первым. Считаем здесь, а не на экране: тот же
            # список пригодится и там, где таблицы нет.
            "worst": [r["class_index"] for r in worst(rows)],
        }

    cm = getattr(metrics, "confusion_matrix", None)
    if cm is None:
        cm = getattr(validator, "confusion_matrix", None)
    got["confusion"] = confusion_of(getattr(cm, "matrix", None), names)
    got["curves"] = curves_of(getattr(metrics, "curves_results", None))
    try:
        got["summary"] = {
            k: float(v) for k, v in (getattr(metrics, "results_dict", None) or {}).items()
            if isinstance(v, (int, float))
        }
    except Exception:  # noqa: BLE001
        got["summary"] = None
    return got
