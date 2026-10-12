"""Wizard probe classification, folder names, and symlink staging."""

from pathlib import Path

import pytest

from controlroom import convert, ffprobe


def test_classify_convertible_audio_only_and_unreadable():
    ok, reason = convert.classify(True, {
        "width": 1280, "height": 720, "codec": "h264", "error": None,
    })
    assert ok and reason is None

    ok, reason = convert.classify(True, {
        "width": None, "height": None, "codec": None, "has_audio": True, "error": None,
    })
    assert not ok and "Audio only" in reason

    ok, reason = convert.classify(True, {"error": "ffprobe: exit 1", "has_audio": None})
    assert not ok and "Could not read" in reason

    ok, reason = convert.classify(False, {"width": 10, "height": 10, "codec": "h264"})
    assert not ok and "Not a video" in reason


def test_name_rules():
    assert convert.name_error("Beach Day") is None
    assert convert.name_error("") is not None
    assert convert.name_error("  ") is not None
    assert convert.name_error(".") is not None
    assert convert.name_error("..") is not None
    assert convert.name_error("a/b") is not None
    assert convert.name_error("a\\b") is not None
    assert convert.name_error(" lead") is not None


def test_probe_skips_non_video_and_keeps_a_bad_video(tmp_path, monkeypatch):
    (tmp_path / "notes.txt").write_text("hello")
    (tmp_path / "clip.mp4").write_bytes(b"x")
    (tmp_path / "song.mp4").write_bytes(b"x")

    def fake_probe(path, *args, **kwargs):
        if Path(path).name == "song.mp4":
            return ffprobe.MediaInfo(has_audio=True)
        return ffprobe.MediaInfo(width=640, height=360, codec="h264", has_audio=False)

    monkeypatch.setattr(ffprobe, "probe", fake_probe)
    report = convert.probe_path(tmp_path, "ffprobe")
    by_rel = {item["rel"]: item for item in report["items"]}
    assert "notes.txt" not in by_rel
    assert by_rel["clip.mp4"]["convertible"] is True
    assert by_rel["song.mp4"]["convertible"] is False
    assert "Audio only" in by_rel["song.mp4"]["reason"]


def test_single_non_video_is_reported(tmp_path):
    text = tmp_path / "readme.txt"
    text.write_text("nope")
    report = convert.probe_path(text, "ffprobe")
    assert report["items"][0]["convertible"] is False
    assert report["items"][0]["reason"]


def test_stage_symlink_and_clear_job(tmp_path):
    src = tmp_path / "orig" / "vacation.mp4"
    src.parent.mkdir()
    src.write_bytes(b"video-bytes")
    work = tmp_path / "work"
    work.mkdir()

    bad = convert.stage_job(work, [
        {"src": str(src), "name": "Beach"},
        {"src": str(src), "name": "Beach"},
    ])
    assert bad["ok"] is False
    assert not (work / "jobs").exists()

    result = convert.stage_job(work, [{"src": str(src), "name": "Beach Day"}])
    assert result["ok"], result
    link = Path(result["input_root"]) / "Beach Day.mp4"
    assert link.is_symlink()
    assert link.resolve() == src.resolve()
    assert src.read_bytes() == b"video-bytes"

    assert convert.clear_job(work, str(tmp_path))["ok"] is False
    assert link.exists()
    assert convert.clear_job(work, result["input_root"])["ok"] is True
    assert src.is_file()
    assert not link.exists()


def test_builtin_ladder_matches_the_engine_default():
    labels = [row["label"] for row in convert.builtin_ladder()]
    assert labels == ["240p", "360p", "480p", "720p", "1080p", "1440p", "2160p"]
    assert convert.builtin_ladder()[4]["height"] == 1080


def test_stage_creates_a_missing_work_directory(tmp_path):
    src = tmp_path / "clip.mp4"
    src.write_bytes(b"x")
    work = tmp_path / "Videos" / "curbstream"
    result = convert.stage_job(work, [{"src": str(src), "name": "Clip"}])
    assert result["ok"], result
    assert work.is_dir()
    assert Path(result["input_root"]).is_relative_to(work)
    assert not str(result["input_root"]).startswith("/tmp/.mount_")


