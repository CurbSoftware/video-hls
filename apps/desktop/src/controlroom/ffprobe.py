"""Probe media files with ffprobe, reusing run.sh's exact invocation
patterns. Never raises - failures become MediaInfo.error so a queue of
videos always renders.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path


@dataclass
class MediaInfo:
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    codec: str | None = None
    duration_s: float | None = None
    has_audio: bool | None = None
    error: str | None = None


def _run(ffprobe: str, path: Path, args: list[str], timeout: float) -> str:
    """One ffprobe call; returns stdout, raises on any failure."""
    proc = subprocess.run(
        [ffprobe, "-v", "error", *args, str(path)],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"ffprobe exited {proc.returncode}")
    return proc.stdout


def probe(path: str | Path, ffprobe: str = "ffprobe", timeout: float = 10.0) -> MediaInfo:
    """Probe one file. Video stream, audio presence and container duration
    are separate calls because that is how run.sh asks; each gets its own
    timeout so a hung probe cannot wedge the GUI."""
    path = Path(path)
    info = MediaInfo()
    try:
        # key=value output: csv would reorder fields to ffprobe's internal
        # order, so position-based parsing is wrong across versions.
        fields = dict(
            line.split("=", 1)
            for line in _run(
                ffprobe,
                path,
                [
                    "-select_streams", "v:0",
                    "-show_entries", "stream=width,height,codec_name,r_frame_rate",
                    "-of", "default=noprint_wrappers=1",
                ],
                timeout,
            ).splitlines()
            if "=" in line
        )
        if fields.get("width", "").isdigit():
            info.width = int(fields["width"])
        if fields.get("height", "").isdigit():
            info.height = int(fields["height"])
        info.codec = fields.get("codec_name") or None
        rate = fields.get("r_frame_rate", "")
        if rate and "/" in rate:
            info.fps = float(Fraction(rate))
        elif rate.replace(".", "").isdigit():
            info.fps = float(rate)
    except (subprocess.TimeoutExpired, RuntimeError, OSError, IndexError, ValueError) as exc:
        info.error = str(exc) or exc.__class__.__name__
        return info

    try:
        # run.sh's audio check: a:0 index output is non-empty iff audio exists.
        info.has_audio = bool(
            _run(
                ffprobe,
                path,
                ["-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0"],
                timeout,
            ).strip()
        )
    except (subprocess.TimeoutExpired, RuntimeError, OSError):
        info.has_audio = False

    try:
        info.duration_s = float(
            _run(
                ffprobe,
                path,
                ["-show_entries", "format=duration", "-of", "csv=p=0"],
                timeout,
            ).strip()
        )
    except (subprocess.TimeoutExpired, RuntimeError, OSError, ValueError):
        pass

    return info
