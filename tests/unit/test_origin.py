"""Проверка Origin против CSRF: своя страница проходит, соседний порт и поддомен — нет."""
from common.origin import allowed


def test_свой_origin_проходит():
    assert allowed("http://localhost:8080", "localhost:8080")
    assert allowed("http://localhost:5173", "localhost:5173")


def test_referer_сравнивается_по_origin():
    assert allowed("http://localhost:8080/projects/X/tasks", "localhost:8080")


def test_соседний_порт_и_поддомен_отклоняются():
    assert not allowed("http://localhost:3000", "localhost:8080")
    assert not allowed("https://evil.example.com", "app.example.com")
    assert not allowed("https://sub.app.example.com", "app.example.com")


def test_null_и_мусор_отклоняются():
    assert not allowed("null", "localhost:8080")
    assert not allowed("localhost:8080", "localhost:8080")


def test_без_заголовков_не_браузер():
    assert allowed(None, "localhost:8080")
