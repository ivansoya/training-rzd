"""Разметка видео: кадры, треки и покадровые боксы.

Пока таска не сдана, разметка размечаемого ролика живёт в ``video_tracks`` и
``video_annotations``, а не в обычных ``annotations``: кадров как изображений
ещё нет, есть только номера кадров на ролике. При сдаче таски нужные кадры
извлекаются из видео и разметка переезжает в проект (см. ``materialize``).

Кадр выдаётся сервером, а не берётся из ``<video>`` в браузере: currentTime не
даёт номера кадра, браузер волен показать соседний, а mkv и avi он не играет
вовсе. Клиент воспроизводит ролик для поиска момента, но рисует всегда по
серверному кадру — тому же, что уйдёт в датасет.
"""
import os
import uuid

from flask import Blueprint, jsonify, request, send_file
from sqlalchemy import select

from common import config
from common.db import SessionLocal
from common.models import (
    Image,
    LabelClass,
    TaskVideo,
    VideoAnnotation,
    VideoTrack,
)
from datasets_svc import video as videolib
from datasets_svc import video_tracks as tracklib
from datasets_svc.materialize import collect_plan
from datasets_svc.task_routes import (
    _clamp_box,
    _log,
    _may_work,
    _resolve_task,
    _uuid_or_none,
)

bp = Blueprint("video_annotation", __name__)

# Сколько распакованных кадров держим на томе. Кадр 1920×1080 в JPEG — около
# 200 КБ, так что несколько сотен на ролик стоят дешевле, чем повторное
# декодирование при каждом возврате на уже виденный момент.
FRAME_CACHE_PER_VIDEO = 400


# --------------------------------------------------------------------------- #
# Общее
# --------------------------------------------------------------------------- #
def _resolve_video(task_id, video_id, needed="viewer"):
    """Таска, ролик и права разом: все маршруты начинаются с этого."""
    db, task, project, user, role, err = _resolve_task(task_id, needed)
    if err:
        return None, None, None, None, None, err
    vid = _uuid_or_none(video_id)
    row = db.get(TaskVideo, vid) if vid else None
    if row is None or row.task_id != task.id:
        db.close()
        return None, None, None, None, None, (jsonify({"error": "Видео не найдено."}), 404)
    return db, task, project, user, role, row


def _resolve_track(track_id, needed="editor"):
    """Трек вместе с таской, которой он принадлежит."""
    db = SessionLocal()
    tid = _uuid_or_none(track_id)
    track = db.get(VideoTrack, tid) if tid else None
    if track is None:
        db.close()
        return None, None, None, (jsonify({"error": "Трек не найден."}), 404)
    video = db.get(TaskVideo, track.video_id)
    db.close()
    if video is None:
        return None, None, None, (jsonify({"error": "Видео не найдено."}), 404)
    db, task, project, user, role, err = _resolve_task(str(video.task_id), needed)
    if err:
        return None, None, None, err
    if not _may_work(task, user, role):
        db.close()
        return None, None, None, (jsonify({"error": "Это не ваша таска."}), 403)
    if task.status == "closed":
        db.close()
        return None, None, None, (jsonify({"error": "Таска закрыта, разметка заморожена."}), 409)
    return db, task, db.get(VideoTrack, tid), None


def _writable(task, user, role, video):
    """Общая проверка перед любой правкой разметки видео."""
    if not _may_work(task, user, role):
        return jsonify({"error": "Это не ваша таска."}), 403
    if task.status == "closed":
        return jsonify({"error": "Таска закрыта, разметка заморожена."}), 409
    if video.mode != "annotate":
        return jsonify({"error": "Это видео загружено для нарезки на кадры."}), 409
    return None


def _class_by_index(db, project_id, class_index):
    return db.execute(
        select(LabelClass).where(
            LabelClass.project_id == project_id,
            LabelClass.class_index == class_index,
        )
    ).scalar_one_or_none()


def _last_frame(video):
    if video.frame_count:
        return max(0, int(video.frame_count) - 1)
    if video.duration_ms and video.fps:
        return max(0, tracklib.ms_to_frame(video.duration_ms, video.fps) - 1)
    return None


