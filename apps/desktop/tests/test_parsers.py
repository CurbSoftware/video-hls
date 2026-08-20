"""Replay recorded engine output through the parsers."""

import re
from pathlib import Path

from controlroom import parsers

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def logical_lines(text: str) -> list[str]:
    """Split the way EngineRunner's reader thread does: on \\r AND \\n."""
    return [ln for ln in re.split(r"\r\n|\r|\n", text) if ln]


# --- parse_check -----------------------------------------------------------


def test_check_ok_fixture():
    report = parsers.parse_check(fixture("check_ok.txt"))
    assert report.ready is True
    assert [c.name for c in report.commands] == ["ffmpeg", "ffprobe", "python3"]
    assert all(c.ok and c.path for c in report.commands)
    assert report.ffmpeg_version.startswith("ffmpeg version 7.0.2")
    assert report.bash_version.startswith("5.2")
    assert ("NVIDIA", "not detected (no nvidia-smi)") in report.hardware
    assert ("VAAPI", "/dev/dri/renderD128 present") in report.hardware
    assert report.active == {
        "VIDEO_CODEC": "h264",
        "AUDIO_CODEC": "aac",
        "HWACCEL": "auto",
        "QUALITY": "28",
        "video_encoder": "libx264",
        "audio_encoder": "aac",
        "segment_type": "mpegts",
    }
    assert report.paths["output"] == "/home/you/projects/video-hls/hls"
    assert report.paths["archive"] == "/home/you/projects/video-hls/video-done"
    by_name = {row.encoder: row for row in report.video_encoders}
    assert by_name["libx264"].status == "USABLE"
    assert by_name["libx264"].codec == "h264"
    assert by_name["libaom-av1"].codec == "av1"
    assert by_name["h264_nvenc"].status == "not built"
    audio = {row.encoder: row for row in report.audio_encoders}
    assert audio["aac"].status == "available"
    assert audio["libopus"].codec == "audio"


def test_check_hwaccel_none_variant():
    report = parsers.parse_check(fixture("check_hwnone.txt"))
    assert report.ready is True
    assert report.active["HWACCEL"] == "none"
    assert report.active["video_encoder"] == "libx264"


def test_check_av1_opus_variant():
    report = parsers.parse_check(fixture("check_av1opus.txt"))
    assert report.active["VIDEO_CODEC"] == "av1"
    assert report.active["audio_encoder"] == "libopus"
    assert report.active["segment_type"] == "fmp4"


def test_check_synthetic_edges():
    text = (
        "video-hls system check\n"
        "======================\n"
        "Required commands:\n"
        "  ffmpeg     OK   /usr/bin/ffmpeg\n"
        "  python3    MISSING\n"
        "\n"
        "Video encoders (compiled in / actually usable):\n"
        "  h264\n"
        "    h264_vaapi            built, not usable here\n"
        "\n"
        "Audio encoders:\n"
        "    libopus               not built\n"
        "\n"
        "Result: problems found (see above).\n"
        "some future unknown line the parser has never seen\n"
    )
    report = parsers.parse_check(text)
    assert report.ready is False
    ffmpeg_ok = next(c for c in report.commands if c.name == "ffmpeg")
    py = next(c for c in report.commands if c.name == "python3")
    assert ffmpeg_ok.ok and py is not None and py.ok is False and py.path is None
    assert report.video_encoders[0].status == "built, not usable here"
    # "not built" under the Audio section must land in audio_encoders,
    # not be mistaken for a video encoder row.
    assert report.audio_encoders == [
        parsers.EncoderRow("audio", "libopus", "not built")
    ]
    assert report.video_encoders == [
        parsers.EncoderRow("h264", "h264_vaapi", "built, not usable here")
    ]


def test_check_garbage_never_raises():
    assert parsers.parse_check("").ready is False
    assert parsers.parse_check("\x00\xff random \x1b[31m noise").commands == []


# --- parse_dryrun ----------------------------------------------------------


def test_dryrun_fixture():
    report = parsers.parse_dryrun(fixture("dryrun.txt"))
    assert report.total == 1
    assert report.encoder == "libx264"
    assert report.audio_encoder == "aac"
    assert report.segment_type == "mpegts"
    assert report.ladder_labels == ["360p", "480p", "720p", "1080p"]
    assert report.output_root == "/home/you/projects/video-hls/hls"
    (video,) = report.videos
    assert video.rel == "Route 66 Demo.mp4"
    assert video.source_height == 720
    assert [(t.label, t.action) for t in video.tiers] == [
        ("360p", "encode"),
        ("480p", "encode"),
        ("720p", "encode"),
        ("1080p", "skip"),
    ]


