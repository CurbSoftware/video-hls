"""api.py — the QWebChannel bridge object.

Exactly one ``Api(QObject)`` is registered as "api" on the channel. Slots are
QString in / QString out, payloads JSON — the frozen contract is BRIDGE.md.

Slots run on the GUI thread (QWebChannel marshals meta-calls to the object's
thread). The engine reader thread, the verify thread and the tail thread only
ever *emit signals* — queued connections make that safe; they never touch
widgets.

Core modules (agents A/B):
  engine_paths.locate_engine(app_settings) -> (EnginePaths|None, reason)
  engine_paths.engine_version(EnginePaths) -> str
  runner.EngineRunner(engine, env_file).launch(kind, mode, overrides, cwd,
      on_line(text), on_done(rc)) — raises runner.EngineBusy; .cancel()
  config.RUNSH_SPECS / BATCH_SPECS, validate(), resolve_roots(), parse_ladder(),
  load_app_settings()/save_app_settings(), HELP_HEADER
  envfile.read_env / write_env / env_preview / env_file_path
  parsers.parse_check / parse_dryrun / parse_summary
  ffprobe.probe(path, exe) -> MediaInfo
  library.scan_library / archive_list / verify_package / disk_usage
  tail.FileTail(interval).start(path, on_line) / .stop()

Import failures degrade to error JSON (a half-synced tree must not crash the
GUI); every slot is wrapped so nothing ever raises into JS.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from PySide6.QtCore import QObject, QUrl, Signal, Slot
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import QFileDialog, QWidget

from . import config, engine_paths, envfile, ffprobe, library, parsers, runner, tail

VIDEO_SUFFIXES = {
    ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg",
    ".ts", ".m2ts", ".flv", ".wmv",
}

CHANNEL_FOR_MODE = {"check": "check", "dry-run": "dryrun", "run": "run"}

# The screenshot-harness views; the frontend routes #/<view> to these.
VIEWS = ("dashboard", "routes", "library", "batch", "settings", "dispatch")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


def _batch_dir(engine_root: Path | None, value: str) -> Path:
    """expand $RUN_DIR / relative batch paths (encode-batch anchors to cwd)."""
    v = value.replace("$RUN_DIR", ".")
    p = Path(v).expanduser()
    if p.is_absolute():
        return p
    return (engine_root or Path.cwd()) / p


class Api(QObject):
    # Qt -> JS
    lineReady = Signal(str, str)
    reportReady = Signal(str, str)
    stateChanged = Signal(str)
    # internal: the screenshot harness waits on this
    viewRendered = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._app_settings: dict = {}
        self._engine: engine_paths.EnginePaths | None = None
        self._engine_note: str | None = None
        self._engine_version = "unknown"
        self._engine_runner: runner.EngineRunner | None = None
        self._channel = "run"
        self._t0 = 0.0
        self._cancelled = False
        self._lines: list[str] = []
        self._tail: tail.FileTail | None = None
        self._verify_busy = False
        self._disk_cache = None
        self._reload_engine()

    # ---------------------------------------------------------- util / core

    def _guard(self, fn, *args,
               fallback='{"ok": false, "error": "internal error"}'):
        """Never let a slot raise into JS; log to stderr instead."""
        try:
            return fn(*args)
        except Exception:
            traceback.print_exc()
            return fallback

    def _reload_engine(self) -> None:
        try:
            self._app_settings = config.load_app_settings()
        except Exception:
            traceback.print_exc()
            self._app_settings = {}
        try:
            self._engine, self._engine_note = engine_paths.locate_engine(
                self._app_settings)
        except Exception:
            traceback.print_exc()
            self._engine, self._engine_note = None, "engine_paths failed"
        self._engine_version = (
            engine_paths.engine_version(self._engine)
            if self._engine else "unknown")
        self._engine_runner = None
        self._disk_cache = None

    def _runner(self) -> runner.EngineRunner:
        if self._engine is None:
            raise RuntimeError("no engine (set the engine path)")
        if self._engine_runner is None:
            self._engine_runner = runner.EngineRunner(
                self._engine, env_file=envfile.env_file_path(self._engine.root))
        return self._engine_runner

    def _busy(self) -> bool:
        r = self._engine_runner
        return bool(r and r.is_busy())

    def _tools(self) -> dict:
        if self._engine is None:
            return {n: shutil.which(n) for n in ("ffmpeg", "ffprobe", "python3")}
        ffmpeg_dir = self._app_settings.get("ffmpeg_dir") or None
        return self._runner().tools_ok(ffmpeg_dir)

    def _env_values(self) -> dict[str, str]:
        if self._engine is None:
            return {}
        return envfile.read_env(envfile.env_file_path(self._engine.root))

    def _effective(self, engine: str, provided: dict | None = None) -> dict[str, str]:
        """defaults <- persisted values <- what the caller just sent."""
        specs = config.RUNSH_SPECS if engine == "runsh" else config.BATCH_SPECS
        stored = (self._env_values() if engine == "runsh"
                  else self._app_settings.get("batch_values", {}))
        vals = {name: str(stored.get(name, spec.default))
                for name, spec in specs.items()}
        for k, v in (provided or {}).items():
            if k in specs:
                vals[k] = str(v)
        return vals

    def _roots(self, runsh_values: dict | None = None) -> dict[str, Path]:
        if self._engine is None:
            return {}
        vals = runsh_values or self._effective("runsh")
        return config.resolve_roots(self._engine.root, vals)

    # ------------------------------------------------------ state / signals

    def _state(self) -> dict:
        return {
            "busy": self._busy(),
            "kind": self._engine_runner.handle.kind
                    if self._busy() and self._engine_runner.handle else None,
            "started": _iso(self._engine_runner.handle.started.timestamp())
                       if self._busy() and self._engine_runner.handle else None,
            "engine_version": self._engine_version,
            "tools": self._tools(),
        }

    def _emit_state(self) -> None:
        self.stateChanged.emit(_dumps(self._state()))

    # -------------------------------------------------------------- disk

    def _disk(self) -> dict:
        roots = self._roots()
        key = tuple(sorted(map(str, roots.items())))
        if self._disk_cache is not None and self._disk_cache[0] == key:
            return self._disk_cache[1]
        data = library.disk_usage(roots)
        self._disk_cache = (key, data)
        return data

    # ================================================================ slots

    @Slot(result=str)
    def getBootstrap(self) -> str:
        return self._guard(self._bootstrap)

    def _bootstrap(self) -> str:
        env_path = (envfile.env_file_path(self._engine.root)
                    if self._engine else None)
        engine = {"root": str(self._engine.root) if self._engine else None,
                  "source": "setting" if self._engine and self._engine.source == "external" else "auto",
                  "version": self._engine_version}
        if self._engine_note and self._engine is None:
            engine["error"] = self._engine_note
        out = {
            "engine": engine,
            "tools": self._tools(),
            "roots": {k: str(v) for k, v in self._roots().items()},
            "disk": self._disk(),
            "busy": self._busy(),
            "app_settings": {
                "engine_path": self._app_settings.get("engine_path", ""),
                "ffmpeg_dir": self._app_settings.get("ffmpeg_dir", ""),
                "batch_values": self._effective("batch"),
            },
            "env_path": str(env_path) if env_path else None,
            "env_writable": os.access(env_path.parent, os.W_OK) if env_path else False,
        }
        return _dumps(out)

    # ------------------------------------------------------------ launches

    @Slot()
    def runCheck(self) -> None:
        self._guard(self._check_or_dry, "check")

    @Slot(str)
    def dryRun(self, overrides_json: str) -> None:
        self._guard(self._check_or_dry, "dry-run", overrides_json)

    def _check_or_dry(self, mode: str, overrides_json: str = "{}") -> None:
        if self._busy():
            self.reportReady.emit(CHANNEL_FOR_MODE[mode], _dumps({"error": "busy"}))
            return
        try:
            overrides = self._parse_overrides(overrides_json)
            self._launch_engine("runsh", mode, overrides)
        except Exception as exc:
            traceback.print_exc()
            self.reportReady.emit(CHANNEL_FOR_MODE[mode],
                                  _dumps({"error": str(exc)}))

    @Slot(str, result=str)
    def launchRun(self, overrides_json: str) -> str:
        return self._guard(self._launch_slot, "runsh", overrides_json)

    @Slot(str, result=str)
    def launchBatch(self, overrides_json: str) -> str:
        return self._guard(self._launch_slot, "batch", overrides_json)

    def _launch_slot(self, kind: str, overrides_json: str) -> str:
        if self._busy():
            return _dumps({"ok": False, "error": "busy"})
        if not self._tools().get("ffmpeg"):
            return _dumps({"ok": False, "error": "ffmpeg missing"})
        try:
            overrides = self._parse_overrides(overrides_json, kind)
            self._launch_engine(kind, "run", overrides)
        except Exception as exc:
            traceback.print_exc()
            return _dumps({"ok": False, "error": str(exc)})
        return _dumps({"ok": True, "error": None})

    def _parse_overrides(self, js: str, kind: str = "runsh") -> dict:
        """Flat {VAR: value} or {"values": {...}}; path vars made absolute."""
        data: dict = {}
        if js and js.strip():
            data = json.loads(js)
            if isinstance(data, dict) and isinstance(data.get("values"), dict):
                data = data["values"]
        if not isinstance(data, dict):
            raise ValueError("overrides_json must be a JSON object")
        overrides = {str(k): str(v) for k, v in data.items()}
        if self._engine is None:
            return overrides
        if kind == "runsh":
            eff = self._effective("runsh", overrides)
            roots = config.resolve_roots(self._engine.root, eff)
            var2root = {"INPUT_ROOT": "input", "HLS_ROOT": "hls",
                        "WORK_ROOT": "work", "PROCESSED_ROOT": "processed",
                        "ENCODED_ROOT": "encoded", "STATE_ROOT": "state",
                        "LOG_ROOT": "logs"}
            for var, name in var2root.items():
                if var in overrides:
                    overrides[var] = str(roots[name])
        else:
            # stored batch settings backstop whatever the form just sent
            overrides = self._effective("batch", overrides)
            for var in ("INPUT_DIR", "OUTPUT_DIR", "ENCODING_WORK_DIR",
                        "ORIGINALS_REVIEW_DIR", "ERROR_DIR", "LOG_DIR"):
                overrides[var] = str(_batch_dir(self._engine.root,
                                                overrides.get(var, "")))
        return overrides

    def _launch_engine(self, kind: str, mode: str, overrides: dict) -> None:
        r = self._runner()
        self._channel = CHANNEL_FOR_MODE[mode] if kind == "runsh" else "batch"
        self._t0 = time.monotonic()
        self._cancelled = False
        self._lines = []
        channel = self._channel

        def on_line(text: str) -> None:
            if len(self._lines) < 5000:
                self._lines.append(text)
            self.lineReady.emit(channel, text)  # queued to the GUI thread

        def on_done(rc: int) -> None:
            self._finish_run(channel, rc)

        r.launch(kind, mode if kind == "runsh" else None,
                 overrides=overrides, on_line=on_line, on_done=on_done)
        self._emit_state()

    def _finish_run(self, channel: str, rc: int) -> None:
        duration = time.monotonic() - self._t0
        cancelled = self._cancelled
        report = {
            "ok": rc == 0 and not cancelled,
            "exit_code": rc,
            "duration_s": round(duration, 2),
            "cancelled": cancelled,
        }
        lines = self._lines
        try:
            if channel in ("check", "dryrun"):
                parsed = (parsers.parse_check("\n".join(lines))
                          if channel == "check"
                          else parsers.parse_dryrun("\n".join(lines)))
                # merge, don't replace: the parsed dataclass carries no
                # ok/exit_code, and dropping them breaks the bridge contract.
                # merge, don't replace: the parsed dataclass carries no
                # ok/exit_code, and dropping them breaks the bridge contract.
                report.update(asdict(parsed))
                if channel == "check":
                    report["ok"] = bool(parsed.ready and rc == 0)
                report["exit_code"] = rc
            else:
                counts = parsers.parse_summary(lines)
                if counts:
                    report.update(counts)
        except Exception:
            traceback.print_exc()
        self.reportReady.emit(
            channel if channel in ("check", "dryrun") else f"{channel}.summary",
            _dumps(report))
        self._disk_cache = None
        self._emit_state()

    @Slot(result=str)
    def cancelRun(self) -> str:
        return self._guard(self._cancel)

    def _cancel(self) -> str:
        r = self._engine_runner
        if r is None or not r.cancel():
            return _dumps({"ok": False, "error": "not running"})
        self._cancelled = True
        self._emit_state()
        return _dumps({"ok": True, "error": None})

    # -------------------------------------------------------------- inputs

    @Slot(result=str)
    def listInputs(self) -> str:
        return self._guard(self._list_inputs, fallback="[]")

    def _list_inputs(self) -> str:
        root = self._roots().get("input")
        out = []
        if root is None or not root.is_dir():
            return _dumps(out)
        regex = None
        try:
            regex = re.compile(self._effective("runsh")["VIDEO_EXTENSIONS_REGEX"],
                               re.IGNORECASE)
        except re.error:
            pass
        for p in sorted(root.rglob("*")):
            rel = str(p.relative_to(root))
            if not p.is_file():
                continue
            if regex is not None:
                if not regex.fullmatch(rel):
                    continue
            elif p.suffix.lower() not in VIDEO_SUFFIXES:
                continue
            try:
                size = p.stat().st_size
            except OSError:
                size = 0
            entry = {"rel": rel, "abs": str(p), "size_bytes": size}
            entry.update(asdict(ffprobe.probe(p, ffprobe=self._tools()["ffprobe"] or "ffprobe")))
            out.append(entry)
        return _dumps(out)

    # ------------------------------------------------------------- library

    @Slot(result=str)
    def libraryList(self) -> str:
        return self._guard(self._library_list, fallback="[]")

    def _library_list(self) -> str:
        root = self._roots().get("hls")
        out = []
        for pkg in library.scan_library(root or ""):
            out.append({
                "name": pkg.name,
                "path": str(pkg.path),
                "meta": pkg.meta or None,
                "tier_count": len(pkg.tiers),
                "mtime": _iso(pkg.mtime) if pkg.mtime else None,
                "error": pkg.error,
            })
        return _dumps(out)

    @Slot(str, result=str)
    def packageDetail(self, name: str) -> str:
        return self._guard(self._package_detail, name,
                           fallback='{"error": "internal error"}')

    def _package_detail(self, name: str) -> str:
        root = self._roots().get("hls")
        for pkg in library.scan_library(root or ""):
            if pkg.name == name:
                return _dumps({
                    "name": pkg.name,
                    "path": str(pkg.path),
                    "meta": pkg.meta or None,
                    "tiers": [asdict(t) for t in pkg.tiers],
                    "master": str(pkg.master) if pkg.master else None,
                    "error": pkg.error,
                })
        return _dumps({"name": name, "path": None, "meta": None, "tiers": [],
                       "master": None, "error": f"no package named {name!r}"})

    @Slot(result=str)
    def archiveList(self) -> str:
        return self._guard(self._archive_list, fallback="[]")

    def _archive_list(self) -> str:
        root = self._roots().get("processed")
        out = []
        for p in library.archive_list(root or ""):
            try:
                out.append({"rel": str(p.relative_to(root)),
                            "size_bytes": p.stat().st_size})
            except OSError:
                continue
        return _dumps(out)

    # -------------------------------------------------------------- verify

    @Slot(str)
    def verifyPackage(self, name: str) -> None:
        self._guard(self._verify, name)

    def _verify(self, name: str) -> None:
        if self._verify_busy:
            self.reportReady.emit("verify", _dumps({
                "name": name, "ok": False, "error": "busy",
                "exit_code": None, "stderr_tail": "", "duration_s": 0.0}))
            return
        self._verify_busy = True
        threading.Thread(target=self._verify_worker, args=(name,),
                         daemon=True, name="verify").start()

    def _verify_worker(self, name: str) -> None:
        try:
            master = None
            root = self._roots().get("hls")
            for pkg in library.scan_library(root or ""):
                if pkg.name == name:
                    master = pkg.master
                    break
            if master is None:
                raise FileNotFoundError(f"no package named {name!r}")
            result = library.verify_package(
                master, ffmpeg=self._tools().get("ffmpeg") or "ffmpeg")
            report = {"name": name, **asdict(result)}
        except Exception as exc:
            report = {"name": name, "ok": False, "exit_code": None,
                      "stderr_tail": str(exc), "duration_s": 0.0}
        finally:
            self._verify_busy = False
        self._disk_cache = None
        self.reportReady.emit("verify", _dumps(report))

    # ---------------------------------------------------------------- logs

    @Slot(result=str)
    def logsList(self) -> str:
        return self._guard(self._logs_list, fallback="[]")

    def _logs_list(self) -> str:
        out = []
        sources = [
            ("runsh", self._roots().get("logs")),
            ("batch", self._batch_log_dir()),
        ]
        for engine, d in sources:
            if d is None or not d.is_dir():
                continue
            try:
                files = sorted(d.iterdir(), key=lambda q: q.stat().st_mtime,
                               reverse=True)
            except OSError:
                continue
            for p in files:
                if not p.is_file():
                    continue
                try:
                    st = p.stat()
                    out.append({"engine": engine, "name": p.name,
                                "path": str(p), "size_bytes": st.st_size,
                                "mtime": _iso(st.st_mtime)})
                except OSError:
                    continue
        return _dumps(out)

    def _batch_log_dir(self) -> Path | None:
        if self._engine is None:
            return None
        return _batch_dir(self._engine.root,
                          self._effective("batch")["LOG_DIR"])

    @Slot(str, str, result=str)
    def logRead(self, path: str, tail_bytes: str = "65536") -> str:
        return self._guard(self._log_read, path, tail_bytes,
                           fallback='{"path": "", "text": "", "error": "internal error"}')

    def _log_read(self, path: str, tail_bytes: str) -> str:
        p = Path(path)
        try:
            n = max(0, int((tail_bytes or "65536").strip()))
        except ValueError:
            n = 65536
        try:
            with p.open("rb") as fh:
                fh.seek(0, os.SEEK_END)
                size = fh.tell()
                fh.seek(max(0, size - n))
                return _dumps({"path": str(p),
                               "text": fh.read().decode("utf-8", errors="replace")})
        except FileNotFoundError:
            return _dumps({"path": path, "text": "", "error": "not found"})
        except OSError as exc:
            return _dumps({"path": path, "text": "", "error": str(exc)})

    # ---------------------------------------------------------------- tail

    @Slot(str)
    def tailStart(self, path: str) -> None:
        self._guard(self._tail_start, path)

    def _tail_start(self, path: str) -> None:
        old, self._tail = self._tail, None
        if old is not None:
            old.stop()  # daemon thread exits within one poll interval
        t = tail.FileTail()

        def on_line(line: str) -> None:
            self.lineReady.emit("tail", line)  # queued to the GUI thread

        try:
            t.start(path, on_line)
            self._tail = t
        except RuntimeError:
            t.stop()

    @Slot()
    def tailStop(self) -> None:
        self._guard(self._tail_stop)

    def _tail_stop(self) -> None:
        t, self._tail = self._tail, None
        if t is not None:
            t.stop()

    # ------------------------------------------------------------ settings

    @Slot(result=str)
    def settingsGet(self) -> str:
        return self._guard(self._settings_get,
                           fallback='{"error": "internal error"}')

    def _settings_get(self) -> str:
        env_path = (envfile.env_file_path(self._engine.root)
                    if self._engine else None)
        env_text = ""
        if env_path is not None and env_path.is_file():
            try:
                env_text = env_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                pass
        def specs_json(specs):
            return [{"name": s.name, "default": s.default, "kind": s.kind,
                     "choices": list(s.choices), "help": s.help,
                     "label": s.label, "group": s.group}
                    for s in specs.values()]
        return _dumps({
            "specs": {"runsh": specs_json(config.RUNSH_SPECS),
                      "batch": specs_json(config.BATCH_SPECS)},
            "values": {"runsh": self._effective("runsh"),
                       "batch": self._effective("batch")},
            "defaults": {
                "runsh": {n: s.default for n, s in config.RUNSH_SPECS.items()},
                "batch": {n: s.default for n, s in config.BATCH_SPECS.items()},
            },
            "env_text": env_text,
            "env_path": str(env_path) if env_path else None,
            "env_writable": os.access(env_path.parent, os.W_OK) if env_path else False,
        })

    @Slot(str, result=str)
    def settingsPreview(self, values_json: str) -> str:
        return self._guard(self._settings_preview, values_json,
                           fallback='{"errors": ["internal error"]}')

    def _settings_preview(self, values_json: str) -> str:
        values = json.loads(values_json) if values_json and values_json.strip() else {}
        if not isinstance(values, dict):
            raise ValueError("values_json must be {runsh: {...}, batch: {...}}")
        return _dumps(self._apply_settings(values, write=False))

    @Slot(str, result=str)
    def settingsSave(self, values_json: str) -> str:
        return self._guard(self._settings_save, values_json,
                           fallback='{"ok": false, "errors": ["internal error"]}')

    def _settings_save(self, values_json: str) -> str:
        values = json.loads(values_json) if values_json and values_json.strip() else {}
        if not isinstance(values, dict):
            raise ValueError("values_json must be {runsh: {...}, batch: {...}}")
        result = self._apply_settings(values, write=True)
        return _dumps({"ok": not result["errors"], "errors": result["errors"],
                       "env_path": result["env_path"]})

    def _apply_settings(self, values: dict, write: bool) -> dict:
        """Shared preview/save path: validate, derive, optionally persist."""
        runsh_in = values.get("runsh") or {}
        batch_in = values.get("batch") or {}
        if not isinstance(runsh_in, dict) or not isinstance(batch_in, dict):
            raise ValueError("runsh/batch values must be objects")
        runsh = self._effective("runsh", runsh_in)
        batch = self._effective("batch", batch_in)
        errors = (config.validate(config.RUNSH_SPECS, runsh)
                  + config.validate(config.BATCH_SPECS, batch))
        rows, ladder_errors = config.parse_ladder(runsh["LADDER"])
        env_path = (envfile.env_file_path(self._engine.root)
                    if self._engine else None)
        env_text = ""
        if self._engine is not None:
            env_text = envfile.env_preview(runsh, config.RUNSH_SPECS,
                                           self._engine.root, config.HELP_HEADER)
        if write and not errors and self._engine is not None:
            try:
                envfile.write_env(env_path, runsh, config.RUNSH_SPECS,
                                  self._engine.root, config.HELP_HEADER)
                self._app_settings["batch_values"] = batch
                config.save_app_settings(self._app_settings)
                self._disk_cache = None
            except (OSError, ValueError) as exc:
                errors.append(f"write failed: {exc}")
        return {
            "errors": errors,  # validate() already includes LADDER row errors
            "env_text": env_text,
            "derived_roots": {k: str(v) for k, v in self._roots(runsh).items()},
            "ladder_rows": [[r.label, str(r.height), str(r.width),
                             r.video_bitrate, r.maxrate, r.bufsize,
                             r.audio_bitrate] for r in rows],
            "ladder_errors": ladder_errors,
            "env_path": str(env_path) if env_path else None,
        }

    # --------------------------------------------------------- engine / os

    @Slot(str, result=str)
    def setEnginePath(self, path: str) -> str:
        return self._guard(self._set_engine_path, path)

    def _set_engine_path(self, path: str) -> str:
        if self._busy():
            return _dumps({"ok": False, "error": "busy",
                           "version": self._engine_version})
        root = Path(path).expanduser().resolve()
        if not (root / "run.sh").is_file():
            return _dumps({"ok": False, "error": f"run.sh not found in {root}",
                           "version": "unknown"})
        self._app_settings["engine_path"] = str(root)
        config.save_app_settings(self._app_settings)
        self._reload_engine()
        self._emit_state()
        return _dumps({"ok": True, "error": None,
                       "version": self._engine_version})

    @Slot(str, result=str)
    def pickDirectory(self, current: str) -> str:
        try:
            start = current or (str(self._engine.root) if self._engine
                                else str(Path.home()))
            parent = self.parent() if isinstance(self.parent(), QWidget) else None
            return QFileDialog.getExistingDirectory(parent, "Choose directory",
                                                    start) or ""
        except Exception:
            traceback.print_exc()
            return ""

    @Slot(str)
    def openPath(self, path: str) -> None:
        self._guard(lambda: QDesktopServices.openUrl(
            QUrl.fromLocalFile(str(Path(path).expanduser()))))

    @Slot(str)
    def revealFile(self, path: str) -> None:
        def _reveal():
            d = Path(path).expanduser().parent
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(d)))
        self._guard(_reveal)

    @Slot(str)
    def openInPlayer(self, master: str) -> None:
        def _play():
            target = str(Path(master).expanduser())
            for player in ("mpv", "vlc"):
                exe = shutil.which(player)
                if exe:
                    subprocess.Popen([exe, target], start_new_session=True,
                                     stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)
                    return
            QDesktopServices.openUrl(QUrl.fromLocalFile(target))
        self._guard(_play)

    @Slot(str)
    def viewReady(self, view: str) -> None:
        self.viewRendered.emit(view)
