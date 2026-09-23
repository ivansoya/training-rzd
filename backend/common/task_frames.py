"""Какие кадры таски входят в блок и какие размечены агентом, но не проверены.

Двое спрашивают одно и то же: галерея таски (`datasets`) и прогон агента
(`training-worker`). Разойдись они — агент разметил бы не те кадры, что
показывает блок, на который человек нажал.
"""
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
    return Image.source_video_id == source


def agent_marked():
    """На кадре есть рамка агента — не правленная человеком."""
    return exists().where(
        Annotation.image_id == Image.id,
        Annotation.source == "model",
        Annotation.agent_version_id.isnot(None),
    )


def agent_pending():
    """«Агент, не проверено»: кадр новый, а рамки агента на нём есть.

    Отдельного статуса нет нарочно: кадр агента — это новый кадр с
    предложением, и принятым его делает человек — сохранением или «Принять».
    """
    return and_(Image.task_status == "new", agent_marked())


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
