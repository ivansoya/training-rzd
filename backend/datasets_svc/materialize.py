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

from sqlalchemy import func, select

from common import config, tags, task_frames
from common.models import (
    Annotation,
    Image,
    LabelClass,
    TaskVideo,
    VideoAnnotation,
    VideoTrack,
)
from common import polygon as polylib
from datasets_svc import video_index
from datasets_svc import video as videolib
from common import video_tracks as tracklib


def _last_frame(video):
    if video.frame_count:
        return max(0, int(video.frame_count) - 1)
    if video.duration_ms and video.fps:
        return max(0, tracklib.ms_to_frame(video.duration_ms, video.fps) - 1)
    return None


def collect(db, video):
    """Что уйдёт в таску: ``({кадр: [боксы]}, [фоновые кадры])``.

    Зовут трое — предпросмотр в редакторе, сводка незакрытых роликов и само
    закрытие. Расходиться им нельзя, иначе предпросмотр обещает одно, а в таску
    уходит другое; поэтому и фоновые кадры отбираются здесь же, а не у каждого
    вызывающего по-своему.
    """
    payload, singles = task_frames.video_payload(db, video)
    return (
        tracklib.plan(payload, singles, _last_frame(video)),
        tracklib.empty_frames(payload, singles, video.empty_frames),
    )


def frame_is_free(db, video, frame_no):
    """Свободен ли кадр от объектов — по тому же правилу, что и при выгрузке.

    Нужно пометке «фоновый»: спрашивать об этом планом нельзя, шаг выгрузки
    трека выбрасывает из плана кадры, на которых объект есть.
    """
    payload, singles = task_frames.video_payload(db, video)
    return bool(tracklib.empty_frames(payload, singles, [frame_no]))


def frames_in_task(db, video):
    """Сколько черновых кадров ролик дал прежним закрытием.

    Пока они есть, закрыть разметку заново нельзя — их убирают. Принятые в
    датасет не в счёт: убрать их нечем, и раньше они запирали ролик навсегда.
    Один счёт на отказ в закрытии и на сводку.
    """
    return db.execute(
        select(func.count(Image.id)).where(
            Image.source_video_id == video.id, Image.source_frame_no.isnot(None),
            Image.dataset_id.is_(None),
        )
    ).scalar_one()


