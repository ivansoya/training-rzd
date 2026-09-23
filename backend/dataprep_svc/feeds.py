"""Строки сборки: что вливаем в конвейер и через что пропускаем.

До 13.09.2026 набор знал ровно два графа — один на обучение, один на
проверку. Этого перестало хватать: на одну половину вешают несколько графов, у
графа бывает несколько «Источников», и каждому источнику говорят, откуда брать
кадры — из половины целиком или по тагам.

Строка — это «что кладём → через что пропускаем». Её читают двое: предпросмотр
мастера, который обязан назвать числа до сборки, и сам сборщик. Поэтому отбор
кадров под строку живёт здесь, а не в каждом из них по копии.

Два правила, которые здесь и закреплены:

**Таговый источник не берёт чужую половину.** Строка на обучение, взявшая таг
«ночь», получит только те ночные кадры, что деление отправило в обучение.
Иначе копии проверочных кадров оказались бы в обучении, проверка начала бы
мерить запоминание, и узнать об этом было бы неоткуда — ровно то, ради чего
деление считается раньше аугментаций.

**Строки складываются.** Кадр, попавший в две строки, даст образцы по каждой.
Это не ошибка, а то, ради чего строк несколько: «все кадры как есть плюс
ночные через граф» — обычный набор.

Отбор и счёт здесь **не знают про базу**: SQLAlchemy подтягивают только
``load`` и ``save``, и импорт у них местный. Причина та же, что у
``common/splitting.py``: считающее ядро закрывается числами, а образ тестов про
ORM не знает и знать не должен.
"""
import uuid

from dataprep_svc.graph import schema

PARTS = ("train", "val")
FEEDS = ("train", "val", "tags")


def _uuids(raw):
    out = []
    for item in raw or []:
        try:
            out.append(uuid.UUID(str(item)))
        except (ValueError, AttributeError, TypeError):
            continue
    return out


def _uuid_or_none(raw):
    try:
        return uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        return None


def parse(raw):
    """Строки из тела запроса, приведённые к пригодному для счёта виду.

    Пусто — значит «как было всегда»: по строке на половину, кадры своей
    половины, без графа. Это же и стартовое состояние мастера, и поведение
    старых наборов, у которых строк ещё нет.
    """
    rows = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        part = item.get("part")
        if part not in PARTS:
            continue
        version_id = _uuid_or_none(item.get("graph_version_id"))
        bindings = []
        for b in item.get("bindings") or []:
            if not isinstance(b, dict):
                continue
            feed = b.get("feed")
            if feed not in FEEDS:
                continue
            bindings.append({
                "source_node": str(b.get("source_node") or "")[:64],
                "feed": feed,
                "tag_ids": _uuids(b.get("tag_ids")),
            })
        if not bindings:
            # Строка без привязок приходит из мастера, где граф ещё не выбран.
            # Считаем, что льём свою половину: это и есть её смысл по умолчанию.
            bindings = [{"source_node": "", "feed": part, "tag_ids": []}]
        if version_id is None:
            # «Без графа» — один поток и один вход. Лишние привязки здесь
            # только удвоили бы счёт на ровном месте.
            bindings = bindings[:1]
            bindings[0]["source_node"] = ""
        rows.append({
            "part": part,
            "position": len(rows),
            "graph_version_id": version_id,
            "bindings": bindings,
        })
    return _renumber(rows) if rows else default_rows()


def _renumber(rows):
    """Номер строки — её место внутри своей половины, а не в общем списке:
    по нему строится имя файла образца, и уникальным оно обязано быть внутри
    той папки, куда ложится."""
    seen = {}
    for row in rows:
        row["position"] = seen.get(row["part"], 0)
        seen[row["part"]] = row["position"] + 1
    return rows


def default_rows():
    """Строка на половину, кадры своей половины, без графа."""
    return [
        {
            "part": part,
            "position": 0,
            "graph_version_id": None,
            "bindings": [{"source_node": "", "feed": part, "tag_ids": []}],
        }
        for part in PARTS
    ]


