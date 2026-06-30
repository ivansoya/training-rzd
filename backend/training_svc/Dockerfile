# Training + inference service (torch / ultralytics / ffmpeg). The leading
# instructions are kept identical to the previous monolith Dockerfile so the
# heavy torch layer is reused from the build cache. Build context is backend/.
FROM python:3.12-slim

WORKDIR /app

# opencv-python-headless still needs libGL/libglib at runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# torch build is selected at build time. Default is the CPU wheel; for GPU pass
#   --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cu121
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir torch==2.3.1 torchvision==0.18.1 \
    --index-url ${TORCH_INDEX_URL}

COPY training_svc/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# ffmpeg encodes browser-friendly H.264 video for inference output.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app
COPY common ./common
COPY training_svc ./training_svc

EXPOSE 5000
# One worker (video/inference state lives in-memory and must be shared) with a
# large thread pool so slow streaming/thumbnail requests are served in parallel
# instead of blocking each other. Shared state is guarded by locks in routes.py.
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "32", \
     "--timeout", "1800", "--access-logfile", "-", "--error-logfile", "-", \
     "training_svc.app:app"]
