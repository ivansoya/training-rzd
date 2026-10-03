"""Общее для HTTP-слоя всех сервисов: ошибки в JSON и разбор ввода.

`InputError` из любого обработчика превращается в 400 с текстом по-русски и
полем формы; прочие исключения — в JSON 500 без подробностей, полный текст в
журнал. Клиент (`api/http.ts`) читает `error`, `code` и `errors`.
"""
import json
import logging
import math
import re

from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException

log = logging.getLogger(__name__)

HTTP_TEXT = {
    400: "Неверный запрос.",
    401: "Нужно войти.",
    403: "Недостаточно прав.",
    404: "Не найдено.",
    405: "Метод не поддерживается.",
    409: "Конфликт с текущим состоянием.",
    413: "Слишком большой запрос.",
    415: "Неподдерживаемый формат запроса.",
    429: "Слишком много запросов.",
}
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class InputError(Exception):
    """Негодный ввод: 400 (или `status`) с сообщением и, если есть, полем формы."""

    def __init__(self, message, field=None, status=400):
        super().__init__(message)
        self.message = message
        self.field = field
        self.status = status


def register_json_errors(app: Flask) -> None:
    @app.errorhandler(InputError)
    def _input(exc):
        body = {"error": exc.message, "code": "invalid"}
        if exc.field:
            body["errors"] = {exc.field: exc.message}
        return jsonify(body), exc.status

    @app.errorhandler(HTTPException)
    def _http(exc):
        text = HTTP_TEXT.get(exc.code) or exc.description or exc.name
        return jsonify({"error": text, "code": exc.name.lower().replace(" ", "_")}), exc.code

    @app.errorhandler(Exception)
    def _crash(exc):
        log.exception("Необработанная ошибка в %s %s", request.method, request.path)
        return jsonify({
            "error": "Внутренняя ошибка сервера. Подробности — в журнале сервиса.",
            "code": "internal",
        }), 500


def _no_constants(name):
    raise ValueError(name)


def json_body() -> dict:
    """Тело запроса как объект. Пустое тело — `{}`; не объект, NaN, мусор — 400."""
    raw = request.get_data(cache=True)
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw, parse_constant=_no_constants)
    except (ValueError, UnicodeDecodeError):
        raise InputError("Тело запроса — не JSON.")
    if not isinstance(data, dict):
        raise InputError("Тело запроса должно быть JSON-объектом.")
    return data


def str_field(data, key, *, max_len, required=False, default="", label=None,
              strip=True):
    value = data.get(key)
    if value is None:
        value = default
    if not isinstance(value, str):
        raise InputError(f"{label or key}: ожидается строка.", key)
    if strip:
        value = value.strip()
    if required and not value:
        raise InputError(f"{label or key}: поле не заполнено.", key)
    if len(value) > max_len:
        raise InputError(f"{label or key}: длиннее {max_len} символов.", key)
    return value


def int_field(data, key, *, lo=None, hi=None, default=None, required=False, label=None):
    value = data.get(key)
    if value is None or value == "":
        if required:
            raise InputError(f"{label or key}: поле не заполнено.", key)
        return default
    if isinstance(value, bool):
        raise InputError(f"{label or key}: ожидается целое число.", key)
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, str) and re.fullmatch(r"\s*-?\d+\s*", value):
        value = int(value)
    if not isinstance(value, int):
        raise InputError(f"{label or key}: ожидается целое число.", key)
    if (lo is not None and value < lo) or (hi is not None and value > hi):
        span = (f"от {lo} до {hi}" if lo is not None and hi is not None
                else f"не меньше {lo}" if lo is not None else f"не больше {hi}")
        raise InputError(f"{label or key}: допустимо {span}.", key)
    return value


def color_field(data, key, *, default=None, label=None):
    value = data.get(key)
    if value is None:
        return default
    if not isinstance(value, str) or not COLOR_RE.match(value):
        raise InputError(f"{label or key}: цвет в виде #rrggbb.", key)
    return value.lower()


def finite(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) \
        and math.isfinite(value)


def public_error(exc, fallback="Не получилось. Подробности — в журнале сервиса."):
    """Текст чужого исключения (SQL, пути тома, errno) — в журнал, человеку — фраза."""
    log.error("%s: %s", fallback, exc, exc_info=exc)
    return fallback
