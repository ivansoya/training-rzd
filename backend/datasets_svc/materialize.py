"""Кадры размечаемого ролика: как разметка ролика становится кадрами датасета.

Пока таска в работе, разметка ролика — номера кадров и боксы на них. Изображений
не существует: держать на диске каждый тронутый кадр значило бы плодить файлы,
которые разметчик через минуту перерисует.

Сдача таски («Готово», «Закрыто») выполняет план ролика, и кадры уходят в датасет
вместе с остальными (решение 14.10.2026; ручное «Закрыть разметку» убрано — после
него ролик было не вернуть в работу). Кадр «ролик + номер» один на все сдачи:
повторная обновляет его на месте — рамки и состояние из ролика, а id, сплит и таги
остаются. Кадр, который правили в датасете после прошлой сдачи, сдача не трогает:
чужая работа молча не затирается. Возврат таски к разметке убирает черновые кадры
ролика — их рамки и так в ролике.

Разово после выкладки: ``python -m datasets_svc.materialize [--yes]`` убирает нетронутые
черновики роликов в тасках, которые в работе (остались от ручного закрытия).
"""
import os

from sqlalchemy import select

from common import config, tags, task_frames
from common.models import (
    Annotation,
    Image,
    LabelClass,
    Task,
    TaskVideo,
)
from common import polygon as polylib
from datasets_svc import video_index
from datasets_svc import video as videolib
from common import video_tracks as tracklib

# Таски, в которых черновых кадров ролика быть не должно: они рождаются сдачей.
WORKING = ("queued", "in_progress", "updating")


def _last_frame(video):
    if video.frame_count:
        return max(0, int(video.frame_count) - 1)
    if video.duration_ms and video.fps:
        return max(0, tracklib.ms_to_frame(video.duration_ms, video.fps) - 1)
    return None


def collect(db, video, shapes=True, loaded=None):
    """Что уйдёт в датасет: ``({кадр: [боксы]}, [фоновые кадры])``.

    Зовут трое — предпросмотр в редакторе, сводка роликов таски и сама сдача.
    Расходиться им нельзя, иначе предпросмотр обещает одно, а уходит другое;
    поэтому и фоновые кадры отбираются здесь же, а не у каждого вызывающего по-своему.

    Геометрия одиночных нужна только сдаче: остальные считают (`shapes=False`).
    `loaded` — уже прочитанный `video_payload`, чтобы не читать ролик второй раз.
    """
    payload, singles = loaded or task_frames.video_payload(db, video, shapes)
    return (
        tracklib.plan(payload, singles, _last_frame(video)),
        tracklib.empty_frames(payload, singles, video.empty_frames),
    )


def frame_is_free(db, video, frame_no):
    """Свободен ли кадр от объектов — по тому же правилу, что и при выгрузке.

    Нужно пометке «фоновый»: спрашивать об этом планом нельзя, шаг выгрузки
    трека выбрасывает из плана кадры, на которых объект есть.
    """
    payload, singles = task_frames.video_payload(db, video, shapes=False)
    return bool(tracklib.empty_frames(payload, singles, [frame_no]))


def edited(image):
    """Правили после прошлой сдачи: разметку (счётчик ушёл от отметки) или забраковали."""
    return image.task_status == "deleted" or image.annotations_rev != (image.handed_rev or 0)


def annotate_videos(db, task):
    return db.execute(
        select(TaskVideo).where(TaskVideo.task_id == task.id, TaskVideo.mode == "annotate")
    ).scalars().all()


def pending_summary(db, task):
    """Что уйдёт при сдаче: по строке на размечаемый ролик с разметкой.

    Нужна вкладке прогресса, шапке таски и карточке ролика: работа по ролику
    до сдачи иначе невидима, и прогресс врал бы.

    Каждый трек считается **отдельно**. Раньше одна негодная дорожка обнуляла
    сводку целиком, и карточка показывала «0 кадров» — то есть ровно то же, что у
    ролика без разметки. Теперь видно, сколько даёт каждый объект и который не считается.
    """
    by_class = class_look(db, task.project_id)
    return [row for video in annotate_videos(db, task) if (row := pending_row(db, video, by_class))]


def class_look(db, project_id):
    """{класс: (номер, имя, цвет)}. Имя и цвет берём здесь: в сводке таски классы считаются
    по уже созданным аннотациям, а у ролика до сдачи их нет — экран показывал бы «класс 0»."""
    return {
        c.id: (c.class_index, c.name, c.color)
        for c in db.execute(select(LabelClass).where(LabelClass.project_id == project_id)).scalars()
    }


