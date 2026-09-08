"""Форма графа и счёт потока по проводам.

Образцы графов лежат в ``tests/fixtures/graphs`` и читаются ДВАЖДЫ: отсюда и
из клиентской проверки на vitest. Это не удобство, а страховка: числа на
проводах считают и сервер, и браузер, и разойтись им нельзя — человек увидел
бы одно, а собрал другое.
"""
import json
import pathlib

import pytest

from dataprep_svc.graph import plan, schema
from dataprep_svc.graph.schema import GraphError

FIXTURES = pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "graphs"


def load(name):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def loader_for(fixture):
    graphs = fixture.get("graphs") or {}
    return lambda graph_id, version_id: graphs.get(version_id)


ALL = sorted(p.stem for p in FIXTURES.glob("*.json"))


# --------------------------------------------------------------------------- #
# Счёт по образцам
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("name", ALL)
def test_поток_считается_как_обещано(name):
    fixture = load(name)
    got = plan.counts(
        fixture["doc"], fixture["base"], loader_for(fixture)
    )
    want = fixture["expect"]
    assert got["outputs"] == pytest.approx(want["outputs"])
    assert got["dropped"] == pytest.approx(want["dropped"])
    assert got["multiplier"] == pytest.approx(want["multiplier"])
    assert got["nodes"] == want["nodes"]
    for wire, value in (want.get("edges") or {}).items():
        assert got["edges"][wire] == pytest.approx(value), wire


@pytest.mark.parametrize("name", ALL)
def test_форма_образцов_принимается(name):
    fixture = load(name)
    loader = loader_for(fixture)
    for doc in (fixture.get("graphs") or {}).values():
        schema.check(doc, root=False)
    # Гнёзда блока объявлены во вложенной версии — форма сама их знать не
    # может и просит отдельным доводом.
    schema.check(
        fixture["doc"],
        group_ports=plan.group_ports_for(fixture["doc"], loader),
    )


def test_умножение_и_доли_сходятся():
    """Сумма по веткам разделителя равна входу: он делит поток, а не множит."""
    got = plan.counts(load("shares")["doc"], 1000)
    assert (
        got["edges"]["cut:o0->a:in"]
        + got["edges"]["cut:o1->b:in"]
        + got["dropped"]
    ) == pytest.approx(1000)


def test_ветвление_из_гнезда_дублирует_поток():
    """Из одного гнезда можно вести сколько угодно проводов — как в любом
    нодовом редакторе. Тот же образец уходит в обе стороны, и сумма на выходах
    поэтому больше входа."""
    got = plan.counts(load("vagony")["doc"], 1040)
    assert got["edges"]["src:out->mul:in"] == 1040
    assert got["edges"]["src:out->orig:in"] == 1040
    assert got["outputs"] == 4160


# --------------------------------------------------------------------------- #
# Что граф обязан отвергнуть
# --------------------------------------------------------------------------- #
def two_nodes(**over):
    doc = {
        "nodes": [
            {"id": "s", "type": "source"},
            {"id": "e", "type": "output"},
        ],
        "edges": [{"from": "s", "out": "out", "to": "e", "in": "in"}],
    }
    doc.update(over)
    return doc


def test_простейший_граф_проходит():
    schema.check(two_nodes())


def test_без_источника_не_принимается():
    doc = two_nodes()
    doc["nodes"] = [{"id": "e", "type": "output"}]
    doc["edges"] = []
    with pytest.raises(GraphError, match="Источник"):
        schema.check(doc)


def test_двух_источников_не_бывает():
    doc = two_nodes()
    doc["nodes"].append({"id": "s2", "type": "source"})
    doc["edges"].append({"from": "s2", "out": "out", "to": "e", "in": "in"})
    with pytest.raises(GraphError, match="ровно один"):
        schema.check(doc)


def test_без_выхода_собирать_нечего():
    doc = {
        "nodes": [{"id": "s", "type": "source"}],
        "edges": [],
    }
    with pytest.raises(GraphError, match="Выхода"):
        schema.check(doc)


def test_в_одно_гнездо_два_провода_нельзя():
    """Два потока, слитые молча, — это «Слияние», и оно обязано быть видимым
    узлом: иначе сумма на проводе перестаёт объясняться картинкой."""
    doc = {
        "nodes": [
            {"id": "s", "type": "source"},
            {"id": "m", "type": "multiply", "params": {"times": 2}},
            {"id": "e", "type": "output"},
        ],
        "edges": [
            {"from": "s", "out": "out", "to": "e", "in": "in"},
            {"from": "m", "out": "out", "to": "e", "in": "in"},
        ],
    }
    with pytest.raises(GraphError, match="два провода"):
        schema.check(doc)


