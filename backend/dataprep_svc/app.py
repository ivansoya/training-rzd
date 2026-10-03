"""Сервис подготовки данных: графы аугментаций и обучающие наборы.

Ручки тонкие. Всё тяжёлое — сборка набора, счёт признаков — уходит в очередь
в базе, а делает его отдельный процесс. Тот же уклад, что у видео, и по той же
причине: пул потоков, обслуживающий списки и превью, не должен уходить на
минуты в перекладывание гигабайтов.
"""
from flask import Flask

from common import config, origin, web
from common.db import wait_for_db
from dataprep_svc.routes import bp

wait_for_db()
config.ensure_dirs()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = None
origin.guard(app)
web.register_json_errors(app)
web.served_by(app, "dataprep")
app.register_blueprint(bp)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