def pending_row(db, video, by_class):
    """Строка сводки одного ролика; None — при сдаче от него ничего не уйдёт.
    Страница таски спрашивает ролики по одному, чтобы тяжёлый не держал остальные."""
    loaded = task_frames.video_payload(db, video, shapes=False)
    payload, singles = loaded
    last = _last_frame(video)

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
    }
    try:
        plan, empty = collect(db, video, loaded=loaded)
    except tracklib.TrackError as exc:
        # План целиком не считается, но остальное показать всё равно надо:
        # человеку нужно знать, какой именно объект мешает сдаче.
        row.update({"frames": 0, "boxes": 0, "empty": 0, "unchecked": 0, "error": str(exc)})
        return row
    if not plan and not empty:
        return None
    row.update({
        # Фоновые кадры — такие же кадры, поэтому входят в общее число;
        # отдельным полем видно, сколько их из этого числа.
        "frames": len(plan) + len(empty),
        "boxes": sum(len(v) for v in plan.values()),
        "empty": len(empty),
        "unchecked": unchecked_frames(plan),
    })
    return row


def unchecked_frames(plan):
    """Сколько кадров плана с непроверенной разметкой агента: в датасет они не уйдут."""
    return len([f for f, items in plan.items() if any(i.get("pending") for i in items)])


def _file_name(video, frame_no):
    stem = os.path.splitext(video.file_name)[0]
    return f"{stem}_f{frame_no:06d}.jpg"


def drop_frame_files(project_id, task_id, image_ids):
    """Файлы кадров, чьих строк больше нет: иначе они остались бы на томе ничьими."""
    base = config.image_base_dir(project_id, task_id)
    for image_id in image_ids:
        for sub in ("images", "thumbs", "preview"):
            try:
                os.remove(os.path.join(base, sub, f"{image_id}.jpg"))
            except OSError:
                pass