def test_висящий_вход_называется_поимённо():
    doc = {
        "nodes": [
            {"id": "s", "type": "source"},
            {"id": "m", "type": "merge", "params": {"label": "Слияние"}},
            {"id": "e", "type": "output"},
        ],
        "edges": [
            {"from": "s", "out": "out", "to": "m", "in": "i0"},
            {"from": "m", "out": "out", "to": "e", "in": "in"},
        ],
    }
    with pytest.raises(GraphError) as err:
        schema.check(doc)
    assert "Слияние" in str(err.value)
    assert "i1" in str(err.value)


def test_кольцо_показывается_путём():
    """«Где-то кольцо» на графе из шестидесяти узлов бесполезно."""
    doc = {
        "nodes": [
            {"id": "s", "type": "source"},
            {"id": "a", "type": "flow", "params": {"label": "Туман"}},
            {"id": "b", "type": "flow", "params": {"label": "Шум"}},
            {"id": "m", "type": "merge", "params": {"inputs": 2}},
            {"id": "e", "type": "output"},
        ],
        "edges": [
            {"from": "s", "out": "out", "to": "m", "in": "i0"},
            {"from": "m", "out": "out", "to": "a", "in": "in"},
            {"from": "a", "out": "out", "to": "b", "in": "in"},
            {"from": "b", "out": "out", "to": "m", "in": "i1"},
            {"from": "a", "out": "out", "to": "e", "in": "in"},
        ],
    }
    with pytest.raises(GraphError) as err:
        schema.check(doc)
    text = str(err.value)
    assert "кольцо" in text
    assert "Туман" in text and "Шум" in text


def test_вход_бывает_только_у_блока():
    doc = {
        "nodes": [
            {"id": "s", "type": "source"},
            {"id": "i", "type": "input"},
            {"id": "e", "type": "output"},
        ],
        "edges": [
            {"from": "s", "out": "out", "to": "e", "in": "in"},
            {"from": "i", "out": "out", "to": "e", "in": "in"},
        ],
    }
    with pytest.raises(GraphError):
        schema.check(doc)


def test_у_блока_обязан_быть_вход():
    doc = {
        "nodes": [{"id": "e", "type": "output"}],
        "edges": [],
    }
    with pytest.raises(GraphError, match="Вход"):
        schema.check(doc, root=False)


# --------------------------------------------------------------------------- #
# Блоки
# --------------------------------------------------------------------------- #
def test_один_блок_вставленный_дважды_считается_дважды():
    fixture = load("block")
    nodes, edges = plan.expand(fixture["doc"], loader_for(fixture))
    ids = {n["id"] for n in nodes}
    assert "g1/x2" in ids and "g2/x2" in ids
    assert not any(n["type"] == "group" for n in nodes)


def test_гнёзда_блока_становятся_пустыми_узлами():
    fixture = load("block")
    nodes, _ = plan.expand(fixture["doc"], loader_for(fixture))
    boundary = [n for n in nodes if n["id"].endswith(("/in1", "/o1"))]
    assert boundary
    assert all(n["type"] == "flow" for n in boundary)


def test_пропавший_блок_называется_поимённо():
    fixture = load("block")
    with pytest.raises(GraphError, match="Блок А"):
        plan.expand(fixture["doc"], lambda *_: None)


def test_глубина_вложения_ограничена():
    """Блок, вставляющий сам себя, — кольцо, которого не видно на холсте."""
    inner = {
        "nodes": [
            {"id": "i", "type": "input", "params": {"name": "in"}},
            {"id": "g", "type": "group",
             "params": {"graph_id": "g", "version_id": "v"}},
            {"id": "o", "type": "output", "params": {"name": "out"}},
        ],
        "edges": [
            {"from": "i", "out": "out", "to": "g", "in": "in"},
            {"from": "g", "out": "out", "to": "o", "in": "in"},
        ],
    }
    doc = {
        "nodes": [
            {"id": "s", "type": "source"},
            {"id": "g", "type": "group",
             "params": {"graph_id": "g", "version_id": "v"}},
            {"id": "e", "type": "output"},
        ],
        "edges": [
            {"from": "s", "out": "out", "to": "g", "in": "in"},
            {"from": "g", "out": "out", "to": "e", "in": "in"},
        ],
    }
    with pytest.raises(GraphError, match="глубже"):
        plan.expand(doc, lambda *_: inner)


# --------------------------------------------------------------------------- #
# Порядок обхода
# --------------------------------------------------------------------------- #
def test_порядок_обхода_повторяем():
    """План обязан быть одинаковым от запуска к запуску, иначе «пересобрать
    так же» перестаёт работать."""
    fixture = load("vagony")
    nodes, edges = plan.expand(fixture["doc"], loader_for(fixture))
    first = plan.topo(nodes, edges)
    shuffled = list(reversed(nodes))
    second = plan.topo(shuffled, list(reversed(edges)))
    assert first == second