def _track_json(track, keys):
    return {
        "id": str(track.id),
        "class_index": track.class_index,
        "start_frame": track.start_frame,
        "end_frame": track.end_frame,
        "interpolate": track.interpolate,
        "export_step": track.export_step,
        "label": track.label,
        "keys": [
            {
                "frame_no": k.frame_no,
                "geometry": k.geometry,
                "visible": k.visible,
                "source": k.source,
            }
            for k in keys
        ],
    }


# --------------------------------------------------------------------------- #
# Кадр
# --------------------------------------------------------------------------- #
def _frame_dir(task, video_id):
    return os.path.join(
        config.task_video_dir(task.project_id, task.id), f"{video_id}_frames"
    )


def _trim_cache(folder):
    """Кэш кадров не должен расти бесконечно: срезаем самое старое."""
    try:
        names = [n for n in os.listdir(folder) if n.endswith(".jpg")]
    except OSError:
        return
    if len(names) <= FRAME_CACHE_PER_VIDEO:
        return
    paths = [os.path.join(folder, n) for n in names]
    paths.sort(key=lambda p: os.path.getmtime(p))
    for path in paths[: len(paths) - FRAME_CACHE_PER_VIDEO]:
        try:
            os.remove(path)
        except OSError:
            pass


@bp.get("/api/tasks/<task_id>/videos/<video_id>/frame")
def video_frame(task_id, video_id):
    """Точный кадр ролика по номеру — то же изображение, что уйдёт в датасет."""
    db, task, project, user, role, video = _resolve_video(task_id, video_id)
    if db is None:
        return video
    try:
        try:
            frame_no = int(request.args.get("n", 0))
        except (TypeError, ValueError):
            return jsonify({"error": "Номер кадра должен быть числом."}), 400
        if frame_no < 0:
            return jsonify({"error": "Номер кадра должен быть неотрицательным."}), 400

        folder = _frame_dir(task, video.id)
        cached = os.path.join(folder, f"{frame_no}.jpg")
        if not os.path.exists(cached):
            source = os.path.join(config.DATA_DIR, video.file_path)
            if not os.path.exists(source):
                return jsonify({"error": "Файл видео не найден."}), 404
            try:
                image = videolib.grab_frame(source, frame_no)
            except videolib.VideoError as exc:
                return jsonify({"error": str(exc)}), 400
            os.makedirs(folder, exist_ok=True)
            tmp = cached + ".part"
            image.convert("RGB").save(tmp, "JPEG", quality=88)
            os.replace(tmp, cached)
            _trim_cache(folder)

        resp = send_file(cached, mimetype="image/jpeg", conditional=True)
        # Кадр по номеру неизменен, пока существует ролик.
        resp.headers["Cache-Control"] = "private, max-age=86400"
        return resp
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Чтение разметки
# --------------------------------------------------------------------------- #
@bp.get("/api/tasks/<task_id>/videos/<video_id>/annotations")
def video_annotations(task_id, video_id):
    """Вся разметка ролика разом: редактор листает кадры без новых запросов."""
    db, task, project, user, role, video = _resolve_video(task_id, video_id)
    if db is None:
        return video
    try:
        by_index = {
            c.id: c.class_index
            for c in db.execute(
                select(LabelClass).where(LabelClass.project_id == project.id)
            ).scalars()
        }
        tracks = db.execute(
            select(VideoTrack).where(VideoTrack.video_id == video.id)
            .order_by(VideoTrack.created_at)
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
                    "id": str(row.id),
                    "frame_no": row.frame_no,
                    "class_index": by_index.get(row.class_id),
                    "geometry": row.geometry,
                    "source": row.source,
                })
            else:
                keys_by_track.setdefault(row.track_id, []).append(row)

        out = []
        for track in tracks:
            track.class_index = by_index.get(track.class_id)
            out.append(_track_json(track, keys_by_track.get(track.id, [])))

        # Кадры, уже уехавшие в проект: редактор помечает их на таймлайне,
        # чтобы правка попадала в то же изображение, а не создавала второе.
        materialized = dict(db.execute(
            select(Image.source_frame_no, Image.id).where(
                Image.source_video_id == video.id,
                Image.source_frame_no.isnot(None),
            )
        ).all())

        return jsonify({
            "video": {
                "id": str(video.id),
                "file_name": video.file_name,
                "mode": video.mode,
                "fps": video.fps,
                "duration_ms": video.duration_ms,
                "frame_count": video.frame_count,
                "width": video.width,
                "height": video.height,
            },
            "tracks": out,
            "singles": singles,
            "materialized": {str(k): str(v) for k, v in materialized.items()},
            "editable": _may_work(task, user, role) and task.status != "closed"
                        and video.mode == "annotate",
        })
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Треки
# --------------------------------------------------------------------------- #
@bp.post("/api/tasks/<task_id>/videos/<video_id>/tracks")
def create_track(task_id, video_id):
    """Новый трек и его первый ключевой кадр — одним действием.

    Трек без единого положения бессмыслен: он ничего не показывает и ничего
    не выгружает, а в списке объектов висит мусором.
    """
    db, task, project, user, role, video = _resolve_video(task_id, video_id, "editor")
    if db is None:
        return video
    try:
        denied = _writable(task, user, role, video)
        if denied:
            return denied
        data = request.get_json(silent=True) or {}
        cls = _class_by_index(db, project.id, data.get("class_index"))
        if cls is None:
            return jsonify({"error": "Класс не найден в проекте."}), 400
        try:
            frame_no = int(data.get("frame_no"))
        except (TypeError, ValueError):
            return jsonify({"error": "Не указан кадр."}), 400
        geometry = _clamp_box(data.get("geometry") or {}, video.width or 0, video.height or 0)
        if geometry is None:
            return jsonify({"error": "Рамка слишком мала."}), 400

        track = VideoTrack(
            video_id=video.id,
            class_id=cls.id,
            start_frame=frame_no,
            end_frame=None,
            interpolate=bool(data.get("interpolate", True)),
            export_step=max(1, int(data.get("export_step", 1) or 1)),
            label=(data.get("label") or None),
            created_by=user.id,
        )
        db.add(track)
        db.flush()
        key = VideoAnnotation(
            video_id=video.id,
            track_id=track.id,
            frame_no=frame_no,
            class_id=cls.id,
            ann_type="bbox",
            geometry=geometry,
            visible=True,
            source=data.get("source") or "human",
            created_by=user.id,
        )
        db.add(key)
        db.commit()
        track.class_index = cls.class_index
        return jsonify(_track_json(track, [key])), 201
    finally:
        db.close()


