"""Агент на кадре таски: ничего не положил — предлагает «пустой» на подтверждение человеку.

База подменена: проверяется только решение `_write`, без PostgreSQL и моделей.
"""
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from training_svc import agent_runner

CLASS_ID = str(uuid.uuid4())


class _Result:
    def __init__(self, rows):
        self.rows = rows

    def scalar(self):
        return None

    def scalars(self):
        return self

    def all(self):
        return self.rows


class _Db:
    """Аннотации кадра до записи (`rows`) и что останется на нём после (`left`)."""

    def __init__(self, rows=(), left=None):
        self.rows, self.left, self.added = list(rows), left, []

    def execute(self, _stmt):
        return _Result(self.rows)

    def scalar(self, _stmt):
        return self.added[0].id if self.added else self.left

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        pass


def frame(status="new"):
    return SimpleNamespace(id=uuid.uuid4(), task_status=status, agent_empty=False, annotations_rev=1, width=640, height=480)


def write(db, image, found, mapping, propose_empty=True):
    run = SimpleNamespace(version_id=uuid.uuid4(), created_by=uuid.uuid4())
    with patch.object(agent_runner, "_settle", lambda _db, _model, _rows, got, _mapping: got):
        return agent_runner._write(db, run, image, found, mapping, propose_empty=propose_empty)


def det(cls="person", box=(10, 10, 50, 80)):
    return {"cls": cls, "box": list(box), "conf": 0.9}


def test_ничего_не_нашёл_кадр_ждёт_подтверждения_пустоты():
    image = frame()
    assert write(_Db(), image, [], {"person": CLASS_ID}) == 0
    assert image.agent_empty and image.task_status == "new"
    assert image.annotations_rev == 2


@pytest.mark.parametrize("found, mapping", [
    ([det("sky")], {"person": CLASS_ID, "sky": None}),  # класс сопоставлен с «не размечать»
    ([det(box=(700, 700, 10, 10))], {"person": CLASS_ID}),  # фигура целиком за краем кадра
])
def test_находки_отсеялись_кадр_тоже_ждёт_подтверждения(found, mapping):
    image = frame()
    assert write(_Db(), image, found, mapping) == 0
    assert image.agent_empty and image.task_status == "new"


def test_рамка_на_проверку_снимает_предложение_пустоты():
    image = frame(); image.agent_empty = True
    db = _Db()
    assert write(db, image, [det()], {"person": CLASS_ID}) == 1
    assert not image.agent_empty and db.added[0].pending


def test_на_кадре_осталась_чужая_разметка_пустоту_не_предлагает():
    image = frame()
    human = SimpleNamespace(id=uuid.uuid4(), pending=False, class_id=CLASS_ID, ann_type="bbox", geometry={}, attributes={})
    assert write(_Db(rows=[human], left=human.id), image, [], {"person": CLASS_ID}) == 0
    assert not image.agent_empty


def test_вне_таски_и_не_на_новом_кадре_пустоту_не_предлагает():
    outside = frame()
    write(_Db(), outside, [], {"person": CLASS_ID}, propose_empty=False)
    skipped = frame("skipped")
    write(_Db(), skipped, [], {"person": CLASS_ID})
    assert not outside.agent_empty and not skipped.agent_empty
