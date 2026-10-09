"""Какие кадры таски входят в блок и какие размечены агентом, но не проверены.

Двое спрашивают одно и то же: галерея таски (`datasets`) и прогон агента
(`training-worker`). Разойдись они — агент разметил бы не те кадры, что
показывает блок, на который человек нажал.
"""
import uuid

from sqlalchemy import and_, exists, select

from common.models import Annotation, Image, TaskVideo, VideoAnnotation, VideoTrack

# Блоки вкладки «Кадры». Идентификатор ролика тоже годится как источник.
SOURCES = ("files", "videos")


def source_clause(task_id, source):
    """Условие на `Image` для блока, или None — «все кадры таски».

    «files» — загруженные файлами, «videos» — все нарезаемые ролики разом,
    иначе идентификатор одного ролика (uuid).
    """
    if not source:
        return None
    if source == "files":
        return Image.source_video_id.is_(None)
    if source == "videos":
        # Именно нарезаемые: кадры размечаемого ролика приходят в таску уже
        # размеченными и своим источником во вкладке «Кадры» не значатся.
        return Image.source_video_id.in_(
            select(TaskVideo.id).where(
                TaskVideo.task_id == task_id, TaskVideo.mode == "cut"
            )
        )
    # Из параметров прогона источник приходит строкой, а колонка ждёт UUID.
    return Image.source_video_id == (source if isinstance(source, uuid.UUID) else uuid.UUID(str(source)))


def has_pending():
    """На кадре есть рамка агента, которую ещё не проверили."""
    return exists().where(Annotation.image_id == Image.id, Annotation.pending.is_(True))


def agent_pending():
    """«Агент, на проверке»: на кадре есть непроверенная рамка агента.

    Состояние кадра тут ни при чём — агента зовут и на размеченный кадр, и тогда
    на нём рядом работа человека и непроверенное. Забракованный не в счёт.
    """
    return and_(Image.task_status != "deleted", has_pending())


def video_payload(db, video):
    """Треки и одиночная разметка ролика — в том виде, в каком их ждёт
    `common.video_tracks`. Закрытие разметки и агент на ролике смотрят на
    ролик одинаково: что уйдёт в таску и где уже поработал человек."""
    tracks = db.execute(
        select(VideoTrack).where(VideoTrack.video_id == video.id)
    ).scalars().all()
    rows = db.execute(
        select(VideoAnnotation).where(VideoAnnotation.video_id == video.id)
        .order_by(VideoAnnotation.frame_no)
    ).scalars().all()

    keys_by_track = {}
    singles = []
    for row in rows:
        if row.track_id is None:
            singles.append({
                "frame_no": row.frame_no,
                "class_id": row.class_id,
                "ann_type": row.ann_type,
                "geometry": row.geometry,
                "source": row.source,
                "agent_version_id": row.agent_version_id,
                "created_by": row.created_by,
                "pending": row.pending,
                "reviewed_by": row.reviewed_by,
            })
        else:
            keys_by_track.setdefault(row.track_id, []).append({
                "frame_no": row.frame_no,
                "geometry": row.geometry,
                "source": row.source,
            })

    payload = [
        {
            "id": t.id,
            "class_id": t.class_id,
            "start_frame": t.start_frame,
            "end_frame": t.end_frame,
            "interpolate": t.interpolate,
            "export_step": t.export_step,
            "hidden_ranges": t.hidden_ranges or [],
            "keys": keys_by_track.get(t.id, []),
        }
        for t in tracks
    ]
    return payload, singles


def settle_status(db, image_ids):
    """Кадры, у которых не осталось объектов, перестают числиться «размеченными».

    То же правило, что при записи разметки: кадр в датасете — фоновый пример,
    черновик — снова нетронутый. Зовётся после удаления разметки мимо редактора.
    """
    if not image_ids:
        return
    left = select(Annotation.id).where(Annotation.image_id == Image.id)
    for image in db.execute(
        select(Image).where(
            Image.id.in_(image_ids), Image.task_status == "annotated", ~exists(left)
        )
    ).scalars():
        image.task_status = "empty" if image.dataset_id else "new"
