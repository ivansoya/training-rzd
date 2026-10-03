"""Защита от CSRF: меняющий запрос из браузера принимается только со своей страницы.

SPA и API живут на одном origin за nginx (и за vite-прокси в разработке), поэтому
CORS не нужен вовсе. Своим считается origin, чей host:port совпадает с `Host`
запроса (nginx передаёт его с портом), плюс белый список `APP_ORIGINS` через запятую.
"""
import os
from urllib.parse import urlsplit

from flask import Flask, jsonify, request

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
EXTRA = {
    o.strip().rstrip("/").lower()
    for o in os.environ.get("APP_ORIGINS", "").split(",")
    if o.strip()
}


def _origin_of(url: str) -> tuple[str, str] | None:
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if not parts.scheme or not parts.netloc:
        return None
    return parts.scheme.lower(), parts.netloc.lower()


def allowed(source: str | None, host: str) -> bool:
    """Чистая проверка: `source` — Origin или Referer, `host` — Host запроса."""
    # Ни Origin, ни Referer — не браузер (curl, тесты): CSRF без браузера не бывает.
    if source is None:
        return True
    origin = _origin_of(source)
    if origin is None:  # «null» из песочницы, мусор
        return False
    scheme, netloc = origin
    return netloc == host.lower() or f"{scheme}://{netloc}" in EXTRA


def guard(app: Flask) -> None:
    @app.before_request
    def _same_origin():
        if request.method in SAFE_METHODS:
            return None
        source = request.headers.get("Origin") or request.headers.get("Referer")
        if allowed(source, request.host):
            return None
        return jsonify({"error": "Запрос с чужой страницы отклонён.", "code": "cross_origin"}), 403
