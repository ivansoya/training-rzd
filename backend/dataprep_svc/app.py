"""Сервис подготовки данных: графы аугментаций и обучающие наборы.

Ручки тонкие. Всё тяжёлое — сборка набора, счёт признаков — уходит в очередь
в базе, а делает его отдельный процесс. Тот же уклад, что у видео, и по той же
причине: пул потоков, обслуживающий списки и превью, не должен уходить на
минуты в перекладывание гигабайтов.
"""
from flask import Flask
from flask_cors import CORS

from common import config
from common.db import wait_for_db
from dataprep_svc.routes import bp

wait_for_db()
config.ensure_dirs()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = None
CORS(app)
app.register_blueprint(bp)


@app.after_request
def whose(response):
    """Кто ответил.

    Не отладочная мелочь: маршрутизация в nginx идёт регулярками по порядку, и
    ошибка в порядке уводит запрос в соседний сервис, который отвечает 404 —
    а в логах нужного сервиса при этом нет ни строчки. С этим заголовком
    вопрос «куда ушёл мой запрос» закрывается за секунду.
    """
    response.headers["X-Served-By"] = "dataprep"
    return response


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
