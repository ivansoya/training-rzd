"""Outgoing mail. In dev everything lands in the Mailpit container
(SMTP :1025, web UI :8025); in prod the same env vars point at a real relay.
"""
import logging
import os
import smtplib
from email.message import EmailMessage

log = logging.getLogger(__name__)

SMTP_HOST = os.environ.get("SMTP_HOST", "mailpit")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "1025"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_STARTTLS = os.environ.get("SMTP_STARTTLS", "") == "1"
MAIL_FROM = os.environ.get("MAIL_FROM", "Магистраль ML <no-reply@magistral.local>")
# Base URL the user's browser can open (the dev server / public site).
APP_BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:5173")


def _send(msg: EmailMessage) -> None:
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as smtp:
        if SMTP_STARTTLS:
            smtp.starttls()
        if SMTP_USER:
            smtp.login(SMTP_USER, SMTP_PASSWORD)
        smtp.send_message(msg)


def send_confirmation_email(to_email: str, display_name: str, token: str) -> bool:
    link = f"{APP_BASE_URL}/confirm/{token}"
    msg = EmailMessage()
    msg["Subject"] = "Подтвердите почту — Магистраль ML"
    msg["From"] = MAIL_FROM
    msg["To"] = to_email
    msg.set_content(
        f"Здравствуйте, {display_name}!\n\n"
        f"Вы зарегистрировались в Магистраль ML. Чтобы завершить регистрацию,\n"
        f"подтвердите почту — откройте ссылку:\n\n"
        f"  {link}\n\n"
        f"Ссылка действует 24 часа. Если вы не регистрировались — просто\n"
        f"проигнорируйте это письмо.\n"
    )
    try:
        _send(msg)
        return True
    except Exception:
        log.exception("Не удалось отправить письмо на %s", to_email)
        return False