def test_existing_packages(tmp_path):
    (tmp_path / "Beach").mkdir()
    assert convert.existing_packages(tmp_path, ["Beach", "Other"]) == ["Beach"]
    assert convert.existing_packages(tmp_path / "missing", ["Beach"]) == []


def test_probe_missing_path_is_an_empty_report(tmp_path):
    report = convert.probe_path(tmp_path / "nope")
    assert report["items"] == []
    assert report["error"] == "not found"


def test_stage_rejects_empty_choice_and_a_missing_file(tmp_path):
    work = tmp_path / "Videos" / "curbstream"
    empty = convert.stage_job(work, [])
    assert empty["ok"] is False
    assert empty["input_root"] is None
    assert "at least one" in empty["error"]

    missing = convert.stage_job(work, [{
        "src": str(tmp_path / "gone.mp4"),
        "name": "Gone",
    }])
    assert missing["ok"] is False
    assert "Missing source" in missing["error"]
    assert not (work / "jobs").exists()


def test_stage_keeps_the_source_suffix(tmp_path):
    src = tmp_path / "clip.mov"
    src.write_bytes(b"mov")
    work = tmp_path / "Videos" / "curbstream"
    result = convert.stage_job(work, [{"src": str(src), "name": "Clip"}])
    assert result["ok"], result
    link = Path(result["input_root"]) / "Clip.mov"
    assert link.is_symlink()
    assert link.resolve() == src.resolve()
    assert Path(result["input_root"]).name == "in"
    assert Path(result["input_root"]).parent.parent == work / "jobs"


def test_stage_read_only_link_removes_the_partial_job(tmp_path):
    """A read-only failure while linking must not leave a half-built job
    and must not touch the originals."""
    first = tmp_path / "a.mp4"
    second = tmp_path / "b.mkv"
    first.write_bytes(b"a")
    second.write_bytes(b"b")
    work = tmp_path / "Videos" / "curbstream"
    seen = {"n": 0}

    def link(dest, src):
        seen["n"] += 1
        if seen["n"] == 2:
            raise OSError(30, "Read-only file system", str(dest))
        dest.symlink_to(src.resolve())

    result = convert.stage_job(work, [
        {"src": str(first), "name": "One"},
        {"src": str(second), "name": "Two"},
    ], link=link)
    assert result["ok"] is False
    assert result["input_root"] is None
    assert "Could not stage the videos" in result["error"]
    assert "Read-only file system" in result["error"]
    assert list(work.glob("jobs/*")) == []
    assert first.read_bytes() == b"a"
    assert second.read_bytes() == b"b"


def test_stage_fails_when_the_work_tree_cannot_be_created(tmp_path):
    src = tmp_path / "clip.mp4"
    src.write_bytes(b"x")
    blocked = tmp_path / "not-a-directory"
    blocked.write_text("file")
    work = blocked / "curbstream"
    result = convert.stage_job(work, [{"src": str(src), "name": "Clip"}])
    assert result["ok"] is False
    assert result["input_root"] is None
    assert "Could not stage the videos" in result["error"]
    assert src.read_bytes() == b"x"


def test_stage_fails_on_a_read_only_work_directory(tmp_path):
    src = tmp_path / "clip.mp4"
    src.write_bytes(b"x")
    work = tmp_path / "Videos" / "curbstream"
    work.mkdir(parents=True)
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
        result = convert.stage_job(work, [{"src": str(src), "name": "Clip"}])
        assert result["ok"] is False
        assert result["input_root"] is None
        assert "Could not stage the videos" in result["error"]
        assert list(work.glob("jobs/*")) == []
        assert src.read_bytes() == b"x"
    finally:
        work.chmod(0o755)


def test_clear_job_refuses_a_symlink_that_resolves_outside(tmp_path):
    work = tmp_path / "Videos" / "curbstream"
    jobs = work / "jobs"
    jobs.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (jobs / "alias").symlink_to(outside, target_is_directory=True)
    result = convert.clear_job(work, str(jobs / "alias" / "in"))
    assert result["ok"] is False
    assert "Refusing to delete" in result["error"]
    assert outside.is_dir()
