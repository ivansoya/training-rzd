"""Джобы прежнего процесса не висят «идёт» вечно.

Поток закрытия разметки умирает вместе с процессом datasets, а файл джобы
оставался `running` — окно таски бесконечно показывало «Достаю кадры…».
"""
from common import jobs


def test_идущие_джобы_прежнего_процесса_становятся_ошибкой(tmp_path):
    jobs.configure(str(tmp_path))
    running = jobs.create("video-close", message="Достаю кадры")
    done = jobs.create("video-close")
    jobs.update(done, status="done", result={"created": 1})

    assert jobs.abandon_running("Прервано перезапуском") == 1
    assert jobs.get(running)["status"] == "error"
    assert jobs.get(running)["error"] == "Прервано перезапуском"
    assert jobs.get(done)["status"] == "done"
