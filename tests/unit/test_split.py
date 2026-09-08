"""Деление на обучение и проверку: четыре стратегии, закрытые числами.

Ни базы, ни ORM — только кадры, их группы и их классы. Ловится здесь ровно то,
что иначе обнаруживается через месяц по неправдоподобно хорошим метрикам:
кадры одного перегона, разъехавшиеся по обеим половинам.
"""
from collections import Counter

from common.splitting import by_clusters, by_groups, bucket_key


class Frame:
    """Кадр — это здесь только его номер: остальное делению не нужно."""

    __slots__ = ("id",)

    def __init__(self, n):
        self.id = f"img-{n:04d}"

    def __repr__(self):
        return self.id


def frames(n, start=0):
    return [Frame(i) for i in range(start, start + n)]


def sides(placed, rows):
    c = Counter(placed[f.id] for f in rows)
    return c["train"], c["val"]


# --------------------------------------------------------------------------- #
# Случайное деление: одна группа на всё
# --------------------------------------------------------------------------- #
def test_доля_проверки_соблюдается():
    rows = frames(1000)
    placed = by_groups(rows, {f.id: "" for f in rows}, 0.2, seed=0)
    train, val = sides(placed, rows)
    assert train + val == 1000
    assert val == 200


def test_повтор_даёт_то_же_самое():
    """Пересобрать набор тем же зерном — значит получить те же файлы. Без
    этого «повторить обучение ровно на том же» превращается в обещание."""
    rows = frames(300)
    one = {f.id: "" for f in rows}
    first = by_groups(rows, one, 0.2, seed=42)
    second = by_groups(list(reversed(rows)), one, 0.2, seed=42)
    assert first == second


def test_другое_зерно_даёт_другое_деление():
    rows = frames(300)
    one = {f.id: "" for f in rows}
    a = by_groups(rows, one, 0.2, seed=1)
    b = by_groups(rows, one, 0.2, seed=2)
    assert a != b


def test_новые_кадры_не_перетасовывают_старых():
    """Порядок берётся из отпечатка, а не из положения в списке."""
    old = frames(100)
    one = {f.id: "" for f in old}
    before = by_groups(old, one, 0.2, seed=7)

    grown = old + frames(20, start=100)
    one_grown = {f.id: "" for f in grown}
    after = by_groups(grown, one_grown, 0.2, seed=7)

    moved = [f.id for f in old if before[f.id] != after[f.id]]
    # Сдвиг возможен только на границе доли, и он мал: это не перетасовка.
    assert len(moved) <= 5


# --------------------------------------------------------------------------- #
# Деление с оглядкой на классы
# --------------------------------------------------------------------------- #
def test_редкий_класс_попадает_в_проверку():
    """Класс из трёх кадров обязан дать хотя бы один проверочный. Ради этого
    стратификация и затевалась — иначе редкий класс целиком уезжает в
    обучение, и измерить его нечем."""
    common = frames(200)
    rare = frames(3, start=1000)
    group_of = {f.id: "вагон" for f in common}
    group_of.update({f.id: "стрелка" for f in rare})

    placed = by_groups(common + rare, group_of, 0.2, seed=0)
    _, rare_val = sides(placed, rare)
    assert rare_val == 1


def test_класс_из_одного_кадра_остаётся_в_обучении():
    """Один кадр нельзя одновременно учить и проверять. Молча делить его
    пополам нечем, поэтому он идёт в обучение — а мастер об этом скажет."""
    one = frames(1, start=2000)
    placed = by_groups(one, {one[0].id: "уникум"}, 0.2, seed=0)
    assert placed[one[0].id] == "train"


# --------------------------------------------------------------------------- #
# Умное деление: группа едет целиком
# --------------------------------------------------------------------------- #
def test_группа_не_разъезжается():
    """Главное свойство умного деления. Кадры одного перегона обязаны
    оказаться по одну сторону, иначе проверка мерит запоминание."""
    rows = frames(300)
    cluster_of = {f.id: f"перегон-{i // 30}" for i, f in enumerate(rows)}
    classes_of = {f.id: {"вагон"} for f in rows}

    placed = by_clusters(rows, cluster_of, classes_of, 0.2)
    by_cluster = {}
    for f in rows:
        by_cluster.setdefault(cluster_of[f.id], set()).add(placed[f.id])
    assert all(len(s) == 1 for s in by_cluster.values())


def test_умное_деление_держится_доли():
    rows = frames(400)
    cluster_of = {f.id: f"г{i // 20}" for i, f in enumerate(rows)}
    classes_of = {f.id: {"вагон"} for f in rows}
    placed = by_clusters(rows, cluster_of, classes_of, 0.25)
    train, val = sides(placed, rows)
    assert train + val == 400
    # Группами точную долю не выдержать — но промах должен быть меньше группы.
    assert abs(val - 100) <= 20


def test_редкий_класс_не_достаётся_последнему():
    """Группы с самым редким классом проекта обходятся первыми. Иначе редкий
    класс достаётся тому, кто попросит последним, а попросит последним тот, у
    кого групп больше."""
    big = frames(180)
    rare = frames(20, start=500)
    rows = big + rare
    cluster_of = {f.id: f"вагоны-{i // 20}" for i, f in enumerate(big)}
    cluster_of.update({f.id: f"стрелки-{i // 10}" for i, f in enumerate(rare)})
    classes_of = {f.id: {"вагон"} for f in big}
    classes_of.update({f.id: {"стрелка"} for f in rare})

    placed = by_clusters(rows, cluster_of, classes_of, 0.2)
    _, rare_val = sides(placed, rare)
    assert rare_val > 0


def test_кадры_без_классов_тоже_делятся():
    """Фоновые кадры — не повод падать: делить их не по чему, кроме размера."""
    rows = frames(50)
    cluster_of = {f.id: f"г{i // 5}" for i, f in enumerate(rows)}
    placed = by_clusters(rows, cluster_of, {}, 0.2)
    train, val = sides(placed, rows)
    assert train + val == 50
    assert val > 0


# --------------------------------------------------------------------------- #
# Отпечаток
# --------------------------------------------------------------------------- #
def test_отпечаток_без_зерна_совпадает_со_старым():
    """Выгрузка проекта делила по отпечатку без зерна с самого начала. Ключ
    обязан остаться тем же, иначе старый архив и новый разойдутся при
    одинаковых галочках."""
    import hashlib

    ident = "img-0001"
    assert bucket_key(ident, 0) == hashlib.sha1(ident.encode()).hexdigest()
    assert bucket_key(ident, 5) != bucket_key(ident, 0)
