"""Копия просмотра не меняет видеопакеты/PTS и публикуется только после проверки."""
import hashlib
import os
from fractions import Fraction
from pathlib import Path

import pytest

av = pytest.importorskip("av")
from datasets_svc import video_browser as browser
from common.video_frames import VideoError
from test_video_sparse import make_video


@pytest.mark.parametrize("codec,variable", [("libx264", False), ("libx265", False), ("libx265", True)])
def test_fragmented_copy_keeps_all_packets_timestamps_and_original(tmp_path, codec, variable):
    source = tmp_path / "source.mp4"
    make_video(source, codec, variable, fragmented=True)
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    assert browser.needs_remux(source)
    output = browser.prepare(str(source))
    assert output != str(source)
    assert not browser.needs_remux(output)
    assert browser._packets(output)[:2] == browser._packets(source)[:2]
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
    stamp = os.stat(output).st_mtime_ns
    assert browser.prepare(str(source)) == output
    assert os.stat(output).st_mtime_ns == stamp
    assert browser.playback_path(str(source)) == output
    os.utime(source, ns=(source.stat().st_atime_ns, source.stat().st_mtime_ns + 1_000_000))
    assert browser.playback_path(str(source)) == str(source)


def test_submillisecond_start_is_preserved_exactly(tmp_path):
    source = tmp_path / "source.mp4"
    make_video(source, "libx265", fragmented=True)
    data = bytearray(source.read_bytes())
    # Один тик tfdt воспроизводит камеру с началом 0.0004с: шкала фильма 1/1000 его округляла.
    def shift(start, end):
        while start + 8 <= end:
            size = int.from_bytes(data[start:start+4], "big")
            kind = data[start+4:start+8]
            assert size >= 8
            if kind in (b"moof", b"traf"):
                shift(start+8, start+size)
            elif kind == b"tfdt":
                width = 8 if data[start+8] == 1 else 4
                at = start+12
                data[at:at+width] = (int.from_bytes(data[at:at+width], "big")+1).to_bytes(width, "big")
            start += size
    shift(0, len(data))
    source.write_bytes(data)
    with browser.open_video(str(source)) as container:
        stream = container.streams.video[0]
        first = next(p for p in container.demux(stream) if p.pts is not None)
        assert (first.pts * Fraction(stream.time_base) * 1000).denominator != 1
    output = browser.prepare(str(source))
    assert browser._packets(output)[:2] == browser._packets(source)[:2]


def test_initial_nonkey_packets_are_preserved(tmp_path):
    base, source = tmp_path / "base.mp4", tmp_path / "source.mp4"
    make_video(base, "libx265")
    with av.open(str(base)) as input:
        original = input.streams.video[0]
        with av.open(str(source), "w", options={"movflags": "frag_keyframe+empty_moov"}) as output:
            stream = output.add_stream(template=original)
            first = True
            for packet in input.demux(original):
                if packet.pts is None:
                    continue
                if first:
                    first = False
                    continue
                packet.stream = stream
                output.mux(packet)
    with browser.open_video(str(source)) as container:
        first = next(p for p in container.demux(video=0) if p.pts is not None)
        assert not first.is_keyframe
    result = browser.prepare(str(source))
    assert browser._packets(result)[:2] == browser._packets(source)[:2]


def test_already_indexed_file_is_used_without_copy(tmp_path):
    source = tmp_path / "source.mp4"
    make_video(source, "libx264")
    assert not browser.needs_remux(source)
    assert browser.prepare(str(source)) == str(source)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.mp4"]


def test_changed_packet_or_pts_cannot_be_published(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    make_video(source, "libx264", fragmented=True)
    packets = browser._packets
    def changed(path, heartbeat=None):
        count, digest, scale = packets(path, heartbeat)
        return count, (digest if str(path) == str(source) else "changed"), scale
    monkeypatch.setattr(browser, "_packets", changed)
    with pytest.raises(VideoError, match="изменила"):
        browser.prepare(str(source))
    assert browser.playback_path(str(source)) == str(source)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.mp4"]


def test_broken_marker_does_not_expose_partial_copy(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    Path(browser._paths(str(source))[0]).write_bytes(b"partial")
    Path(browser._paths(str(source))[1]).write_text("{broken")
    assert browser.playback_path(str(source)) == str(source)
