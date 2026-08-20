"""Run the bash engines (run.sh / scripts/encode-batch.sh) as child processes.

One engine process at a time, period: run.sh has no lockfile, so the GUI
enforces single-flight via EngineBusy. All output is merged into one stream
and delivered line-by-line on a reader thread, so CR-terminated ffmpeg
progress lines (encode-batch pipes -stats through tee) arrive as one
callback per logical line.
"""

from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .engine_paths import EnginePaths

# ffmpeg -stats and friends paint with CSI sequences; strip them so the
# GUI sees plain text.
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")

_MODE_ARGS = {
    "check": ["--check"],
    "dry-run": ["--dry-run"],
    "run": [],
}

_TOOLS = ("ffmpeg", "ffprobe", "python3")


class EngineBusy(RuntimeError):
    """An engine process is already running (run.sh has no lockfile)."""


@dataclass
class RunHandle:
    """A launched engine process."""

    kind: str  # "runsh" | "batch"
    pid: int
    started: datetime = field(default_factory=datetime.now)
    overrides: dict = field(default_factory=dict)


class EngineRunner:
    """Single-flight launcher for the bash engines."""

    def __init__(self, engine: EnginePaths, env_file: Path | None = None):
        self.engine = engine
        self.env_file = env_file
        self._proc: subprocess.Popen | None = None
        self.handle: RunHandle | None = None

    # -- state -----------------------------------------------------------

    def is_busy(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def tools_ok(self, ffmpeg_dir: str | os.PathLike | None = None) -> dict[str, str | None]:
        """Locate required tools; returns name -> resolved path (None = missing).

        ffmpeg_dir, when given, is prepended to PATH so a bundled ffmpeg
        wins over whatever happens to be installed.
        """
        env_path = None
        if ffmpeg_dir:
            env_path = str(ffmpeg_dir) + os.pathsep + os.environ.get("PATH", "")
        return {name: shutil.which(name, path=env_path) for name in _TOOLS}

    # -- environment -----------------------------------------------------

    def build_env(self, overrides: dict | None = None) -> dict:
        """Child environment: current env, then ENV_FILE, then overrides last.

        Overrides win over everything, matching the engines' documented
        precedence (environment > .env > defaults).
        """
        env = dict(os.environ)
        if self.env_file is not None:
            env["ENV_FILE"] = str(self.env_file)
        for key, value in (overrides or {}).items():
            env[str(key)] = str(value)
        return env

    # -- lifecycle -------------------------------------------------------

    def launch(
        self,
        kind: str,
        mode: str | None = None,
        overrides: dict | None = None,
        cwd: str | os.PathLike | None = None,
        on_line=None,
        on_done=None,
    ) -> RunHandle:
        """Start an engine. Raises EngineBusy if one is already running.

        kind: "runsh" (mode: "check"|"dry-run"|"run"/None) or "batch" (no
        modes; caller must pass cwd because encode-batch anchors its
        default dirs to the working directory).
        """
        if self.is_busy():
            raise EngineBusy("an engine process is already running")

        overrides = dict(overrides or {})
        if kind == "runsh":
            script, args = self.engine.run_sh, _MODE_ARGS[mode or "run"]
        elif kind == "batch":
            if mode is not None:
                raise ValueError("encode-batch has no modes")
            script, args = self.engine.encode_batch, []
        else:
            raise ValueError(f"unknown kind: {kind!r}")

        self._proc = subprocess.Popen(
            ["bash", str(script), *args],
            cwd=str(cwd or self.engine.root),
            env=self.build_env(overrides),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # own process group, so cancel() can killpg
        )
        self.handle = RunHandle(kind=kind, pid=self._proc.pid, overrides=overrides)

        reader = threading.Thread(
            target=self._read_output,
            args=(self._proc, on_line, on_done),
            daemon=True,
            name=f"engine-reader-{self._proc.pid}",
        )
        reader.start()
        return self.handle

    def cancel(self) -> bool:
        """Terminate the running engine: SIGTERM the process group, then
        SIGKILL after 5s if it lingers. Returns False when idle."""
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return False
        self._signal_group(proc, signal.SIGTERM)
        timer = threading.Timer(5.0, self._escalate, args=(proc,))
        timer.daemon = True
        timer.start()
        return True

    # -- internals ---------------------------------------------------------

    @staticmethod
    def _signal_group(proc: subprocess.Popen, sig: int) -> None:
        try:
            os.killpg(os.getpgid(proc.pid), sig)
        except (ProcessLookupError, PermissionError):
            pass  # already dead or not ours

    @staticmethod
    def _escalate(proc: subprocess.Popen) -> None:
        if proc.poll() is None:  # re-check: pid must still be this run
            EngineRunner._signal_group(proc, signal.SIGKILL)

    def _read_output(self, proc, on_line, on_done) -> None:
        """Drain the merged output stream. on_done fires exactly once:
        with the real return code on clean end, or -1 if the reader or an
        on_line callback blows up (the engine is killed in that case -
        a dead reader would otherwise block the child on a full pipe)."""
        finished = threading.Event()

        def finish(rc: int) -> None:
            if not finished.is_set():
                finished.set()
                if on_done is not None:
                    try:
                        on_done(rc)
                    except Exception:
                        pass

        try:
            assert proc.stdout is not None
            pending = b""
            while True:
                chunk = proc.stdout.read1(4096)
                if not chunk:
                    break
                pending += chunk
                # Split on \r AND \n: ffmpeg -stats progress lines are
                # CR-terminated (encode-batch pipes them through tee).
                *complete, pending = re.split(rb"[\r\n]", pending)
                for raw in complete:
                    self._emit(raw, on_line)
            if pending:
                self._emit(pending, on_line)  # final line without terminator
            finish(proc.wait())
        except Exception:
            self._escalate(proc)
            finish(-1)

    @staticmethod
    def _emit(raw: bytes, on_line) -> None:
        if on_line is None:
            return
        text = _ANSI_RE.sub("", raw.decode("utf-8", errors="replace"))
        if text:
            on_line(text)
