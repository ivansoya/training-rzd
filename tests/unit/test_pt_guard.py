"""Чужой `.pt` проверяется вхолостую: вредный файл отвергнут и ничего не выполнил.

Без torch: чекпойнт собирается руками тем же форматом (zip с data.pkl), что
пишет torch.save. Отрицательная проверка важнее положительной — она ловит
того, кто сочтёт белый список лишним и вернёт прямой `YOLO(путь)`.
"""
import collections
import os
import pickle
import tempfile
import zipfile

import pytest

from training_svc import pt_guard

MARK = os.path.join(tempfile.gettempdir(), "pt_guard_was_executed")


class _Global:
    """Объект, который pickle запишет ссылкой на модуль.имя с аргументами."""

    def __init__(self, module, name, args=()):
        self.module, self.name, self.args = module, name, args

    def __reduce__(self):
        fn = type(self.name, (), {"__module__": self.module, "__qualname__": self.name})
        return fn, self.args


def _pickle_with(*objs):
    # Свой Pickler: он пишет GLOBAL с нужными именами, не проверяя, что такие
    # классы существуют, — ровно как выглядел бы чужой файл.
    import io

    class P(pickle._Pickler):
        def save_global(self, obj, name=None):
            self.write(pickle.GLOBAL + f"{obj.__module__}\n{obj.__qualname__}\n".encode())
            self.memoize(obj)

        def reducer_override(self, obj):
            if isinstance(obj, _Global):
                cls = type(obj.name, (), {})
                cls.__module__, cls.__qualname__ = obj.module, obj.name
                return cls, obj.args
            return NotImplemented

    buf = io.BytesIO()
    P(buf, protocol=2).dump(list(objs))
    return buf.getvalue()


def _pt(payload: bytes) -> str:
    fd, path = tempfile.mkstemp(suffix=".pt")
    os.close(fd)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("best/data.pkl", payload)
        z.writestr("best/version", "3\n")
    return path


def test_настоящие_имена_чекпойнта_пропускаются():
    path = _pt(_pickle_with(
        collections.OrderedDict(a=1),
        _Global("ultralytics.nn.tasks", "DetectionModel"),
        _Global("torch.nn.modules.conv", "Conv2d"),
        _Global("torch", "HalfStorage"),
        _Global("torch._utils", "_rebuild_tensor_v2", (1, 2)),
    ))
    pt_guard.check(path)
    assert ("ultralytics.nn.tasks", "DetectionModel") in pt_guard.globals_of(path)


def test_вызов_команды_отвергнут_и_не_выполнен():
    if os.path.exists(MARK):
        os.remove(MARK)
    path = _pt(_pickle_with(_Global("os", "system", (f"touch {MARK}",))))
    with pytest.raises(pt_guard.UnsafeWeights) as err:
        pt_guard.check(path)
    assert ("os", "system") in err.value.names
    assert not os.path.exists(MARK)


@pytest.mark.parametrize("module,name", [
    ("builtins", "getattr"),
    ("builtins", "eval"),
    ("torch", "load"),
    ("torch.hub", "load"),
    ("ultralytics.nnx", "Evil"),
    ("subprocess", "Popen"),
])
def test_соседи_белого_списка_не_проходят(module, name):
    assert not pt_guard.allowed(module, name)


def test_не_zip_это_отказ():
    fd, path = tempfile.mkstemp(suffix=".pt")
    os.write(fd, b"not a zip")
    os.close(fd)
    with pytest.raises(ValueError):
        pt_guard.check(path)
