"""Backend of the convert wizard: staging, clashes, and the work path
handed to run.sh when the engine lives on an AppImage mount."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


def _pyside_unavailable_reason() -> str | None:
    try:
        import PySide6.QtWidgets  # noqa: F401
    except Exception as exc:
        return f"PySide6 cannot be imported: {exc!r}"
    return None


pytestmark = pytest.mark.skipif(
    _pyside_unavailable_reason() is not None,
    reason=_pyside_unavailable_reason() or "unreachable",
)

MOUNT = "/tmp/.mount_CurbStreamTest/usr/share/videohls-controlroom/engine"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    from controlroom.api import Api

    return Api()


def _install_packaged_engine(api, tmp_path, monkeypatch):
    """Point the bridge at a fake AppImage engine and a fake home directory."""
    from controlroom import config

    home = tmp_path / "home"
    monkeypatch.setattr(config.Path, "home", staticmethod(lambda: home))
    root = tmp_path / "mnt" / ".mount_CurbStreamTest" / "usr" / "share" / "videohls-controlroom" / "engine"
    root.mkdir(parents=True)
    (root / "run.sh").write_text("#!/bin/bash\nexit 0\n")
    (root / "scripts").mkdir()
    (root / "scripts" / "encode-batch.sh").write_text("#!/bin/bash\nexit 0\n")
    result = json.loads(api.setEnginePath(str(root)))
    assert result["ok"], result
    assert ".mount_" in str(api._engine.root)
    return home


def _capture_launch(monkeypatch):
    from controlroom import runner

    captured: dict = {}

    def fake_launch(self, kind, mode=None, overrides=None, cwd=None,
                    on_line=None, on_done=None):
        captured["kind"] = kind
        captured["mode"] = mode
        captured["overrides"] = dict(overrides or {})
        captured["cwd"] = None if cwd is None else Path(cwd)
        return None

    monkeypatch.setattr(runner.EngineRunner, "launch", fake_launch)
    return captured


def test_probe_requires_a_path(api):
    report = json.loads(api.probeSources(""))
    assert report["items"] == []
    assert report["error"] == "Choose a file or a folder."


def test_output_clash_names_packages_that_would_be_replaced(api, tmp_path):
    hls = tmp_path / "hls"
    (hls / "Beach").mkdir(parents=True)
    (hls / "Beach" / "master.m3u8").write_text("#EXTM3U\n")
    found = json.loads(api.outputClash(json.dumps({
        "dir": str(hls),
        "names": ["Beach", "Other"],
    })))
    assert found == {"existing": ["Beach"]}
    assert json.loads(api.outputClash(json.dumps({"dir": "", "names": ["Beach"]}))) == {
        "existing": [],
    }


def test_stage_without_an_engine_fails(api):
    api._engine = None
    result = json.loads(api.stageJob(json.dumps({
        "items": [{"src": "/tmp/clip.mp4", "name": "Clip"}],
    })))
    assert result["ok"] is False
    assert result["input_root"] is None
    assert "No engine" in result["error"]


def test_packaged_bootstrap_work_root_is_home_videos(api, tmp_path, monkeypatch):
    home = _install_packaged_engine(api, tmp_path, monkeypatch)
    boot = json.loads(api.getBootstrap())
    work = boot["roots"]["work"]
    assert work == str(home / "Videos" / "curbstream")
    for key, path in boot["roots"].items():
        assert "/.mount_" not in path, key
        assert "share/videohls-controlroom" not in path, key
        assert "appimage_extracted_" not in path, key
    assert boot["roots"]["hls"] == str(home / "Videos" / "curbstream" / "hls")
    assert boot["roots"]["state"] == str(home / "Videos" / "curbstream" / "state")
    assert [row["label"] for row in boot["builtin_ladder"]][0] == "240p"


def test_packaged_launch_keeps_scratch_off_the_mount(api, tmp_path, monkeypatch):
    home = _install_packaged_engine(api, tmp_path, monkeypatch)
    monkeypatch.setattr(api, "_tools", lambda: {
        "ffmpeg": "/usr/bin/ffmpeg",
        "ffprobe": "/usr/bin/ffprobe",
        "python3": "/usr/bin/python3",
    })
    captured = _capture_launch(monkeypatch)
    base = home / "Videos" / "curbstream"
    staging = base / "jobs" / "abc123" / "in"
    hls = base / "hls"
    ack = json.loads(api.launchRun(json.dumps({
        "INPUT_ROOT": str(staging),
        "HLS_ROOT": str(hls),
        "VIDEO_CODEC": "h264",
        "AUDIO_CODEC": "aac",
        "HWACCEL": "none",
        "ARCHIVE_SOURCE": "false",
    })))
    assert ack == {"ok": True, "error": None}
    overrides = captured["overrides"]
    assert captured["kind"] == "runsh"
    assert captured["mode"] == "run"
    assert captured["cwd"] == base
    assert overrides["WORK_ROOT"] == str(base)
    assert overrides["INPUT_ROOT"] == str(staging)
    assert overrides["HLS_ROOT"] == str(hls)
    assert overrides["ENCODED_ROOT"] == str(base / "encoded")
    assert overrides["STATE_ROOT"] == str(base / "state")
    assert overrides["LOG_ROOT"] == str(base / "logs")
    assert overrides["ARCHIVE_SOURCE"] == "false"
    assert overrides["HWACCEL"] == "none"
    for value in overrides.values():
        assert "/.mount_" not in value
        assert "share/videohls-controlroom" not in value
    assert base.is_dir()


def test_checkout_launch_keeps_the_repo_work_tree(api, repo_root, monkeypatch):
    chosen = json.loads(api.setEnginePath(str(repo_root)))
    assert chosen["ok"], chosen
    monkeypatch.setattr(api, "_tools", lambda: {
        "ffmpeg": "/usr/bin/ffmpeg",
        "ffprobe": "/usr/bin/ffprobe",
        "python3": "/usr/bin/python3",
    })
    captured = _capture_launch(monkeypatch)
    ack = json.loads(api.launchRun(json.dumps({
        "INPUT_ROOT": str(repo_root / "video"),
        "HLS_ROOT": str(repo_root / "hls"),
        "HWACCEL": "none",
    })))
    assert ack["ok"] is True
    assert captured["cwd"] is None
    assert captured["overrides"]["WORK_ROOT"] == str(repo_root / "video-work")
    assert "Videos/curbstream" not in captured["overrides"]["WORK_ROOT"]


def test_packaged_stage_uses_the_home_tree_and_reports_read_only(api, tmp_path, monkeypatch):
    home = _install_packaged_engine(api, tmp_path, monkeypatch)
    src = tmp_path / "vacation.mp4"
    src.write_bytes(b"video-bytes")
    work = home / "Videos" / "curbstream"
    work.mkdir(parents=True)

    staged = json.loads(api.stageJob(json.dumps({
        "items": [{"src": str(src), "name": "Beach Day"}],
    })))
    assert staged["ok"], staged
    link = next((work / "jobs").rglob("Beach Day.mp4"))
    assert link.is_symlink()
    assert link.resolve() == src.resolve()
    assert "/.mount_" not in staged["input_root"]
    assert staged["input_root"].startswith(str(work))

    cleared = json.loads(api.clearJob(staged["input_root"]))
    assert cleared["ok"] is True
    assert src.read_bytes() == b"video-bytes"
    jobs = work / "jobs"
    if jobs.is_dir():
        jobs.chmod(0o555)
    work.chmod(0o555)
    try:
        probe = work / ".write-probe"
        try:
            probe.write_text("x")
        except OSError:
            pass
        else:
            probe.unlink()
            pytest.skip("this process can write a mode-555 directory")
        denied = json.loads(api.stageJob(json.dumps({
            "items": [{"src": str(src), "name": "Beach Day"}],
        })))
        assert denied["ok"] is False
        assert denied["input_root"] is None
        assert "Could not stage the videos" in denied["error"]
        assert src.read_bytes() == b"video-bytes"
        assert list(jobs.glob("*")) == []
    finally:
        if jobs.is_dir():
            jobs.chmod(0o755)
        work.chmod(0o755)
