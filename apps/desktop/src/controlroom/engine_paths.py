"""Locate the engine (run.sh + scripts/encode-batch.sh) and describe it.

The engine is either the copy bundled with the app (repo checkout in dev,
share/ tree in a frozen build) or a user-selected external checkout.
"""

from __future__ import annotations

import hashlib
import sys
from dataclasses import dataclass
from pathlib import Path

_MANIFEST_NAME = "ENGINE_MANIFEST"


@dataclass
class EnginePaths:
    """Paths into one engine checkout."""

    root: Path
    source: str  # "bundled" | "external"

    @property
    def run_sh(self) -> Path:
        return self.root / "run.sh"

    @property
    def encode_batch(self) -> Path:
        return self.root / "scripts" / "encode-batch.sh"

    @property
    def env_example(self) -> Path:
        return self.root / ".env.example"


def locate_engine(app_settings: dict) -> tuple[EnginePaths | None, str | None]:
    """Resolve the engine to use.

    app_settings["engine_path"] wins when it points at a directory
    containing run.sh. Otherwise fall back to the bundled copy. Returns
    (paths, None) on success or (None, reason) on failure - never raises.
    """
    custom = app_settings.get("engine_path")
    if custom:
        root = Path(str(custom)).expanduser().resolve()
        if not (root / "run.sh").is_file():
            return None, f"engine_path has no run.sh: {root}"
        return EnginePaths(root=root, source="external"), None

    if getattr(sys, "frozen", False):  # PyInstaller bundle
        root = Path(sys.prefix).parent / "share" / "videohls-controlroom" / "engine"
        if (root / "run.sh").is_file():
            return EnginePaths(root=root, source="bundled"), None
        return None, f"bundled engine not found at {root}"

    # Dev checkout: walk up from this file until a directory holding
    # run.sh appears (src/controlroom/ -> apps/desktop -> repo root).
    for parent in Path(__file__).resolve().parents:
        if (parent / "run.sh").is_file():
            return EnginePaths(root=parent, source="bundled"), None
    return None, "bundled engine not found above the package (no run.sh)"


def engine_version(engine: EnginePaths) -> str:
    """Best-effort engine version string, never raises.

    Prefers an ENGINE_MANIFEST file next to run.sh (first line verbatim);
    otherwise identifies the script by content hash + mtime date.
    """
    manifest = engine.root / _MANIFEST_NAME
    try:
        if manifest.is_file():
            first = manifest.read_text(encoding="utf-8", errors="replace").splitlines()
            if first and first[0].strip():
                return first[0].strip()
    except OSError:
        pass

    try:
        digest = hashlib.sha256(engine.run_sh.read_bytes()).hexdigest()[:8]
        mtime = engine.run_sh.stat().st_mtime
        from datetime import datetime

        return f"sha256-{digest} {datetime.fromtimestamp(mtime).date().isoformat()}"
    except OSError as exc:
        return f"unknown ({exc})"
