"""Экспорт проекта в YOLO-архив: images/ + labels/ + data.yaml.

Весь смысл — в `_plan`: он один раз считает, что войдёт в выгрузку, и им же
пользуются предпросмотр («сколько получится») и джоба («сложи это в zip»).
Разойтись они не могут по построению.

Три правила, вокруг которых всё вертится:

* Класс в выгрузке получает **новый номер 0..N-1**. Номера проекта разрежены
  (38 объявлено, размечено 9), а YOLO требует сплошной ряд. Соответствие
  старого и нового номера кладётся в архив (`classes.json`).
* Кадр попадает в архив, если после фильтра классов у него осталась хотя бы
  одна аннотация, либо он помечен «пусто» (осознанный фон, пустой .txt).
  Просто неразмеченные кадры не выгружаются.
* Сплит назначается **детерминированно**: порядок внутри группы — по sha1
  от image_id, группа — самый редкий класс на кадре. Повторный экспорт того
  же набора даёт тот же train/val, а новые кадры не перетасовывают старые.
"""
import hashlib
import json
import os
import threading
import time
import uuid
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request, send_file
from sqlalchemy import select

from common import config, jobs
from common.auth import current_user
from common.db import SessionLocal
from common.models import Annotation, Dataset, Image, LabelClass, Project
from common.storage import load_json, save_json, translit_slug
# Тот же разбор кода проекта и прав, что у остальных данных проекта.
from datasets_svc.project_routes import _resolve

bp = Blueprint("export", __name__)

VAL_DEFAULT = 0.2
# Сплиты, которые считаются проставленными. Всё остальное («other» у кадров из
# тасок) раскидывает сам экспорт.
FIXED_SPLITS = ("train", "val", "test")
# Кадров между обновлениями прогресса: чаще — лишние записи на том.
PACK_BATCH = 25


# --------------------------------------------------------------------------- #
# План выгрузки
# --------------------------------------------------------------------------- #
def _uuids(raw):
    out = []
    for item in raw or []:
        try:
            out.append(uuid.UUID(str(item)))
        except (ValueError, AttributeError):
            continue
    return out


def _selection(data):
    ratio = data.get("val_ratio", VAL_DEFAULT)
    try:
        ratio = float(ratio)
    except (TypeError, ValueError):
        ratio = VAL_DEFAULT
    return {
        "datasets": _uuids(data.get("datasets")),
        "classes": _uuids(data.get("classes")),
        "resplit": data.get("split_mode") == "resplit",
        # Крайние значения бессмысленны: при 0 нечем проверять, при 1 нечем учить.
        "val_ratio": min(max(ratio, 0.05), 0.5),
    }


def _bucket_key(image_id):
    return hashlib.sha1(str(image_id).encode()).hexdigest()


def _assign(rows, group_of, ratio):
    """Раскидать кадры по train/val внутри каждой группы редкости."""
    groups = defaultdict(list)
    for img in rows:
        groups[group_of.get(img.id, "")].append(img)

    out = {}
    for key in sorted(groups):
        bunch = sorted(groups[key], key=lambda i: _bucket_key(i.id))
        n = len(bunch)
        k = int(round(n * ratio))
        # Класс из трёх кадров должен попасть в проверку хотя бы одним — ради
        # этого стратификация и затевалась. Пропорцию это слегка искажает.
        if n >= 2 and ratio > 0 and k == 0:
            k = 1
        if n >= 2 and k >= n:
            k = n - 1
        for i, img in enumerate(bunch):
            out[img.id] = "val" if i < k else "train"
    return out


def _unique_name(taken, file_name, fallback_ext=".jpg"):
    """Имя внутри сплита. Одинаковые file_name в базе уже встречаются — на
    диске они разведены по uuid, а в архиве столкнулись бы."""
    base, ext = os.path.splitext(os.path.basename(file_name or "image"))
    # Имя без расширения — берём его у файла на диске, иначе .jpg в архиве
    # оказался бы подписью к чужим байтам.
    ext = ext or fallback_ext or ".jpg"
    candidate = base + ext
    n = 2
    while candidate.lower() in taken:
        candidate = f"{base}_{n}{ext}"
        n += 1
    taken.add(candidate.lower())
    return candidate


