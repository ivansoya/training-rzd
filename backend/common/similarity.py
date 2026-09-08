"""Группы похожих кадров: от векторов до кластеров.

Зачем это нужно, стоит сказать прямо. Соседние кадры одного перегона похожи
почти как копии. Если они разъедутся по обучению и проверке, метрики выйдут
неправдоподобно хорошими, и понять это будет нельзя: модель просто узнаёт
кадры, которые уже видела. Группы не дают им разъехаться.

Считаем k-means вручную на numpy, а не через sklearn: ради одного места тянуть
в образ ещё сорок мегабайт и целое дерево зависимостей незачем. Косинусная
близость сводится к скалярному произведению, потому что вектора нормированы,
а матрица считается кусками — держать N×N в памяти нельзя даже на десяти
тысячах кадров.
"""
import os

from sqlalchemy import select

from common.models import ImageEmbedding

MODEL = os.environ.get("EMBED_MODEL", "dinov2_vits14")
DIM = int(os.environ.get("EMBED_DIM", "384"))
# Сколько кадров в группе считаем осмысленным. Сорок — это примерно полторы
# секунды съёмки на 25 кадрах в секунду: столько соседних кадров действительно
# похожи как копии.
TARGET_GROUP_SIZE = int(os.environ.get("EMBED_GROUP", "40"))
MIN_CLUSTERS = 8
MAX_CLUSTERS = 512
BATCH = 4096
ITERATIONS = 15
# Сколько кадров берём в подвыборку для начальной расстановки центров.
SEED_SAMPLE = 20000


def missing_for(db, image_ids, model=MODEL):
    """Кадры, у которых вектора ещё нет."""
    if not image_ids:
        return []
    have = set(db.execute(
        select(ImageEmbedding.image_id).where(
            ImageEmbedding.image_id.in_(image_ids),
            ImageEmbedding.model == model,
        )
    ).scalars())
    return [i for i in image_ids if i not in have]


def load_vectors(db, image_ids, model=MODEL):
    """Вектора выбранных кадров одним запросом.

    Сто тысяч по 768 байт — это 77 МБ: одна поездка в базу, а не сто тысяч.
    """
    import numpy as np

    if not image_ids:
        return [], None
    rows = db.execute(
        select(ImageEmbedding).where(
            ImageEmbedding.image_id.in_(image_ids),
            ImageEmbedding.model == model,
        )
    ).scalars().all()
    if not rows:
        return [], None
    ids = [r.image_id for r in rows]
    matrix = np.stack([
        np.frombuffer(r.vector, dtype=np.float16).astype(np.float32)
        for r in rows
    ])
    # На всякий случай нормируем ещё раз: вектор мог прийти из старой версии
    # счётчика, а косинус через скалярное произведение это молча испортит.
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return ids, matrix / norms


def _kmeanspp(matrix, k, rng):
    """Начальные центры: подальше друг от друга, а не наугад.

    Случайные центры на сплошном видеоряде сходятся к одному месту, и половина
    кластеров остаётся пустой.
    """
    import numpy as np

    n = matrix.shape[0]
    first = int(rng.integers(n))
    centers = [matrix[first]]
    closest = 1.0 - matrix @ centers[0]
    for _ in range(1, k):
        weights = np.maximum(closest, 0) ** 2
        total = weights.sum()
        if total <= 0:
            centers.append(matrix[int(rng.integers(n))])
        else:
            pick = int(rng.choice(n, p=weights / total))
            centers.append(matrix[pick])
        closest = np.minimum(closest, 1.0 - matrix @ centers[-1])
    return np.stack(centers)


def cluster(matrix, seed, target=TARGET_GROUP_SIZE):
    """Номер группы для каждой строки матрицы."""
    import numpy as np

    n = matrix.shape[0]
    if n == 0:
        return np.zeros(0, dtype=np.int32)
    k = max(MIN_CLUSTERS, min(MAX_CLUSTERS, int(round(n / max(1, target)))))
    k = min(k, n)
    rng = np.random.default_rng(int(seed) & 0xFFFFFFFF)

    sample = matrix
    if n > SEED_SAMPLE:
        sample = matrix[rng.choice(n, SEED_SAMPLE, replace=False)]
    centers = _kmeanspp(sample, k, rng)

    for _ in range(ITERATIONS):
        batch = matrix
        if n > BATCH:
            batch = matrix[rng.choice(n, BATCH, replace=False)]
        assign = np.argmax(batch @ centers.T, axis=1)
        for j in range(k):
            rows = batch[assign == j]
            if rows.shape[0] == 0:
                continue
            mid = rows.mean(axis=0)
            norm = np.linalg.norm(mid)
            if norm > 0:
                centers[j] = mid / norm

    # Итоговая раскладка — кусками: матрица n×k целиком на ста тысячах кадров
    # и пятистах центрах это двести мегабайт на пустом месте.
    out = np.empty(n, dtype=np.int32)
    for start in range(0, n, BATCH):
        chunk = matrix[start:start + BATCH]
        out[start:start + chunk.shape[0]] = np.argmax(chunk @ centers.T, axis=1)
    return out


# Готовые раскладки по отпечатку выбора. Предпросмотр мастера считается на
# каждое движение ползунка, а k-means на десяти тысячах кадров стоит две
# секунды: без кэша каждый шаг доли проверки — это две секунды тишины.
# Ключ — кадры и зерно; доля проверки на раскладку не влияет. Записей
# несколько, не больше: один мастер — один набор кадров.
_CACHE = {}
_CACHE_LIMIT = 8


def cache_key(image_ids, seed, model=MODEL):
    import hashlib

    digest = hashlib.sha1()
    for ident in sorted(str(i) for i in image_ids):
        digest.update(ident.encode())
    return (digest.hexdigest(), int(seed), model)


def clusters_for(db, image_ids, seed, model=MODEL):
    """{номер кадра: имя группы}. Пусто — векторов ещё нет.

    Пусто здесь не ошибка: деление честно скажет, что поделило обычным
    способом, и человек решит, ждать ему или нет.
    """
    key = cache_key(image_ids, seed, model)
    hit = _CACHE.get(key)
    if hit is not None:
        return dict(hit)
    ids, matrix = load_vectors(db, image_ids, model)
    if matrix is None or len(ids) < MIN_CLUSTERS:
        return {}
    labels = cluster(matrix, seed)
    out = {ident: f"к{int(label)}" for ident, label in zip(ids, labels)}
    if len(ids) == len(set(image_ids)):
        # Кэшируем только полную раскладку: неполная (часть векторов ещё
        # считается) через минуту станет другой.
        if len(_CACHE) >= _CACHE_LIMIT:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = dict(out)
    return out


def save_vectors(db, items, model=MODEL, dim=DIM):
    """Сохранить посчитанные вектора. ``items`` — [(image_id, вектор)]."""
    import numpy as np

    for image_id, vector in items:
        arr = np.asarray(vector, dtype=np.float32).ravel()
        norm = float(np.linalg.norm(arr))
        unit = arr / norm if norm > 0 else arr
        row = db.get(ImageEmbedding, (image_id, model))
        blob = unit.astype(np.float16).tobytes()
        if row is None:
            db.add(ImageEmbedding(
                image_id=image_id, model=model, dim=dim,
                vector=blob, norm=norm,
            ))
        else:
            row.dim = dim
            row.vector = blob
            row.norm = norm
    db.commit()
