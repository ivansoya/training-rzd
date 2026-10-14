"""Какие кадры таски входят в блок и какие размечены агентом, но не проверены.

Двое спрашивают одно и то же: галерея таски (`datasets`) и прогон агента
(`training-worker`). Разойдись они — агент разметил бы не те кадры, что
показывает блок, на который человек нажал.
"""
import uuid

from sqlalchemy import and_, case, exists, select

from common.models import Annotation, Image, TaskVideo, VideoAnnotation, VideoTrack

# Блоки вкладки «Кадры». Идентификатор ролика тоже годится как источник.
SOURCES = ("files", "videos")


def video_frame():
    """Кадр размечаемого ролика. Рождается сдачей таски и в таске правится только в ролике,
    поэтому во вкладку «Кадры» не входит (решение 14.10.2026). NOT EXISTS, а не NOT IN:
    у кадра из файла ролика нет, и `NOT (NULL IN …)` выбросил бы его."""
    return exists().where(TaskVideo.id == Image.source_video_id, TaskVideo.mode == "annotate")


def rev_bump():
    """Правка разметки мимо редактора, одинаковая для ролика и его кадра (перенос, удаление
    класса): версия растёт, отметка сдачи — следом, иначе сдача сочла бы кадр правленым."""
    return {
        "annotations_rev": Image.annotations_rev + 1,
        "handed_rev": case((Image.handed_rev == Image.annotations_rev, Image.handed_rev + 1),
                           else_=Image.handed_rev),
    }


def source_clause(task_id, source):
    """Условие на `Image` для блока; без блока — все кадры вкладки «Кадры».

    «files» — загруженные файлами, «videos» — все нарезаемые ролики разом,
    иначе идентификатор одного ролика (uuid).
    """
    if not source:
        return ~video_frame()
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


def video_payload(db, video, shapes=True):
    """Треки и одиночная разметка ролика — в том виде, в каком их ждёт
    `common.video_tracks`. Закрытие разметки и агент на ролике смотрят на
    ролик одинаково: что уйдёт в таску и где уже поработал человек.

    `shapes=False` — для счёта: у одиночной только кадр, флаг и источник, геометрия None.
    У агента их десятки тысяч на ролик, разбор JSON и UUID шёл секундами."""
    tracks = db.execute(
        select(VideoTrack).where(VideoTrack.video_id == video.id)
    ).scalars().all()
    A = VideoAnnotation
    cols = (A.class_id, A.ann_type, A.geometry, A.agent_version_id, A.created_by, A.reviewed_by) if shapes \
        else (case((A.track_id.isnot(None), A.geometry)).label("geometry"),)
    rows = db.execute(
        select(A.track_id, A.frame_no, A.source, A.pending, *cols)
        .where(A.video_id == video.id)
        .order_by(A.frame_no)
    ).all()

    keys_by_track = {}
    singles = []
    for row in rows:
        if row.track_id is None:
            singles.append({k: v for k, v in row._mapping.items() if k != "track_id"})
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
