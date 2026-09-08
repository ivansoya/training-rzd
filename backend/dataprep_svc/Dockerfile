# Подготовка данных: albumentations и opencv, без torch. Признаки кадров
# считает воркер обучения — тащить сюда три гигабайта ради одной работы
# незачем.
#
# Контекст сборки — backend/, чтобы попал общий пакет `common`.
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app

# Библиотеки времени выполнения для opencv.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY dataprep_svc/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY common ./common
COPY dataprep_svc ./dataprep_svc

EXPOSE 5000
# Потоков шестнадцать, а не тридцать два: тяжёлое отсюда ушло в воркер, и
# столько потоков здесь просто нечем занять.
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "16", \
     "--timeout", "600", "--access-logfile", "-", "--error-logfile", "-", \
     "dataprep_svc.app:app"]
