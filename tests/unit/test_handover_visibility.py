from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from datasets_svc import task_routes, video_busy


@pytest.mark.parametrize("fails", [False, True])
def test_handover_releases_busy_before_publishing_result(monkeypatch, fails):
    task_id, video_id = "handover-test-task", "handover-test-video"
    key = video_busy.task_key(task_id)
    assert video_busy.take(key, "handover") is not None
    assert video_busy.take(video_id, "handover") is not None
    task = SimpleNamespace(id=task_id, project_id="project", status="updating")
    db = MagicMock()
    db.execute.return_value.scalar_one.return_value = task
    db.get.return_value = SimpleNamespace(id="user")
    monkeypatch.setattr(task_routes, "SessionLocal", lambda: db)
    monkeypatch.setattr(task_routes.materialize, "annotate_videos", lambda *_: [])
    monkeypatch.setattr(task_routes, "_log", lambda *_args, **_kw: None)
    monkeypatch.setattr(task_routes, "_drop_after_commit", lambda *_: None)
    monkeypatch.setattr(task_routes.materialize, "drop_frame_files", lambda *_: None)
    monkeypatch.setattr(task_routes, "_ping", lambda *_args, **_kw: None)
    if fails:
        monkeypatch.setattr(task_routes, "_accept", MagicMock(side_effect=ValueError("failure")))
    else:
        monkeypatch.setattr(task_routes, "_accept", lambda *_: {"accepted": 0})

    published = []

    def update(_job, **fields):
        published.append((fields["status"], video_busy.current(key), video_busy.current(video_id)))

    monkeypatch.setattr(task_routes.jobs, "update", update)
    try:
        task_routes._run_handover("job", task_id, "done", "user", [video_id])
        assert published == [("error" if fails else "done", None, None)]
    finally:
        video_busy.release(key)
        video_busy.release(video_id)
