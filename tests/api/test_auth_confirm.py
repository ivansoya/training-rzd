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


def _register(login, email):
    return requests.post(f"{BASE_URL}/api/auth/register", json={
        "email": email, "login": login, "display_name": "Тестовый", "password": "Test-Passw0rd",
    })


def test_опечатку_в_почте_можно_исправить(db):
    login = tag()
    assert _register(login, f"{login}@exmaple.test").status_code == 201
    res = requests.post(f"{BASE_URL}/api/auth/change-email", json={
        "identity": login, "password": "Test-Passw0rd", "email": f"{login}@example.test",
    })
    assert res.status_code == 200, res.text
    with db.cursor() as cur:
        cur.execute("SELECT email FROM users WHERE login = %s", (login,))
        assert cur.fetchone()[0] == f"{login}@example.test"


def test_логин_с_истёкшей_ссылкой_свободен(db):
    login = tag()
    assert _register(login, f"{login}@exmaple.test").status_code == 201
    with db.cursor() as cur:
        cur.execute(
            "UPDATE email_confirmations SET expires_at = now() - interval '1 day'"
            " WHERE user_id = (SELECT id FROM users WHERE login = %s)", (login,))
    assert _register(login, f"{login}@example.test").status_code == 201
