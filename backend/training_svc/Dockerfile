# Обучение и агенты разметки (torch / ultralytics / ffmpeg). Контекст сборки — backend/.
# Инструкции до слоя торча совпадают с autolabel_svc/Dockerfile дословно: слой собирается один раз на оба образа.
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 git \
    && rm -rf /var/lib/apt/lists/*

# cu128: RTX 30 (sm_86, им же исполняется sm_89 у RTX 40) и RTX 50 (sm_120); драйвер от 570.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128
RUN pip install --no-cache-dir torch==2.7.1 torchvision==0.22.1 \
    --index-url ${TORCH_INDEX_URL}

# Веса «Сети по тексту» агента: YOLOE-26 s/m/l/x и кодировщик промтов, ~0,6 ГБ.
# Слой до зависимостей и кода: зависит только от скрипта, и правка
# requirements его не перекачивает. SAM 3 сюда не входит — 3,45 ГБ, живёт на
# томе (common/config.py, SAM3_WEIGHTS).
COPY training_svc/fetch_yoloe.py /tmp/fetch_yoloe.py
RUN python /tmp/fetch_yoloe.py /opt/yoloe && rm /tmp/fetch_yoloe.py

COPY training_svc/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Токенизатор промтов YOLOE и SAM 3 — пакет clip из форка ultralytics, архивом, без клона репозитория.
RUN pip install --no-cache-dir --no-deps https://github.com/ultralytics/CLIP/archive/refs/heads/main.zip

# SAM2 для узла «Уточнение SAM» агента разметки — тот же пакет, что у
# полуавтомата, чтобы одна рамка давала один контур. Без зависимостей и без
# изолированной сборки — иначе pip качает второй torch на гигабайты.
# CUDA-расширение sam2 нужно только для заливки дыр внутри самой модели, а
# SAM2ImagePredictor по умолчанию её не делает (max_hole_area=0).
RUN pip install --no-cache-dir setuptools wheel tqdm "hydra-core>=1.3.2" "iopath>=0.1.10" \
    && SAM2_BUILD_CUDA=0 pip install --no-cache-dir --no-deps --no-build-isolation \
       https://github.com/facebookresearch/sam2/archive/refs/heads/main.zip

# ffmpeg encodes browser-friendly H.264 video for inference output.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app
COPY common ./common
COPY training_svc ./training_svc

EXPOSE 5000
# Два рабочих процесса и много потоков. Раньше стоял один — состояние жило в
# его памяти, и второй процесс отвечал бы «не найдено» на половину запросов.
# Теперь состояние в базе, и потолок мест живой связи считается отсюда:
# GUNICORN_THREADS минус запас под обычные запросы (см. common/live.py).
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--threads", "48",      "--timeout", "1800", "--access-logfile", "-", "--error-logfile", "-",      "training_svc.app:app"]