# --------------------------------------------------------------------------- #
# База
# --------------------------------------------------------------------------- #
def load(db, set_id):
    from common.models import TrainSetFeed

    rows = db.query(TrainSetFeed).filter(
        TrainSetFeed.set_id == set_id
    ).order_by(TrainSetFeed.part, TrainSetFeed.position).all()
    by_key = {}
    for row in rows:
        key = (row.part, row.position)
        entry = by_key.setdefault(key, {
            "part": row.part,
            "position": row.position,
            "graph_version_id": row.graph_version_id,
            "bindings": [],
        })
        entry["bindings"].append({
            "source_node": row.source_node or "",
            "feed": row.feed,
            "tag_ids": _uuids(row.tag_ids),
        })
    return [by_key[k] for k in sorted(by_key)] or default_rows()


def save(db, set_id, rows):
    """Переписать строки набора целиком. Набор собирают один раз, поэтому
    правка строк — это новый набор, а не дописывание к старому."""
    from common.models import TrainSetFeed

    db.query(TrainSetFeed).filter(TrainSetFeed.set_id == set_id).delete()
    for row in rows:
        for binding in row["bindings"]:
            db.add(TrainSetFeed(
                set_id=set_id,
                part=row["part"],
                position=row["position"],
                graph_version_id=row["graph_version_id"],
                source_node=binding["source_node"],
                feed=binding["feed"],
                tag_ids=[str(t) for t in binding["tag_ids"]],
            ))


def view(rows):
    """Строки для интерфейса."""
    return [
        {
            "part": row["part"],
            "position": row["position"],
            "graph_version_id": (
                str(row["graph_version_id"]) if row["graph_version_id"] else None
            ),
            "bindings": [
                {
                    "source_node": b["source_node"],
                    "feed": b["feed"],
                    "tag_ids": [str(t) for t in b["tag_ids"]],
                }
                for b in row["bindings"]
            ],
        }
        for row in rows
    ]


def versions_of(rows):
    """Версии графов, на которые ссылаются строки, без повторов."""
    seen = []
    for row in rows:
        vid = row["graph_version_id"]
        if vid is not None and vid not in seen:
            seen.append(vid)
    return seen


# --------------------------------------------------------------------------- #
# Отбор кадров под строку
# --------------------------------------------------------------------------- #
def images_for(picked, split_of, part, binding):
    """Кадры, которые вольются в этот источник.

    Порядок — тот же, что у отбора: план сборки обязан быть одинаковым от
    запуска к запуску, иначе «пересобрать так же» перестаёт работать.
    """
    if binding["feed"] == "tags":
        want = set(binding["tag_ids"])
        if not want:
            return []
        return [
            img for img in picked.images
            # Своя половина: таг не повод утащить проверочный кадр в обучение.
            if split_of.get(img.id, "train") == part
            and picked.tags_of.get(img.id, ()) & want
        ]
    return [
        img for img in picked.images
        if split_of.get(img.id, "train") == binding["feed"]
    ]


def bind_sources(row, doc):
    """Привязки строки, разложенные по источникам графа.

    Граф могли пересохранить между выбором и сборкой: источника, которого в
    документе уже нет, здесь не будет, а появившийся без привязки получит
    половину своей строки — молчаливый пропуск кадров хуже лишнего кадра.
    """
    if doc is None:
        return [{**row["bindings"][0], "source_node": None, "name": "без графа"}]
    nodes = schema.sources_of(doc)
    by_node = {b["source_node"]: b for b in row["bindings"] if b["source_node"]}
    loose = [b for b in row["bindings"] if not b["source_node"]]
    out = []
    for index, node in enumerate(nodes):
        binding = by_node.get(node["id"])
        if binding is None:
            # Безымянная привязка — это граф с единственным источником, каким
            # он и был до появления строк. Такие наборы собираются как прежде.
            binding = (loose[index] if index < len(loose)
                       else {"feed": row["part"], "tag_ids": []})
        out.append({
            "source_node": node["id"],
            "name": schema.source_name(node),
            "feed": binding["feed"],
            "tag_ids": binding["tag_ids"],
        })
    return out


