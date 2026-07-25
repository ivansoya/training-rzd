# Auth service — light image (Flask + SQLAlchemy + psycopg2). Build context is
# backend/ so the shared `common` package can be copied in.
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app

COPY auth_svc/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY common ./common
COPY auth_svc ./auth_svc

EXPOSE 5000
# Apply pending migrations, then serve.
CMD ["sh", "-c", "alembic -c auth_svc/alembic.ini upgrade head && \
     exec gunicorn --bind 0.0.0.0:5000 --workers 2 --threads 4 \
     --timeout 120 --access-logfile - --error-logfile - auth_svc.app:app"]
