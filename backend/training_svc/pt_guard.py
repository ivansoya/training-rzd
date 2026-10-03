"""Проверка чужого `.pt` до того, как его откроет torch.

Веса YOLO — это pickle, а распаковать pickle значит выполнить то, что в нём
записано. Агент принимает файлы от людей, и `YOLO(путь)` на присланном файле
был бы запуском чужого кода в контейнере с видеокартой и томом всех проектов.

Поэтому файл сперва читается вхолостую: каждый класс, который pickle просит
найти, подменяется заглушкой, ничего настоящего не создаётся и не вызывается,
а имена запоминаются. Если хоть одно имя вне белого списка — файл отвергнут.
Проверенный файл дальше открывается обычным путём.

Своё холостое чтение, а не `torch.load(weights_only=True)`: открывает файл
всё равно ultralytics, и ему нужен обычный pickle; проверка же не должна
зависеть от версии torch и его списка безопасных имён.

`getattr` пускается в одном виде: класс из белого списка и публичное имя —
так -seg модели хранят `Detect.forward`. Любой другой вызов — отказ.

Список снят с настоящих чекпойнтов — yolo11n, yolo26n и всех обученных здесь
best.pt (23.09.2026: девять файлов, один yolo26 добавил шесть имён) — и
нарочно узок: встретится новое имя, ошибка назовёт его, и решение расширить
список примет человек, а не код.
"""
import pickle
import zipfile

# Модули целиком, вместе с вложенными: слои сети и сама модель ultralytics.
# Это классы, а не функции общего назначения: создать слой — не значит
# выполнить команду. Потери и назначатель (`loss`, `tal`) сохраняет в
# чекпойнт обучение yolo26.
_MODULES = ("torch.nn.modules", "ultralytics.nn", "ultralytics.utils.loss",
            "ultralytics.utils.tal")
_NAMES = {
    ("collections", "OrderedDict"),
    ("__builtin__", "set"),
    ("builtins", "set"),
    ("builtins", "frozenset"),
    ("torch", "Size"),
    ("torch", "device"),
    # Аргументы обучения внутри чекпойнта yolo26.
    ("ultralytics.utils", "IterableSimpleNamespace"),
    ("torch._utils", "_rebuild_tensor_v2"),
    ("torch._utils", "_rebuild_parameter"),
}
# Хранилища тензоров: FloatStorage, HalfStorage, LongStorage…
_TORCH_STORAGE = "Storage"
_GETATTR = {("__builtin__", "getattr"), ("builtins", "getattr")}


class UnsafeWeights(ValueError):
    """Файл просит то, чего нет в белом списке. `names` — что именно."""

    def __init__(self, names):
        self.names = sorted(names)
        shown = ", ".join(f"{m}.{n}" for m, n in self.names[:5])
        super().__init__(
            f"Файл весов ссылается на запрещённое: {shown}. Если это официальные "
            "веса ultralytics, передайте это сообщение администратору — "
            "список разрешённых имён расширяют вручную."
        )


def allowed(module: str, name: str) -> bool:
    if (module, name) in _NAMES:
        return True
    if module == "torch" and name.endswith(_TORCH_STORAGE):
        return True
    # Сам модуль или вложенный в него: «ultralytics.nn.tasks» проходит,
    # «ultralytics.nnx» — нет.
    return any(module == m or module.startswith(m + ".") for m in _MODULES)


class _Stub:
    """Всё, что pickle попросит сделать с объектом, — пустое действие."""

    def __init__(self, *args, **kwargs):
        pass

    def __call__(self, *args, **kwargs):
        return _Stub()

    def __setstate__(self, state):
        pass

    def __setitem__(self, key, value):
        pass

    def append(self, value):
        pass

    def extend(self, values):
        pass

    def update(self, *args, **kwargs):
        pass

    def add(self, value):
        pass


class _DryRun(pickle.Unpickler):
    def __init__(self, fh):
        super().__init__(fh)
        self.seen = set()
        self.bad_getattr = False
        self.stubs = {}

    def find_class(self, module, name):
        self.seen.add((module, name))
        if (module, name) in _GETATTR:
            return self._getattr
        # Своя заглушка на имя: getattr должен знать, у какого класса берут атрибут.
        key = (module, name)
        if key not in self.stubs:
            self.stubs[key] = type(name, (_Stub,), {"_origin": key})
        return self.stubs[key]

    def _getattr(self, obj, attr, *default):
        origin = getattr(obj, "_origin", None) if isinstance(obj, type) else None
        safe = (origin is not None and allowed(*origin) and isinstance(attr, str)
                and attr.isidentifier() and not attr.startswith("_"))
        self.bad_getattr |= not safe
        return _Stub()

    def persistent_load(self, pid):
        return None


def globals_of(path: str) -> set:
    """Имена, на которые ссылается чекпойнт. Ничего из них не создаётся."""
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise ValueError("Это не файл весов torch: ожидается .pt в формате zip")
    with archive:
        pickles = [n for n in archive.namelist() if n.endswith("/data.pkl") or n == "data.pkl"]
        if len(pickles) != 1:
            raise ValueError("В файле весов нет data.pkl или их несколько")
        with archive.open(pickles[0]) as fh:
            runner = _DryRun(fh)
            try:
                runner.load()
            except Exception as exc:  # битый pickle — тоже отказ, а не падение
                raise ValueError(f"Файл весов не читается: {exc}") from exc
            return runner.seen if runner.bad_getattr else runner.seen - _GETATTR


def check(path: str) -> None:
    """Бросает `UnsafeWeights`, если файл нельзя открывать обычным путём."""
    bad = {(m, n) for m, n in globals_of(path) if not allowed(m, n)}
    if bad:
        raise UnsafeWeights(bad)
