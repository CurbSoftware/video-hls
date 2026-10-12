"""Wizard helpers: which files can become HLS, and a symlink staging dir.

run.sh still does the encode. The GUI points INPUT_ROOT at a directory of
symlinks named for the output folder, so originals are not copied or moved.
"""

from __future__ import annotations

import re
import shutil
import uuid
from pathlib import Path

from . import config, ffprobe

# Same allowlist as run.sh VIDEO_EXTENSIONS_REGEX. A caller may pass the
# engine's current regex; this is the fallback when that string is bad.
DEFAULT_EXT_RE = re.compile(
    r".*\.(mp4|mov|mkv|avi|webm|m4v|mpg|mpeg|ts|m2ts|flv|wmv)$",
    re.IGNORECASE,
)

_NAME_BAD = re.compile(r"[/\\\x00]")


def builtin_ladder() -> list[dict]:
    """The engine's built-in tiers, in ladder order. One source of truth."""
    rows, _errors = config.parse_ladder(config.DEFAULT_LADDER)
    return [
        {
            "label": r.label,
            "height": r.height,
            "width": r.width,
            "video_bitrate": r.video_bitrate,
            "maxrate": r.maxrate,
            "bufsize": r.bufsize,
            "audio_bitrate": r.audio_bitrate,
        }
        for r in rows
    ]


def compile_ext_re(pattern: str | None) -> re.Pattern:
    if not pattern:
        return DEFAULT_EXT_RE
    try:
        return re.compile(pattern, re.IGNORECASE)
    except re.error:
        return DEFAULT_EXT_RE


def extension_ok(path: Path, pattern: re.Pattern) -> bool:
    return pattern.fullmatch(path.as_posix()) is not None or (
        pattern.fullmatch(str(path)) is not None
    )


def classify(extension_allowed: bool, info: dict) -> tuple[bool, str | None]:
    """A file is convertible when the extension is allowed and ffprobe saw
    a video stream (width, height, codec) with no probe error."""
    if not extension_allowed:
        return False, "Not a video file this converter can read."
    if info.get("error"):
        return False, "Could not read the file."
    if info.get("width") and info.get("height") and info.get("codec"):
        return True, None
    if info.get("has_audio"):
        return False, "Audio only, no video stream."
    return False, "Not a video file this converter can read."


def name_error(name: str) -> str | None:
    """Reject names that would escape the output directory or collide with
    the engine's own safety check (empty, `.`, `..`, a slash)."""
    if not isinstance(name, str) or name.strip() == "" or name != name.strip():
        return "Folder name is empty."
    if name in {".", ".."}:
        return "Folder name is not allowed."
    if _NAME_BAD.search(name):
        return "Folder names cannot contain slashes."
    return None


def _files_under(root: Path) -> list[Path]:
    found: list[Path] = []
    for path in sorted(root.rglob("*")):
        # is_file() follows a symlink and is true when the target is a file.
        # Directory links are not descended into (rglob does not follow them).
        if path.is_file():
            found.append(path)
    return found


def probe_path(path: str | Path, ffprobe_exe: str = "ffprobe",
               ext_pattern: str | None = None) -> dict:
    """Probe one file or every allowed video under a directory.

    Directory scans skip files whose extension the engine would ignore.
    A single picked file is always returned, so a wrong type is visible.
    """
    pattern = compile_ext_re(ext_pattern)
    root = Path(path).expanduser()
    if not root.exists():
        return {"root": str(root), "items": [], "error": "not found"}

    single = root.is_file()
    files = [root] if single else _files_under(root)
    base = root.parent if single else root
    items = []
    for src in files:
        allowed = extension_ok(src, pattern)
        if not single and not allowed:
            continue
        try:
            rel = str(src.relative_to(base))
        except ValueError:
            rel = src.name
        try:
            size = src.stat().st_size
        except OSError:
            size = 0
        info = ffprobe.probe(src, ffprobe=ffprobe_exe) if allowed else None
        payload = {
            "rel": rel,
            "abs": str(src),
            "size_bytes": size,
            "width": None,
            "height": None,
            "fps": None,
            "codec": None,
            "duration_s": None,
            "has_audio": None,
            "error": None,
        }
        if info is not None:
            payload.update({
                "width": info.width,
                "height": info.height,
                "fps": info.fps,
                "codec": info.codec,
                "duration_s": info.duration_s,
                "has_audio": info.has_audio,
                "error": info.error,
            })
        ok, reason = classify(allowed, payload)
        payload["convertible"] = ok
        payload["reason"] = reason
        items.append(payload)
    return {"root": str(base if single else root), "items": items, "error": None}


def existing_packages(output_dir: Path, names: list[str]) -> list[str]:
    """Output folder names that already exist and would be replaced."""
    if not output_dir.is_dir():
        return []
    found = []
    for name in names:
        if name and (output_dir / name).exists():
            found.append(name)
    return found


def _symlink(dest: Path, src: Path) -> None:
    dest.symlink_to(src.resolve())


def stage_job(work_root: Path, items: list[dict], link=None) -> dict:
    """Symlink each chosen file into work_root/jobs/<id>/in/<name><ext>.

    `items` is `[{src, name}]`. The link name is the package folder. The
    target is the real file. `link(dest, src)` creates the symlink; the
    default is a host symlink. Returns the staging directory as `input_root`.
    """
    link = link or _symlink
    if not isinstance(items, list) or not items:
        return {"ok": False, "error": "Choose at least one video.", "input_root": None}

    errors: list[str] = []
    seen: dict[str, str] = {}
    planned: list[tuple[Path, str, str]] = []
    for raw in items:
        if not isinstance(raw, dict):
            errors.append("Each video needs a source and a folder name.")
            continue
        src = Path(str(raw.get("src") or "")).expanduser()
        name = str(raw.get("name") or "")
        bad = name_error(name)
        if bad:
            errors.append(f"{src.name or 'video'}: {bad}")
            continue
        if name in seen:
            errors.append(f"'{name}' is used by more than one video.")
            continue
        seen[name] = str(src)
        if not src.is_file():
            errors.append(f"Missing source: {src}")
            continue
        ext = src.suffix or ".mp4"
        planned.append((src, name, ext))

    if errors:
        return {"ok": False, "error": " ".join(errors), "input_root": None}

    work_root = Path(work_root).expanduser()
    job = uuid.uuid4().hex[:12]
    staging = work_root / "jobs" / job / "in"
    try:
        # The default work tree (~/Videos/curbstream) may not exist yet.
        work_root.mkdir(parents=True, exist_ok=True)
        staging.mkdir(parents=True, exist_ok=False)
        for src, name, ext in planned:
            dest = staging / f"{name}{ext}"
            link(dest, src)
    except OSError as exc:
        shutil.rmtree(staging.parent, ignore_errors=True)
        return {"ok": False, "error": f"Could not stage the videos: {exc}",
                "input_root": None}
    return {"ok": True, "error": None, "input_root": str(staging)}


def clear_job(work_root: Path, input_root: str) -> dict:
    """Delete one staged job directory. Refuses any path outside work/jobs."""
    try:
        jobs = (work_root / "jobs").resolve()
        path = Path(input_root).expanduser().resolve()
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    if path.name != "in" or path.parent.parent != jobs:
        return {"ok": False, "error": "Refusing to delete outside a job."}
    if path.parent.is_dir():
        shutil.rmtree(path.parent)
    return {"ok": True, "error": None}
