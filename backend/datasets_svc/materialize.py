"""Превращение разметки видео в кадры проекта.

Пока таска в работе, размеченное видео — это номера кадров и боксы на них.
Изображений не существует: держать на диске каждый тронутый кадр значило бы
плодить файлы, которые разметчик через минуту перерисует.

На сдаче таски план выполняется: нужные кадры извлекаются из ролика, кадр
становится обычным изображением проекта, а боксы — обычными аннотациями.
Дальше их не отличить от нарезанных или загруженных файлами, и экспорт,
обучение и статистика работают без единой правки.

Повторная сдача не плодит дубли: кадр находится по ``source_frame_no`` и
правится на месте. Это и есть «зафиксированное изменение, которое обращается
только явным удалением».
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

    Зовут двое — предпросмотр в редакторе и сдача таски. Расходиться им
    нельзя, иначе предпросмотр обещает одно, а в проект уходит другое.
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
                "visible": row.visible,
            })
        else:
            keys_by_track.setdefault(row.track_id, []).append({
                "frame_no": row.frame_no,
                "geometry": row.geometry,
                "visible": row.visible,
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
            "keys": keys_by_track.get(t.id, []),
        }
        for t in tracks
    ]
    return tracklib.plan(payload, singles, _last_frame(video))


def annotated_videos(db, task):
    return db.execute(
        select(TaskVideo).where(
            TaskVideo.task_id == task.id, TaskVideo.mode == "annotate"
        )
    ).scalars().all()


def count_pending(db, task):
    """Сколько кадров даст сдача таски — для прикидки и прогресса.

    Ошибку слишком мелкого шага не глотаем: молча пропустить трек значило бы
    сдать таску без объекта, который разметчик размечал.
    """
    return sum(len(collect_plan(db, video)) for video in annotated_videos(db, task))


def _file_name(video, frame_no):
    stem = os.path.splitext(video.file_name)[0]
    return f"{stem}_f{frame_no:06d}.jpg"


def run(db, task, user_id, progress=None):
    """Материализует все размечаемые ролики таски.

    Возвращает счётчики: сколько кадров создано, сколько обновлено, сколько
    объектов записано. Коммит остаётся за вызывающим — сдача таски должна
    быть одной транзакцией с проставлением датасета.
    """
    created = updated = boxes = 0
    videos = annotated_videos(db, task)
    if not videos:
        return {"created": 0, "updated": 0, "boxes": 0}

    base = config.image_base_dir(task.project_id, task.id)
    done = 0

    for video in videos:
        by_frame = collect_plan(db, video)
        if not by_frame:
            continue
        source = os.path.join(config.DATA_DIR, video.file_path)
        if not os.path.exists(source):
            raise videolib.VideoError(
                f"Файл ролика «{video.file_name}» не найден — материализовать нечего."
            )

        existing = {
            frame_no: image_id
            for frame_no, image_id in db.execute(
                select(Image.source_frame_no, Image.id).where(
                    Image.source_video_id == video.id,
                    Image.source_frame_no.isnot(None),
                )
            ).all()
        }
        # Уже существующим кадрам ролик перечитывать незачем: картинка та же,
        # меняется только разметка.
        missing = [f for f in by_frame if f not in existing]
        fresh_images = {}

        def on_frame(frame_no, time_ms, img, _video=video, _bucket=fresh_images):
            image = Image(
                project_id=task.project_id,
                dataset_id=None,
                task_id=task.id,
                task_status="annotated",
                file_name=_file_name(_video, frame_no),
                file_path="",
                split="other",
                source_video_id=_video.id,
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
            _bucket[frame_no] = image.id

        if missing:
            videolib.extract_frames(source, missing, on_frame)

        for frame_no, planned in sorted(by_frame.items()):
            image_id = fresh_images.get(frame_no) or existing.get(frame_no)
            if image_id is None:
                # Кадр не дошёл: декодер до него не добрался (номер за концом
                # ролика). Молча пропускаем — разметки без картинки не бывает.
                continue
            if frame_no in fresh_images:
                created += 1
            else:
                updated += 1
                image = db.get(Image, image_id)
                if image is not None and image.task_status == "new":
                    image.task_status = "annotated"

            # Разметка кадра заменяется целиком — тем же правилом, что и у
            # обычного изображения: план видео и есть источник истины.
            db.execute(
                Annotation.__table__.delete().where(Annotation.image_id == image_id)
            )
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

            done += 1
            if progress and done % 20 == 0:
                progress(done)

    if progress:
        progress(done)
    return {"created": created, "updated": updated, "boxes": boxes}
