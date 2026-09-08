"""Каталог узлов-аугментаций: что человек видит в палитре.

Список отобран, а не вытянут из библиотеки целиком. Причина простая: среди ста
с лишним трансформов albumentations есть такие, что ломают разметку, требуют
чужих входов или бессмысленны на кадрах с путей. Узнавать об этом после
часовой сборки — дорого, а объяснять «почему этот узел не работает» ещё
дороже.

**Параметр объявляется по смыслу, а имя подбирается.** У каждого параметра
здесь список кандидатов: albumentations переименовывает их между версиями
(``slant_lower``/``slant_upper`` стали ``slant_range``, ``var_limit`` стал
``std_range``). Мы берём первое имя, которое есть в установленной версии.
Обновление библиотеки тогда не ломает сохранённые графы молча — в худшем
случае узел честно помечается недоступным, и это видно в палитре.

**Вместе с именем иногда меняются единицы, и это опаснее переименования.**
``var_limit`` у шума мерился в дисперсии 10..50, а ``std_range`` — в долях
единицы 0..1. Подставить старые числа под новое имя значит тихо выкрутить шум
до белого. Поэтому пределы объявляются ``per_name``: своя пара для каждого
имени. Пропустишь — узел откажется собираться, а не соберётся неверно.

Реестр — чистые данные: он читается и без albumentations. Это нужно и тестам
(«у каждого узла есть русское имя и объяснение»), и палитре на машине, где
библиотека не поднялась.
"""
import os

os.environ.setdefault("NO_ALBUMENTATIONS_UPDATE", "1")

# Группы палитры. Порядок — это порядок в дереве слева.
GROUPS = (
    ("light", "Цвет и свет"),
    ("noise", "Шум и резкость"),
    ("weather", "Погода"),
    ("geometry", "Геометрия"),
)


def _rng(low, high, default, *, step=None, integer=False):
    return {
        "kind": "range", "low": low, "high": high,
        "default": default, "step": step, "int": integer,
    }


def _num(low, high, default, *, step=None, integer=False):
    return {
        "kind": "number", "low": low, "high": high,
        "default": default, "step": step, "int": integer,
    }


def _flag(default=False):
    return {"kind": "flag", "default": default}


def _pick(*options, default=None):
    return {"kind": "choice", "options": list(options),
            "default": default if default is not None else options[0]}


# Вероятность есть у каждого узла и вынесена отдельно: это не параметр
# трансформа, а то, как часто он вообще случается.
CHANCE = _num(0.0, 1.0, 0.5, step=0.05)

