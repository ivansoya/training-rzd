"""Строки сборки: что вливается в источник и сколько из этого выйдет.

Ни базы, ни картинок — только отбор и счёт. Проверяется здесь то, что дороже
всего стоит ошибиться: **таговый источник не берёт чужую половину**. Взяв
проверочный кадр в обучающую строку, набор молча начал бы учить модель на том,
чем её потом проверяют, и метрики оказались бы неправдоподобно хорошими без
единого сообщения.
"""
import json
import pathlib
import uuid

import pytest

from dataprep_svc import feeds

FIXTURES = pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "graphs"


class FakeImage:
    """Кадру от отбора нужен только номер: файлы здесь никто не читает."""

    def __init__(self, name):
        self.id = uuid.uuid5(uuid.NAMESPACE_OID, name)
        self.file_name = name


class FakePick:
    """То немногое, что отбор даёт строкам сборки: кадры и их таги.

    Настоящий ``common.selection.Selection`` сюда не берём нарочно — он тянет
    SQLAlchemy, а образ тестов про ORM не знает. Это то же правило, по
    которому живёт ``common/splitting.py``.
    """

    def __init__(self, images, tags_of):
        self.images = images
        self.tags_of = tags_of


NIGHT = uuid.uuid5(uuid.NAMESPACE_OID, "tag:night")
RAIN = uuid.uuid5(uuid.NAMESPACE_OID, "tag:rain")


@pytest.fixture
def picked():
    """Четыре кадра: два ночных, один дождливый, один без тагов."""
    images = [FakeImage(n) for n in ("a", "b", "c", "d")]
    a, b, c, d = images
    return FakePick(images, {
        a.id: {NIGHT}, b.id: {NIGHT, RAIN}, c.id: {RAIN}, d.id: set(),
    })


@pytest.fixture
def split_of(picked):
    a, b, c, d = picked.images
    return {a.id: "train", b.id: "val", c.id: "train", d.id: "train"}


def tags_binding(*tag_ids):
    return {"source_node": "s", "feed": "tags", "tag_ids": list(tag_ids)}


def half_binding(feed):
    return {"source_node": "s", "feed": feed, "tag_ids": []}


# --------------------------------------------------------------------------- #
# Отбор под строку
# --------------------------------------------------------------------------- #
def test_таг_не_тащит_чужую_половину(picked, split_of):
    """Ночных кадров два, но один из них деление отправило в проверку. Строка
    на обучение получает только первый."""
    got = feeds.images_for(picked, split_of, "train", tags_binding(NIGHT))
    assert [i.file_name for i in got] == ["a"]


def test_таг_в_проверочной_строке_берёт_проверочные(picked, split_of):
    got = feeds.images_for(picked, split_of, "val", tags_binding(NIGHT))
    assert [i.file_name for i in got] == ["b"]


def test_несколько_тагов_это_любой_из(picked, split_of):
    got = feeds.images_for(picked, split_of, "train", tags_binding(NIGHT, RAIN))
    assert [i.file_name for i in got] == ["a", "c"]


def test_источник_без_тагов_не_даёт_ничего(picked, split_of):
    """Человек выбрал «кадры с тагами» и не отметил ни одного. Молча подсунуть
    ему половину целиком было бы хуже пустой строки: он увидел бы в наборе то,
    чего не просил."""
    assert feeds.images_for(picked, split_of, "train", tags_binding()) == []


def test_половина_берётся_целиком(picked, split_of):
    got = feeds.images_for(picked, split_of, "train", half_binding("train"))
    assert [i.file_name for i in got] == ["a", "c", "d"]


def test_чужая_половина_берётся_если_названа_явно(picked, split_of):
    """Строка на обучение, источник «проверочная половина» — это утечка, но
    названная человеком вслух. Делаем, и предупреждаем словами."""
    got = feeds.images_for(picked, split_of, "train", half_binding("val"))
    assert [i.file_name for i in got] == ["b"]
    rows = [{"part": "train", "bindings": [half_binding("val")]}]
    assert feeds.cross_half_warnings(rows)


# --------------------------------------------------------------------------- #
# Разбор строк
# --------------------------------------------------------------------------- #
def test_пусто_это_как_было_всегда():
    """Старый набор и только что открытый мастер выглядят одинаково: по строке
    на половину, своя половина, без графа."""
    rows = feeds.parse(None)
    assert [(r["part"], r["graph_version_id"]) for r in rows] == [
        ("train", None), ("val", None)
    ]
    assert all(r["bindings"][0]["feed"] == r["part"] for r in rows)


