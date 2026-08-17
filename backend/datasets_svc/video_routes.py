"""Разметка видео: кадры, треки и покадровые боксы.

Пока разметка ролика не закрыта, она живёт в ``video_tracks`` и
``video_annotations``, а не в обычных ``annotations``: кадров как изображений
ещё нет, есть только номера кадров на ролике. Закрытие разметки — отдельное
действие, а не сдача таски: оно достаёт нужные кадры и превращает их в
обычные кадры таски, после чего они живут своей жизнью и никем не
переписываются (см. ``materialize``).

Кадр выдаётся сервером, а не берётся из ``<video>`` в браузере: currentTime не
даёт номера кадра, браузер волен показать соседний, а mkv и avi он не играет
вовсе. Быстрая перемотка держится на прогреве окна кадров одним проходом
декодера — подряд идущие кадры дешевле одиночных примерно в восемьдесят раз.
"""
import os
import threading

from flask import Blueprint, jsonify, request, send_file
from sqlalchemy import func, select

from common import config, jobs
from common.db import SessionLocal
from common.models import (
    Image,
    LabelClass,
    Task,
    TaskVideo,
    User,
    VideoAnnotation,
    VideoTrack,
    utcnow,
)
from datasets_svc import materialize
from datasets_svc import video as videolib
from datasets_svc import video_chunks as chunklib
from datasets_svc import video_tracks as tracklib
from datasets_svc.materialize import collect_plan
from datasets_svc.task_routes import (
    _clamp_box,
    _drop_files,
    _log,
    _may_work,
    _resolve_task,
    _uuid_or_none,
)

bp = Blueprint("video_annotation", __name__)

