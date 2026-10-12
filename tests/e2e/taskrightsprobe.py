"""Данные для taskrightsprobe.mjs: два человека в одном проекте, таска на обоих, один кадр.

Всё с приставкой `test-` — раннер тестов сотрёт. Запуск:
docker exec -w /work/tests/e2e yolo-tests python3 taskrightsprobe.py
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


def person(name, display):
    login = f"test-{name}-{stamp}"
    s = requests.Session()
    s.post(f"{BASE}/api/auth/register", json={"email": f"{login}@example.test", "login": login,
                                              "display_name": display, "password": "Test-Passw0rd"}).raise_for_status()
    with db.cursor() as cur:
        cur.execute("UPDATE users SET email_confirmed_at = now() WHERE login = %s", (login,))
    s.post(f"{BASE}/api/auth/login", json={"identity": login, "password": "Test-Passw0rd"}).raise_for_status()
    me = s.get(f"{BASE}/api/auth/me").json()
    s.uid = (me.get("user") or me)["id"]
    s.login = login
    return s


admin, petr = person("anna", "Анна Проба"), person("petr", "Пётр Проба")
project = admin.post(f"{BASE}/api/projects", json={"name": f"test-права-{stamp}"}).json()
code = project["code"]
admin.post(f"{BASE}/api/projects/{code}/invite", json={"identity": petr.login, "role": "editor"}).raise_for_status()
inv = next(i for i in petr.get(f"{BASE}/api/invitations").json()["invitations"] if i["project"]["code"] == code)
petr.post(f"{BASE}/api/invitations/{inv['id']}/accept").raise_for_status()
cls = admin.post(f"{BASE}/api/projects/{code}/classes", json={"name": "вагон"}).json()

task = admin.post(f"{BASE}/api/projects/{code}/tasks",
                  json={"name": "Совместная", "assignees": [admin.uid, petr.uid]}).json()
buf = io.BytesIO()
Image.new("RGB", (640, 400), (40, 60, 90)).save(buf, "JPEG")
buf.seek(0)
admin.post(f"{BASE}/api/tasks/{task['id']}/images", files={"files": ("кадр.jpg", buf, "image/jpeg")}).raise_for_status()
admin.post(f"{BASE}/api/tasks/{task['id']}/status", json={"status": "in_progress"}).raise_for_status()
image = admin.get(f"{BASE}/api/tasks/{task['id']}/images").json()["images"][0]

print(json.dumps({"code": code, "task": task["id"], "image": image["id"], "class_index": cls["class_index"],
                  "admin": admin.login, "petr": petr.login, "petr_id": petr.uid, "password": "Test-Passw0rd"}))
