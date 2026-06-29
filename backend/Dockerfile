FROM python:3.12-slim

WORKDIR /app

# opencv-python-headless still needs libGL/libglib at runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# torch build is selected at build time. Default is the CPU wheel; for GPU pass
#   --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cu121
# (the CUDA wheels bundle the CUDA runtime, so no CUDA base image is needed).
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir torch==2.3.1 torchvision==0.18.1 \
    --index-url ${TORCH_INDEX_URL}

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ffmpeg encodes browser-friendly H.264 video for inference output (kept in a
# separate layer so the heavy torch/ultralytics layers above stay cached).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY app.py augmentations.py jobs.py training.py train_runner.py inference.py ./

EXPOSE 5000

# A single worker (with threads) so the in-memory training state is shared by
# all requests; background threads run uploads/augmentation/training.
#  - long timeout for large dataset extraction / augmentation passes
#  - access/error logs to stdout so requests are visible in `docker logs`
CMD ["gunicorn", "--bind", "0.0.0.0:5000", \
     "--workers", "1", "--threads", "8", "--timeout", "1800", \
     "--access-logfile", "-", "--error-logfile", "-", \
     "app:app"]