def _line(export_id, geometry, width, height):
    """Пиксельный бокс (COCO) → строка YOLO, или None, если от бокса ничего
    не осталось.

    Режем по углам, а не по готовым центру и размеру: подрезав их порознь,
    можно получить четыре числа внутри [0,1], которые вместе всё равно
    описывают бокс, торчащий за край кадра.
    """
    try:
        x = float(geometry.get("x", 0))
        y = float(geometry.get("y", 0))
        w = float(geometry.get("w", 0))
        h = float(geometry.get("h", 0))
    except (TypeError, ValueError):
        return None
    x1 = min(max(x, 0.0), width)
    y1 = min(max(y, 0.0), height)
    x2 = min(max(x + w, 0.0), width)
    y2 = min(max(y + h, 0.0), height)
    if x2 - x1 <= 0 or y2 - y1 <= 0:
        return None
    cx = (x1 + x2) / 2 / width
    cy = (y1 + y2) / 2 / height
    nw = (x2 - x1) / width
    nh = (y2 - y1) / height
    return f"{export_id} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}\n"


def _plan(db, project, sel):
    classes = []
    if sel["classes"]:
        classes = db.execute(
            select(LabelClass)
            .where(
                LabelClass.project_id == project.id,
                LabelClass.id.in_(sel["classes"]),
            )
            .order_by(LabelClass.class_index)
        ).scalars().all()
    export_id = {c.id: i for i, c in enumerate(classes)}

    images = []
    if sel["datasets"]:
        images = db.execute(
            select(Image)
            .where(
                Image.project_id == project.id,
                Image.dataset_id.in_(sel["datasets"]),
            )
            .order_by(Image.file_name)
        ).scalars().all()

    # Аннотации одним запросом через датасеты, а не списком id: список из ста
    # тысяч uuid в IN — уже не запрос, а поэма.
    anns = defaultdict(list)
    if images and classes:
        rows = db.execute(
            select(Annotation)
            .join(Image, Annotation.image_id == Image.id)
            .where(
                Image.dataset_id.in_(sel["datasets"]),
                Annotation.class_id.in_([c.id for c in classes]),
                Annotation.ann_type == "bbox",
            )
        ).scalars().all()
        for ann in rows:
            anns[ann.image_id].append(ann)

    # Кадр без разметки бывает двух родов, и в окне их надо разделить: один
    # отсеял фильтр классов, другого никогда не размечали.
    labelled = set()
    if images:
        labelled = set(db.execute(
            select(Annotation.image_id)
            .join(Image, Annotation.image_id == Image.id)
            .where(Image.dataset_id.in_(sel["datasets"]))
        ).scalars())

    kept, no_size, dropped, unlabelled = [], 0, 0, 0
    for img in images:
        if not anns.get(img.id) and img.task_status != "empty":
            if img.id in labelled:
                dropped += 1
            else:
                unlabelled += 1
            continue
        if not img.width or not img.height:
            no_size += 1
            continue
        kept.append(img)

    # Группа кадра — самый редкий его класс: раскидывая группы по отдельности,
    # мы не даём редкому классу целиком уехать в одну половину.
    per_class_images = Counter()
    for img in kept:
        for cid in {a.class_id for a in anns.get(img.id, [])}:
            per_class_images[cid] += 1
    group_of = {}
    for img in kept:
        cids = {a.class_id for a in anns.get(img.id, [])}
        group_of[img.id] = (
            str(min(cids, key=lambda c: (per_class_images[c], export_id[c])))
            if cids else "~background"  # фон — своя группа, делится отдельно
        )

    if sel["resplit"]:
        fixed, floating, ratio = {}, kept, sel["val_ratio"]
    else:
        fixed = {i.id: i.split for i in kept if i.split in FIXED_SPLITS}
        floating = [i for i in kept if i.id not in fixed]
        train = sum(1 for s in fixed.values() if s == "train")
        val = sum(1 for s in fixed.values() if s == "val")
        # Пропорция, которая уже сложилась в проекте; нет ни одной — берём свою.
        ratio = val / (train + val) if train + val else VAL_DEFAULT

    split_of = dict(fixed)
    split_of.update(_assign(floating, group_of, ratio))

    items, taken = [], defaultdict(set)
    counts = Counter()
    per_class = defaultdict(Counter)
    empty_total = 0
    for img in kept:
        split = split_of.get(img.id, "train")
        # Класс каждой уцелевшей строки — чтобы табличка «класс → train/val»
        # считалась по тому же, что уходит в файл, а не по тому, что в базе.
        lines, kinds = [], []
        for a in anns.get(img.id, []):
            line = _line(export_id[a.class_id], a.geometry or {}, img.width, img.height)
            if line is None:
                continue
            lines.append(line)
            kinds.append(a.class_id)
        name = _unique_name(
            taken[split], img.file_name, os.path.splitext(img.file_path)[1]
        )
        items.append({
            "id": str(img.id),
            "src": os.path.join(config.DATA_DIR, img.file_path),
            "split": split,
            "name": name,
            "dataset_id": str(img.dataset_id),
            "lines": lines,
        })
        counts[split] += 1
        counts["annotations"] += len(lines)
        if not lines:
            empty_total += 1
        for cid in set(kinds):
            per_class[cid][split] += 1
        for cid in kinds:
            per_class[cid]["annotations"] += 1

    warnings = []
    if not items:
        warnings.append("В выгрузку не попадает ни одного кадра.")
    else:
        if not counts["val"]:
            warnings.append("Проверочная часть пуста — качество измерить будет нечем.")
        if not counts["train"]:
            warnings.append("Обучающая часть пуста.")
    if no_size:
        warnings.append(f"Пропущено кадров без размеров: {no_size}.")
    idle = [c.name for c in classes if not per_class[c.id]["annotations"]]
    if idle:
        shown = ", ".join(idle[:5]) + ("…" if len(idle) > 5 else "")
        warnings.append(f"Классы без разметки в выгрузке: {shown}")

    return {
        "classes": [
            {
                "export_id": export_id[c.id],
                "class_index": c.class_index,
                "name": c.name,
                "train": per_class[c.id]["train"],
                "val": per_class[c.id]["val"],
                "test": per_class[c.id]["test"],
                "annotations": per_class[c.id]["annotations"],
            }
            for c in classes
        ],
        "items": items,
        "images": len(items),
        "annotations": counts["annotations"],
        "empty": empty_total,
        "dropped": dropped,
        "unlabelled": unlabelled,
        "splits": {s: counts[s] for s in FIXED_SPLITS if counts[s]},
        "val_ratio": round(ratio, 4),
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- #
# Сборка архива
# --------------------------------------------------------------------------- #
def _data_yaml(project, plan):
    """Ключ `path` намеренно не пишем: без него ultralytics считает пути от
    самого yaml, а с относительным `path` — от своей папки датасетов."""
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    lines = [
        f"# Магистраль ML · проект «{project.name}» · выгружено {stamp}",
        "train: images/train",
        "val: images/val",
    ]
    if plan["splits"].get("test"):
        lines.append("test: images/test")
    lines.append(f"nc: {len(plan['classes'])}")
    lines.append("names:")
    for c in plan["classes"]:
        lines.append(f"  {c['export_id']}: {json.dumps(c['name'], ensure_ascii=False)}")
    return "\n".join(lines) + "\n"


def _sweep():
    """Старые выгрузки: архив тяжёлый, а нужен он ровно один раз."""
    cutoff = time.time() - config.EXPORT_KEEP_HOURS * 3600
    try:
        for name in os.listdir(config.EXPORTS_DIR):
            path = os.path.join(config.EXPORTS_DIR, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
            except OSError:
                pass
    except OSError:
        pass


def _archive_name(project):
    slug = translit_slug(project.name) or "project"
    return f"{slug}-{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.zip"


def _run_export_job(job_id, project_id, sel, user_id):
    db = SessionLocal()
    try:
        project = db.get(Project, project_id)
        plan = _plan(db, project, sel)
        items = plan["items"]
        names = {
            str(d.id): d.name
            for d in db.execute(
                select(Dataset).where(Dataset.project_id == project.id)
            ).scalars()
        }
        jobs.update(job_id, total=len(items), message="Собираю архив", phase="pack")

        os.makedirs(config.EXPORTS_DIR, exist_ok=True)
        _sweep()
        path = config.export_file(job_id)
        part = path + ".part"
        with zipfile.ZipFile(part, "w") as zf:
            zf.writestr("data.yaml", _data_yaml(project, plan), zipfile.ZIP_DEFLATED)
            # Карта номеров: без неё выгрузка теряет связь с проектом, ведь
            # номера в архиве свои.
            zf.writestr(
                "classes.json",
                json.dumps(
                    [
                        {k: c[k] for k in ("export_id", "class_index", "name")}
                        for c in plan["classes"]
                    ],
                    ensure_ascii=False,
                    indent=2,
                ),
                zipfile.ZIP_DEFLATED,
            )
            index = ["path,image_id,dataset\n"]
            for n, item in enumerate(items, 1):
                arc = f"images/{item['split']}/{item['name']}"
                stem = os.path.splitext(item["name"])[0]
                try:
                    # Картинки уже сжаты: DEFLATE на jpeg — это минуты работы
                    # ради процента размера.
                    zf.write(item["src"], arc, zipfile.ZIP_STORED)
                except OSError:
                    continue
                zf.writestr(
                    f"labels/{item['split']}/{stem}.txt",
                    "".join(item["lines"]),
                    zipfile.ZIP_DEFLATED,
                )
                # Имя датасета — произвольный текст, в нём бывает и запятая,
                # и кавычка: закрываем по правилам CSV, а не «на глаз».
                ds = names.get(item["dataset_id"], "").replace('"', '""')
                index.append(f'{arc},{item["id"]},"{ds}"\n')
                if n % PACK_BATCH == 0:
                    jobs.update(job_id, processed=n)
            zf.writestr("images.csv", "".join(index), zipfile.ZIP_DEFLATED)
        os.replace(part, path)

        meta = {
            "project_id": str(project.id),
            "file_name": _archive_name(project),
            "size_bytes": os.path.getsize(path),
            "images": plan["images"],
            "annotations": plan["annotations"],
            "splits": plan["splits"],
            "classes": len(plan["classes"]),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "created_by": str(user_id) if user_id else None,
        }
        save_json(config.export_meta(job_id), meta)
        jobs.update(job_id, status="done", processed=len(items),
                    result={"job_id": job_id, **meta})
    except Exception as exc:  # noqa: BLE001
        jobs.update(job_id, status="error", error=str(exc))
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Эндпоинты
# --------------------------------------------------------------------------- #
@bp.post("/api/projects/<code>/export/preview")
def preview_export(code):
    """Что получится при текущем выборе — считается на каждое изменение."""
    db, project, err = _resolve(code)
    if err:
        return err
    try:
        plan = _plan(db, project, _selection(request.get_json(silent=True) or {}))
        plan.pop("items")
        return jsonify(plan)
    finally:
        db.close()


@bp.post("/api/projects/<code>/export")
def start_export(code):
    db, project, err = _resolve(code)
    if err:
        return err
    try:
        if project.status == "importing":
            return jsonify({"error": "Проект ещё импортируется."}), 409
        data = request.get_json(silent=True) or {}
        # Формат и тип пока одни; проверяем явно, чтобы чужой запрос не получил
        # молча yolo-боксы вместо того, что просил.
        if data.get("format", "yolo") != "yolo":
            return jsonify({"error": "Пока поддерживается только формат YOLO."}), 400
        if data.get("ann_type", "bbox") != "bbox":
            return jsonify({"error": "Пока выгружаются только боксы."}), 400
        sel = _selection(data)
        if not sel["datasets"]:
            return jsonify({"error": "Выберите хотя бы один датасет."}), 400
        if not sel["classes"]:
            return jsonify({"error": "Выберите хотя бы один класс."}), 400

        job_id = jobs.create("project-export", message="Готовлю выгрузку")
        user = current_user(db)
        user_id = user.id if user is not None else None
        threading.Thread(
            target=_run_export_job,
            args=(job_id, project.id, sel, user_id),
            daemon=True,
        ).start()
        return jsonify({"job_id": job_id}), 202
    finally:
        db.close()


@bp.get("/api/projects/<code>/export/<job_id>/download")
def download_export(code, job_id):
    db, project, err = _resolve(code)
    if err:
        return err
    try:
        # Имя джобы приходит из URL — пускаем в путь только hex, иначе это
        # готовый обход каталога.
        if not job_id.isalnum():
            return jsonify({"error": "Выгрузка не найдена."}), 404
        meta = load_json(config.export_meta(job_id), None)
        path = config.export_file(job_id)
        if not meta or not os.path.isfile(path):
            return jsonify({"error": "Выгрузка не найдена или уже удалена."}), 404
        if meta.get("project_id") != str(project.id):
            return jsonify({"error": "Выгрузка не найдена."}), 404
        return send_file(
            path,
            mimetype="application/zip",
            as_attachment=True,
            download_name=meta.get("file_name") or "export.zip",
        )
    finally:
        db.close()
