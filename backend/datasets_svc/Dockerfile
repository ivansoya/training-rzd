# Datasets service — light image (no torch / opencv). Build context is backend/
# so the shared `common` package can be copied in.
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app

COPY datasets_svc/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY common ./common
COPY datasets_svc ./datasets_svc

EXPOSE 5000
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "8", \
     "--timeout", "1800", "--access-logfile", "-", "--error-logfile", "-", \
     "datasets_svc.app:app"]
