"""Экспорт проекта в YOLO-архив: images/ + labels/ + data.yaml.

Весь смысл — в `_plan`: он один раз считает, что войдёт в выгрузку, и им же
пользуются предпросмотр («сколько получится») и джоба («сложи это в zip»).
Разойтись они не могут по построению. Сам отбор кадров и деление считает
`common.selection` — тот же код, которым мастер собирает обучающий набор:
одинаковые галочки обязаны давать одинаковое содержимое и в архиве, и в наборе.

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

Выгрузок две, и выбирает между ними человек в окне экспорта.

* **Боксы** (`ann_type="bbox"`) — как было. Полигон сводится к своей
  охватывающей рамке: объект упрощается, но не пропадает.
* **Сегментация** (`ann_type="polygon"`) — строка YOLO-seg на объект. Боксы
  сюда **не идут**: прямоугольник, записанный как контур, учил бы модель, что
  объекты прямоугольные, и человек об этом не узнал бы. Пропущенные считаются
  и показываются в плане отдельной строкой — отказ обязан быть виден до
  выгрузки, а не обнаруживаться по недостаче в архиве.
"""
import json
import os
import threading
import time
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request, send_file
from sqlalchemy import select

from common import config, jobs
from common import prep_queue as queue
from common import similarity
from common import selection as sel_lib
from common.auth import current_user
from common.db import SessionLocal
from common.models import Dataset, Project
from common.web import public_error
from common.storage import load_json, one_line, save_json, translit_slug
# Тот же разбор кода проекта и прав, что у остальных данных проекта.
from datasets_svc.project_routes import _resolve

bp = Blueprint("export", __name__)

# Что умеем выгружать — одно перечисление на выгрузку и на мастер.
EXPORT_TYPES = sel_lib.EXPORT_TYPES
# Кадров между обновлениями прогресса: чаще — лишние записи на том.
PACK_BATCH = 25


# --------------------------------------------------------------------------- #
# План выгрузки
# --------------------------------------------------------------------------- #
# Как выгрузка делит заново — те же способы, что у мастера набора. «keep» —
# уважать проставленные половины; «resplit» — старое имя «с учётом классов».
EXPORT_SPLITS = ("keep", "random", "balanced", "smart")


def _selection(data):
    """Выбор из окна выгрузки. Умолчание — «уважать проставленные половины»:
    так эта ручка вела себя с самого начала, и менять её молча нельзя."""
    raw = dict(data or {})
    mode = raw.get("split_mode")
    raw["split_mode"] = "balanced" if mode == "resplit" else mode if mode in EXPORT_SPLITS else "keep"
    return sel_lib.parse(raw)


def _embeddings(db, project, picked, sel):
    """Для умного деления: признаки кадров и группы похожих — как в мастере набора.
    Признаков нет — групп нет, и деление скажет, что поделило с учётом классов."""
    ids = [i.id for i in picked.images]
    missing = similarity.missing_for(db, ids)
    failed = queue.last_error(db, queue.KIND_EMBED, project.id)
    state = {
        "ready": len(ids) - len(missing),
        "total": len(ids),
        "missing": len(missing),
        "job": queue.progress_of(db, queue.KIND_EMBED, project.id),
        "failure": {
            "error": failed.error,
            "at": failed.finished_at.isoformat() if failed.finished_at else None,
        } if failed is not None and missing else None,
    }
    clusters = similarity.clusters_for(db, ids, sel.get("seed", 0)) if not missing else None
    return state, clusters


