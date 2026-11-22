"""Адресная нарезка обязана совпадать с последовательной по номеру, времени и пикселям."""
import hashlib
import random
from fractions import Fraction

import pytest

av = pytest.importorskip("av")
from PIL import Image, ImageDraw
from contextlib import contextmanager
from common import video_frames
from common.video_frames import VideoError, extract_frames


def make_video(path, codec, variable=False, fragmented=False):
    av.logging.set_level(None)
    options = {"movflags": "frag_keyframe+empty_moov"} if fragmented else {"movflags": "+faststart"}
    with av.open(str(path), "w", options=options) as container:
        stream = container.add_stream(codec, rate=25)
        stream.width, stream.height, stream.pix_fmt = 160, 96, "yuv420p"
        stream.time_base = Fraction(1, 1000)
        stream.options = ({"x265-params": "log-level=error:pools=none:frame-threads=1:keyint=25:min-keyint=25:scenecut=0"}
                          if codec == "libx265" else {"g": "25", "bf": "3", "sc_threshold": "0"})
        pts = 0
        for n in range(180):
            image = Image.new("RGB", (160, 96), (n % 255, 30, 50))
            ImageDraw.Draw(image).rectangle([n % 120, 20, n % 120 + 30, 70], fill=(230, 120, n % 255))
            frame = av.VideoFrame.from_image(image)
            frame.pts, frame.time_base = pts, Fraction(1, 1000)
            pts += 80 if variable and n % 7 == 0 else 40
            container.mux(stream.encode(frame))
        container.mux(stream.encode())
    with av.open(str(path)) as container:
        packets = [(p.pts, p.is_keyframe) for p in container.demux(video=0) if p.pts is not None]
    packets.sort()
    return [p for p, _ in packets], [i for i, (_, key) in enumerate(packets) if key]


def collect(path, targets, pts, **kwargs):
    seen, progress = [], []
    extract_frames(str(path), targets, lambda n, ms, image: seen.append((n, ms, hashlib.sha256(image.tobytes()).hexdigest())),
                   pts=pts, progress=lambda d, t: progress.append((d, t)), **kwargs)
    return seen, progress


@pytest.mark.parametrize("codec", ["libx264", "libx265"])
@pytest.mark.parametrize("variable,fragmented", [(False, False), (True, False), (False, True)])
def test_sparse_matches_sequential_at_boundaries_and_random_frames(tmp_path, codec, variable, fragmented):
    path = tmp_path / "source.mp4"
    pts, keys = make_video(path, codec, variable, fragmented)
    targets = sorted({0, 1, len(pts)-1, *random.Random(57).sample(range(len(pts)), 20),
                      *(n for k in keys for n in [k-1, k, k+1] if 0 <= n < len(pts))})
    expected, _ = collect(path, targets, pts)
    got, progress = collect(path, targets[::-1] + targets[:3], pts, keys=keys)
    assert got == expected
    assert [n for n, _, _ in got] == targets
    assert progress[-1] == (len(targets), len(targets))


def test_sparse_starts_at_late_frame_and_dense_group(tmp_path):
    path = tmp_path / "source.mp4"
    pts, keys = make_video(path, "libx265", True)
    targets = list(range(124, 151)) + [179]
    assert collect(path, targets, pts, keys=keys)[0] == collect(path, targets, pts)[0]


def test_sparse_rejects_out_of_index_before_delivering_any_image(tmp_path):
    path = tmp_path / "source.mp4"
    pts, keys = make_video(path, "libx264")
    seen = []
    with pytest.raises(VideoError, match="таблиц"):
        extract_frames(str(path), [0, len(pts)], lambda *args: seen.append(args), pts=pts, keys=keys)
    assert seen == []


@pytest.mark.parametrize("overshoot", [False, True])
def test_dense_stream_and_recovery_after_seek_overshoots(tmp_path, monkeypatch, overshoot):
    path = tmp_path / "source.mp4"
    pts, keys = make_video(path, "libx265", True)
    targets = [60, 150] if overshoot else list(range(len(pts)))
    expected = collect(path, targets, pts)[0]
    original, seeks = video_frames.open_video, []

    @contextmanager
    def wrapped(source):
        with original(source) as container:
            class Proxy:
                streams = container.streams
                def seek(self, offset, **kwargs):
                    seeks.append(offset)
                    if overshoot and len(seeks) == 1:
                        offset = pts[100]
                    return container.seek(offset, **kwargs)
                def decode(self, stream):
                    return container.decode(stream)
            yield Proxy()

    monkeypatch.setattr(video_frames, "open_video", wrapped)
    assert collect(path, targets, pts, keys=keys)[0] == expected
    if overshoot:
        assert seeks[1] == pts[0]
    else:
        assert seeks == [pts[0]]


def test_missing_exact_pts_is_never_replaced_with_adjacent_frame(tmp_path):
    path = tmp_path / "source.mp4"
    pts, keys = make_video(path, "libx264")
    pts[60] += 1
    seen = []
    with pytest.raises(VideoError, match="не найден"):
        extract_frames(str(path), [60], lambda *args: seen.append(args), pts=pts, keys=keys)
    assert seen == []
