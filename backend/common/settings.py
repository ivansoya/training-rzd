"""Настройки сервера целиком: умолчания здесь, изменённые — в `server_settings`.

Меняет «Управление» оборудованием на странице «Оборудование».
"""
from common.models import ServerSetting, utcnow

# SAM 3 ужимается в fp16 ещё на процессоре: иначе на карту на миг едет fp32-копия
# (замер 10.10.2026: пик загрузки 3,24 → 1,64 ГБ, качество и скорость те же).
SAM3_CPU_HALF = "sam3_cpu_half"

DEFAULTS = {SAM3_CPU_HALF: True}


def get(db, key):
    row = db.get(ServerSetting, key)
    return DEFAULTS[key] if row is None or row.value is None else row.value


def get_fresh(key):
    """Без своей сессии у вызывающего — загрузка моделей идёт в нитях воркера."""
    from common.db import SessionLocal

    db = SessionLocal()
    try:
        return get(db, key)
    except Exception:
        return DEFAULTS[key]
    finally:
        db.close()


def view(db):
    """{ключ: {value, default, updated_at, updated_by}} — для страницы «Оборудование»."""
    rows = {r.key: r for r in db.query(ServerSetting).filter(ServerSetting.key.in_(DEFAULTS)).all()}
    out = {}
    for key, default in DEFAULTS.items():
        row = rows.get(key)
        out[key] = {
            "value": default if row is None or row.value is None else row.value,
            "default": default,
            "updated_at": row.updated_at.isoformat() if row is not None else None,
            "updated_by": str(row.updated_by) if row is not None and row.updated_by else None,
        }
    return out


def put(db, key, value, user_id):
    if key not in DEFAULTS:
        raise KeyError(key)
    if not isinstance(value, type(DEFAULTS[key])):
        raise ValueError(f"{key}: ожидается {type(DEFAULTS[key]).__name__}")
    row = db.get(ServerSetting, key)
    if row is None:
        row = ServerSetting(key=key)
        db.add(row)
    row.value, row.updated_at, row.updated_by = value, utcnow(), user_id
    db.commit()
    return row
