"""Подметание файловых джоб: старые завершённые уходят, идущие остаются."""
import json
import os
import time

from common import jobs


def _old(path, status):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"status": status}, fh)
    stale = time.time() - 7200
    os.utime(path, (stale, stale))


def test_подметание_не_трогает_идущие(tmp_path):
    jobs.configure(str(tmp_path))
    _old(tmp_path / "done.json", "done")
    _old(tmp_path / "busy.json", "running")
    jobs._swept[0] = 0.0
    fresh = jobs.create("test")
    names = sorted(os.listdir(tmp_path))
    assert "done.json" not in names and "busy.json" in names
    assert f"{fresh}.json" in names
