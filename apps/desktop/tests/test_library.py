"""Library scanning, master-playlist parsing, package verify, disk usage."""

import shutil
import subprocess
from pathlib import Path

import pytest

from controlroom import library

LIBDIR = Path(__file__).resolve().parent / "library"
pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg not installed"
)


# --- master playlist parsing ------------------------------------------------


def test_parse_master_fixture():
    tiers = library.parse_master((LIBDIR / "master_fixture.txt").read_text())
    assert [t.uri for t in tiers] == ["360p/index.m3u8", "480p/index.m3u8", "720p/index.m3u8", "1080p/index.m3u8"]
    top = tiers[-1]
    assert top.bandwidth == 7500000
    assert top.avg_bandwidth == 5000000
    assert top.resolution == "1920x1080"
    assert top.codecs == "avc1.4D4028"
    assert tiers[0].resolution == "640x360"


def test_parse_master_quoted_and_odd_attrs():
    text = (
        "#EXTM3U\n"
        '#EXT-X-STREAM-INF:BANDWIDTH="1200",AVERAGE-BANDWIDTH=800,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"\n'
        "360p/index.m3u8\n"
    )
    (tier,) = library.parse_master(text)
    assert tier.bandwidth == 1200
    assert tier.codecs == "avc1.4d401e,mp4a.40.2"


def test_parse_master_degenerate():
    assert library.parse_master("") == []
    assert library.parse_master("#EXTM3U\n#EXT-X-VERSION:3\n") == []
    # STREAM-INF with no URI after it is dropped, not crashed on.
    assert library.parse_master("#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-ENDLIST\n") == []


# --- scan_library --------------------------------------------------------------


def test_scan_library_real_shaped_package(tmp_path):
    pkg_dir = tmp_path / "hls" / "PressedMail Demo"
    pkg_dir.mkdir(parents=True)
    shutil.copy(LIBDIR / "package_fixture.json", pkg_dir / "package.json")
    shutil.copy(LIBDIR / "master_fixture.txt", pkg_dir / "master.m3u8")

    (pkg,) = library.scan_library(tmp_path / "hls")
    assert pkg.name == "PressedMail Demo"
    assert pkg.meta["source"] == "PressedMail Demo.mp4"
    assert pkg.meta["video_encoder"] == "h264_nvenc"
    assert pkg.error is None
    assert len(pkg.tiers) == 4
    assert pkg.mtime > 0


def test_scan_library_nested_and_broken(tmp_path):
    root = tmp_path / "hls"
    good = root / "sub" / "clip"
    good.mkdir(parents=True)
    shutil.copy(LIBDIR / "package_fixture.json", good / "package.json")
    shutil.copy(LIBDIR / "master_fixture.txt", good / "master.m3u8")

    no_master = root / "half"
    no_master.mkdir()
    shutil.copy(LIBDIR / "package_fixture.json", no_master / "package.json")

    bad_meta = root / "corrupt"
    bad_meta.mkdir()
    (bad_meta / "package.json").write_text("{not json")

    plain_dir = root / "not-a-package"
    plain_dir.mkdir()  # no package.json -> invisible

    packages = library.scan_library(root)
    assert [p.name for p in packages] == ["corrupt", "half", "clip"]
    by_name = {p.name: p for p in packages}
    assert by_name["clip"].error is None and len(by_name["clip"].tiers) == 4
    assert by_name["half"].tiers == [] and "master.m3u8 missing" in by_name["half"].error
    assert by_name["corrupt"].meta == {} and "unreadable" in by_name["corrupt"].error


def test_scan_library_missing_root():
    assert library.scan_library("/nonexistent/nowhere") == []


# --- archive_list ----------------------------------------------------------------


def test_archive_list_recursive_sorted(tmp_path):
    root = tmp_path / "done"
    (root / "b" / "deep").mkdir(parents=True)
    (root / "a").mkdir()
    for rel in ("b/deep/x.mp4", "a/A Clip.mp4", "top.mov", "b/note.txt"):
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x")
    expected = sorted([root / "a/A Clip.mp4", root / "b/deep/x.mp4", root / "b/note.txt", root / "top.mov"])
    assert library.archive_list(root) == expected
    assert library.archive_list(tmp_path / "missing") == []


# --- verify_package ----------------------------------------------------------------


def _make_hls_package(out_dir: Path) -> Path:
    """One-tier fMP4 package in run.sh's on-disk shape (the av1/opus
    packaging path), via the real muxer. fMP4 rather than TS: the static
    ffmpeg build on this CI machine segfaults in the MPEG-TS *demuxer*,
    so TS packages cannot be decode-verified here at all."""
    src = out_dir / "src.mp4"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=4",
            "-f", "lavfi", "-i", "sine=duration=4",
            "-c:v", "libx264", "-preset", "ultrafast", "-g", "20",
            "-c:a", "aac", "-shortest", str(src),
        ],
        check=True,
    )
    variant = out_dir / "360p"
    variant.mkdir()
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
            "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
            "-hls_time", "2", "-hls_playlist_type", "vod",
            "-hls_flags", "independent_segments",
            "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
            "-hls_segment_filename", str(variant / "seg_%06d.m4s"),
            str(variant / "index.m3u8"),
        ],
        check=True,
    )
    master = out_dir / "master.m3u8"
    master.write_text(
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n"
        '#EXT-X-STREAM-INF:BANDWIDTH=1200000,AVERAGE-BANDWIDTH=800000,RESOLUTION=320x240,CODECS="avc1.4d401e,mp4a.40.2"\n'
        "360p/index.m3u8\n"
    )
    return master


def test_verify_package_ok(tmp_path):
    master = _make_hls_package(tmp_path)
    result = library.verify_package(master)
    assert result.ok, result.stderr_tail
    assert result.exit_code == 0
    assert result.duration_s > 0


def test_verify_package_bad_master(tmp_path):
    result = library.verify_package(tmp_path / "nope.m3u8")
    assert result.ok is False
    assert result.exit_code != 0


# --- disk_usage ----------------------------------------------------------------------


def test_disk_usage(tmp_path):
    (tmp_path / "media").mkdir()
    (tmp_path / "media" / "big.bin").write_bytes(b"\0" * 5000)
    usage = library.disk_usage({"input": tmp_path / "media", "missing": tmp_path / "nope"})
    assert set(usage["input"]) == {"free_gb", "used_gb", "total_gb", "tree_bytes"}
    assert usage["input"]["tree_bytes"] == 5000
    assert 0 < usage["input"]["free_gb"] < usage["input"]["total_gb"]
    assert "error" in usage["missing"]
