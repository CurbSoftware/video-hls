"""test_api.py — the Api slot layer: payload shapes against BRIDGE.md.

The other test modules exercise the core directly (parsers, runner, library,
config). This one covers Api's *own* assembly of the payloads, which is where
a contract break can hide: `_finish_run` wraps its parsing in a catch-all
`except Exception`, so a KeyError there silently ships a truncated report
instead of failing loudly. That is exactly how the dryrun report once lost
its `ok` and `exit_code` fields.

No subprocess and no event loop needed: `_finish_run(channel, rc)` reads only
`_lines`, `_t0` and `_cancelled`, so recorded fixture output can be pushed
straight through it, and Qt signals fire on direct connections without a
QApplication.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

# Must precede the PySide6 import: keeps the suite headless on CI boxes that
# happen to have a DISPLAY.
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _pyside_unavailable_reason() -> str | None:
    try:
        import PySide6.QtWidgets  # noqa: F401
    except Exception as exc:  # ImportError, or a broken Qt load
        return f"PySide6 cannot be imported: {exc!r}"
    return None


pytestmark = pytest.mark.skipif(
    _pyside_unavailable_reason() is not None,
    reason=_pyside_unavailable_reason() or "unreachable",
)


@pytest.fixture()
def api(tmp_path, monkeypatch, repo_root):
    """An Api bound to this checkout, with app settings redirected into
    tmp_path — config.py honours XDG_CONFIG_HOME, so the developer's real
    ~/.config/videohls-controlroom/app.json is never touched."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    from controlroom.api import Api  # imported late: env must be set first

    obj = Api()
    result = json.loads(obj.setEnginePath(str(repo_root)))
    assert result["ok"], result
    return obj


def _capture(obj) -> list[tuple[str, dict]]:
    """Collect every reportReady emission as (channel, parsed payload)."""
    seen: list[tuple[str, dict]] = []
    obj.reportReady.connect(lambda ch, js: seen.append((ch, json.loads(js))))
    return seen


def _feed(obj, channel: str, fixture: str, rc: int = 0) -> dict:
    """Push a recorded engine transcript through _finish_run, return the report."""
    seen = _capture(obj)
    obj._lines = (FIXTURES / fixture).read_text().splitlines()
    obj._t0 = time.monotonic()
    obj._cancelled = False
    obj._finish_run(channel, rc)
    assert seen, f"no reportReady emitted on {channel}"
    emitted_channel, report = seen[-1]
    assert emitted_channel == channel
    return report


# ----------------------------------------------------------------- reports


def test_dryrun_report_carries_ok_and_exit_code(api):
    """Regression: asdict(parsed) used to *replace* the base report, dropping
    both fields and raising a KeyError that the guard swallowed."""
    report = _feed(api, "dryrun", "dryrun.txt", rc=0)

    assert report["ok"] is True
    assert report["exit_code"] == 0
    # and the parsed DryRunReport fields still ride along (BRIDGE.md)
    for key in ("total", "encoder", "audio_encoder", "segment_type",
                "ladder_labels", "output_root", "videos"):
        assert key in report, f"missing {key}"
    assert report["total"] == 1
    assert report["encoder"] == "libx264"
    assert report["videos"][0]["tiers"][-1]["action"] == "skip"


def test_dryrun_report_not_ok_on_nonzero_exit(api):
    report = _feed(api, "dryrun", "dryrun.txt", rc=2)
    assert report["ok"] is False
    assert report["exit_code"] == 2


def test_check_report_carries_ok_exit_code_and_ready(api):
    report = _feed(api, "check", "check_ok.txt", rc=0)

    assert report["exit_code"] == 0
    assert report["ready"] is True
    assert report["ok"] is True  # ready AND rc == 0
    for key in ("commands", "ffmpeg_version", "bash_version", "hardware",
                "video_encoders", "audio_encoders", "active", "paths"):
        assert key in report, f"missing {key}"


def test_check_report_not_ok_when_exit_code_nonzero(api):
    """`ok` is ready && exit_code == 0 — a ready report with a bad rc is not ok."""
    report = _feed(api, "check", "check_ok.txt", rc=1)
    assert report["ready"] is True
    assert report["ok"] is False


def test_run_summary_channel_is_renamed(api):
    """run/batch finish on `<channel>.summary`, unlike check/dryrun."""
    seen = _capture(api)
    api._lines = []
    api._t0 = time.monotonic()
    api._cancelled = False
    api._finish_run("run", 0)

    channel, report = seen[-1]
    assert channel == "run.summary"
    assert report["ok"] is True
    assert report["exit_code"] == 0
    assert report["cancelled"] is False
    assert "duration_s" in report


# -------------------------------------------------------------------- logs