def test_dryrun_empty():
    report = parsers.parse_dryrun(fixture("dryrun_empty.txt"))
    assert report.total == 0
    assert report.videos == []


def test_dryrun_unknown_height_and_nested_names():
    text = (
        "video-hls: 2 video(s) to process\n"
        "  encoder:  libsvtav1 + libopus  (segments: fmp4)\n"
        "  ladder:   360p 720p \n"
        "  output:   /srv/hls\n"
        "\n"
        "Dry run - nothing will be encoded.\n"
        "\n"
        "My Folder/PressedMail Demo.mp4  (source height: unknown)\n"
        "    360p   encode -> 360p/index.m3u8\n"
        "Clip 2.mp4  (source height: 480)\n"
        "    720p   skip (would upscale from 480p)\n"
    )
    report = parsers.parse_dryrun(text)
    assert report.total == 2
    assert report.segment_type == "fmp4"
    first, second = report.videos
    assert first.rel == "My Folder/PressedMail Demo.mp4"
    assert first.source_height is None
    assert first.tiers == [parsers.TierPlan("360p", "encode")]
    assert second.source_height == 480
    assert second.tiers == [parsers.TierPlan("720p", "skip")]


# --- log lines, counters, progress ----------------------------------------


def test_parse_log_line():
    line = parsers.parse_log_line("[2026-08-15 20:55:30] [INFO] [1/1] Processing: X (1920x1080)")
    assert line.ts == "2026-08-15 20:55:30"
    assert line.level == "INFO"
    assert line.msg == "[1/1] Processing: X (1920x1080)"
    raw = parsers.parse_log_line("frame=   12 fps=0.0 q=35.0 size=0kB time=00:00:00.48")
    assert raw == parsers.LogLine(None, "RAW", "frame=   12 fps=0.0 q=35.0 size=0kB time=00:00:00.48")


def test_parse_log_line_all_levels():
    for level in ("INFO", "START", "DONE", "SKIP", "ERROR", "FATAL", "WARN", "STAGE"):
        parsed = parsers.parse_log_line(f"[2026-08-18 10:00:00] [{level}] msg")
        assert parsed.level == level


def test_parse_counters():
    assert parsers.parse_counters("[2/5] Encoding from staged file: X") == (2, 5)
    assert parsers.parse_counters("no counters here") is None


def test_batch_flow_fixture():
    lines = [parsers.parse_log_line(ln) for ln in logical_lines(fixture("batch_flow.txt"))]
    levels = {ln.level for ln in lines}
    assert {"INFO", "STAGE", "START", "WARN", "ERROR", "DONE"} <= levels
    stage = next(ln for ln in lines if ln.level == "STAGE")
    assert parsers.parse_counters(stage.msg) == (1, 2)
    warn = next(ln for ln in lines if ln.level == "WARN")
    assert "Retrying once" in warn.msg


def test_parse_summary_runsh():
    lines = ["", "Done. 3 succeeded, 1 failed.", "HLS output:   /srv/hls"]
    assert parsers.parse_summary(lines) == {"engine": "runsh", "succeeded": 3, "failed": 1}


def test_parse_summary_batch_from_fixture():
    lines = logical_lines(fixture("batch_flow.txt"))
    assert parsers.parse_summary(lines) == {
        "engine": "batch",
        "total": 2,
        "succeeded": 1,
        "failed": 1,
    }


def test_parse_summary_nothing():
    assert parsers.parse_summary(["random output"]) == {}
    assert parsers.parse_summary([]) == {}


def test_parse_ffmpeg_progress():
    progress = parsers.parse_ffmpeg_progress(
        "frame=  150 fps= 30 q=35.0 size=    2048kB time=00:00:06.00 bitrate=2796.2kbits/s speed=1.19x    "
    )
    assert progress == parsers.FFProgress(frames=150, seconds=6.0)
    long = parsers.parse_ffmpeg_progress("frame= 1234 q=35.0 time=00:01:40.50 bitrate=1kbits/s")
    assert long.frames == 1234
    assert long.seconds == 100.5


def test_parse_ffmpeg_progress_rejects_non_progress():
    assert parsers.parse_ffmpeg_progress("[2026-08-18 10:00:10] [START] [1/2] job") is None
    assert parsers.parse_ffmpeg_progress("time=00:00:06.00 without frame") is None
    assert parsers.parse_ffmpeg_progress("") is None
