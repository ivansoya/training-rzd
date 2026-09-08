"""Отбор кадров проекта и деление их на обучение и проверку.

Один и тот же отбор считают двое: выгрузка проекта в архив и мастер сборки
обучающего набора. Копия разошлась бы с оригиналом на первой же правке, и
человек получил бы архив и набор с разным содержимым при одинаковых галочках.

Здесь же живут четыре стратегии деления. Порядок их появления — это порядок
роста доверия к машине: сперва человек делит сам, потом соглашается на
случайность, потом на случайность с оглядкой на редкие классы, и только потом
отдаёт решение группам похожих кадров.

Деление всегда идёт РАНЬШЕ аугментаций и по исходным кадрам. Иначе копии
одного кадра разъедутся по обеим половинам, проверка начнёт мерить
запоминание вместо обобщения, и узнать об этом будет неоткуда.
"""
import os
import uuid
from collections import Counter, defaultdict

from sqlalchemy import select

from common import polygon as polylib
from common.splitting import (  # noqa: F401 — coverage_warnings нужен соседям
    FIXED_SPLITS, bucket_key, by_clusters, by_groups, coverage_warnings,
)
from common.models import Annotation, Image, LabelClass

VAL_DEFAULT = 0.2
# Что умеем отдавать. Ключ — то же слово, что в ``annotations.ann_type``:
# лишнее имя для одного и того же расходится при первой же правке.
EXPORT_TYPES = ("bbox", "polygon")
# Какая разметка годится для какой выгрузки. Полигон в боксовую попадает
# охватывающей рамкой; бокс в сегментацию не попадает никак.
USABLE = {"bbox": ("bbox", "polygon"), "polygon": ("polygon",)}
# «keep» — не пятая стратегия для человека, а то, что окно выгрузки делало с
# самого начала: проставленные половины уважаем, остальное раскидываем с
# оглядкой на классы. В мастере его нет, там выбор честнее.
SPLIT_MODES = ("manual", "random", "balanced", "smart", "keep")


# --------------------------------------------------------------------------- #
# Разбор запроса
# --------------------------------------------------------------------------- #
def uuids(raw):
    out = []
    for item in raw or []:
        try:
            out.append(uuid.UUID(str(item)))
        except (ValueError, AttributeError):
            continue
    return out


def parse(data):
    """Выбор человека, приведённый к пригодному для счёта виду."""
    ratio = data.get("val_ratio", VAL_DEFAULT)
    try:
        ratio = float(ratio)
    except (TypeError, ValueError):
        ratio = VAL_DEFAULT
    ann_type = data.get("ann_type", "bbox")
    if ann_type not in EXPORT_TYPES:
        ann_type = "bbox"
    mode = data.get("split_mode", "balanced")
    if mode == "resplit":
        mode = "balanced"   # старое имя из окна выгрузки
    if mode not in SPLIT_MODES:
        mode = "balanced"
    try:
        seed = int(data.get("seed") or 0)
    except (TypeError, ValueError):
        seed = 0
    return {
        "datasets": uuids(data.get("datasets")),
        "classes": uuids(data.get("classes")),
        "ann_type": ann_type,
        "split_mode": mode,
        "seed": seed,
        # Крайние значения бессмысленны: при 0 нечем проверять, при 1 нечем
        # учить.
        "val_ratio": min(max(ratio, 0.05), 0.5),
    }


