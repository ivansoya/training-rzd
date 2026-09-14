"""Таги: метки происхождения кадров и роликов.

Таг отвечает не на вопрос «что на кадре» — на это отвечает класс, — а на
вопрос «в каких условиях он снят»: ночь, дождь, тоннель, такой-то перегон.
Нужны они одному: собрать обучающий набор, в котором ночные кадры проходят
через свою цепочку аугментаций, а дневные — через свою.

Главное правило здесь — **таги кадра это снимок**. Ролику таги ставят руками,
и в момент, когда из ролика рождается кадр (нарезка или закрытие разметки),
они копируются кадру. Дальше кадр живёт сам: правка одному кадру не спорит с
роликом, а закрытие таски, которое уносит исходники, не стирает
происхождение уже нарезанных кадров.
"""
import uuid

from sqlalchemy import delete, select

from common.models import Image, ImageTag, Tag, VideoTag

# Связь и её колонка «чей таг». Две таблицы отличаются только ею, и разводить
# ради этого два набора одинаковых функций незачем.
LINKS = {
    "image": (ImageTag, ImageTag.image_id),
    "video": (VideoTag, VideoTag.video_id),
}


def view(tag) -> dict:
    return {"id": str(tag.id), "name": tag.name}


def project_tags(db, project_id):
    return db.execute(
        select(Tag).where(Tag.project_id == project_id).order_by(Tag.name)
    ).scalars().all()


def valid_ids(db, project_id, raw):
    """Таги проекта из присланного списка. Чужое и несуществующее молча
    отбрасываем: тагов может не стать между открытием окна и отправкой."""
    want = set()
    for item in raw or []:
        try:
            want.add(uuid.UUID(str(item)))
        except (ValueError, AttributeError, TypeError):
            continue
    if not want:
        return []
    return list(db.execute(
        select(Tag.id).where(Tag.project_id == project_id, Tag.id.in_(want))
    ).scalars().all())


def of(db, kind, owner_ids):
    """{чей_id: [tag_id]} для списка владельцев. Одним запросом: галерея
    спрашивает таги сразу у страницы кадров, а не у каждого по отдельности."""
    table, column = LINKS[kind]
    out = {}
    if not owner_ids:
        return out
    rows = db.execute(
        select(column, table.tag_id).where(column.in_(list(owner_ids)))
    ).all()
    for owner_id, tag_id in rows:
        out.setdefault(owner_id, []).append(tag_id)
    return out


def set_for(db, kind, owner_id, tag_ids):
    """Заменить таги владельца целиком. Без flush: вызывающий решает, когда
    коммитить, — правка тага кадра обычно едет вместе с другой работой."""
    table, column = LINKS[kind]
    db.execute(delete(table).where(column == owner_id))
    for tag_id in dict.fromkeys(tag_ids):
        db.add(table(**{column.key: owner_id, "tag_id": tag_id}))


def attach(db, kind, owner_id, tag_ids):
    """Добавить таги, не трогая уже стоящие."""
    table, column = LINKS[kind]
    have = set(db.execute(
        select(table.tag_id).where(column == owner_id)
    ).scalars().all())
    for tag_id in dict.fromkeys(tag_ids):
        if tag_id not in have:
            db.add(table(**{column.key: owner_id, "tag_id": tag_id}))


def ids_of(db, kind, owner_id):
    table, column = LINKS[kind]
    return list(db.execute(
        select(table.tag_id).where(column == owner_id)
    ).scalars().all())


def link(db, kind, owner_id, tag_ids):
    """Привязать таги к только что созданному владельцу.

    Без проверки «а не стоит ли уже»: нарезка зовёт это на каждый кадр, и
    лишний запрос на кадр превратился бы в лишний запрос на десять тысяч.
    """
    table, column = LINKS[kind]
    for tag_id in tag_ids:
        db.add(table(**{column.key: owner_id, "tag_id": tag_id}))


def usage(db, tag_id):
    """Сколько кадров и роликов носит таг. Экран управления показывает это
    перед удалением: таг сам по себе ничего не весит, а вот отбор по нему —
    весит."""
    images = db.execute(
        select(ImageTag.image_id).where(ImageTag.tag_id == tag_id)
    ).scalars().all()
    videos = db.execute(
        select(VideoTag.video_id).where(VideoTag.tag_id == tag_id)
    ).scalars().all()
    in_datasets = db.execute(
        select(Image.id).where(Image.id.in_(images or [None]),
                               Image.dataset_id.isnot(None))
    ).scalars().all() if images else []
    return {
        "images": len(images),
        "videos": len(videos),
        "in_datasets": len(in_datasets),
    }