def test_log_read_missing_path_says_not_found(api):
    """BRIDGE.md pins this string; the OSError text used to leak through."""
    payload = json.loads(api.logRead("/nonexistent/nope.log", "4096"))
    assert payload["error"] == "not found"
    assert payload["text"] == ""


def test_log_read_returns_trailing_bytes(api, tmp_path):
    log = tmp_path / "sample.log"
    log.write_text("alpha\nbeta\ngamma\n")

    whole = json.loads(api.logRead(str(log), "65536"))
    assert "error" not in whole
    assert whole["text"] == "alpha\nbeta\ngamma\n"
    assert whole["path"] == str(log)

    # reads from the END of the file, not the start
    assert json.loads(api.logRead(str(log), "6"))["text"] == "gamma\n"


# ------------------------------------------------------------------- state


def test_cancel_run_when_idle(api):
    assert json.loads(api.cancelRun()) == {"ok": False, "error": "not running"}


def test_bootstrap_shape(api, repo_root):
    boot = json.loads(api.getBootstrap())

    for key in ("engine", "tools", "roots", "disk", "busy", "app_settings",
                "env_path", "env_writable"):
        assert key in boot, f"missing {key}"
    assert boot["busy"] is False
    assert boot["engine"]["root"] == str(repo_root)
    assert boot["engine"]["source"] == "setting"  # we called setEnginePath
    for root in ("input", "hls", "work", "processed", "encoded", "state", "logs"):
        assert root in boot["roots"], f"missing root {root}"
        assert root in boot["disk"], f"missing disk entry {root}"


def test_settings_get_shape(api):
    got = json.loads(api.settingsGet())

    for key in ("specs", "values", "defaults", "env_text", "env_path",
                "env_writable"):
        assert key in got, f"missing {key}"
    assert {"runsh", "batch"} <= set(got["specs"])
    assert got["specs"]["runsh"], "no runsh specs"

    kinds = {"str", "int", "bool", "enum", "path", "bitrate", "ladder"}
    for spec in got["specs"]["runsh"]:
        assert {"name", "default", "kind", "choices", "help", "label",
                "group"} <= set(spec)
        assert spec["kind"] in kinds, f"{spec['name']}: bad kind {spec['kind']}"

    names = {s["name"] for s in got["specs"]["runsh"]}
    assert {"VIDEO_CODEC", "HLS_TIME", "LADDER"} <= names


def test_settings_preview_is_read_only(api, repo_root):
    """Preview derives roots and ladder rows without writing anything."""
    env = repo_root / ".env"
    before = env.read_bytes() if env.exists() else None

    preview = json.loads(api.settingsPreview(json.dumps(
        {"runsh": {"VIDEO_CODEC": "av1", "HWACCEL": "none"}})))

    for key in ("errors", "env_text", "derived_roots", "ladder_rows",
                "ladder_errors"):
        assert key in preview, f"missing {key}"
    # written as ${VAR:-value} so a real env var still wins over .env
    assert 'VIDEO_CODEC="${VIDEO_CODEC:-av1}"' in preview["env_text"]
    # every ladder row is the 7 columns run.sh expects
    for row in preview["ladder_rows"]:
        assert len(row) == 7, row

    after = env.read_bytes() if env.exists() else None
    assert after == before, "settingsPreview must not write .env"


def test_set_engine_path_rejects_a_dir_without_run_sh(api, tmp_path):
    result = json.loads(api.setEnginePath(str(tmp_path)))
    assert result["ok"] is False
    assert "run.sh not found" in result["error"]


# ----------------------------------------------------------------- listings


def test_listings_are_arrays_with_the_documented_shape(api):
    """These depend on runtime dirs that may be empty in a fresh clone, so
    assert the container plus the per-item shape only when items exist."""
    inputs = json.loads(api.listInputs())
    assert isinstance(inputs, list)
    for item in inputs:
        assert {"rel", "abs", "size_bytes", "width", "height", "fps",
                "has_audio", "duration_s", "error"} <= set(item)

    packages = json.loads(api.libraryList())
    assert isinstance(packages, list)
    for pkg in packages:
        assert {"name", "path", "meta", "tier_count", "mtime", "error"} <= set(pkg)

    archive = json.loads(api.archiveList())
    assert isinstance(archive, list)
    for entry in archive:
        assert {"rel", "size_bytes"} <= set(entry)

    logs = json.loads(api.logsList())
    assert isinstance(logs, list)
    for log in logs:
        assert {"engine", "name", "path", "size_bytes", "mtime"} <= set(log)
        assert log["engine"] in ("runsh", "batch")


def test_package_detail_of_unknown_name_does_not_raise(api):
    detail = json.loads(api.packageDetail("no-such-package-here"))
    assert detail["name"] == "no-such-package-here"
    assert detail["tiers"] == []
