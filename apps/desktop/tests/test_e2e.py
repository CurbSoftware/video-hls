"""End-to-end: the real run.sh driven through OUR EngineRunner.

This is the CLAUDE.md verification recipe (generate a throwaway clip, run
the pipeline, inspect the published HLS tree), executed via the same code
path the GUI uses. Each pipeline config runs once per module in a
module-scoped fixture.

The ffmpeg static build on this machine segfaults when demuxing MPEG-TS,
so the default h264+aac config is verified structurally (playlists, CODECS
strings, segment alignment, archive) and the fMP4 config (av1 where the
local libaom accepts run.sh's GOP flags, hevc otherwise — see
fmp4_video_codec) carries the decode check via library.verify_package.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

import pytest

from controlroom import parsers
from controlroom.config import HELP_HEADER, RUNSH_SPECS
from controlroom.engine_paths import EnginePaths
from controlroom.envfile import write_env
from controlroom.library import parse_master, verify_package
from controlroom.runner import EngineRunner

REPO_ROOT = Path(__file__).resolve().parents[3]

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg not on PATH"
)

CLIP_NAME = "Route 66 E2E.mp4"  # spaces are deliberate: they exercise safe_name
PKG_NAME = "Route 66 E2E"  # published package dir keeps the source stem
RUN_TIMEOUT = 600  # engine-side wall clock; tests themselves are much faster


# --- shared helpers ---------------------------------------------------------


def run_engine(overrides: dict, mode: str = "run",
               env_file: Path | None = None) -> tuple[int, list[str]]:
    """Launch run.sh through the real runner; returns (exit code, lines)."""
    if env_file is None:
        # The repo's own .env (if any) must not leak into the test run.
        env_file = Path("/nonexistent/controlroom-e2e.env")
    runner = EngineRunner(EnginePaths(root=REPO_ROOT, source="bundled"),
                          env_file=env_file)
    lines: list[str] = []
    done: dict = {}
    finished = threading.Event()
    runner.launch(
        kind="runsh", mode=mode, overrides=overrides,
        on_line=lines.append,
        on_done=lambda rc: (done.__setitem__("rc", rc), finished.set()),
    )
    assert finished.wait(RUN_TIMEOUT), "engine never finished"
    return done["rc"], lines


def root_overrides(tmp: Path) -> dict:
    """The four roots plus the always-explicit run settings, into tmp."""
    return {
        "INPUT_ROOT": str(tmp / "in"),
        "HLS_ROOT": str(tmp / "hls"),
        "WORK_ROOT": str(tmp / "work"),
        "PROCESSED_ROOT": str(tmp / "done"),
        "HWACCEL": "none",
        "ARCHIVE_SOURCE": "true",
        "PARALLEL_VIDEOS": "1",
        # Speed-only knobs; nothing below asserts on their effects.
        "X264_PRESET": "veryfast",
        "AOM_CPU_USED": "8",
    }


@pytest.fixture(scope="session")
def source_clip(tmp_path_factory) -> Path:
    """One 6s 720p clip per the CLAUDE.md recipe, generated once."""
    out = tmp_path_factory.mktemp("clip") / CLIP_NAME
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-y",
         "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=6",
         "-f", "lavfi", "-i", "sine=duration=6",
         "-c:v", "libx264", "-c:a", "aac", "-shortest", str(out)],
        check=True, capture_output=True,
    )
    return out


def stage_input(base, source_clip: Path) -> Path:
    inp = base / "in"
    inp.mkdir(parents=True, exist_ok=True)
    shutil.copy(source_clip, inp / CLIP_NAME)
    return inp


# --- config A: defaults (h264+aac -> MPEG-TS) --------------------------------


@pytest.fixture(scope="module")
def run_default(source_clip, tmp_path_factory):
    """Full pipeline with default codecs; 2 ladder tiers keep it fast while
    still exercising multi-tier segment alignment."""
    tmp = tmp_path_factory.mktemp("cfg-default")
    stage_input(tmp, source_clip)
    started = time.monotonic()
    rc, lines = run_engine({**root_overrides(tmp),
                            "MAX_RESOLUTION_HEIGHT": "480"})
    print(f"[e2e config A] rc={rc} {time.monotonic() - started:.1f}s")
    return tmp, rc, lines


def test_default_run_succeeds(run_default):
    _, rc, lines = run_default
    assert rc == 0, "\n".join(lines[-30:])
    assert parsers.parse_summary(lines) == {
        "engine": "runsh", "succeeded": 1, "failed": 0}


def test_default_publishes_package(run_default):
    tmp, _, _ = run_default
    pkg = tmp / "hls" / PKG_NAME
    assert (pkg / "master.m3u8").is_file()
    assert (pkg / "package.json").is_file()
    meta = (pkg / "package.json").read_text(encoding="utf-8")
    assert '"video_codec": "h264"' in meta
    assert '"segment_type": "mpegts"' in meta
    tiers = sorted(p.name for p in pkg.iterdir() if p.is_dir())
    assert tiers == ["360p", "480p"]
    assert all((pkg / t / "index.m3u8").is_file() for t in tiers)


def test_default_master_advertises_codecs(run_default):
    # Structural verification only: this machine's ffmpeg segfaults
    # demuxing MPEG-TS, so decode-verify lives in the fMP4 config below.
    tmp, _, _ = run_default
    text = (tmp / "hls" / PKG_NAME / "master.m3u8").read_text(encoding="utf-8")
    assert "#EXT-X-VERSION:3" in text
    tiers = parse_master(text)
    assert {t.uri for t in tiers} == {"360p/index.m3u8", "480p/index.m3u8"}
    for tier in tiers:
        # CODECS is derived from the encoded files; the audio entry only
        # appears because the source actually has audio.
        assert tier.codecs.startswith("avc1.")
        assert tier.codecs.endswith(",mp4a.40.2")
        assert tier.resolution is not None


def test_default_tiers_share_segment_boundaries(run_default):
    """Identical #EXTINF sequences across tiers = GOP alignment held."""
    tmp, _, _ = run_default
    pkg = tmp / "hls" / PKG_NAME
    seqs = {}
    for tier in ("360p", "480p"):
        text = (pkg / tier / "index.m3u8").read_text(encoding="utf-8")
        seqs[tier] = re.findall(r"#EXTINF:([0-9.]+),", text)
        assert seqs[tier], f"{tier} has no #EXTINF lines"
    assert seqs["360p"] == seqs["480p"], f"tiers diverged: {seqs}"


