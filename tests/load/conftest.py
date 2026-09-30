"""Фикстуры нагрузочного набора — те же, что у API-тестов.

Заводить второй такой же набор фикстур значило бы, что однажды они разойдутся:
регистрация, подтверждение почты и уборка по префиксу `test-` должны быть
ровно одни на весь прогон. Поэтому каталог API-тестов добавляется в путь, а
фикстуры импортируются оттуда — pytest находит их в этом пространстве имён и
работает с ними как со своими.
"""
import importlib.util
import os
import sys

_API = os.path.join(os.path.dirname(__file__), "..", "api")
sys.path.insert(0, _API)

# Грузим под своим именем: этот файл сам зовётся `conftest`, и
# `from conftest import …` находил в sys.modules его же, недогруженного, —
# набор падал с ImportError, не начав ни одного теста.
_spec = importlib.util.spec_from_file_location("api_conftest", os.path.join(_API, "conftest.py"))
_mod = importlib.util.module_from_spec(_spec)
sys.modules["api_conftest"] = _mod
_spec.loader.exec_module(_mod)

from api_conftest import (  # noqa: E402,F401  — импорт ради регистрации фикстур
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