def hand_over(db, task, video, user_id, progress=None):
    """Сдача одного ролика. Коммит, как и `_accept`, — за вызывающим.

    По номеру кадра: правленый после прошлой сдачи — не трогаем; есть изображение —
    обновляем на месте; нет — достаём из ролика. Выпавшие из плана изображения
    убираются. Кадр с непроверенным агента в датасет не идёт: новый остаётся
    черновиком, а уже бывший в датасете — прежним, пока непроверенное не разберут.

    Всё или ничего: при ошибке файлы новых кадров убираются здесь же, строки
    откатывает вызывающий. В ответе `image_ids` — файлы новых кадров (убрать, если
    упадёт уже его коммит), `dropped_ids` — файлы убранных (удалить после коммита).
    """
    source = os.path.join(config.DATA_DIR, video.file_path)
    if not os.path.exists(source):
        raise videolib.VideoError(
            f"Файл ролика «{video.file_name}» не найден — доставать кадры неоткуда."
        )

    # Номер кадра — позиция в таблице кадров ролика, как у `/frame` и перегонов.
    # Сдача — фоновая работа, так что недостроенную таблицу строим здесь же.
    # До замка: `store` коммитит и отпустил бы его.
    index = video_index.ensure(db, video, source)

    # Замок на ролик до коммита: агент из training-worker, пишущий рамки, ждёт
    # его и после видит сданную таску, а не дописывает мимо снятого плана.
    db.execute(select(TaskVideo.id).where(TaskVideo.id == video.id).with_for_update())
    by_frame, empty = collect(db, video)
    empty_set = set(empty)
    unchecked = {f for f, items in by_frame.items() if any(i.get("pending") for i in items)}
    have = {
        img.source_frame_no: img for img in db.execute(
            select(Image).where(Image.source_video_id == video.id, Image.source_frame_no.isnot(None))
        ).scalars()
    }
    kept = {f for f, img in have.items() if edited(img)}
    planned = set(by_frame) | empty_set
    stats = {"planned": len(planned), "created": 0, "updated": 0, "removed": 0, "kept_edited": len(kept),
             "waiting": 0, "boxes": 0, "empty": 0, "unchecked": 0}

    # Выпавшие из плана: строки уходят сейчас, файлы — после коммита.
    dropped = []
    for f, img in have.items():
        if f not in planned and f not in kept:
            dropped.append(img.id)
            db.delete(img)
    stats["removed"] = len(dropped)

    # Уже есть: рамки и состояние — из ролика, id/сплит/таги остаются.
    for f in sorted(planned & set(have) - kept):
        img = have[f]
        if f in unchecked:
            stats["waiting"] += 1
            continue
        db.execute(Annotation.__table__.delete().where(Annotation.image_id == img.id))
        img.task_status = "empty" if f in empty_set else "annotated"
        # Открытый редактор датасета получит «stale», а не запишет старое поверх.
        img.annotations_rev += 1
        img.handed_rev = img.annotations_rev
        stats["boxes"] += _annotate(db, {f: by_frame.get(f, [])}, {f: img.id}, user_id)
        stats["empty"] += f in empty_set
        stats["updated"] += 1

    # Ход — по кадрам плана: обновлённые на месте разжимать не надо, они идут сразу.
    ready = len(planned & set(have))
    if progress:
        progress(ready)
    base = config.image_base_dir(task.project_id, task.id)
    created = {}
    # Таги ролика — один раз на всю сдачу, а не на кадр.
    video_tags = tags.ids_of(db, "video", video.id)
    wanted = planned - set(have)

    def on_frame(frame_no, time_ms, img):
        image = Image(
            project_id=task.project_id,
            dataset_id=None,
            task_id=task.id,
            # Кадр, на котором одно непроверенное агента, — новый: работы человека на нём нет.
            task_status=("empty" if frame_no in empty_set
                         else "new" if all(i.get("pending") for i in by_frame[frame_no]) else "annotated"),
            file_name=_file_name(video, frame_no),
            file_path="",
            split="other",
            source_video_id=video.id,
            source_frame_no=frame_no,
            source_time_ms=time_ms,
            handed_rev=0,
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
            progress(ready + len(created))

    # Одним проходом декодера: фоновые кадры перемешаны с размеченными, и
    # второй проход по тому же ролику стоил бы столько же, сколько первый.
    try:
        if wanted:
            videolib.extract_frames(source, sorted(wanted), on_frame, pts=index["pts"])
        missing = sorted(wanted - set(created))
        if missing:
            # Кадр не дошёл — разметка на нём потерялась бы молча. Лучше не записать ничего.
            raise videolib.VideoError(
                f"Не достались кадры {', '.join(map(str, missing[:5]))}"
                f"{' и ещё ' + str(len(missing) - 5) if len(missing) > 5 else ''} — "
                "ничего не записано."
            )
        stats["boxes"] += _annotate(db, {f: v for f, v in by_frame.items() if f in created}, created, user_id)
    except BaseException:
        drop_frame_files(task.project_id, task.id, created.values())
        raise

    stats["created"] = len(created)
    stats["empty"] += len([f for f in empty_set if f in created])
    stats["unchecked"] = len([f for f in unchecked if f in created])
    if progress:
        progress(len(planned))
    return {**stats, "image_ids": list(created.values()), "dropped_ids": dropped}


def _annotate(db, by_frame, created, user_id):
    """Фигуры плана — аннотациями на кадры. Возвращает их число."""
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


def drop_drafts(db, task):
    """Возврат к разметке: черновые кадры роликов таски уходят — их рамки и так в ролике.
    Правленые не трогаем. Возвращает id, чьи файлы убрать после коммита."""
    rows = db.execute(
        select(Image).where(Image.task_id == task.id, Image.dataset_id.is_(None),
                            Image.source_frame_no.isnot(None), task_frames.video_frame())
    ).scalars().all()
    gone = [img for img in rows if not edited(img)]
    for img in gone:
        db.delete(img)
    return [img.id for img in gone]


def _main():
    """Разовая уборка после выкладки 14.10.2026: черновики от ручного закрытия в тасках в работе."""
    import argparse

    from common.db import SessionLocal

    parser = argparse.ArgumentParser(description=_main.__doc__)
    parser.add_argument("--yes", action="store_true", help="удалить; без него — только счёт")
    args = parser.parse_args()
    db = SessionLocal()
    try:
        total = 0
        for task in db.execute(select(Task).where(Task.status.in_(WORKING))).scalars().all():
            ids = drop_drafts(db, task)
            if not ids:
                continue
            total += len(ids)
            print(f"таска {task.id} ({task.status}): черновиков {len(ids)}")
            if args.yes:
                db.commit()
                drop_frame_files(task.project_id, task.id, ids)
            else:
                db.rollback()
        print(f"всего {total}{'' if args.yes else ' — ничего не удалено, запустите с --yes'}")
    finally:
        db.close()


if __name__ == "__main__":
    _main()