def accepted_frames(db, video):
    """Номера кадров ролика, уже принятых в датасет: повторное закрытие их не трогает."""
    return set(db.execute(
        select(Image.source_frame_no).where(
            Image.source_video_id == video.id, Image.source_frame_no.isnot(None),
            Image.dataset_id.isnot(None),
        )
    ).scalars())


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

    Нужна вкладке прогресса, шапке таски и карточке ролика: работа по
    незакрытому ролику иначе невидима, и прогресс врал бы.

    Каждый трек считается **отдельно**. Раньше одна негодная дорожка обнуляла
    сводку целиком, и карточка показывала «0 кадров уйдёт в таску» — то есть
    ровно то же, что у ролика без разметки. Теперь видно, сколько даёт каждый
    объект и который из них не считается.
    """
    out = []
    for video in open_videos(db, task):
        payload, singles = task_frames.video_payload(db, video)
        last = _last_frame(video)
        # Имя и цвет берём здесь: в сводке таски классы считаются по уже
        # созданным аннотациям, а у незакрытого ролика их ещё нет — экран
        # показывал бы «класс 0» вместо названия.
        by_class = {
            c.id: (c.class_index, c.name, c.color)
            for c in db.execute(
                select(LabelClass).where(LabelClass.project_id == task.project_id)
            ).scalars()
        }

        objects = []
        for track in payload:
            keys = sorted(track.get("keys") or [], key=lambda k: k["frame_no"])
            index, name, color = by_class.get(track["class_id"], (None, None, None))
            item = {
                "class_index": index,
                "class_name": name,
                "class_color": color,
                "start": track["start_frame"],
                "end": tracklib.track_end(track, keys),
                "keys": len(keys),
                "step": int(track.get("export_step") or 1),
                "interpolate": bool(track.get("interpolate", True)),
                "hidden": len(track.get("hidden_ranges") or []),
                "frames": 0,
                "error": None,
            }
            try:
                item["frames"] = len(tracklib.export_frames(track, keys, last))
            except tracklib.TrackError as exc:
                item["error"] = str(exc)
            objects.append(item)

        row = {
            "video_id": str(video.id),
            "file_name": video.file_name,
            "tracks": len(payload),
            "objects": objects,
            "singles": len(singles),
            "frames_in_task": frames_in_task(db, video),
        }
        if row["frames_in_task"]:
            # Открыли заново, а прежние кадры на месте: план не станет кадрами,
            # пока их не уберут. Считать его в «ждут закрытия» значило бы
            # показать одни и те же кадры дважды — рядом с «размечено».
            row.update({
                "frames": 0, "boxes": 0, "empty": 0, "unchecked": 0,
                "error": f"Прежние кадры ролика ещё в таске ({row['frames_in_task']}) — "
                         "уберите их, чтобы закрыть разметку заново.",
            })
            out.append(row)
            continue
        try:
            plan, empty = collect(db, video)
        except tracklib.TrackError as exc:
            # План целиком не считается, но остальное показать всё равно надо:
            # человеку нужно знать, какой именно объект мешает закрыть разметку.
            row.update({"frames": 0, "boxes": 0, "empty": 0, "unchecked": 0, "error": str(exc)})
            out.append(row)
            continue
        if not plan and not empty:
            continue
        row.update({
            # Фоновые кадры — такие же кадры таски, поэтому входят в общее
            # число; отдельным полем видно, сколько их из этого числа.
            "frames": len(plan) + len(empty),
            "boxes": sum(len(v) for v in plan.values()),
            "empty": len(empty),
            "unchecked": unchecked_frames(plan),
        })
        out.append(row)
    return out


def unchecked_frames(plan):
    """Сколько кадров плана уйдут с непроверенной разметкой агента."""
    return len([f for f, items in plan.items() if any(i.get("pending") for i in items)])


def _file_name(video, frame_no):
    stem = os.path.splitext(video.file_name)[0]
    return f"{stem}_f{frame_no:06d}.jpg"


def drop_frame_files(task, image_ids):
    """Файлы кадров, чьи строки откатились: иначе они остались бы на томе ничьими."""
    base = config.image_base_dir(task.project_id, task.id)
    for image_id in image_ids:
        for sub in ("images", "thumbs", "preview"):
            try:
                os.remove(os.path.join(base, sub, f"{image_id}.jpg"))
            except OSError:
                pass


def run_video(db, task, video, user_id, progress=None):
    """Выполняет план одного ролика. Коммит остаётся за вызывающим.

    Кадры создаются нетронутыми данными таски: со статусом «размечен», но без
    датасета — в проект они уйдут обычной сдачей вместе со всеми остальными.
    Помеченные фоновыми уходят со статусом «empty» и без разметки — ровно тем
    же, каким разметчик изображений объявляет кадр фоновым примером.

    Всё или ничего: при ошибке файлы созданных кадров убираются здесь же, строки
    откатывает вызывающий. ``image_ids`` в ответе — чтобы убрать файлы, если
    упадёт уже его коммит.
    """
    source = os.path.join(config.DATA_DIR, video.file_path)
    if not os.path.exists(source):
        raise videolib.VideoError(
            f"Файл ролика «{video.file_name}» не найден — доставать кадры неоткуда."
        )

    # Номер кадра — позиция в таблице кадров ролика, как у `/frame` и перегонов.
    # Закрытие — фоновая работа, так что недостроенную таблицу строим здесь же.
    # До замка: `store` коммитит и отпустил бы его.
    index = video_index.ensure(db, video, source)

    # Замок на ролик до коммита: агент из training-worker, пишущий рамки, ждёт
    # его и после видит закрытый ролик, а не дописывает мимо снятого плана.
    db.execute(select(TaskVideo.id).where(TaskVideo.id == video.id).with_for_update())
    by_frame, empty = collect(db, video)
    empty_set = set(empty)
    if not by_frame and not empty_set:
        return {"created": 0, "boxes": 0, "empty": 0, "kept_accepted": 0, "image_ids": []}

    base = config.image_base_dir(task.project_id, task.id)
    created = {}
    # Кадр, на котором одно непроверенное агента, уходит в таску новым. Рамки
    # переезжают со своим флагом: проверять их дальше можно и в редакторе кадров.
    # Любая работа человека на кадре (своя рамка, проверенная агентова, трек)
    # делает его размеченным.
    unchecked = {
        f for f, items in by_frame.items()
        if items and all(i.get("pending") for i in items)
    }
    # Таги ролика — один раз на всю материализацию, а не на кадр.
    video_tags = tags.ids_of(db, "video", video.id)

    def on_frame(frame_no, time_ms, img):
        image = Image(
            project_id=task.project_id,
            dataset_id=None,
            task_id=task.id,
            task_status=("empty" if frame_no in empty_set
                         else "new" if frame_no in unchecked else "annotated"),
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
        tags.link(db, "image", image.id, video_tags)
        full, size, nbytes = videolib.save_frame(img, base, image.id)
        image.file_path = os.path.relpath(full, config.DATA_DIR)
        image.width, image.height = size
        image.size_bytes = nbytes
        created[frame_no] = image.id
        if progress and len(created) % 20 == 0:
            progress(len(created))

    # Одним проходом декодера: фоновые кадры перемешаны с размеченными, и
    # второй проход по тому же ролику стоил бы столько же, сколько первый.
    # Принятые кадры — уже данные проекта: создаём только недостающие номера.
    kept = accepted_frames(db, video)
    by_frame = {f: items for f, items in by_frame.items() if f not in kept}
    empty_set = empty_set - kept
    wanted = set(by_frame) | empty_set
    try:
        videolib.extract_frames(source, sorted(wanted), on_frame, pts=index["pts"])
        missing = sorted(wanted - set(created))
        if missing:
            # Кадр не дошёл — разметка на нём потерялась бы молча. Лучше не записать ничего.
            raise videolib.VideoError(
                f"Не достались кадры {', '.join(map(str, missing[:5]))}"
                f"{' и ещё ' + str(len(missing) - 5) if len(missing) > 5 else ''} — "
                "ничего не записано."
            )
        boxes = _annotate(db, by_frame, created, user_id)
    except BaseException:
        drop_frame_files(task, created.values())
        raise

    if progress:
        progress(len(created))
    return {
        "created": len(created),
        "boxes": boxes,
        "empty": len([f for f in empty_set if f in created]),
        "kept_accepted": len(kept),
        "image_ids": list(created.values()),
    }


def _annotate(db, by_frame, created, user_id):
    """Фигуры плана — аннотациями на созданные кадры. Возвращает их число."""
    boxes = 0
    for frame_no, planned in sorted(by_frame.items()):
        image_id = created[frame_no]
        for item in planned:
            geometry = item["geometry"]
            ann_type = item.get("ann_type") or "bbox"
            if ann_type == "polygon":
                # Площадь контура — сумма площадей его частей: объект,
                # разорванный надвое, занимает ровно столько, сколько занимают
                # обе половины.
                parts = polylib.parts_of(geometry)
                area = sum(polylib.area(ring) for ring in parts)
            else:
                area = geometry["w"] * geometry["h"]
            db.add(Annotation(
                image_id=image_id,
                class_id=item["class_id"],
                ann_type=ann_type,
                geometry=geometry,
                area=round(area, 2),
                source=item.get("source") or "human",
                agent_version_id=item.get("agent_version_id"),
                created_by=item.get("created_by") or user_id,
                pending=bool(item.get("pending")),
                reviewed_by=item.get("reviewed_by"),
            ))
            boxes += 1
    # Ошибка строки (класс удалён, кривая геометрия) — здесь, а не на коммите.
    db.flush()
    return boxes
