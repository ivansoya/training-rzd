"""Фикстуры нагрузочного набора — те же, что у API-тестов.

Заводить второй такой же набор фикстур значило бы, что однажды они разойдутся:
регистрация, подтверждение почты и уборка по префиксу `test-` должны быть
ровно одни на весь прогон. Поэтому каталог API-тестов добавляется в путь, а
фикстуры импортируются оттуда — pytest находит их в этом пространстве имён и
работает с ними как со своими.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))

from conftest import (  # noqa: E402,F401  — импорт ради регистрации фикстур
    BASE_URL,
    api,
    assets_of,
    cleanup,
    clip_url,
    db,
    jobs_of,
    label_class,
    project,
    pytest_configure,
    tag,
    task,
    wait_clip,
    wait_job,
)