# --------------------------------------------------------------------------- #
# Отбор кадров
# --------------------------------------------------------------------------- #
class Selection:
    """Что вошло в отбор и что при этом отсеялось.

    **Кадр без разметки — это фон, и он идёт в набор** с пустым файлом
    разметки. До 08.09.2026 такие кадры отбрасывались как «никогда не
    размечали», и набор «Варан» ушёл в обучение без единого кадра фона:
    580 пустых из 11 885 остались за бортом, а модель дала 342 ложных
    срабатывания на фоне за одну проверку. Ultralytics советует держать
    до десятой части набора фоном — именно для этого.

    Отсеивается теперь только то, что фоном назвать нельзя: кадр, у
    которого разметка выбранных классов есть, но не того рода (боксы при
    сегментации). Объекты на нём есть, а строк для них нет — такой кадр
    научил бы модель их не видеть.
    """

    __slots__ = (
        "classes", "export_id", "images", "anns", "by_image",
        "dropped", "background", "no_size", "wrong_kind", "ann_type",
        "rarest_of", "classes_of",
    )

    def __init__(self):
        self.classes = []
        self.export_id = {}
        self.images = []
        self.anns = defaultdict(list)
        self.by_image = {}
        self.dropped = 0
        self.background = 0
        self.no_size = 0
        self.wrong_kind = 0
        self.ann_type = "bbox"
        self.rarest_of = {}
        self.classes_of = {}


def gather(db, project, sel) -> Selection:
    """Кадры, разметка и классы, прошедшие фильтр.

    Аннотации берутся одним запросом через датасеты, а не списком id: список
    из ста тысяч uuid в IN — уже не запрос, а поэма.
    """
    out = Selection()
    out.ann_type = want = sel["ann_type"]

    if sel["classes"]:
        out.classes = db.execute(
            select(LabelClass)
            .where(
                LabelClass.project_id == project.id,
                LabelClass.id.in_(sel["classes"]),
            )
            .order_by(LabelClass.class_index)
        ).scalars().all()
    out.export_id = {c.id: i for i, c in enumerate(out.classes)}

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

    # Кадры, у которых разметка выбранных классов есть только не того рода.
    # Их одних и отсеиваем: остальное без строк — фон.
    wrong_only = set()
    if images and out.classes:
        rows = db.execute(
            select(Annotation)
            .join(Image, Annotation.image_id == Image.id)
            .where(
                Image.dataset_id.in_(sel["datasets"]),
                Annotation.class_id.in_([c.id for c in out.classes]),
            )
        ).scalars().all()
        for ann in rows:
            if (ann.ann_type or "bbox") in USABLE[want]:
                out.anns[ann.image_id].append(ann)
            else:
                # Разметка не того рода: она есть, класс подходит, но в эту
                # выгрузку не идёт. Считаем отдельно и словами.
                out.wrong_kind += 1
                wrong_only.add(ann.image_id)
        wrong_only -= set(out.anns)

    kept = []
    for img in images:
        if not img.width or not img.height:
            out.no_size += 1
            continue
        if not out.anns.get(img.id):
            if img.id in wrong_only:
                out.dropped += 1
                continue
            out.background += 1
        kept.append(img)
    out.images = kept
    out.by_image = {img.id: img for img in kept}

    # Класс каждого уцелевшего кадра и его самый редкий класс. Группа кадра —
    # именно редчайший: раскидывая группы по отдельности, мы не даём редкому
    # классу целиком уехать в одну половину.
    per_class = Counter()
    for img in kept:
        cids = {a.class_id for a in out.anns.get(img.id, [])}
        out.classes_of[img.id] = cids
        for cid in cids:
            per_class[cid] += 1
    for img in kept:
        cids = out.classes_of[img.id]
        out.rarest_of[img.id] = (
            str(min(cids, key=lambda c: (per_class[c], out.export_id[c])))
            if cids else "~background"   # фон — своя группа, делится отдельно
        )
    return out


