"""Письмо подтверждения собирается и не несёт чужого текста."""
from auth_svc import mailer


def test_письмо_без_имени_и_со_ссылкой(monkeypatch):
    sent = []
    monkeypatch.setattr(mailer, "_send", sent.append)
    assert mailer.send_confirmation_email("a@example.test", "tok")
    body = sent[0].get_content()
    assert "/confirm/tok" in body and body.startswith("Здравствуйте!")
