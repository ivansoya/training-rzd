# Datasets service — light image (no torch / opencv). Build context is backend/
# so the shared `common` package can be copied in.
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app

# Копии ступеней на видеокарте: в PyAV кодировщика NVENC нет, в ffmpeg Debian есть (и scale_cuda).
# Образ тяжелее на ~630 МБ — решение 20.10.2026, статическая сборка весила бы 172 МБ.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY datasets_svc/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY common ./common
COPY datasets_svc ./datasets_svc

EXPOSE 5000
# Образ обслуживает два контейнера: сам сервис и воркер видео, который
# поднимается тем же образом с командой `python -m datasets_svc.worker`.
#
# Потоков много, потому что теперь они только ждут: перекодирование уехало в
# воркер, а здесь остались запросы к базе и отдача готовых файлов. Раньше их
# было восемь, и восьми одновременных нарезок хватало, чтобы сервис перестал
# отвечать и на список тасок, и на сохранение бокса.
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "32", \
     "--timeout", "1800", "--access-logfile", "-", "--error-logfile", "-", \
     "datasets_svc.app:app"]
