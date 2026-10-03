"""Ссылка подтверждения подтверждает почту, но не входит: иначе чужая ссылка
молча подменяла бы сессию того, кто её открыл (login CSRF)."""
import hashlib
import uuid

import requests

from conftest import BASE_URL, tag


def test_подтверждение_не_ставит_куку(db):
    login = tag()
    res = requests.post(f"{BASE_URL}/api/auth/register", json={
        "email": f"{login}@example.test", "login": login,
        "display_name": "Тестовый", "password": "Test-Passw0rd",
    })
    assert res.status_code == 201, res.text
    token = uuid.uuid4().hex
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO email_confirmations (id, user_id, token_hash, expires_at, created_at)"
            " SELECT gen_random_uuid(), id, %s, now() + interval '1 hour', now()"
            " FROM users WHERE login = %s",
            (hashlib.sha256(token.encode()).hexdigest(), login),
        )
    res = requests.post(f"{BASE_URL}/api/auth/confirm", json={"token": token})
    assert res.status_code == 200, res.text
    assert res.json()["login"] == login
    assert "session" not in res.headers.get("Set-Cookie", "")