@bp.patch("/api/video-tracks/<track_id>")
def update_track(track_id):
    """Настройки трека: класс, интерполяция, шаг выгрузки, кадр исчезновения."""
    db, task, track, err = _resolve_track(track_id)
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        video = db.get(TaskVideo, track.video_id)
        if "class_index" in data:
            cls = _class_by_index(db, task.project_id, data.get("class_index"))
            if cls is None:
                return jsonify({"error": "Класс не найден в проекте."}), 400
            track.class_id = cls.id
            # Класс трека — класс всех его боксов: разные классы на кадрах
            # одного объекта означали бы, что это разные объекты.
            db.execute(
                VideoAnnotation.__table__.update()
                .where(VideoAnnotation.track_id == track.id)
                .values(class_id=cls.id)
            )
        if "interpolate" in data:
            track.interpolate = bool(data["interpolate"])
        if "export_step" in data:
            try:
                step = int(data["export_step"])
            except (TypeError, ValueError):
                return jsonify({"error": "Шаг должен быть числом."}), 400
            if step < 1:
                return jsonify({"error": "Шаг должен быть больше нуля."}), 400
            track.export_step = step
        if "label" in data:
            track.label = (data.get("label") or "").strip()[:64] or None
        if "end_frame" in data:
            raw = data["end_frame"]
            if raw is None:
                track.end_frame = None
            else:
                try:
                    end = int(raw)
                except (TypeError, ValueError):
                    return jsonify({"error": "Кадр должен быть числом."}), 400
                if end < track.start_frame:
                    return jsonify({
                        "error": "Объект не может исчезнуть раньше, чем появился."
                    }), 400
                track.end_frame = end
                # Ключевые кадры за пределом жизни трека больше ни на что не
                # влияют и только мешают читать список.
                db.execute(
                    VideoAnnotation.__table__.delete().where(
                        VideoAnnotation.track_id == track.id,
                        VideoAnnotation.frame_no > end,
                    )
                )
        db.commit()

        keys = db.execute(
            select(VideoAnnotation).where(VideoAnnotation.track_id == track.id)
            .order_by(VideoAnnotation.frame_no)
        ).scalars().all()
        cls = db.get(LabelClass, track.class_id)
        track.class_index = cls.class_index if cls else None
        _ = video
        return jsonify(_track_json(track, keys))
    finally:
        db.close()


