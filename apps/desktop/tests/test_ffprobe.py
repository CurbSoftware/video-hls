"""ffprobe.probe against a real clip (skipif ffprobe missing)."""

import shutil
import subprocess
from pathlib import Path

import pytest

from controlroom import ffprobe

pytestmark = pytest.mark.skipif(
    shutil.which("ffprobe") is None, reason="ffprobe not installed"
)


@pytest.fixture(scope="module")
def clip(tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp("media") / "clip.mp4"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=2",
            "-f", "lavfi", "-i", "sine=duration=2",
            "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
            "-shortest", str(out),
        ],
        check=True,
    )
    return out


def test_probe_real_clip(clip):
    info = ffprobe.probe(clip)
    assert info.error is None
    assert (info.width, info.height) == (320, 240)
    assert info.codec == "h264"
    assert info.fps == pytest.approx(25.0)
    assert info.has_audio is True
    assert info.duration_s == pytest.approx(2.0, abs=0.2)


def test_probe_no_audio(tmp_path):
    silent = tmp_path / "silent.mp4"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1",
            "-c:v", "libx264", "-preset", "ultrafast", str(silent),
        ],
        check=True,
    )
    info = ffprobe.probe(silent)
    assert info.error is None
    assert info.has_audio is False
    assert info.codec == "h264"


def test_probe_missing_file_never_raises(tmp_path):
    info = ffprobe.probe(tmp_path / "does-not-exist.mp4")
    assert info.error
    # a failed probe reports unknown fields as None, not a guessed False
    assert info.width is None and info.has_audio is None


def test_probe_non_media_file(tmp_path):
    junk = tmp_path / "junk.mp4"
    junk.write_bytes(b"definitely not an mp4")
    info = ffprobe.probe(junk)
    assert info.error  # reported, not raised
