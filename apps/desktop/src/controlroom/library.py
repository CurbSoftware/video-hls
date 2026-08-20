"""The output side of the pipeline: scan published HLS packages,
parse master playlists, verify packages decode, and measure disk usage.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

# #EXT-X-STREAM-INF:BANDWIDTH=7500000,AVERAGE-BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028"
_RE_STREAM_INF = re.compile(r"^#EXT-X-STREAM-INF:(.*)$")
_RE_ATTR = re.compile(r'([A-Z-]+)=("[^"]*"|[^,]*)')


@dataclass
class Tier:
    uri: str
    bandwidth: int | str
    avg_bandwidth: int | str
    resolution: str | None
    codecs: str | None


@dataclass
class Package:
    name: str
    path: Path
    meta: dict = field(default_factory=dict)
    tiers: list[Tier] = field(default_factory=list)
    master: Path | None = None
    mtime: float = 0.0
    error: str | None = None


@dataclass
class VerifyResult:
    ok: bool
    exit_code: int | None
    stderr_tail: str
    duration_s: float


def parse_master(text: str) -> list[Tier]:
    """Pair each #EXT-X-STREAM-INF with the next non-comment line (URI)."""
    tiers: list[Tier] = []
    attrs: dict[str, str] | None = None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if m := _RE_STREAM_INF.match(line):
            attrs = {
                key: value.strip('"')
                for key, value in _RE_ATTR.findall(m.group(1))
            }
            continue
        if line.startswith("#"):
            continue
        if attrs is not None:
            tiers.append(
                Tier(
                    uri=line,
                    bandwidth=_maybe_int(attrs.get("BANDWIDTH")),
                    avg_bandwidth=_maybe_int(attrs.get("AVERAGE-BANDWIDTH")),
                    resolution=attrs.get("RESOLUTION"),
                    codecs=attrs.get("CODECS"),
                )
            )
            attrs = None
    return tiers


def _maybe_int(value: str | None) -> int | str | None:
    if value is None:
        return None
    return int(value) if value.isdigit() else value


def scan_library(hls_root: str | Path) -> list[Package]:
    """Every directory under hls_root containing package.json becomes a
    Package. Corrupt metadata or a missing/broken master yields tiers=[]
    plus an error string - scanning never raises."""
    root = Path(hls_root)
    packages: list[Package] = []
    try:
        manifests = sorted(root.rglob("package.json"))
    except OSError:
        return []
    for manifest in manifests:
        directory = manifest.parent
        pkg = Package(name=directory.name, path=directory, master=directory / "master.m3u8")
        try:
            pkg.mtime = manifest.stat().st_mtime
        except OSError:
            pass
        try:
            pkg.meta = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            pkg.meta = {}
            pkg.error = f"package.json unreadable: {exc}"
            packages.append(pkg)
            continue
        if not pkg.master.is_file():
            pkg.error = "master.m3u8 missing"
        else:
            try:
                pkg.tiers = parse_master(pkg.master.read_text(encoding="utf-8"))
            except OSError as exc:
                pkg.error = f"master.m3u8 unreadable: {exc}"
            if not pkg.error and not pkg.tiers:
                pkg.error = "master.m3u8 has no variants"
        packages.append(pkg)
    return packages


def archive_list(processed_root: str | Path) -> list[Path]:
    """Archived source files (recursive, sorted)."""
    root = Path(processed_root)
    if not root.is_dir():
        return []
    return sorted(p for p in root.rglob("*") if p.is_file())


def verify_package(master: str | Path, ffmpeg: str = "ffmpeg", timeout: float = 300.0) -> VerifyResult:
    """Decode-test a package end to end.

    Asserts on EXIT STATUS ONLY: MPEG-TS probing legitimately emits a
    benign "non-existing SPS 0 referenced in buffering period" warning,
    so stderr content must never fail a verify (see CLAUDE.md).
    """
    master = Path(master)
    started = time.monotonic()
    try:
        proc = subprocess.run(
            [ffmpeg, "-v", "fatal", "-allowed_extensions", "ALL", "-i", str(master), "-f", "null", "-"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return VerifyResult(
            ok=proc.returncode == 0,
            exit_code=proc.returncode,
            stderr_tail=proc.stderr[-2000:],
            duration_s=time.monotonic() - started,
        )
    except subprocess.TimeoutExpired:
        return VerifyResult(False, None, f"timeout after {timeout}s", time.monotonic() - started)
    except OSError as exc:
        return VerifyResult(False, None, str(exc), time.monotonic() - started)


def disk_usage(roots: dict[str, Path]) -> dict[str, dict]:
    """Per-root filesystem usage plus the size of the tree itself.

    GB is decimal (1e9 bytes), matching how disk vendors and df -h report.
    A missing root yields {"error": ...} rather than raising.
    """
    result: dict[str, dict] = {}
    for label, raw in roots.items():
        root = Path(raw)
        if not root.exists():
            result[label] = {"error": f"not found: {root}"}
            continue
        usage = shutil.disk_usage(root)
        tree_bytes = 0
        try:
            for path in root.rglob("*"):
                if path.is_file():
                    tree_bytes += path.stat().st_size
        except OSError:
            pass  # files vanishing mid-walk are not worth aborting for
        result[label] = {
            "free_gb": round(usage.free / 1e9, 2),
            "used_gb": round(usage.used / 1e9, 2),
            "total_gb": round(usage.total / 1e9, 2),
            "tree_bytes": tree_bytes,
        }
    return result