@bp.delete("/api/video-tracks/<track_id>")
def delete_track(track_id):
    db, task, track, err = _resolve_track(track_id)
    if err:
        return err
    try:
        db.delete(track)
        db.commit()
        return jsonify({"deleted": True})
    finally:
        db.close()


@bp.put("/api/video-tracks/<track_id>/keys/<int:frame_no>")
def put_key(track_id, frame_no):
    """Ключевой кадр: положение объекта, заданное рукой.

    Он же переключает видимость: заслонённый объект остаётся в треке, но с
    этого кадра и до следующего ключевого в разметку не идёт.
    """
    db, task, track, err = _resolve_track(track_id)
    if err:
        return err
    try:
        video = db.get(TaskVideo, track.video_id)
        data = request.get_json(silent=True) or {}
        if frame_no < track.start_frame:
            return jsonify({"error": "Кадр раньше появления объекта."}), 400
        if track.end_frame is not None and frame_no > track.end_frame:
            return jsonify({"error": "Кадр позже исчезновения объекта."}), 400

        row = db.execute(
            select(VideoAnnotation).where(
                VideoAnnotation.track_id == track.id,
                VideoAnnotation.frame_no == frame_no,
            )
        ).scalar_one_or_none()

        if "geometry" in data:
            geometry = _clamp_box(
                data.get("geometry") or {}, video.width or 0, video.height or 0
            )
            if geometry is None:
                return jsonify({"error": "Рамка слишком мала."}), 400
        elif row is not None:
            geometry = row.geometry
        else:
            # Без геометрии новый ключевой кадр брать неоткуда — кроме как из
            # интерполяции: «закрепить то, что сейчас показано» это ровно она.
            keys = db.execute(
                select(VideoAnnotation).where(VideoAnnotation.track_id == track.id)
                .order_by(VideoAnnotation.frame_no)
            ).scalars().all()
            geometry = tracklib.box_at(
                {
                    "start_frame": track.start_frame,
                    "end_frame": track.end_frame,
                    "interpolate": track.interpolate,
                },
                [{"frame_no": k.frame_no, "geometry": k.geometry, "visible": k.visible}
                 for k in keys],
                frame_no,
            )
            if geometry is None and track.end_frame is None and keys:
                # Трек ещё не убирали, а кадр дальше последнего ключа: объект
                # просто не двигали с тех пор. Продолжаем его с прежнего места —
                # иначе «объект заслонён с этого кадра» требовало бы сперва
                # нарисовать рамку там, где рисовать нечего.
                last = max(keys, key=lambda k: k.frame_no)
                if frame_no > last.frame_no:
                    geometry = dict(last.geometry)
            if geometry is None:
                return jsonify({"error": "На этом кадре объекта нет."}), 400

        visible = bool(data.get("visible", row.visible if row else True))
        if row is None:
            row = VideoAnnotation(
                video_id=track.video_id,
                track_id=track.id,
                frame_no=frame_no,
                class_id=track.class_id,
                ann_type="bbox",
                created_by=(task and None),
            )
            db.add(row)
        row.geometry = geometry
        row.visible = visible
        row.source = data.get("source") or "human"
        db.commit()

        keys = db.execute(
            select(VideoAnnotation).where(VideoAnnotation.track_id == track.id)
            .order_by(VideoAnnotation.frame_no)
        ).scalars().all()
        cls = db.get(LabelClass, track.class_id)
        track.class_index = cls.class_index if cls else None
        return jsonify(_track_json(track, keys))
    finally:
        db.close()