# Сколько распакованных кадров держим на томе. Кадр 1920×1080 в JPEG — около
# 200 КБ, так что несколько сотен на ролик стоят дешевле, чем повторное
# декодирование при каждом возврате на уже виденный момент.
# Кадр 1080p в полном качестве весит около 200 КБ. Окно ±120 кадров — это
# почти по пять секунд в обе стороны на 25 к/с; кэша на полторы тысячи кадров
# хватает на несколько таких окон, а стирается он вместе с роликом.
FRAME_CACHE_PER_VIDEO = 1500
# За один прогрев больше этого не распаковываем: запрос не должен висеть
# минутами, а окно такого размера и не нужно.
PREFETCH_MAX = 400


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
        "hidden_ranges": track.hidden_ranges or [],
        "keys": [
            {"frame_no": k.frame_no, "geometry": k.geometry, "source": k.source}
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
# Перегоны: видео кусками, разжимает их браузер
# --------------------------------------------------------------------------- #
# Пока перегон режется, второй запрос на него же должен ждать первой нарезки,
# а не запускать свою: иначе два кодировщика молотят одно и то же.
_cut_locks = {}
_cut_locks_guard = threading.Lock()


def _cut_lock(key):
    with _cut_locks_guard:
        lock = _cut_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _cut_locks[key] = lock
        return lock


def _video_file(video):
    return os.path.join(config.DATA_DIR, video.file_path)


def _clip_index(db, video):
    """Таблица кадров ролика; строится при первом обращении, если её ещё нет.

    Заодно чинит записи, загруженные до появления таблицы: точное число кадров
    известно только отсюда — ``stream.frames`` у контейнера врёт или молчит.
    """
    path = _video_file(video)
    if not os.path.exists(path):
        return None, (jsonify({"error": "Файл видео не найден."}), 404)
    try:
        index = chunklib.ensure_index(path)
    except chunklib.VideoError as exc:
        return None, (jsonify({"error": str(exc)}), 400)
    if video.frame_count != index["count"] or video.index_version != index["version"]:
        video.frame_count = index["count"]
        video.index_version = index["version"]
        db.commit()
    return index, None


# Какие ступени качества сейчас режутся: повторное открытие ролика не должно
# заводить вторую такую же работу.
_cutting = {}
_cutting_guard = threading.Lock()


def _run_quality_cut(job_id, source, index, quality):
    try:
        made = chunklib.cut_all(
            source, index, quality,
            progress=lambda done, total: jobs.update(job_id, processed=done),
            skip_existing=True,
        )
        jobs.update(job_id, status="done", processed=index["count"],
                    result={"chunks": made, "quality": quality})
    except Exception as exc:  # noqa: BLE001
        jobs.update(job_id, status="error", error=str(exc))


def _ensure_cut(video, index, quality):
    """Нарезать всю ступень в фоне, если её ещё нет.

    Резать по одному перегону в момент запроса — худшее из возможного: каждый
    переход через границу стоит полной нарезки, а в исходном разрешении это
    шесть секунд. Первый же запрос ступени заводит работу на весь ролик, и
    ждать приходится только этот первый перегон.

    Заодно чинит ролики, загруженные до появления перегонов: у них нарезки нет
    вовсе, и досоздать её больше некому.
    """
    source = _video_file(video)
    total = chunklib.chunk_count(index["count"])
    if chunklib.ready_count(source, total, quality) >= total:
        return None

    key = (str(video.id), quality)
    with _cutting_guard:
        running = _cutting.get(key)
        state = jobs.get(running) if running else None
        if state and state.get("status") == "running":
            return running
        job_id = jobs.create(
            "video-chunks", total=index["count"], message="Готовлю перегоны"
        )
        _cutting[key] = job_id
    threading.Thread(
        target=_run_quality_cut,
        args=(job_id, source, index, quality),
        daemon=True,
    ).start()
    return job_id


@bp.get("/api/tasks/<task_id>/videos/<video_id>/clip")
def video_clip(task_id, video_id):
    """Всё, что клиенту нужно знать о ролике, чтобы начать разметку.

    Перечень перегонов отдаётся явно — какие кадры лежат в каждом. Клиент
    номер кадра не вычисляет ни здесь, ни при разжатии: i-й кадр перегона есть
    ``chunks[k].first + i``, и это объявление сервера, а не арифметика.
    """
    db, task, project, user, role, video = _resolve_video(task_id, video_id)
    if db is None:
        return video
    try:
        if video.mode != "annotate":
            return jsonify({"error": "Это видео загружено для нарезки на кадры."}), 409
        index, err = _clip_index(db, video)
        if err:
            return err
        body = chunklib.manifest(index)
        quality = request.args.get("q") or body["default_quality"]
        if not chunklib.known(quality, index["height"]):
            quality = body["default_quality"]
        body["quality"] = quality
        body["ready"] = chunklib.ready_count(
            _video_file(video), len(body["chunks"]), quality
        )
        body["cut_job"] = _ensure_cut(video, index, quality)
        body["fps"] = video.fps
        body["file_name"] = video.file_name
        return jsonify(body)
    finally:
        db.close()


@bp.get("/api/tasks/<task_id>/videos/<video_id>/chunks/<int:chunk_no>")
def video_chunk(task_id, video_id, chunk_no):
    """Перегон: кусок ролика в 120 кадров, который браузер разожмёт сам.

    Обычно он уже нарезан фоновой задачей после загрузки. Если нет — режем
    здесь и держим соединение: клиенту не нужна машина состояний «ещё не
    готово», ему нужен обычный медленный запрос.
    """
    db, task, project, user, role, video = _resolve_video(task_id, video_id)
    if db is None:
        return video
    try:
        index, err = _clip_index(db, video)
        if err:
            return err
        quality = request.args.get("q") or chunklib.default_for(index["height"])
        if not chunklib.known(quality, index["height"]):
            return jsonify({"error": "Неизвестное качество перегона."}), 400
        try:
            first, last = chunklib.chunk_bounds(chunk_no, index["count"])
        except chunklib.VideoError as exc:
            return jsonify({"error": str(exc)}), 404

        source = _video_file(video)
        path = chunklib.chunk_path(source, chunk_no, quality)
        if not os.path.exists(path):
            # Этот перегон режем прямо сейчас, а всю ступень — фоном: иначе
            # каждый следующий переход стоил бы столько же.
            _ensure_cut(video, index, quality)
            with _cut_lock((str(video.id), quality, chunk_no)):
                if not os.path.exists(path):
                    try:
                        chunklib.cut_chunk(source, index, chunk_no, quality)
                    except chunklib.VideoError as exc:
                        return jsonify({"error": str(exc)}), 500

        resp = send_file(path, mimetype="video/mp4", conditional=True)
        # Какие кадры внутри — говорит сервер, а не считает клиент.
        resp.headers["X-Chunk-First"] = str(first)
        resp.headers["X-Chunk-Count"] = str(last - first + 1)
        resp.headers["X-Index-Version"] = index["version"]
        resp.headers["Access-Control-Expose-Headers"] = (
            "X-Chunk-First, X-Chunk-Count, X-Index-Version"
        )
        # Перегон по номеру неизменен, пока жив ролик.
        resp.headers["Cache-Control"] = "private, max-age=86400, immutable"
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
        if "hidden_ranges" in data:
            try:
                track.hidden_ranges = tracklib.normalize_ranges(data["hidden_ranges"])
            except tracklib.TrackError as exc:
                return jsonify({"error": str(exc)}), 400
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
            state = tracklib.state_at(
                {
                    "start_frame": track.start_frame,
                    "end_frame": track.end_frame,
                    "interpolate": track.interpolate,
                    "hidden_ranges": track.hidden_ranges or [],
                },
                [{"frame_no": k.frame_no, "geometry": k.geometry} for k in keys],
                frame_no,
            )
            # Заслонённый объект всё равно где-то находится — ключ на таком
            # кадре законен, он и задаёт, где именно.
            geometry = state["geometry"] if state else None
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


@bp.patch("/api/video-tracks/<track_id>/keys/<int:frame_no>")
def move_key(track_id, frame_no):
    """Перенести ключевой кадр на другой кадр.

    Отдельный маршрут, а не «удалить и поставить»: между двумя запросами трек
    остался бы без ключа, и обрыв связи посередине потерял бы работу руками.
    """
    db, task, track, err = _resolve_track(track_id)
    if err:
        return err
    try:
        data = request.get_json(silent=True) or {}
        try:
            target = int(data.get("to"))
        except (TypeError, ValueError):
            return jsonify({"error": "Не указан кадр, куда переносим."}), 400
        if track.end_frame is not None and target > track.end_frame:
            return jsonify({"error": "Кадр позже исчезновения объекта."}), 400

        keys = db.execute(
            select(VideoAnnotation).where(VideoAnnotation.track_id == track.id)
            .order_by(VideoAnnotation.frame_no)
        ).scalars().all()
        row = next((k for k in keys if k.frame_no == frame_no), None)
        if row is None:
            return jsonify({"error": "На этом кадре ключа нет."}), 404
        if target == frame_no:
            return jsonify(_track_json(track, keys))
        if any(k.frame_no == target for k in keys):
            return jsonify({"error": "На этом кадре уже есть ключ."}), 409

        row.frame_no = target
        db.flush()
        rest = [k for k in keys if k.id != row.id] + [row]
        # Начало трека — его первый ключ: перенесли начальный, начало съехало.
        track.start_frame = min(k.frame_no for k in rest)
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


@bp.post("/api/tasks/<task_id>/videos/<video_id>/frames/prefetch")
def prefetch_frames(task_id, video_id):
    """Распаковать окно кадров одним проходом декодера.

    Подряд идущие кадры примерно в восемьдесят раз дешевле одиночных: перемотка
    к каждому стоит сотни миллисекунд, а последовательный проход — единицы.
    Поэтому редактор просит не по кадру, а окно вокруг текущего места, и
    дальше берёт кадры обычными запросами, попадая в этот кэш.
    """
    db, task, project, user, role, video = _resolve_video(task_id, video_id)
    if db is None:
        return video
    try:
        data = request.get_json(silent=True) or {}
        try:
            start = max(0, int(data.get("from", 0)))
            end = int(data.get("to", 0))
        except (TypeError, ValueError):
            return jsonify({"error": "Границы окна должны быть числами."}), 400
        last = _last_frame(video)
        if last is not None:
            end = min(end, last)
        if end < start:
            return jsonify({"ready": 0, "decoded": 0})
        if end - start + 1 > PREFETCH_MAX:
            return jsonify({
                "error": f"За один раз распаковываем не больше {PREFETCH_MAX} кадров."
            }), 400

        folder = _frame_dir(task, video.id)
        os.makedirs(folder, exist_ok=True)
        missing = [
            n for n in range(start, end + 1)
            if not os.path.exists(os.path.join(folder, f"{n}.jpg"))
        ]
        if not missing:
            return jsonify({"ready": end - start + 1, "decoded": 0})

        source = os.path.join(config.DATA_DIR, video.file_path)
        if not os.path.exists(source):
            return jsonify({"error": "Файл видео не найден."}), 404

        def on_frame(frame_no, _time_ms, img):
            path = os.path.join(folder, f"{frame_no}.jpg")
            tmp = path + ".part"
            img.convert("RGB").save(tmp, "JPEG", quality=88)
            os.replace(tmp, path)

        try:
            decoded = videolib.extract_frames(source, missing, on_frame)
        except videolib.VideoError as exc:
            return jsonify({"error": str(exc)}), 400
        _trim_cache(folder)
        return jsonify({"ready": end - start + 1, "decoded": decoded})
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Закрытие разметки: план становится кадрами таски
# --------------------------------------------------------------------------- #
def _run_close_job(job_id, task_id, video_id, user_id):
    db = SessionLocal()
    try:
        task = db.get(Task, task_id)
        video = db.get(TaskVideo, video_id)
        made = materialize.run_video(
            db, task, video, user_id,
            progress=lambda done: jobs.update(job_id, processed=done),
        )
        video.annotation_closed_at = utcnow()
        user = db.get(User, user_id) if user_id else None
        _log(db, task, user, "video_annotation_closed",
             file=video.file_name, frames=made["created"], boxes=made["boxes"])
        db.commit()
        jobs.update(job_id, status="done", processed=made["created"], result=made)
    except (videolib.VideoError, tracklib.TrackError) as exc:
        db.rollback()
        jobs.update(job_id, status="error", error=str(exc))
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        jobs.update(job_id, status="error", error=str(exc))
    finally:
        db.close()


@bp.post("/api/tasks/<task_id>/videos/<video_id>/close-annotation")
def close_annotation(task_id, video_id):
    """Превратить разметку ролика в обычные кадры таски.

    Это событие, а не синхронизация: созданные кадры дальше живут как любые
    другие — правятся в обычном редакторе, уходят в проект штатной сдачей и
    никем не переписываются. Поэтому закрыть повторно, пока прежние кадры на
    месте, нельзя: сперва их надо убрать.
    """
    db, task, project, user, role, video = _resolve_video(task_id, video_id, "editor")
    if db is None:
        return video
    try:
        denied = _writable(task, user, role, video)
        if denied:
            return denied
        existing = db.execute(
            select(func.count(Image.id)).where(
                Image.source_video_id == video.id, Image.source_frame_no.isnot(None)
            )
        ).scalar_one()
        if existing:
            return jsonify({
                "error": f"У ролика уже есть {existing} кадров в таске. "
                         "Удалите их, чтобы разметить заново.",
                "code": "frames_exist",
                "frames": existing,
            }), 409

        try:
            plan = collect_plan(db, video)
        except tracklib.TrackError as exc:
            return jsonify({"error": str(exc)}), 400
        if not plan:
            return jsonify({"error": "Размечать нечего — на ролике нет ни одного бокса."}), 400

        job_id = jobs.create("video-close", total=len(plan), message="Достаю кадры")
        threading.Thread(
            target=_run_close_job,
            args=(job_id, task.id, video.id, user.id),
            daemon=True,
        ).start()
        return jsonify({"job_id": job_id, "frames": len(plan)}), 202
    finally:
        db.close()


@bp.post("/api/tasks/<task_id>/videos/<video_id>/reopen-annotation")
def reopen_annotation(task_id, video_id):
    """Вернуть ролик в работу. Кадры не трогаем — они уже данные таски."""
    db, task, project, user, role, video = _resolve_video(task_id, video_id, "editor")
    if db is None:
        return video
    try:
        denied = _writable(task, user, role, video)
        if denied:
            return denied
        video.annotation_closed_at = None
        _log(db, task, user, "video_annotation_reopened", file=video.file_name)
        db.commit()
        return jsonify({"reopened": True})
    finally:
        db.close()


@bp.delete("/api/tasks/<task_id>/videos/<video_id>/frames")
def drop_video_frames(task_id, video_id):
    """Убрать кадры ролика из таски, чтобы разметить его заново.

    Кадры, уже принятые в датасет, не трогаем: это данные проекта, а не
    черновик таски. Их число возвращаем — человек должен знать, что осталось.
    """
    db, task, project, user, role, video = _resolve_video(task_id, video_id, "editor")
    if db is None:
        return video
    try:
        denied = _writable(task, user, role, video)
        if denied:
            return denied
        rows = db.execute(
            select(Image).where(
                Image.source_video_id == video.id, Image.source_frame_no.isnot(None)
            )
        ).scalars().all()
        base = config.image_base_dir(task.project_id, task.id)
        removed, kept = 0, 0
        for image in rows:
            if image.dataset_id is not None:
                kept += 1
                continue
            _drop_files(base, image.id)
            db.delete(image)
            removed += 1
        _log(db, task, user, "video_frames_dropped",
             file=video.file_name, removed=removed, kept=kept)
        db.commit()
        return jsonify({"removed": removed, "kept_accepted": kept})
    finally:
        db.close()