def test_номер_строки_считается_внутри_своей_половины():
    """По номеру строится имя файла образца, а уникальным оно обязано быть
    внутри той папки, куда ложится."""
    rows = feeds.parse([
        {"part": "train", "bindings": [half_binding("train")]},
        {"part": "val", "bindings": [half_binding("val")]},
        {"part": "train", "bindings": [tags_binding(str(NIGHT))]},
    ])
    assert [(r["part"], r["position"]) for r in rows] == [
        ("train", 0), ("val", 0), ("train", 1)
    ]


def test_без_графа_привязка_остаётся_одна():
    """«Без графа» — пустой конвейер: один вход и один выход. Лишние привязки
    удвоили бы счёт на ровном месте."""
    rows = feeds.parse([{
        "part": "train",
        "graph_version_id": None,
        "bindings": [half_binding("train"), tags_binding(str(NIGHT))],
    }])
    assert len(rows[0]["bindings"]) == 1
    assert rows[0]["bindings"][0]["source_node"] == ""


# --------------------------------------------------------------------------- #
# Счёт по строкам
# --------------------------------------------------------------------------- #
def test_числа_строк_складываются(picked, split_of):
    """Два источника графа получают своё, и общий итог — сумма по ним.

    Образец графа тот же, что читают счёт потока и браузер: ночные кадры
    множатся втрое, дневные идут как есть.
    """
    doc = json.loads((FIXTURES / "two-sources.json").read_text(encoding="utf-8"))["doc"]
    version = uuid.uuid4()
    rows = [{
        "part": "train",
        "position": 0,
        "graph_version_id": version,
        "bindings": [
            {"source_node": "night_src", "feed": "tags", "tag_ids": [NIGHT]},
            {"source_node": "day_src", "feed": "train", "tag_ids": []},
        ],
    }]
    units = feeds.plan_units(rows, {version: doc}.get, picked, split_of)
    by_source = {u["source_node"]: u for u in units}
    # Ночной в обучении один — и он же множится втрое.
    assert by_source["night_src"]["images"] == [picked.images[0]]
    assert by_source["night_src"]["expected"] == 3
    # Обучающая половина целиком — три кадра, идут как есть.
    assert by_source["day_src"]["expected"] == 3
    assert sum(u["expected"] for u in units) == 6


def test_кадр_входит_в_два_источника_одного_графа(picked, split_of):
    """«Обучающая половина» и «таг ночь» пересекаются на первом же ночном
    кадре. Это не ошибка — так и задумано, — но путь по графу у такого кадра
    один и тот же, и имя файла образца обязано различать источники. Номер
    источника для этого и едет в плане.
    """
    doc = json.loads((FIXTURES / "two-sources.json").read_text(encoding="utf-8"))["doc"]
    version = uuid.uuid4()
    rows = [{
        "part": "train",
        "position": 0,
        "graph_version_id": version,
        "bindings": [
            {"source_node": "night_src", "feed": "tags", "tag_ids": [NIGHT]},
            {"source_node": "day_src", "feed": "train", "tag_ids": []},
        ],
    }]
    units = feeds.plan_units(rows, {version: doc}.get, picked, split_of)
    night, day = units[0], units[1]
    assert night["source_index"] != day["source_index"]
    assert night["source_count"] == day["source_count"] == 2
    # Кадр «a» ночной И обучающий — он в обоих источниках сразу.
    a = picked.images[0]
    assert a in night["images"] and a in day["images"]


def test_строка_без_графа_даёт_кадр_к_кадру(picked, split_of):
    rows = feeds.parse([{"part": "train", "bindings": [half_binding("train")]}])
    units = feeds.plan_units(rows, lambda _: None, picked, split_of)
    assert len(units) == 1
    assert units[0]["expected"] == 3
    assert units[0]["source_node"] is None


def test_строки_складываются_на_одном_кадре(picked, split_of):
    """«Все кадры как есть плюс ночные через граф» — обычный набор, и кадр,
    попавший в обе строки, даёт образцы по каждой."""
    doc = json.loads((FIXTURES / "two-sources.json").read_text(encoding="utf-8"))["doc"]
    version = uuid.uuid4()
    rows = [
        {"part": "train", "position": 0, "graph_version_id": None,
         "bindings": [half_binding("train")]},
        {"part": "train", "position": 1, "graph_version_id": version,
         "bindings": [
             {"source_node": "night_src", "feed": "tags", "tag_ids": [NIGHT]},
             {"source_node": "day_src", "feed": "tags", "tag_ids": []},
         ]},
    ]
    units = feeds.plan_units(rows, {version: doc}.get, picked, split_of)
    # Три кадра как есть плюс один ночной, размноженный втрое.
    assert sum(u["expected"] for u in units) == 6
