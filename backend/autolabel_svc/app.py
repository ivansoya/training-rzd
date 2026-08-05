"""Сервис полуавтоматической разметки: пул воркеров с моделями сегментации.

Держит и том (кадры читаются по image_id), и БД (права — по сессионной куке).
Сам инференс живёт в отдельных процессах: веб-процессу нельзя блокироваться на
GPU, а модель нельзя грузить в каждый поток gunicorn.
"""
from flask import Flask
from flask_cors import CORS

from autolabel_svc.routes import bp
from common import config, db

config.ensure_dirs()
db.wait_for_db()

app = Flask(__name__)
CORS(app, supports_credentials=True)
app.register_blueprint(bp)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
