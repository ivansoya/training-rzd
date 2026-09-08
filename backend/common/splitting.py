"""Арифметика деления на обучение и проверку — без базы и без ORM.

Отдельный модуль по той же причине, что `polygon.py` и `gpu_rules.py`:
считающее ядро надо закрывать числами, а образ тестов не знает про SQLAlchemy.
Здесь нет ни одного запроса — только кадры, их группы и их классы.

Главное правило, ради которого всё это существует: **группа похожих кадров
едет в одну сторону целиком**. Соседние кадры одного перегона, разъехавшиеся
по разным половинам, превращают проверку в измерение запоминания, и заметить
это по метрикам нельзя — они просто окажутся неправдоподобно хорошими.
"""
import hashlib
from collections import Counter, defaultdict

# Сплиты, которые считаются проставленными. Всё остальное («other» у кадров из
# тасок) раскидывает деление.
FIXED_SPLITS = ("train", "val", "test")


def bucket_key(image_id, seed=0):
    """Место кадра в очереди на проверку.

    Порядок берётся из отпечатка, а не из случайности: тот же набор кадров
    делится одинаково при каждом пересчёте, а новые кадры не перетасовывают
    старых.
    """
    body = f"{seed}:{image_id}" if seed else str(image_id)
    return hashlib.sha1(body.encode()).hexdigest()


def by_groups(rows, group_of, ratio, seed):
    """Раскидать кадры по train/val внутри каждой группы."""
    groups = defaultdict(list)
    for img in rows:
        groups[group_of.get(img.id, "")].append(img)

    out = {}
    for key in sorted(groups):
        bunch = sorted(groups[key], key=lambda i: bucket_key(i.id, seed))
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


def penalty(val_counts, val_n, targets, target_n, weights, lam):
    p = 0.0
    for cid, want in targets.items():
        d = val_counts.get(cid, 0) - want
        p += weights[cid] * d * d
    d = val_n - target_n
    return p + lam * d * d


def by_clusters(rows, cluster_of, classes_of, ratio):
    """Умное деление: группа похожих кадров едет целиком в одну сторону.

    В этом весь смысл: соседние кадры одного перегона не должны оказаться по
    разные стороны, иначе проверка мерит запоминание, а не обобщение.

    Порядок обхода не случаен — первыми идут группы с самым редким классом
    проекта. Иначе редкий класс достанется тому, кто попросит последним, а
    попросит последним тот, у кого групп больше.
    """
    groups = defaultdict(list)
    for img in rows:
        groups[cluster_of.get(img.id, "~")].append(img)

    total = Counter()
    for img in rows:
        for cid in classes_of.get(img.id, ()):  # noqa: SIM118
            total[cid] += 1
    if not total:
        # Ни одного размеченного класса — делить не по чему, кроме размера.
        keys = sorted(groups)
        out, val_n, target_n = {}, 0, int(round(len(rows) * ratio))
        for key in keys:
            side = "val" if val_n < target_n else "train"
            if side == "val":
                val_n += len(groups[key])
            for img in groups[key]:
                out[img.id] = side
        return out

    weights = {cid: 1.0 / max(1, n) for cid, n in total.items()}
    targets = {cid: n * ratio for cid, n in total.items()}
    target_n = len(rows) * ratio
    lam = 1.0 / max(1, len(rows))

    rarest = min(total, key=lambda c: (total[c], str(c)))

    def has_rarest(key):
        return any(rarest in classes_of.get(i.id, ()) for i in groups[key])

    order = sorted(
        groups, key=lambda k: (not has_rarest(k), -len(groups[k]), str(k))
    )

    out = {}
    val_counts, val_n = Counter(), 0
    for key in order:
        bunch = groups[key]
        add = Counter()
        for img in bunch:
            for cid in classes_of.get(img.id, ()):
                add[cid] += 1
        stay = penalty(val_counts, val_n, targets, target_n, weights, lam)
        moved = Counter(val_counts)
        moved.update(add)
        go = penalty(
            moved, val_n + len(bunch), targets, target_n, weights, lam
        )
        side = "val" if go < stay else "train"
        if side == "val":
            val_counts = moved
            val_n += len(bunch)
        for img in bunch:
            out[img.id] = side
    return out


def coverage_warnings(rows):
    """Предупреждения о классах, по которым проверка ничего не измерит.

    ``rows`` — (имя, сколько в обучении, сколько в проверке). Только слова,
    без вмешательства в деление: умное деление держит группу целиком, и
    класс из трёх соседних кадров честно может уехать в одну сторону. Решать,
    менять ли зерно или долю, — человеку; но узнать он должен до обучения,
    а не по прочерку в таблице через два часа.
    """
    absent = sorted(name for name, train, val in rows if train > 0 and val == 0)
    thin = sorted(name for name, _train, val in rows if 0 < val <= 2)
    out = []
    if absent:
        out.append(
            "В проверку не попало ни одного кадра классов: "
            + ", ".join(absent[:6])
            + (f" и ещё {len(absent) - 6}" if len(absent) > 6 else "")
            + ". Метрик по ним не будет — в таблице обучения встанет "
            "прочерк. Помогает другое зерно, бо́льшая доля проверки или "
            "деление «с оглядкой на классы»."
        )
    if thin:
        out.append(
            "По двум кадрам качество не измеряется — цифра будет прыгать "
            "от эпохи к эпохе и ничего не значить. Мало проверочных "
            "кадров у классов: " + ", ".join(thin[:5])
        )
    return out
