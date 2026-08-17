"""Превращение разметки видео в кадры таски.

Пока разметка ролика идёт, это номера кадров и боксы на них. Изображений не
существует: держать на диске каждый тронутый кадр значило бы плодить файлы,
которые разметчик через минуту перерисует.

Закрытие разметки выполняет план: нужные кадры извлекаются из ролика и
становятся обычными кадрами таски. Дальше их не отличить от нарезанных или
загруженных файлами — они правятся обычным редактором, уходят в проект
штатной сдачей таски и никем не переписываются.

Это событие, а не вечная синхронизация. Отсюда правило: закрыть разметку
второй раз, пока прежние кадры на месте, нельзя — сперва их надо убрать.
Иначе трек снова стал бы хозяином кадра, который человек уже поправил рукой.
"""
import os

from sqlalchemy import select

from common import config
from common.models import (
    Annotation,
    Image,
    TaskVideo,
    VideoAnnotation,
    VideoTrack,
)
from datasets_svc import video as videolib
from datasets_svc import video_tracks as tracklib


def _last_frame(video):
    if video.frame_count:
        return max(0, int(video.frame_count) - 1)
    if video.duration_ms and video.fps:
        return max(0, tracklib.ms_to_frame(video.duration_ms, video.fps) - 1)
    return None


def collect_plan(db, video):
    """План материализации ролика: ``{кадр: [боксы]}``.

    Зовут двое — предпросмотр в редакторе и закрытие разметки. Расходиться им
    нельзя, иначе предпросмотр обещает одно, а в таску уходит другое.
    """
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
                "geometry": row.geometry,
                "source": row.source,
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
    return tracklib.plan(payload, singles, _last_frame(video))


def open_videos(db, task):
    """Ролики с незакрытой разметкой: их работа ещё не стала кадрами."""
    return db.execute(
        select(TaskVideo).where(
            TaskVideo.task_id == task.id,
            TaskVideo.mode == "annotate",
            TaskVideo.annotation_closed_at.is_(None),
        )
    ).scalars().all()


def pending_summary(db, task):
    """Что ещё не стало кадрами: по строке на незакрытый ролик с разметкой.

    Нужна вкладке прогресса и предупреждению при сдаче таски: работа по
    незакрытому ролику иначе невидима, и прогресс врал бы.
    """
    out = []
    for video in open_videos(db, task):
        try:
            plan = collect_plan(db, video)
        except tracklib.TrackError as exc:
            out.append({
                "video_id": str(video.id), "file_name": video.file_name,
                "frames": 0, "boxes": 0, "error": str(exc),
            })
            continue
        if not plan:
            continue
        tracks = db.execute(
            select(VideoTrack).where(VideoTrack.video_id == video.id)
        ).scalars().all()
        out.append({
            "video_id": str(video.id),
            "file_name": video.file_name,
            "frames": len(plan),
            "boxes": sum(len(v) for v in plan.values()),
            "tracks": len(tracks),
        })
    return out


def _file_name(video, frame_no):
    stem = os.path.splitext(video.file_name)[0]
    return f"{stem}_f{frame_no:06d}.jpg"


def run_video(db, task, video, user_id, progress=None):
    """Выполняет план одного ролика. Коммит остаётся за вызывающим.

    Кадры создаются нетронутыми данными таски: со статусом «размечен», но без
    датасета — в проект они уйдут обычной сдачей вместе со всеми остальными.
    """
    by_frame = collect_plan(db, video)
    if not by_frame:
        return {"created": 0, "boxes": 0}

    source = os.path.join(config.DATA_DIR, video.file_path)
    if not os.path.exists(source):
        raise videolib.VideoError(
            f"Файл ролика «{video.file_name}» не найден — доставать кадры неоткуда."
        )

    base = config.image_base_dir(task.project_id, task.id)
    created = {}

    def on_frame(frame_no, time_ms, img):
        image = Image(
            project_id=task.project_id,
            dataset_id=None,
            task_id=task.id,
            task_status="annotated",
            file_name=_file_name(video, frame_no),
            file_path="",
            split="other",
            source_video_id=video.id,
            source_frame_no=frame_no,
            source_time_ms=time_ms,
            created_by=user_id,
        )
        db.add(image)
        db.flush()
        full, size, nbytes = videolib.save_frame(img, base, image.id)
        image.file_path = os.path.relpath(full, config.DATA_DIR)
        image.width, image.height = size
        image.size_bytes = nbytes
        created[frame_no] = image.id
        if progress and len(created) % 20 == 0:
            progress(len(created))

    videolib.extract_frames(source, sorted(by_frame), on_frame)

    boxes = 0
    for frame_no, planned in sorted(by_frame.items()):
        image_id = created.get(frame_no)
        if image_id is None:
            # Кадр не дошёл: декодер до него не добрался (номер за концом
            # ролика). Молча пропускаем — разметки без картинки не бывает.
            continue
        for item in planned:
            geometry = item["geometry"]
            db.add(Annotation(
                image_id=image_id,
                class_id=item["class_id"],
                ann_type="bbox",
                geometry=geometry,
                area=round(geometry["w"] * geometry["h"], 2),
                source=item.get("source") or "human",
                created_by=user_id,
            ))
            boxes += 1

    if progress:
        progress(len(created))
    return {"created": len(created), "boxes": boxes}