CATALOGUE = [
    # ----------------------------- Цвет и свет ----------------------------- #
    {
        "op": "RandomBrightnessContrast", "group": "light",
        "name": "Яркость и контраст",
        "why": "Разное освещение суток и погоды. Самая полезная аугментация "
               "для съёмки с путей — камера видит и рассвет, и полдень.",
        "params": {
            "brightness_limit": {
                "names": ["brightness_limit"], "label": "Яркость",
                "hint": "Доля от полного диапазона. 0,4 — уже сильный сдвиг.",
                **_rng(-0.6, 0.6, [-0.2, 0.2]),
            },
            "contrast_limit": {
                "names": ["contrast_limit"], "label": "Контраст",
                **_rng(-0.6, 0.6, [-0.2, 0.2]),
            },
        },
    },
    {
        "op": "HueSaturationValue", "group": "light",
        "name": "Тон и насыщенность",
        "why": "Уводит цвета, не трогая форму. Помогает, когда камеры разные "
               "и каждая красит по-своему.",
        "params": {
            "hue_shift_limit": {
                "names": ["hue_shift_limit"], "label": "Тон",
                "hint": "Больше 30 — вагоны меняют цвет до неузнаваемости.",
                **_num(0, 60, 20, integer=True),
            },
            "sat_shift_limit": {
                "names": ["sat_shift_limit"], "label": "Насыщенность",
                **_num(0, 80, 30, integer=True),
            },
            "val_shift_limit": {
                "names": ["val_shift_limit"], "label": "Светлота",
                **_num(0, 80, 20, integer=True),
            },
        },
    },
    {
        "op": "RandomGamma", "group": "light",
        "name": "Гамма",
        "why": "Тянет тени и света порознь. В отличие от яркости, не смывает "
               "детали в тёмных местах кадра.",
        "params": {
            "gamma_limit": {
                "names": ["gamma_limit"], "label": "Гамма",
                "hint": "100 — без изменений.",
                **_rng(40, 200, [80, 120], integer=True),
            },
        },
    },
    {
        "op": "CLAHE", "group": "light",
        "name": "Локальный контраст",
        "why": "Вытягивает детали в тени, не пересвечивая небо. Полезно на "
               "контровом свете.",
        "params": {
            "clip_limit": {
                "names": ["clip_limit"], "label": "Сила",
                **_num(1.0, 8.0, 4.0, step=0.5),
            },
        },
    },
    {
        "op": "ToGray", "group": "light",
        "name": "Обесцветить",
        "why": "Заставляет модель опираться на форму, а не на цвет. "
               "Пригодится там, где стоят чёрно-белые камеры.",
        "params": {},
    },
    {
        "op": "RandomToneCurve", "group": "light",
        "name": "Тоновая кривая",
        "why": "Мягко перекладывает светлоту — так это делает автоматика "
               "разных камер.",
        "params": {
            "scale": {
                "names": ["scale"], "label": "Изгиб",
                **_num(0.0, 0.6, 0.1, step=0.05),
            },
        },
    },

    # ---------------------------- Шум и резкость --------------------------- #
    {
        "op": "MotionBlur", "group": "noise",
        "name": "Смаз движением",
        "why": "Главный вид брака на съёмке с хода. Учит узнавать объект, "
               "который смазан скоростью.",
        "params": {
            "blur_limit": {
                "names": ["blur_limit"], "label": "Длина смаза",
                "hint": "В пикселях. Больше 15 — объект перестаёт читаться.",
                **_num(3, 21, 7, integer=True),
            },
        },
    },
    {
        "op": "GaussianBlur", "group": "noise",
        "name": "Расфокус",
        "why": "Мягкая нерезкость: грязный объектив, дождь на стекле, "
               "промах автофокуса.",
        "params": {
            "blur_limit": {
                "names": ["blur_limit"], "label": "Ядро",
                **_rng(3, 21, [3, 7], integer=True),
            },
        },
    },
    {
        "op": "GaussNoise", "group": "noise",
        "name": "Шум матрицы",
        "why": "То, что появляется на длинной выдержке и в сумерках.",
        "params": {
            "var_limit": {
                "names": ["std_range", "var_limit"], "label": "Сила",
                "hint": "Доля от полного диапазона яркости. 0,3 — заметный "
                        "шум ночной съёмки.",
                # Единицы разошлись вместе с именем: старое имя мерило
                # дисперсию, новое — долю. Подставить одни числа под другое
                # имя значит выкрутить шум до белого.
                "per_name": {
                    "std_range": _rng(0.0, 1.0, [0.05, 0.25], step=0.01),
                    "var_limit": _rng(0.0, 120.0, [10.0, 50.0], step=1.0),
                },
                **_rng(0.0, 1.0, [0.05, 0.25], step=0.01),
            },
        },
    },
    {
        "op": "ISONoise", "group": "noise",
        "name": "Шум высокой чувствительности",
        "why": "Цветной шум ночной съёмки — не тот же самый, что шум матрицы.",
        "params": {
            "intensity": {
                "names": ["intensity"], "label": "Сила",
                **_rng(0.0, 1.0, [0.1, 0.5], step=0.05),
            },
        },
    },
    {
        "op": "ImageCompression", "group": "noise",
        "name": "Сжатие JPEG",
        "why": "Кадры доезжают по сети сжатыми. Модель, обученная на чистых, "
               "на сжатых теряет мелкое.",
        "params": {
            "quality_lower": {
                "names": ["quality_range", "quality_lower"],
                "label": "Качество",
                "hint": "Ниже 40 — видны квадраты.",
                **_rng(20, 100, [60, 95], integer=True),
            },
        },
    },
    {
        "op": "Downscale", "group": "noise",
        "name": "Понижение разрешения",
        "why": "Дальний объект и дешёвая камера дают одно и то же: мало "
               "пикселей на объект.",
        "params": {
            "scale_min": {
                "names": ["scale_range", "scale_min"], "label": "Во сколько раз",
                **_rng(0.1, 0.9, [0.35, 0.7], step=0.05),
            },
        },
    },
    {
        "op": "Sharpen", "group": "noise",
        "name": "Резкость",
        "why": "Обратная сторона расфокуса: некоторые камеры перешарпливают, "
               "и это тоже надо уметь читать.",
        "params": {
            "alpha": {
                "names": ["alpha"], "label": "Сила",
                **_rng(0.0, 1.0, [0.2, 0.5], step=0.05),
            },
        },
    },

    # -------------------------------- Погода ------------------------------- #
    {
        "op": "RandomRain", "group": "weather",
        "name": "Дождь",
        "why": "Ставит косые струи и приглушает контраст. Учит не терять "
               "объект в непогоду.",
        "params": {
            "slant_lower": {
                "names": ["slant_range", "slant_lower"], "label": "Наклон струй",
                **_rng(-20, 20, [-10, 10], integer=True),
            },
            "drop_length": {
                "names": ["drop_length"], "label": "Длина капли",
                **_num(1, 40, 20, integer=True),
            },
            "brightness_coefficient": {
                "names": ["brightness_coefficient"], "label": "Затемнение",
                "hint": "1 — не темнить. 0,7 — пасмурный ливень.",
                **_num(0.4, 1.0, 0.7, step=0.05),
            },
        },
    },
    {
        "op": "RandomFog", "group": "weather",
        "name": "Туман",
        "why": "Съедает дальний план. Ровно то, из-за чего дальние объекты "
               "перестают детектироваться зимним утром.",
        "params": {
            "fog_coef_lower": {
                "names": ["fog_coef_range", "fog_coef_lower"],
                "label": "Плотность",
                "hint": "Выше 0,6 объект не читается и глазом.",
                **_rng(0.0, 1.0, [0.1, 0.4], step=0.05),
            },
        },
    },
    {
        "op": "RandomSnow", "group": "weather",
        "name": "Снег",
        "why": "Белые пятна поверх кадра и общий пересвет — зимняя съёмка.",
        "params": {
            "snow_point_lower": {
                "names": ["snow_point_range", "snow_point_lower"],
                "label": "Плотность",
                **_rng(0.0, 0.6, [0.1, 0.3], step=0.05),
            },
        },
    },
    {
        "op": "RandomShadow", "group": "weather",
        "name": "Тени",
        "why": "Опоры и мосты кладут на путь резкие тени, и модель принимает "
               "их за объекты.",
        "params": {
            "num_shadows_lower": {
                "names": ["num_shadows_limit", "num_shadows_lower"],
                "label": "Сколько теней",
                **_rng(1, 6, [1, 2], integer=True),
            },
        },
    },
    {
        "op": "RandomSunFlare", "group": "weather",
        "name": "Засветка солнцем",
        "why": "Низкое солнце в объектив — обычное дело на утренних "
               "и вечерних перегонах.",
        "params": {
            "src_radius": {
                "names": ["src_radius"], "label": "Радиус",
                **_num(50, 400, 150, integer=True),
            },
        },
    },

    # ------------------------------ Геометрия ------------------------------ #
    {
        "op": "HorizontalFlip", "group": "geometry",
        "name": "Отразить по горизонтали",
        "why": "Удваивает данные почти даром. Осторожно с текстом и "
               "несимметричными знаками — они станут зеркальными.",
        "params": {},
    },
    {
        "op": "Rotate", "group": "geometry",
        "name": "Поворот",
        "why": "Камера редко стоит ровно. Небольшой поворот — самая честная "
               "геометрическая аугментация для путевой съёмки.",
        "params": {
            "limit": {
                "names": ["limit"], "label": "Угол",
                "hint": "Больше 15° для съёмки с путей неправдоподобно.",
                **_num(0, 45, 10, integer=True),
            },
        },
    },
    {
        "op": "ShiftScaleRotate", "group": "geometry",
        "name": "Сдвиг, масштаб, поворот",
        "why": "Три движения камеры сразу. Заменяет три отдельных узла и "
               "считается за один проход.",
        "params": {
            "shift_limit": {
                "names": ["shift_limit"], "label": "Сдвиг",
                **_num(0.0, 0.3, 0.06, step=0.01),
            },
            "scale_limit": {
                "names": ["scale_limit"], "label": "Масштаб",
                **_num(0.0, 0.5, 0.1, step=0.05),
            },
            "rotate_limit": {
                "names": ["rotate_limit"], "label": "Поворот",
                **_num(0, 45, 10, integer=True),
            },
        },
    },
    {
        "op": "Perspective", "group": "geometry",
        "name": "Перспектива",
        "why": "Меняет точку съёмки. Для путей особенно к месту: один и тот же "
               "вагон снимают и в лоб, и под углом.",
        "params": {
            "scale": {
                "names": ["scale"], "label": "Сила",
                **_rng(0.0, 0.3, [0.02, 0.08], step=0.01),
            },
        },
    },
    {
        "op": "RandomSizedBBoxSafeCrop", "group": "geometry",
        "name": "Кадрирование без потери объектов",
        "why": "Обрезает кадр, но так, чтобы разметка осталась внутри. "
               "Обычная обрезка уводит объекты за край и обессмысливает кадр.",
        "params": {
            "height": {
                "names": ["height"], "label": "Высота",
                **_num(64, 2048, 640, integer=True),
            },
            "width": {
                "names": ["width"], "label": "Ширина",
                **_num(64, 2048, 640, integer=True),
            },
        },
    },
]

