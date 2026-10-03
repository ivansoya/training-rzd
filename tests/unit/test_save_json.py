"""save_json: параллельные записи в один файл не роняют друг друга."""
import json
import os
from concurrent.futures import ThreadPoolExecutor

from common.storage import save_json


def test_параллельная_запись_не_падает_и_не_оставляет_мусора(tmp_path):
    path = str(tmp_path / "state.json")
    with ThreadPoolExecutor(8) as pool:
        list(pool.map(lambda i: save_json(path, {"n": i, "pad": "x" * 10000}), range(64)))
    assert json.load(open(path, encoding="utf-8"))["n"] in range(64)
    assert os.listdir(tmp_path) == ["state.json"]
