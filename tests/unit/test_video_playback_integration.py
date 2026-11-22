"""Контракт /file и воркера подготовки без записи в рабочую БД."""
from types import SimpleNamespace
import uuid

import pytest
pytest.importorskip("av")
from flask import Flask
from datasets_svc import task_routes, video_browser, worker
from test_video_sparse import make_video


def test_file_route_serves_verified_copy_and_honors_range(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    make_video(source, "libx265", fragmented=True)
    output = video_browser.prepare(str(source))
    task_id, video_id = uuid.uuid4(), uuid.uuid4()
    video = SimpleNamespace(task_id=task_id, file_path="source.mp4")
    db = SimpleNamespace(get=lambda cls, key: video, close=lambda: None)
    monkeypatch.setattr(task_routes, "_resolve_task", lambda task: (db, SimpleNamespace(id=task_id), None, None, "viewer", None))
    monkeypatch.setattr(task_routes.config, "DATA_DIR", str(tmp_path))
    app = Flask(__name__)
    app.register_blueprint(task_routes.bp)
    with app.test_client() as client:
        response = client.get(f"/api/tasks/{task_id}/videos/{video_id}/file?browser=1", headers={"Range": "bytes=0-63"})
        assert response.status_code == 206
        assert response.data == open(output, "rb").read(64)
        assert response.headers["Content-Type"] == "video/mp4"
        assert response.headers["Content-Range"].startswith("bytes 0-63/")
        assert response.headers["Cache-Control"].startswith("private")
        response.close()


def test_upload_index_prepares_browser_copy_before_reporting_ready(monkeypatch):
    calls = []
    index = {"version": "same", "count": 100}
    monkeypatch.setattr(worker.chunklib, "build_index", lambda path: index)
    monkeypatch.setattr(worker.video_index, "get", lambda *args: index)
    monkeypatch.setattr(worker.video_browser, "prepare", lambda path, heartbeat=None: calls.append(("browser", path)))
    monkeypatch.setattr(worker.queue, "enqueue", lambda *args: calls.append(("strip", args[1])))
    result = worker._do_index(None, SimpleNamespace(), SimpleNamespace(id="video", mode="cut"), "/source.mp4")
    assert result == {"frames": 100}
    assert calls == [("browser", "/source.mp4"), ("strip", "video")]


@pytest.mark.parametrize("stage,ready", [("index", False), ("strip", True), (None, True)])
def test_cut_readiness_waits_for_browser_preparation(monkeypatch, stage, ready):
    monkeypatch.setattr(task_routes.queue, "progress_of", lambda *args: {"kind": stage, "status": "running"} if stage else None)
    assert task_routes._prepare_state(None, SimpleNamespace(id="video", mode="cut"))["ready"] is ready


def test_annotation_fallback_qualities_survive_unsupported_mp4_copy(tmp_path, monkeypatch):
    path = tmp_path / "source.avi"
    path.write_bytes(b"fixture")
    index = {"version": "same", "count": 100, "width": 160, "height": 96, "range_why": "codec"}
    monkeypatch.setattr(worker.chunklib, "build_index", lambda path: index)
    monkeypatch.setattr(worker.video_index, "get", lambda *args: index)
    def unsupported(*args, **kwargs):
        raise worker.videolib.VideoError("unsupported copy")
    monkeypatch.setattr(worker.video_browser, "prepare", unsupported)
    monkeypatch.setattr(worker.queue, "enqueue", lambda *args: None)
    asset = SimpleNamespace()
    monkeypatch.setattr(worker.queue, "ensure_asset", lambda *args: asset)
    monkeypatch.setattr(worker.chunklib, "pack_table", lambda full: full)
    monkeypatch.setattr(worker.chunklib, "ladder_for", lambda *args: [])
    monkeypatch.setattr(worker, "_drop_chunks", lambda *args: None)
    result = worker._do_index(SimpleNamespace(commit=lambda: None), SimpleNamespace(),
                            SimpleNamespace(id="video", mode="annotate", file_path="source.avi"), str(path))
    assert result["frames"] == 100
    assert asset.file_status == "ready"


def test_delete_includes_browser_copy_and_marker(tmp_path):
    source = str(tmp_path / "source.mp4")
    _dirs, files = task_routes.chunklib.leftovers(source)
    assert set(video_browser._paths(source)) <= set(files)
