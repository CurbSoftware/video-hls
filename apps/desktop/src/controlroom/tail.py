"""Incremental log file tailing: tail -f -n +1 semantics (whole file
first, then appended lines) delivered one callback per line, on a daemon
thread. Missing files are polled for, so a tail can start before the
engine creates the log.
"""

from __future__ import annotations

import threading
from pathlib import Path


class FileTail:
    """Follow a text file, polling."""

    def __init__(self, interval: float = 0.5):
        self._interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self, path, on_line) -> None:
        """Begin tailing `path` on a daemon thread; on_line(line:str)."""
        if self._thread is not None and self._thread.is_alive():
            raise RuntimeError("FileTail already running")
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, args=(Path(path), on_line), daemon=True, name="file-tail"
        )
        self._thread.start()

    def stop(self) -> None:
        """Idempotent; the thread exits within one poll interval."""
        self._stop.set()

    def _run(self, path: Path, on_line) -> None:
        pos = 0
        pending = b""
        while not self._stop.is_set():
            got = self._read_chunk(path, pos)
            if got is None:  # missing or unreadable - keep waiting
                self._stop.wait(self._interval)
                continue
            pos, data = got
            if not data:
                self._stop.wait(self._interval)
                continue
            pending += data
            # Lines are split on bytes; a complete b"\n"-terminated line
            # can never split a multi-byte UTF-8 character.
            *complete, pending = pending.split(b"\n")
            for raw in complete:
                text = raw.decode("utf-8", errors="replace").rstrip("\r")
                if text:
                    on_line(text)

    @staticmethod
    def _read_chunk(path: Path, pos: int) -> tuple[int, bytes] | None:
        try:
            size = path.stat().st_size
            if size < pos:  # truncated/rotated - start over
                pos = 0
            with open(path, "rb") as fh:
                fh.seek(pos)
                data = fh.read()
            return pos + len(data), data
        except OSError:
            return None