def test_default_archives_source(run_default):
    tmp, _, _ = run_default
    assert not any((tmp / "in").iterdir()), "source must leave INPUT_ROOT"
    archived = [p.name for p in (tmp / "done").rglob("*.mp4")]
    assert archived == [CLIP_NAME]


# --- config B: fMP4 (the decode-verifiable path) -----------------------------


@pytest.fixture(scope="session")
def fmp4_video_codec() -> str:
    """av1 where the local libaom accepts run.sh's GOP flags, else hevc.

    This machine's ffmpeg 7.0.2-static bundles a libaom that rejects
    `-aom-params kf-max-dist=...` (the exact flag run.sh's build_gop_args
    emits), so av1 cannot complete here without touching the engine —
    which these tests never do. hevc+opus drives the same fMP4 path
    (version 7, init.mp4 + .m4s, opus audio) through libx265.
    """
    probe = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=0.04",
         "-c:v", "libaom-av1", "-aom-params",
         "kf-max-dist=1:kf-min-dist=1", "-frames:v", "1", "-f", "null", "-"],
        capture_output=True,
    )
    return "av1" if probe.returncode == 0 else "hevc"


@pytest.fixture(scope="module")
def run_fmp4(source_clip, fmp4_video_codec, tmp_path_factory):
    """fMP4 path, pinned to a single 360p tier so software encoding stays
    fast regardless of codec."""
    tmp = tmp_path_factory.mktemp("cfg-fmp4")
    stage_input(tmp, source_clip)
    started = time.monotonic()
    rc, lines = run_engine({
        **root_overrides(tmp),
        "VIDEO_CODEC": fmp4_video_codec, "AUDIO_CODEC": "opus",
        "MAX_RESOLUTION_HEIGHT": "360", "MIN_RESOLUTION_HEIGHT": "360",
    })
    print(f"[e2e config B] codec={fmp4_video_codec} rc={rc} "
          f"{time.monotonic() - started:.1f}s")
    return tmp, rc, lines