BY_OP = {item["op"]: item for item in CATALOGUE}
GROUP_TITLES = dict(GROUPS)


# --------------------------------------------------------------------------- #
# Приведение значений к объявленным пределам
# --------------------------------------------------------------------------- #
def clamp(spec, value):
    """Значение параметра, загнанное в объявленные пределы.

    Не вежливость, а защита: граф приходит с клиента, а клиенту верить нельзя.
    Кроме того, старый граф мог быть сохранён с пределами, которые мы с тех пор
    сузили, — он обязан продолжить работать, пусть и по краю.
    """
    kind = spec.get("kind")
    if kind == "flag":
        return bool(value)
    if kind == "choice":
        return value if value in spec["options"] else spec["default"]
    if kind == "number":
        try:
            got = float(value)
        except (TypeError, ValueError):
            return spec["default"]
        got = max(spec["low"], min(spec["high"], got))
        return int(round(got)) if spec.get("int") else got
    if kind == "range":
        try:
            low, high = value
            low, high = float(low), float(high)
        except (TypeError, ValueError):
            return spec["default"]
        low = max(spec["low"], min(spec["high"], low))
        high = max(spec["low"], min(spec["high"], high))
        if low > high:
            low, high = high, low
        if spec.get("int"):
            return [int(round(low)), int(round(high))]
        return [low, high]
    return value


def spec_for(spec, actual_name=None):
    """Пределы под то имя, которым параметр называется в этой версии."""
    per_name = spec.get("per_name") or {}
    if actual_name and actual_name in per_name:
        return per_name[actual_name]
    return spec


def clamp_args(op, args, names=None):
    """Значения параметров узла: приведённые к пределам, все до одного.

    ``names`` — что во что разрешилось (даёт ``albu.resolve``). Нужно там, где
    вместе с именем сменились единицы.
    """
    item = BY_OP.get(op)
    if item is None:
        return {}
    out = {}
    for key, spec in item["params"].items():
        actual = (names or {}).get(key)
        bounds = spec_for(spec, actual)
        if key in (args or {}):
            out[key] = clamp(bounds, args[key])
        else:
            out[key] = bounds["default"]
    return out
