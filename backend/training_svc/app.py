"""Сервис обучения: раны, железо и живая связь.

Тяжёлое отсюда ушло в воркер, а состояние — в базу. Ради этого и затевалось:
пока состояние жило в памяти процесса, у сервиса стоял один рабочий процесс,
и тридцать две открытые вкладки останавливали раздел всем. Теперь процессов
может быть сколько угодно.
"""
from flask import Flask
from flask_cors import CORS

from common import config, live
from common.db import wait_for_db
from training_svc.routes import bp

wait_for_db()
config.ensure_dirs()
# Слушатель поднимается лениво, на первой подписке: процессу, который за день
# не отдал ни одного потока событий, соединение к базе ни к чему.

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = None
CORS(app)
app.register_blueprint(bp)


@app.after_request
def whose(response):
    """Кто ответил. Маршрутизация в nginx идёт регулярками по порядку, и
    ошибка в порядке уводит запрос в соседний сервис — тот отвечает 404, а в
    логах нужного нет ни строчки."""
    response.headers["X-Served-By"] = "training"
    return response


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