def test_fmp4_run_succeeds(run_fmp4):
    _, rc, lines = run_fmp4
    assert rc == 0, "\n".join(lines[-30:])
    assert parsers.parse_summary(lines) == {
        "engine": "runsh", "succeeded": 1, "failed": 0}


def test_fmp4_layout(run_fmp4, fmp4_video_codec):
    tmp, _, _ = run_fmp4
    pkg = tmp / "hls" / PKG_NAME
    master = (pkg / "master.m3u8").read_text(encoding="utf-8")
    assert "#EXT-X-VERSION:7" in master  # fMP4 forces version 7
    tier = pkg / "360p"
    assert (tier / "init.mp4").is_file()
    assert sorted(tier.glob("*.m4s")), "no fMP4 segments"
    assert (pkg / "package.json").is_file()
    meta = (pkg / "package.json").read_text(encoding="utf-8")
    assert '"segment_type": "fmp4"' in meta
    assert '"video_codec": "%s"' % fmp4_video_codec in meta
    assert '"audio_codec": "opus"' in meta


def test_fmp4_package_decodes(run_fmp4):
    """Decode check through OUR verify module (ffmpeg exit status only)."""
    tmp, _, _ = run_fmp4
    result = verify_package(tmp / "hls" / PKG_NAME / "master.m3u8")
    assert result.ok, (result.exit_code, result.stderr_tail)


# --- dry-run -----------------------------------------------------------------


def test_dryrun_plan_matches_real_files(source_clip, tmp_path):
    stage_input(tmp_path, source_clip)
    rc, lines = run_engine({**root_overrides(tmp_path)}, mode="dry-run")
    assert rc == 0, "\n".join(lines[-30:])
    report = parsers.parse_dryrun("\n".join(lines))
    assert report.total == 1
    assert report.output_root == str(tmp_path / "hls")
    assert [(v.rel, v.source_height) for v in report.videos] == [(CLIP_NAME, 720)]
    tiers = report.videos[0].tiers
    # Default window (360..1080) against a 720p source: 1080p would upscale.
    assert [(t.label, t.action) for t in tiers] == [
        ("360p", "encode"), ("480p", "encode"), ("720p", "encode"),
        ("1080p", "skip"),
    ]
    # Nothing was encoded, published or moved: dry-run only plans.
    assert not list((tmp_path / "hls").rglob("master.m3u8"))
    assert (tmp_path / "in" / CLIP_NAME).is_file()


# --- env precedence: environment > .env > defaults ----------------------------


def test_environment_beats_envfile(source_clip, tmp_path):
    """The full precedence chain, driven the way the GUI drives it:
    ENV_FILE points at a managed .env that says hevc; an environment
    override says av1. The resolved encoder line proves who won."""
    stage_input(tmp_path, source_clip)
    env_file = tmp_path / ".env"
    write_env(env_file, {"VIDEO_CODEC": "hevc"}, RUNSH_SPECS,
              REPO_ROOT, HELP_HEADER)
    assert 'VIDEO_CODEC="${VIDEO_CODEC:-hevc}"' in env_file.read_text()

    base = {**root_overrides(tmp_path)}

    # 1. No env override: the .env value reaches the engine (hevc -> libx265).
    rc, lines = run_engine(base, mode="dry-run", env_file=env_file)
    assert rc == 0, "\n".join(lines[-30:])
    report = parsers.parse_dryrun("\n".join(lines))
    assert report.encoder == "libx265", "managed .env was not honoured"

    # 2. Env override: av1 wins over the .env's hevc.
    rc, lines = run_engine({**base, "VIDEO_CODEC": "av1"},
                           mode="dry-run", env_file=env_file)
    assert rc == 0, "\n".join(lines[-30:])
    report = parsers.parse_dryrun("\n".join(lines))
    assert report.encoder in {"libsvtav1", "libaom-av1"}, report.encoder