# --------------------------------------------------------------------------- #
# Деление
# --------------------------------------------------------------------------- #
def assign(selection, sel, *, cluster_of=None):
    """Деление кадров. Возвращает (что_куда, доля_проверки, предупреждения)."""
    rows = selection.images
    mode = sel["split_mode"]
    ratio = sel["val_ratio"]
    seed = sel.get("seed", 0)
    warnings = []

    if not rows:
        return {}, ratio, warnings

    if mode == "keep":
        fixed = {i.id: i.split for i in rows if i.split in FIXED_SPLITS}
        floating = [i for i in rows if i.id not in fixed]
        train = sum(1 for s in fixed.values() if s == "train")
        val = sum(1 for s in fixed.values() if s == "val")
        # Пропорция, которая уже сложилась в проекте; нет ни одной — берём свою.
        got = val / (train + val) if train + val else ratio
        placed = dict(fixed)
        placed.update(by_groups(floating, selection.rarest_of, got, seed))
        return placed, round(got, 4), warnings

    if mode == "manual":
        fixed = {}
        loose = []
        for img in rows:
            if img.split in FIXED_SPLITS:
                fixed[img.id] = img.split
            else:
                loose.append(img)
        for img in loose:
            # В обучение, а не в проверку: попадание в проверку — решение
            # человека, и принимать его за него нельзя.
            fixed[img.id] = "train"
        if loose:
            warnings.append(
                f"Кадров без назначенной половины: {len(loose)}. "
                "Они ушли в обучение — в проверку кадр попадает только тогда, "
                "когда его туда отправили."
            )
        train = sum(1 for s in fixed.values() if s == "train")
        val = sum(1 for s in fixed.values() if s == "val")
        got = val / (train + val) if train + val else ratio
        return fixed, round(got, 4), warnings

    if mode == "random":
        one = {img.id: "" for img in rows}
        return by_groups(rows, one, ratio, seed), ratio, warnings

    if mode == "smart":
        if not cluster_of:
            warnings.append(
                "Признаки кадров ещё не посчитаны — поделили с оглядкой на "
                "классы. Дождитесь счёта и пересоберите, если нужны группы."
            )
            return (
                by_groups(rows, selection.rarest_of, ratio, seed),
                ratio, warnings,
            )
        missing = [img for img in rows if img.id not in cluster_of]
        if missing:
            warnings.append(
                f"Кадров без признаков: {len(missing)}. Они поделены обычным "
                "способом — умное деление на них не распространяется."
            )
        placed = by_clusters(rows, cluster_of, selection.classes_of, ratio)
        if missing:
            placed.update(by_groups(
                missing, selection.rarest_of, ratio, seed
            ))
        return placed, ratio, warnings

    # balanced — то, что делает выгрузка проекта с самого начала.
    return by_groups(rows, selection.rarest_of, ratio, seed), ratio, warnings


# --------------------------------------------------------------------------- #
# Строки разметки и имена файлов
# --------------------------------------------------------------------------- #
def unique_name(taken, file_name, fallback_ext=".jpg"):
    """Имя внутри сплита. Одинаковые ``file_name`` в базе уже встречаются — на
    диске они разведены по uuid, а в архиве столкнулись бы."""
    base, ext = os.path.splitext(os.path.basename(file_name or "image"))
    # Расширение берём у файла на диске, иначе .jpg в архиве окажется подписью
    # к чужим байтам.
    ext = ext or fallback_ext or ".jpg"
    candidate = base + ext
    n = 2
    while candidate.lower() in taken:
        candidate = f"{base}_{n}{ext}"
        n += 1
    taken.add(candidate.lower())
    return candidate


def box_line(export_id, geometry, width, height):
    """Пиксельный бокс → строка YOLO, или None, если от бокса ничего не осталось.

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


def row_line(export_id, ann, width, height, want):
    """Строка для одной аннотации, или None, если она сюда не идёт.

    Одно место на оба вида разметки: пара «что за разметка» × «что просят»
    решается здесь и больше нигде, иначе правило «бокс в сегментацию не идёт»
    придётся помнить и предпросмотру, и сборке порознь.
    """
    kind = ann.ann_type or "bbox"
    geometry = ann.geometry or {}
    if want == "polygon":
        if kind != "polygon":
            return None
        return polylib.to_line(export_id, geometry, width, height)
    if kind == "polygon":
        # Полигон боксом — его охватывающая рамка. Тот же расчёт, что
        # показывает редактор, ставя подпись класса: разойдясь, они
        # противоречили бы друг другу на одном экране.
        geometry = polylib.bounds(polylib.parts_of(geometry))
        if geometry is None:
            return None
    return box_line(export_id, geometry, width, height)
