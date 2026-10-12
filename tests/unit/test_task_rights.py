"""Права в таске по состоянию: таблица случаев решения 12.10.2026."""
from common.task_rights import can_edit, can_fill, can_tag_frame, joins_on_take, moves

PETR, IVAN, ANNA = "petr", "ivan", "anna"
TEAM = {PETR}


def test_на_очереди_не_правит_никто_даже_админ():
    assert not can_edit("queued", "admin", IVAN, TEAM)
    assert not can_edit("queued", "editor", PETR, TEAM)


def test_в_работе_правят_исполнители_и_админ():
    for status in ("in_progress", "updating"):
        assert can_edit(status, "editor", PETR, TEAM)
        assert can_edit(status, "admin", IVAN, TEAM)
        assert not can_edit(status, "editor", ANNA, TEAM)


def test_зритель_исполнителем_не_работает():
    assert not can_edit("in_progress", "viewer", PETR, TEAM)
    assert moves("in_progress", "viewer", PETR, TEAM) == set()


def test_готово_и_закрыто_заморожены():
    for status in ("done", "closed"):
        assert not can_edit(status, "admin", IVAN, TEAM)
        assert not can_fill(status, "admin", IVAN, TEAM, IVAN)


def test_на_очереди_наполняют_исполнители_автор_и_админ():
    assert can_fill("queued", "editor", PETR, TEAM, IVAN)
    assert can_fill("queued", "editor", ANNA, set(), ANNA)
    assert can_fill("queued", "admin", IVAN, TEAM, PETR)
    assert not can_fill("queued", "editor", ANNA, TEAM, IVAN)


def test_в_работе_автор_без_назначения_не_наполняет():
    assert not can_fill("in_progress", "editor", ANNA, TEAM, ANNA)


def test_таги_кадра_админ_правит_всегда():
    assert can_tag_frame("closed", "admin", IVAN, set())
    assert not can_tag_frame("done", "editor", PETR, TEAM)


def test_ничью_с_очереди_берёт_любой_редактор():
    assert moves("queued", "editor", ANNA, set()) == {"in_progress"}
    assert joins_on_take("queued", "in_progress", set())


def test_назначенную_берут_только_её_люди():
    assert moves("queued", "editor", ANNA, TEAM) == set()
    assert moves("queued", "editor", PETR, TEAM) == {"in_progress"}
    assert not joins_on_take("queued", "in_progress", TEAM)


def test_закрывает_только_админ():
    for status in ("queued", "in_progress", "done", "updating"):
        assert "closed" not in moves(status, "editor", PETR, TEAM)
        assert "closed" in moves(status, "admin", IVAN, TEAM)


def test_исполнитель_сдаёт_возвращает_и_ставит_на_паузу():
    assert moves("in_progress", "editor", PETR, TEAM) == {"done", "queued"}
    assert moves("done", "editor", PETR, TEAM) == {"updating"}
    assert moves("done", "editor", ANNA, TEAM) == set()
