"""Вопросы в разметке (решения 29.10.2026): удержание кадров, место текстом, кому в колокольчик.

Считающее отдельно от базы: всё, кроме `holds`, — чистые функции под таблицей случаев.
"""
from sqlalchemy import and_, exists, or_, select

from common.models import Image, TaskQuestion

TEXT_MAX = 2000
OBJECT_KINDS = ("ann", "track", "box")


def holds():
    """Изображение держит открытый вопрос: на нём самом или на кадре ролика, из которого оно вышло.
    Кадры ролика при сдаче сперва становятся изображениями таски, так что одно условие держит оба места."""
    q = TaskQuestion
    return exists(select(q.id).where(q.status == "open", or_(
        q.image_id == Image.id,
        and_(q.video_id == Image.source_video_id, q.frame_no == Image.source_frame_no),
    )))


def clock(ms):
    """0:23, 1:02:05 — как на шкале ролика."""
    s = max(0, int(ms or 0)) // 1000
    h, m, s = s // 3600, s // 60 % 60, s % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def place(file_name, time_ms=None):
    """Где вопрос, текстом: имя изображения или «ролик.mp4, 0:23». Помнится и после удаления ролика."""
    return f"{file_name}, {clock(time_ms)}" if time_ms is not None else file_name


def text_of(raw):
    """Текст сообщения или ошибка словами: пустое и длиннее предела не пишем."""
    text = (raw or "").strip() if isinstance(raw, str) else ""
    if not text:
        return None, "Напишите текст."
    if len(text) > TEXT_MAX:
        return None, f"Не длиннее {TEXT_MAX} знаков."
    return text, None


def open_word(n):
    """1 открытый вопрос, 3 открытых вопроса, 5 открытых вопросов."""
    if n % 10 == 1 and n % 100 != 11:
        return "открытый вопрос"
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return "открытых вопроса"
    return "открытых вопросов"


def to_new(assignees, creator, author):
    """Новый вопрос — исполнителям таски; ничья таска — её автору. Себе не пишем."""
    return (set(assignees) or ({creator} if creator else set())) - {author}


def to_reply(question_author, message_authors, author):
    """Ответ — всем, кто участвовал в обсуждении, кроме ответившего."""
    return ({question_author} | set(message_authors)) - {author, None}
