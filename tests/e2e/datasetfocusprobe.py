"""Данные для datasetfocusprobe.mjs: датасет из шести кадров, один кадр — копией в живой таске,
на одном — непроверенная рамка агента. Всё с приставкой `test-` — раннер тестов сотрёт.
docker exec -w /work/tests/e2e yolo-tests python3 datasetfocusprobe.py
"""
import io
import json
import os
import time

import psycopg2
import requests
from PIL import Image

BASE = os.environ.get("TEST_BASE_URL", "http://frontend")
DSN = os.environ.get("TEST_DB_DSN", "postgresql://app:app@db:5432/app")
db = psycopg2.connect(DSN)
db.autocommit = True
stamp = str(int(time.time()))

login = f"test-ds-{stamp}"
s = requests.Session()
s.post(f"{BASE}/api/auth/register", json={"email": f"{login}@example.test", "login": login,
                                          "display_name": "Проба Датасета", "password": "Test-Passw0rd"}).raise_for_status()
with db.cursor() as cur:
    cur.execute("UPDATE users SET email_confirmed_at = now() WHERE login = %s", (login,))
s.post(f"{BASE}/api/auth/login", json={"identity": login, "password": "Test-Passw0rd"}).raise_for_status()

code = s.post(f"{BASE}/api/projects", json={"name": f"test-датасет-{stamp}"}).json()["code"]
wagon = s.post(f"{BASE}/api/projects/{code}/classes", json={"name": "вагон"}).json()
s.post(f"{BASE}/api/projects/{code}/classes", json={"name": "опора"}).raise_for_status()

source = s.post(f"{BASE}/api/projects/{code}/tasks", json={"name": "Источник"}).json()
s.post(f"{BASE}/api/tasks/{source['id']}/status", json={"status": "in_progress"}).raise_for_status()
for i in range(6):
    buf = io.BytesIO()
    Image.new("RGB", (960, 540), (30 + i * 30, 60, 120 - i * 10)).save(buf, "JPEG")
    buf.seek(0)
    s.post(f"{BASE}/api/tasks/{source['id']}/images",
           files={"files": (f"кадр-{i + 1}.jpg", buf, "image/jpeg")}).raise_for_status()
frames = sorted(s.get(f"{BASE}/api/tasks/{source['id']}/images").json()["images"], key=lambda x: x["file_name"])
for i, f in enumerate(frames):
    boxes = [{"class_index": wagon["class_index"], "x": 100 + i * 40, "y": 120, "w": 220, "h": 160}]
    s.put(f"{BASE}/api/images/{f['id']}/annotations", json={"boxes": boxes}).raise_for_status()
s.post(f"{BASE}/api/tasks/{source['id']}/status", json={"status": "done"}).raise_for_status()

# Кадр 5 — копией в живой таске; кадр 4 — с непроверенной рамкой агента
held = s.post(f"{BASE}/api/projects/{code}/tasks", json={"name": "Держит", "image_ids": [frames[4]["id"]]}).json()
s.post(f"{BASE}/api/tasks/{held['id']}/status", json={"status": "in_progress"}).raise_for_status()
with db.cursor() as cur:
    cur.execute("""INSERT INTO annotations (id, image_id, class_id, ann_type, geometry, area, iscrowd, source, pending, attributes, created_at)
                   VALUES (gen_random_uuid(), %s, %s, 'bbox', %s, 4000, false, 'model', true, '{"conf": 0.87}', now())""",
                (frames[3]["id"], wagon["id"], json.dumps({"x": 600, "y": 300, "w": 80, "h": 50})))

print(json.dumps({"code": code, "login": login, "password": "Test-Passw0rd", "source": source["id"],
                  "held": held["id"], "frames": [f["id"] for f in frames]}))
