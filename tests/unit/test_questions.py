"""Вопросы в разметке: права, место текстом, кому в колокольчик (решения 29.10.2026)."""
from common.questions import TEXT_MAX, clock, open_word, place, text_of, to_new, to_reply
from common.task_rights import can_ask, can_settle

PETR, IVAN, ANNA, OLGA = "petr", "ivan", "anna", "olga"
TEAM = {PETR}


def test_спрашивают_все_кто_видит_кроме_закрытой():
    for status in ("queued", "in_progress", "done", "updating"):
        for role in ("viewer", "editor", "admin"):
            assert can_ask(status, role)
    assert not can_ask("closed", "admin")
    assert not can_ask("in_progress", None)


def test_решают_автор_и_кто_правит_таску():
    for status in ("queued", "in_progress", "done", "updating"):
        assert can_settle(status, "viewer", OLGA, TEAM, OLGA)  # автор-наблюдатель
        assert can_settle(status, "editor", PETR, TEAM, OLGA)  # исполнитель
        assert can_settle(status, "admin", IVAN, TEAM, OLGA)
        assert not can_settle(status, "editor", ANNA, TEAM, OLGA)  # редактор не из таски
        assert not can_settle(status, "viewer", PETR, TEAM, OLGA)  # наблюдатель в составе не правит
    assert not can_settle("closed", "admin", IVAN, TEAM, IVAN)


def test_место_текстом():
    assert place("IMG_1.jpg") == "IMG_1.jpg"
    assert place("cam.mp4", 23_400) == "cam.mp4, 0:23"
    assert place("cam.mp4", 0) == "cam.mp4, 0:00"
    assert clock(3_725_000) == "1:02:05"


def test_текст_сообщения():
    assert text_of("  да  ") == ("да", None)
    assert text_of("   ")[1] == "Напишите текст."
    assert text_of(None)[1] == "Напишите текст."
    assert text_of(5)[1] == "Напишите текст."
    assert text_of("я" * TEXT_MAX)[0]
    assert "2000" in text_of("я" * (TEXT_MAX + 1))[1]


def test_кому_в_колокольчик():
    assert to_new({PETR, ANNA}, IVAN, PETR) == {ANNA}
    assert to_new(set(), IVAN, PETR) == {IVAN}  # ничья таска — автору
    assert to_new(set(), IVAN, IVAN) == set()
    assert to_reply(OLGA, {OLGA, PETR, None}, PETR) == {OLGA}
    assert to_reply(None, {ANNA}, PETR) == {ANNA}


def test_склонение():
    assert [open_word(n) for n in (1, 2, 5, 11, 12, 21, 22, 25, 111)] == [
        "открытый вопрос", "открытых вопроса", "открытых вопросов", "открытых вопросов", "открытых вопросов",
        "открытый вопрос", "открытых вопроса", "открытых вопросов", "открытых вопросов"]