@bp.delete("/api/video-tracks/<track_id>/keys/<int:frame_no>")
def drop_key(track_id, frame_no):
    """Снять ключевой кадр. Последний снять нельзя — трек остался бы пустым."""
    db, task, track, err = _resolve_track(track_id)
    if err:
        return err
    try:
        keys = db.execute(
            select(VideoAnnotation).where(VideoAnnotation.track_id == track.id)
            .order_by(VideoAnnotation.frame_no)
        ).scalars().all()
        if len(keys) <= 1:
            return jsonify({
                "error": "Это единственное положение объекта. Удалите трек целиком."
            }), 409
        target = next((k for k in keys if k.frame_no == frame_no), None)
        if target is None:
            return jsonify({"error": "На этом кадре ключа нет."}), 404
        db.delete(target)
        db.flush()
        rest = [k for k in keys if k.frame_no != frame_no]
        # Трек начинается с первого ключа: сняли начальный — начало съезжает.
        track.start_frame = min(k.frame_no for k in rest)
        db.commit()
        cls = db.get(LabelClass, track.class_id)
        track.class_index = cls.class_index if cls else None
        return jsonify(_track_json(track, rest))
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Одиночные боксы
# --------------------------------------------------------------------------- #
@bp.put("/api/tasks/<task_id>/videos/<video_id>/frames/<int:frame_no>/boxes")
def put_frame_boxes(task_id, video_id, frame_no):
    """Обычные боксы кадра — заменяются целиком, как разметка изображения.

    Треков это не касается: они живут во времени и правятся по одному.
    """
    db, task, project, user, role, video = _resolve_video(task_id, video_id, "editor")
    if db is None:
        return video
    try:
        denied = _writable(task, user, role, video)
        if denied:
            return denied
        by_index = {
            c.class_index: c
            for c in db.execute(
                select(LabelClass).where(LabelClass.project_id == project.id)
            ).scalars()
        }
        fresh = []
        for raw in (request.get_json(silent=True) or {}).get("boxes") or []:
            cls = by_index.get(raw.get("class_index"))
            if cls is None:
                continue
            geometry = _clamp_box(raw, video.width or 0, video.height or 0)
            if geometry is None:
                continue
            fresh.append((cls.id, geometry, raw.get("source") or "human"))

        db.execute(
            VideoAnnotation.__table__.delete().where(
                VideoAnnotation.video_id == video.id,
                VideoAnnotation.track_id.is_(None),
                VideoAnnotation.frame_no == frame_no,
            )
        )
        for class_id, geometry, source in fresh:
            db.add(VideoAnnotation(
                video_id=video.id,
                track_id=None,
                frame_no=frame_no,
                class_id=class_id,
                ann_type="bbox",
                geometry=geometry,
                visible=True,
                source=source,
                created_by=user.id,
            ))
        db.commit()
        return jsonify({"saved": len(fresh)})
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Что уйдёт в проект
# --------------------------------------------------------------------------- #
@bp.post("/api/tasks/<task_id>/videos/<video_id>/materialize/preview")
def preview_materialize(task_id, video_id):
    """Сколько кадров и объектов уйдёт в проект — до нажатия «Готово»."""
    db, task, project, user, role, video = _resolve_video(task_id, video_id)
    if db is None:
        return video
    try:
        try:
            by_frame = collect_plan(db, video)
        except tracklib.TrackError as exc:
            return jsonify({"error": str(exc)}), 400
        already = set(db.execute(
            select(Image.source_frame_no).where(
                Image.source_video_id == video.id,
                Image.source_frame_no.isnot(None),
            )
        ).scalars())
        frames = sorted(by_frame)
        return jsonify({
            "frames": len(frames),
            "boxes": sum(len(v) for v in by_frame.values()),
            "new_frames": len([f for f in frames if f not in already]),
            "updated_frames": len([f for f in frames if f in already]),
            "first_frames": frames[:50],
        })
    finally:
        db.close()