def _plan(db, project, sel):
    """Что войдёт в архив при текущем выборе.

    Отбор и деление считает ``common.selection`` — тот же код, которым мастер
    собирает обучающий набор. Здесь остаётся только то, что специфично для
    архива: имена файлов внутри сплитов и таблица по классам.
    """
    picked = sel_lib.gather(db, project, sel)
    embeddings, cluster_of = (
        _embeddings(db, project, picked, sel) if sel["split_mode"] == "smart" else (None, None)
    )
    split_of, ratio, warnings = sel_lib.assign(picked, sel, cluster_of=cluster_of)
    want = picked.ann_type

    items, taken = [], defaultdict(set)
    counts = Counter()
    per_class = defaultdict(Counter)
    empty_total = 0
    for img in picked.images:
        split = split_of.get(img.id, "train")
        # Класс каждой уцелевшей строки — чтобы табличка «класс → train/val»
        # считалась по тому, что уходит в файл, а не по тому, что в базе.
        lines, kinds = [], []
        for a in picked.anns.get(img.id, []):
            line = sel_lib.row_line(
                picked.export_id[a.class_id], a, img.width, img.height, want
            )
            if line is None:
                continue
            lines.append(line)
            kinds.append(a.class_id)
        name = sel_lib.unique_name(
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

    if not items:
        warnings.append("В выгрузку не попадает ни одного кадра.")
    else:
        if not counts["val"]:
            warnings.append(
                "Проверочная часть пуста — качество измерить будет нечем."
            )
        if not counts["train"]:
            warnings.append("Обучающая часть пуста.")
    if picked.no_size:
        warnings.append(f"Пропущено кадров без размеров: {picked.no_size}.")
    # Разметку не того рода (`wrong_kind`) и выпавшие из-за неё кадры
    # (`dropped`) окно называет само, числами с единицами. Третьей строкой
    # здесь она дублировалась: окно показывало одно и то же дважды. Боксы в
    # сегментацию не идут потому, что прямоугольник, записанный контуром,
    # учил бы модель неверно.
    idle = [
        c.name for c in picked.classes
        if not per_class[c.id]["annotations"]
    ]
    if idle:
        shown = ", ".join(idle[:5]) + ("…" if len(idle) > 5 else "")
        warnings.append(f"Классы без разметки в выгрузке: {shown}")

    return {
        "classes": [
            {
                "export_id": picked.export_id[c.id],
                "class_index": c.class_index,
                "name": c.name,
                "train": per_class[c.id]["train"],
                "val": per_class[c.id]["val"],
                "test": per_class[c.id]["test"],
                "annotations": per_class[c.id]["annotations"],
            }
            for c in picked.classes
        ],
        "items": items,
        "images": len(items),
        "annotations": counts["annotations"],
        "empty": empty_total,
        "dropped": picked.dropped,
        "wrong_kind": picked.wrong_kind,
        # Отсеянное фильтром по тагам: без этого числа «выбрал
        # «ночь» и получил 12 кадров» читается как поломка.
        "no_tag": picked.no_tag,
        "ann_type": want,
        "background": picked.background,
        "background_parts": picked.background_parts,
        "splits": {s: counts[s] for s in sel_lib.FIXED_SPLITS if counts[s]},
        "val_ratio": round(ratio, 4),
        "split_mode": sel["split_mode"],
        "embeddings": embeddings,
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- #
# Сборка архива
# --------------------------------------------------------------------------- #
def _local_today(offset_min):
    """Дата у человека, а не у сервера. Сервер живёт по UTC, и ночью по
    Москве архив назывался вчерашним числом. Смещение присылает браузер
    (минуты к востоку от UTC); без него — UTC, как прежде."""
    try:
        minutes = max(-14 * 60, min(14 * 60, int(offset_min or 0)))
    except (TypeError, ValueError):
        minutes = 0
    return datetime.now(timezone(timedelta(minutes=minutes))).strftime("%Y-%m-%d")


def _data_yaml(project, plan, offset_min=0):
    """Ключ `path` намеренно не пишем: без него ultralytics считает пути от
    самого yaml, а с относительным `path` — от своей папки датасетов."""
    stamp = _local_today(offset_min)
    # Вид разметки пишем комментарием, а не ключом: ultralytics выбирает задачу
    # по модели, а не по yaml, и лишний ключ он бы просто не понял. Человеку же
    # по строке labels/ не отличить бокс от контура.
    kind = "сегментация" if plan.get("ann_type") == "polygon" else "боксы"
    lines = [
        f"# Магистраль ML · проект «{one_line(project.name)}» · выгружено {stamp}",
        f"# Разметка: {kind}",
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


def _archive_name(project, offset_min=0):
    slug = translit_slug(project.name) or "project"
    return f"{slug}-{_local_today(offset_min)}.zip"


def _run_export_job(job_id, project_id, sel, user_id, offset_min=0):
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
            zf.writestr("data.yaml", _data_yaml(project, plan, offset_min),
                        zipfile.ZIP_DEFLATED)
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
            "file_name": _archive_name(project, offset_min),
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
        jobs.update(job_id, status="error",
                    error=public_error(exc, "Выгрузка прервалась."))
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
        # Формат один; проверяем явно, чтобы чужой запрос не получил молча
        # yolo вместо того, что просил.
        if data.get("format", "yolo") != "yolo":
            return jsonify({"error": "Пока поддерживается только формат YOLO."}), 400
        if data.get("ann_type", "bbox") not in EXPORT_TYPES:
            return jsonify({"error": "Выгружаются боксы или сегментация."}), 400
        sel = _selection(data)
        if not sel["datasets"]:
            return jsonify({"error": "Выберите хотя бы один датасет."}), 400
        if not sel["classes"]:
            return jsonify({"error": "Выберите хотя бы один класс."}), 400

        user = current_user(db)
        user_id = user.id if user is not None else None
        job_id = jobs.create("project-export", message="Готовлю выгрузку",
                             project_id=project.id, owner=user_id)
        threading.Thread(
            target=_run_export_job,
            args=(job_id, project.id, sel, user_id, data.get("tz_offset")),
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
