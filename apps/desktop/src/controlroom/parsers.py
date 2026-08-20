"""Parse engine output: --check reports, --dry-run plans, log lines,
ffmpeg progress, and run summaries.

Every parser is anchored on the exact printf formats used by run.sh and
scripts/encode-batch.sh, never raises, and treats unparsable input as
None/RAW - a half-garbled log must still render in the GUI.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# --- run.sh --check -------------------------------------------------------
# printf '  %-10s OK   %s\n' / printf '  %-10s MISSING\n'
_RE_COMMAND = re.compile(r"^  (\S+)\s+OK\s*(\S+)$|^  (\S+)\s+MISSING\b")
_RE_FFMPEG_VER = re.compile(r"^  ffmpeg: (.+)$")
_RE_BASH_VER = re.compile(r"^  bash:\s+(.+)$")
_RE_HARDWARE = re.compile(r"^  (NVIDIA|VAAPI)\s+(.+)$")
_RE_CODEC_GROUP = re.compile(r"^  (h264|hevc|av1)$")
_RE_VIDEO_SECTION = re.compile(r"^Video encoders")
_RE_AUDIO_SECTION = re.compile(r"^Audio encoders:")
# printf '    %-22s %s\n'; status set covers both sections, routing is by
# section header ("not built" alone is ambiguous).
_RE_ENCODER_ROW = re.compile(r"^    (\S+)\s+(USABLE|not built|built, not usable here|available)$")
_RE_ACTIVE = re.compile(
    r"^  VIDEO_CODEC=(\S+)\s+AUDIO_CODEC=(\S+)\s+HWACCEL=(\S+)\s+QUALITY=(\S+)$"
)
_RE_RESOLVED_V = re.compile(r"^  resolved video encoder: (.+)$")
_RE_RESOLVED_A = re.compile(r"^  resolved audio encoder: (.+)$")
_RE_SEGMENT = re.compile(r"^  segment type:\s+(\S+)$")
_RE_PATH = re.compile(r"^  (input|output|work|archive)\s+(\S+)$")
_RE_RESULT = re.compile(r"^Result: (ready|problems found)")

# --- run.sh --dry-run -------------------------------------------------------
_RE_TOTAL = re.compile(r"^video-hls: (\d+) video\(s\) to process$")
_RE_ENCODER = re.compile(r"^  encoder:\s+(.+?)\s+\+\s+(\S+)\s+\(segments: (\w+)\)$")
_RE_LADDER = re.compile(r"^  ladder:\s+(.+)$")
_RE_OUTPUT = re.compile(r"^  output:\s+(.+)$")
_HEIGHT_SUFFIX = "  (source height: "
_RE_TIER_ENCODE = re.compile(r"^    (\S+)\s+encode -> ")
_RE_TIER_SKIP = re.compile(r"^    (\S+)\s+skip \(would upscale from (\d+)p\)$")
_RE_NO_VIDEOS = re.compile(r"^No videos found in ")

# --- log lines / progress / summaries ---------------------------------------
_RE_LOG_LINE = re.compile(
    r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] "
    r"\[(INFO|START|DONE|SKIP|ERROR|FATAL|WARN|STAGE)\] (.*)$"
)
_RE_COUNTERS = re.compile(r"\[(\d+)/(\d+)\]")
_RE_RUNSH_SUMMARY = re.compile(r"Done\. (\d+) succeeded, (\d+) failed\.")
_RE_FRAME = re.compile(r"frame=\s*(\d+)")
_RE_TIME = re.compile(r"time=(\d+):(\d{2}):(\d{2}\.\d+)")


@dataclass
class Command:
    name: str
    ok: bool
    path: str | None = None


@dataclass
class EncoderRow:
    codec: str
    encoder: str
    status: str


@dataclass
class CheckReport:
    commands: list[Command] = field(default_factory=list)
    ffmpeg_version: str | None = None
    bash_version: str | None = None
    hardware: list[tuple[str, str]] = field(default_factory=list)
    video_encoders: list[EncoderRow] = field(default_factory=list)
    audio_encoders: list[EncoderRow] = field(default_factory=list)
    active: dict = field(default_factory=dict)
    paths: dict = field(default_factory=dict)
    ready: bool = False


@dataclass
class TierPlan:
    label: str
    action: str  # "encode" | "skip"


@dataclass
class DryRunVideo:
    rel: str
    source_height: int | None
    tiers: list[TierPlan] = field(default_factory=list)


@dataclass
class DryRunReport:
    total: int = 0
    encoder: str | None = None
    audio_encoder: str | None = None
    segment_type: str | None = None
    ladder_labels: list[str] = field(default_factory=list)
    output_root: str | None = None
    videos: list[DryRunVideo] = field(default_factory=list)


@dataclass
class LogLine:
    ts: str | None
    level: str  # INFO|START|DONE|SKIP|ERROR|FATAL|WARN|STAGE|RAW
    msg: str


@dataclass
class FFProgress:
    frames: int
    seconds: float


def parse_check(text: str) -> CheckReport:
    """Parse `run.sh --check` output. Unknown lines are ignored."""
    report = CheckReport()
    codec: str | None = None
    section: str | None = None
    for line in text.splitlines():
        if m := _RE_COMMAND.match(line):
            if m.group(1):  # OK row carries a path
                report.commands.append(Command(m.group(1), True, m.group(2)))
            else:
                report.commands.append(Command(m.group(3), False))
        elif m := _RE_FFMPEG_VER.match(line):
            report.ffmpeg_version = m.group(1)
        elif m := _RE_BASH_VER.match(line):
            report.bash_version = m.group(1)
        elif m := _RE_HARDWARE.match(line):
            report.hardware.append((m.group(1), m.group(2)))
        elif m := _RE_CODEC_GROUP.match(line):
            codec = m.group(1)
        elif _RE_VIDEO_SECTION.match(line):
            section = "video"
        elif _RE_AUDIO_SECTION.match(line):
            section = "audio"
        elif m := _RE_ENCODER_ROW.match(line):
            row = EncoderRow(codec or "" if section == "video" else "audio", m.group(1), m.group(2))
            if section == "audio":
                report.audio_encoders.append(row)
            else:
                report.video_encoders.append(row)
        elif m := _RE_ACTIVE.match(line):
            report.active = {
                "VIDEO_CODEC": m.group(1),
                "AUDIO_CODEC": m.group(2),
                "HWACCEL": m.group(3),
                "QUALITY": m.group(4),
            }
        elif m := _RE_RESOLVED_V.match(line):
            report.active["video_encoder"] = m.group(1)
        elif m := _RE_RESOLVED_A.match(line):
            report.active["audio_encoder"] = m.group(1)
        elif m := _RE_SEGMENT.match(line):
            report.active["segment_type"] = m.group(1)
        elif m := _RE_PATH.match(line):
            report.paths[m.group(1)] = m.group(2)
        elif m := _RE_RESULT.match(line):
            report.ready = m.group(1) == "ready"
    return report


def parse_dryrun(text: str) -> DryRunReport:
    """Parse `run.sh --dry-run` output (also handles the no-videos case)."""
    report = DryRunReport()
    video: DryRunVideo | None = None
    for line in text.splitlines():
        if m := _RE_TOTAL.match(line):
            report.total = int(m.group(1))
        elif m := _RE_ENCODER.match(line):
            report.encoder, report.audio_encoder, report.segment_type = m.groups()
        elif m := _RE_LADDER.match(line):
            report.ladder_labels = m.group(1).split()
        elif m := _RE_OUTPUT.match(line):
            report.output_root = m.group(1)
        elif _RE_NO_VIDEOS.match(line):
            report.total = 0
        elif line.endswith(")") and _HEIGHT_SUFFIX in line:
            name, _, height = line.rpartition(_HEIGHT_SUFFIX)
            if name:
                video = DryRunVideo(
                    rel=name,
                    source_height=int(height.rstrip(")")) if height.rstrip(")").isdigit() else None,
                )
                report.videos.append(video)
        elif m := _RE_TIER_ENCODE.match(line):
            if video is not None:
                video.tiers.append(TierPlan(m.group(1), "encode"))
        elif m := _RE_TIER_SKIP.match(line):
            if video is not None:
                video.tiers.append(TierPlan(m.group(1), "skip"))
    return report


def parse_log_line(line: str) -> LogLine:
    """Classify one logical output line; anything unparsable is RAW."""
    if m := _RE_LOG_LINE.match(line):
        return LogLine(ts=m.group(1), level=m.group(2), msg=m.group(3))
    return LogLine(ts=None, level="RAW", msg=line)


def parse_counters(msg: str) -> tuple[int, int] | None:
    """Extract an [i/N] job counter from a log message, else None."""
    if m := _RE_COUNTERS.search(msg):
        return int(m.group(1)), int(m.group(2))
    return None


def parse_summary(lines: list[str]) -> dict:
    """Extract end-of-run counts from logical log lines.

    run.sh ends with "Done. N succeeded, M failed."; encode-batch ends
    with a "===="-framed INFO block carrying Total/Successful/Failed
    files. Returns {} when neither shape is present.
    """
    for line in lines:
        if m := _RE_RUNSH_SUMMARY.search(line):
            return {"engine": "runsh", "succeeded": int(m.group(1)), "failed": int(m.group(2))}

    framed = any(re.search(r"====", ln) for ln in lines)
    if framed:
        counts = {}
        for line in lines:
            if m := re.search(r"Successful files:\s+(\d+)", line):
                counts["succeeded"] = int(m.group(1))
            elif m := re.search(r"Failed files:\s+(\d+)", line):
                counts["failed"] = int(m.group(1))
            elif m := re.search(r"Total files:\s+(\d+)", line):
                counts["total"] = int(m.group(1))
        if {"succeeded", "failed", "total"} <= counts.keys():
            return {"engine": "batch", **counts}
    return {}


def parse_ffmpeg_progress(line: str) -> FFProgress | None:
    """Parse an ffmpeg -stats progress line (frame=... time=HH:MM:SS.ss)."""
    mf = _RE_FRAME.search(line)
    mt = _RE_TIME.search(line)
    if not (mf and mt):
        return None
    hours, minutes, seconds = (float(g) for g in mt.groups())
    return FFProgress(
        frames=int(mf.group(1)),
        seconds=hours * 3600 + minutes * 60 + seconds,
    )
