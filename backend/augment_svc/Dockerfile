# Augmentation service — needs albumentations + opencv (no torch). Build context
# is backend/ so the shared `common` package can be copied in.
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app

# opencv runtime libs
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY augment_svc/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY common ./common
COPY augment_svc ./augment_svc

EXPOSE 5000
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "8", \
     "--timeout", "1800", "--access-logfile", "-", "--error-logfile", "-", \
     "augment_svc.app:app"]
