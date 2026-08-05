# Сервис полуавтоматической разметки: SAM2 на GPU. Контекст сборки — backend/.
#
# Торч тут свежее, чем в training_svc (2.3.1+cu121): карты Blackwell (RTX 50xx,
# sm_120) не поддерживаются колёсами cu121 — на них ядра просто не запускаются.
FROM python:3.12-slim

WORKDIR /app

# opencv-python-headless просит libGL/libglib в рантайме; git — чтобы поставить
# sam2 из репозитория.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 git \
    && rm -rf /var/lib/apt/lists/*

# GPU обязателен: CPU-пути у полуавтоматической разметки нет.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128
RUN pip install --no-cache-dir torch==2.7.1 torchvision==0.22.1 \
    --index-url ${TORCH_INDEX_URL}

COPY autolabel_svc/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app
COPY common ./common
COPY autolabel_svc ./autolabel_svc

EXPOSE 5000
# Один веб-процесс: реестр сессий и дескрипторы воркеров живут в его памяти.
# Потоков много — запросы к модели ждут ответа из очереди, а не считают сами.
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "32", \
     "--timeout", "600", "--access-logfile", "-", "--error-logfile", "-", \
     "autolabel_svc.app:app"]
