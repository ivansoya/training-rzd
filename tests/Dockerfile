# Тестовый прогон: pytest, vitest и Playwright в одном образе.
#
# База — образ Playwright: в нём уже стоят браузеры и их системные зависимости,
# а собрать их самому дольше, чем скачать. Python доезжает сверху.
#
# Образ только для разработки. В docker-compose он под профилем `dev` и без
# явного `--profile dev` не поднимается: тесты ходят в живой бэкенд и создают
# там данные, чему в бою делать нечего.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /work

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
RUN pip3 install --no-cache-dir -r requirements.txt

# Playwright той же версии, что браузеры в образе. Кладём в сторону, а не в
# каталог тестов: он монтируется с хоста, и node_modules там были бы мусором в
# репозитории. Перед прогоном содержимое раскатывается в свой том — офлайн.
RUN mkdir -p /opt/e2e \
    && cd /opt/e2e \
    && npm init -y > /dev/null \
    && npm install --no-audit --no-fund @playwright/test@1.49.1

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Прогоны читают исходники из примонтированных каталогов, а не из образа:
    # правку теста видно сразу, пересборка не нужна.
    PYTHONPATH=/work/tests:/work/backend \
    NODE_PATH=/work/frontend/node_modules

EXPOSE 8090
CMD ["python3", "-u", "/work/tests/runner/app.py"]
