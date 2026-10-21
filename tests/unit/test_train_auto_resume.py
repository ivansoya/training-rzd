"""Обучение, которое сторож снял или которое умерло молча, один раз продолжается само.

Решение 21.10.2026: продолжение с last.pt без человека — одно; второй раз,
после «Остановить» или без last.pt — ран закрывается ошибкой, как раньше.
"""
from types import SimpleNamespace

from training_svc import trainer


def _run(**kw):
    base = dict(status="running", cancel_requested=False, set_id="set", params={"epochs": 10}, phase="train",
                pid=42, worker_id="w", gpu_lease_id="lease", current_batch=17, val_batch=3, error=None)
    base.update(kw)
    return SimpleNamespace(**base)


def test_один_раз_продолжает_второй_нет(monkeypatch, tmp_path):
    last = tmp_path / "last.pt"
    last.write_bytes(b"x")
    monkeypatch.setattr(trainer, "last_checkpoint", lambda run: str(last))
    run = _run()
    assert trainer.auto_resume(run, "now")
    assert (run.status, run.queued_at, run.pid, run.worker_id, run.gpu_lease_id, run.current_batch) == \
        ("queued", "now", None, None, None, 0)
    assert run.params == {"epochs": 10, "auto_resumes": 1}
    run.status = "running"
    assert not trainer.auto_resume(run, "later")


def test_остановку_и_пустое_место_не_продолжает(monkeypatch, tmp_path):
    monkeypatch.setattr(trainer, "last_checkpoint", lambda run: str(tmp_path / "last.pt"))
    assert not trainer.auto_resume(_run(), "now")  # last.pt нет — ни одной эпохи
    (tmp_path / "last.pt").write_bytes(b"x")
    assert not trainer.auto_resume(_run(cancel_requested=True), "now")
    assert not trainer.auto_resume(_run(status="stopping"), "now")
    assert not trainer.auto_resume(_run(set_id=None), "now")