def plan_units(rows, doc_of, picked, split_of, load_version=None):
    """План сборки: одна запись на (строка, источник).

    Считают его двое — предпросмотр мастера и сам сборщик, — и потому он живёт
    здесь, а не в каждом по копии. Разойдясь, они показали бы одно число и
    собрали бы другое, а заметить это можно только сложив папку руками.

    ``expected`` считается подачей ровно в один источник. Так можно: и
    «Умножение», и оба «Разделителя», и «Слияние» линейны по числу образцов,
    поэтому сумма по источникам равна тому, что даст граф со всеми сразу.

    Кроме «Слияния сеткой»: оно берёт минимум по входам, и поданный в один
    источник граф дал бы ноль. Такую строку считаем всеми источниками разом и
    делим итог по источникам пропорционально кадрам.
    """
    from dataprep_svc.graph import plan as planlib   # ради него же и здесь

    units = []
    for row in rows:
        doc = doc_of(row["graph_version_id"])
        bound = bind_sources(row, doc)
        first = len(units)
        for index, binding in enumerate(bound):
            images = images_for(picked, split_of, row["part"], binding)
            if doc is None or binding["source_node"] is None:
                expected = float(len(images))
            else:
                expected = planlib.counts(
                    doc, {binding["source_node"]: len(images)},
                    load_version=load_version,
                )["outputs"]
            units.append({
                "part": row["part"],
                "position": row["position"],
                "graph_version_id": row["graph_version_id"],
                "source_node": binding["source_node"],
                "source_name": binding["name"],
                # Номер источника внутри строки и сколько их всего. Нужны
                # имени файла образца: один кадр может войти в два источника
                # одного графа — «обучающая половина» и «таг ночь» пересекутся
                # на первом же ночном кадре, — и пути по графу у него совпадут.
                # Без этого номера второй образец затёр бы первый.
                "source_index": index,
                "source_count": len(bound),
                "feed": binding["feed"],
                "tag_ids": binding["tag_ids"],
                "images": images,
                "expected": expected,
            })
        row_units = units[first:]
        if doc is not None and _has_mosaic(doc, load_version) and all(
            u["source_node"] is not None for u in row_units
        ):
            total = planlib.counts(
                doc, {u["source_node"]: len(u["images"]) for u in row_units},
                load_version=load_version,
            )["outputs"]
            frames = sum(len(u["images"]) for u in row_units) or 1
            for u in row_units:
                u["expected"] = total * len(u["images"]) / frames
    return units


def _has_mosaic(doc, load_version):
    from dataprep_svc.graph import plan as planlib

    nodes, _ = planlib.expand(doc, load_version or (lambda *_: None))
    return any(n.get("type") == "mosaic" for n in nodes)


def cross_half_warnings(rows):
    """Строка, которая льёт чужую половину, названа человеком явно — значит
    это его выбор, а не ошибка формы. Но сказать о нём надо: копии
    проверочных кадров в обучении делают метрики неправдоподобно хорошими."""
    out = []
    for row in rows:
        for binding in row["bindings"]:
            if binding["feed"] in PARTS and binding["feed"] != row["part"]:
                out.append(
                    f"Строка «{row['part']}» берёт кадры половины "
                    f"«{binding['feed']}». Проверка после такого мерит "
                    "запоминание, а не обобщение."
                )
    return out


def work(units, compiled_of):
    """Порядок работы: списки частей плана, которые идут вместе.

    Тактами — по кадру от каждого источника строки сразу — идёт только граф
    со «Слиянием сеткой». Остальные идут как раньше, источник за источником:
    зерно кадра у них то же, что до тактов, и пересборка старого набора даёт
    те же файлы.
    """
    rows, order = {}, []
    for unit in units:
        compiled = compiled_of.get(unit["graph_version_id"])
        ticked = compiled is not None and unit["source_node"] is not None and any(
            n["type"] == "mosaic" for n in compiled.nodes
        )
        key = (unit["part"], unit["position"]) if ticked else id(unit)
        if key not in rows:
            rows[key] = []
            order.append(key)
        rows[key].append(unit)
    return [rows[k] for k in order]
