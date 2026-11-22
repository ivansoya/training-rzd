FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app YOLO_AUTOINSTALL=False
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cpu
# Versions used together on Voran. The toolkit wheel declares older torch/numpy bounds.
RUN pip install --no-cache-dir ultralytics==8.4.18 numpy==2.1.3 onnx==1.17.0 onnxruntime==1.20.1 onnxslim==0.1.80 protobuf==4.25.4 ruamel.yaml fast-histogram tqdm \
    && pip install --no-cache-dir --no-deps rknn-toolkit2==2.3.0
COPY common ./common
COPY rknn_svc ./rknn_svc
CMD ["python", "-m", "rknn_svc.worker"]
