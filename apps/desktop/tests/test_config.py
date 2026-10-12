"""Tests for config.py: spec tables vs the engine sources, validation
mirroring the engines' bash rejections, ladder parsing/formatting, root
resolution and app settings persistence."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from controlroom import config
from controlroom.config import (
    BATCH_SPECS,
    DEFAULT_LADDER,
    RUNSH_SPECS,
    LadderRow,
    format_ladder,
    load_app_settings,
    parse_ladder,
    resolve_roots,
    save_app_settings,
    validate,
)

ASSIGN = re.compile(r'^([A-Z_][A-Z0-9_]*)="\$\{\1:-(.*)\}"\s*(?:#.*)?$')

# Engine-source ground truth: every ${VAR:-default} line each script declares.
RUNSH_DECLARED = {
    m.group(1): m.group(2)
    for m in (ASSIGN.match(l) for l in (Path(__file__).parents[3] / "run.sh").read_text().splitlines())
    if m
}
BATCH_DECLARED = {
    m.group(1): m.group(2)
    for m in (ASSIGN.match(l) for l in (Path(__file__).parents[3] / "scripts" / "encode-batch.sh").read_text().splitlines())
    if m
}

KINDS = {"str", "int", "bool", "enum", "path", "bitrate", "ladder"}
GROUPS = {"paths", "codecs", "quality", "packaging", "ladder", "concurrency",
          "file-handling", "batch-paths", "batch-output", "batch-advanced"}


class TestSpecTables:
    def test_runsh_defaults_match_script(self):
        # ENV_FILE is the bootstrap variable, not a GUI setting; LADDER's
        # heredoc assignment is checked separately below.
        assert set(RUNSH_SPECS) - {"LADDER"} == set(RUNSH_DECLARED) - {"ENV_FILE"}
        for name, default in RUNSH_DECLARED.items():
            if name in RUNSH_SPECS:
                assert RUNSH_SPECS[name].default == default, name

    def test_batch_defaults_match_script(self):
        # The three inner work dirs derive from ENCODING_WORK_DIR inside the
        # script; they are intentionally not surfaced.
        skipped = {"ENCODING_SOURCE_DIR", "ENCODING_PARTIAL_DIR", "RESERVATION_DIR"}
        assert set(BATCH_SPECS) == set(BATCH_DECLARED) - skipped
        for name, default in BATCH_DECLARED.items():
            if name in BATCH_SPECS:
                assert BATCH_SPECS[name].default == default, name

    def test_default_ladder_matches_runsh_heredoc(self, repo_root):
        text = (repo_root / "run.sh").read_text()
        block = text.split("cat <<'LADDER_EOF'\n", 1)[1].split("\nLADDER_EOF", 1)[0]
        assert DEFAULT_LADDER == block + "\n"
        assert RUNSH_SPECS["LADDER"].default == DEFAULT_LADDER

    def test_defaults_differ_between_engines(self):
        for name, runsh, batch in [
            ("VIDEO_CODEC", "h264", "av1"),
            ("AUDIO_CODEC", "aac", "opus"),
            ("NVENC_PRESET", "p6", "p7"),
            ("SVTAV1_PRESET", "8", "6"),
            ("AOM_CPU_USED", "6", "5"),
            ("FFMPEG_LOGLEVEL", "error", "warning"),
        ]:
            assert RUNSH_SPECS[name].default == runsh
            assert BATCH_SPECS[name].default == batch

    def test_enum_choices(self):
        assert RUNSH_SPECS["VIDEO_CODEC"].choices == ("h264", "hevc", "av1")
        assert RUNSH_SPECS["AUDIO_CODEC"].choices == ("aac", "opus")
        assert BATCH_SPECS["AUDIO_CODEC"].choices == ("opus", "aac", "copy")
        assert RUNSH_SPECS["HWACCEL"].choices == BATCH_SPECS["HWACCEL"].choices
        assert RUNSH_SPECS["HWACCEL"].choices == (
            "auto", "nvenc", "qsv", "vaapi", "videotoolbox", "none")
        assert RUNSH_SPECS["HLS_PLAYLIST_TYPE"].choices == ("vod", "event")
        assert RUNSH_SPECS["HLS_SEGMENT_TYPE"].choices == ("auto", "mpegts", "fmp4")
        assert BATCH_SPECS["OUTPUT_EXTENSION"].choices == ("mkv", "mp4")
        assert RUNSH_SPECS["FFMPEG_LOGLEVEL"].choices == (
            "quiet", "error", "warning", "info", "verbose", "debug")

    def test_spec_metadata_complete(self):
        for specs in (RUNSH_SPECS, BATCH_SPECS):
            for name, spec in specs.items():
                assert spec.name == name
                assert spec.kind in KINDS, name
                assert spec.group in GROUPS, name
                assert spec.label, name
                assert spec.help, name
                if spec.kind == "enum":
                    assert spec.choices and spec.default in spec.choices, name
                if spec.kind == "bool":
                    assert spec.default in ("true", "false"), name

    def test_defaults_are_self_valid(self):
        assert validate(RUNSH_SPECS, {}) == []
        assert validate(BATCH_SPECS, {}) == []


class TestValidate:
    def test_enum_membership(self):
        errs = validate(RUNSH_SPECS, {"VIDEO_CODEC": "vp9"})
        assert any("VIDEO_CODEC" in e for e in errs)
        assert validate(RUNSH_SPECS, {"AUDIO_CODEC": "mp3"})
        assert validate(RUNSH_SPECS, {"HWACCEL": "cuda"})
        assert validate(BATCH_SPECS, {"OUTPUT_EXTENSION": "avi"})

    def test_mpegts_requires_h264_aac(self):
        msg = "HLS_SEGMENT_TYPE=mpegts only supports h264+aac"
        assert msg in validate(RUNSH_SPECS, {"HLS_SEGMENT_TYPE": "mpegts",
                                             "VIDEO_CODEC": "hevc"})
        assert msg in validate(RUNSH_SPECS, {"HLS_SEGMENT_TYPE": "mpegts",
                                             "AUDIO_CODEC": "opus"})
        assert msg not in validate(RUNSH_SPECS, {"HLS_SEGMENT_TYPE": "mpegts"})
        assert validate(RUNSH_SPECS, {"HLS_SEGMENT_TYPE": "mpegts",
                                      "VIDEO_CODEC": "h264",
                                      "AUDIO_CODEC": "aac"}) == []
        # auto upgrades silently for hevc; only mpegts is rejected.
        assert validate(RUNSH_SPECS, {"HLS_SEGMENT_TYPE": "auto",
                                      "VIDEO_CODEC": "hevc"}) == []

    def test_int_fields(self):
        for bad in ("fast", "2.5", ""):
            assert any("QUALITY" in e for e in validate(RUNSH_SPECS, {"QUALITY": bad})), bad
        assert validate(RUNSH_SPECS, {"QUALITY": "23", "HLS_TIME": "4"}) == []

    def test_bools_are_literal(self):
        for bad in ("True", "yes", "1", ""):
            errs = validate(RUNSH_SPECS, {"SKIP_EXISTING": bad})
            assert any("SKIP_EXISTING" in e for e in errs), bad
        assert validate(RUNSH_SPECS, {"SKIP_EXISTING": "false",
                                       "ARCHIVE_SOURCE": "true"}) == []

    def test_bitrate(self):
        assert validate(BATCH_SPECS, {"AUDIO_BITRATE": "160"}) == []
        assert validate(BATCH_SPECS, {"AUDIO_BITRATE": "160k"}) == []
        assert validate(BATCH_SPECS, {"AUDIO_BITRATE": "2M"}) == []
        assert validate(BATCH_SPECS, {"AUDIO_BITRATE": "160x"})
        assert validate(BATCH_SPECS, {"AUDIO_BITRATE": "k"})

    def test_ladder_window(self):
        # MIN must sit below MAX, mirroring run.sh's effective ladder check.
        errs = validate(RUNSH_SPECS, {"MIN_RESOLUTION_HEIGHT": "2000"})
        assert any("must be below" in e for e in errs)
        # Default window keeps the 360..1080 tiers.
        assert validate(RUNSH_SPECS, {}) == []
        # A window that excludes every tier is rejected like run.sh does.
        errs = validate(RUNSH_SPECS, {"MIN_RESOLUTION_HEIGHT": "2170",
                                       "MAX_RESOLUTION_HEIGHT": "4000"})
        assert any(e.startswith("no ladder tiers between MIN_RESOLUTION_HEIGHT=2170 "
                                "and MAX_RESOLUTION_HEIGHT=4000.") for e in errs)
        errs = validate(RUNSH_SPECS, {"MIN_RESOLUTION_HEIGHT": "361",
                                       "MAX_RESOLUTION_HEIGHT": "479"})
        assert any("no ladder tiers between" in e for e in errs)

    def test_ladder_row_errors_surface(self):
        bad = DEFAULT_LADDER + "1080p 1080 1920 5000k\n"
        errs = validate(RUNSH_SPECS, {"LADDER": bad})
        assert any("LADDER" in e and "expected 7 columns" in e for e in errs)

    def test_parallel_jobs_warning(self):
        errs = validate(BATCH_SPECS, {"PARALLEL_JOBS": "12"})
        assert errs and errs[0].startswith("warning:")
        assert validate(BATCH_SPECS, {"PARALLEL_JOBS": "8"}) == []
        assert validate(BATCH_SPECS, {"PARALLEL_JOBS": "four"})

    def test_validate_never_raises_on_garbage(self):
        assert isinstance(validate(RUNSH_SPECS, {"LADDER": "\x00\xff"}), list)


class TestLadder:
    def test_parse_default(self):
        rows, errs = parse_ladder(DEFAULT_LADDER)
        assert errs == []
        assert rows == [
            LadderRow("240p", 240, 426, "400k", "600k", "900k", "64k"),
            LadderRow("360p", 360, 640, "800k", "1200k", "1800k", "96k"),
            LadderRow("480p", 480, 854, "1400k", "2100k", "3000k", "128k"),
            LadderRow("720p", 720, 1280, "2800k", "4200k", "6000k", "128k"),
            LadderRow("1080p", 1080, 1920, "5000k", "7500k", "10000k", "192k"),
            LadderRow("1440p", 1440, 2560, "9000k", "13500k", "18000k", "192k"),
            LadderRow("2160p", 2160, 3840, "16000k", "24000k", "32000k", "256k"),
        ]

    def test_format_default_roundtrip(self):
        rows, errs = parse_ladder(DEFAULT_LADDER)
        assert errs == []
        assert format_ladder(rows) == DEFAULT_LADDER

    def test_parse_skips_blank_and_comments(self):
        rows, errs = parse_ladder("\n# comment\n   \n  # indented\n" + DEFAULT_LADDER)
        assert errs == []
        assert len(rows) == 7

    def test_parse_collects_errors_and_keeps_good_rows(self):
        text = (
            "240p 240 426 400k 600k 900k 64k\n"
            "broken row\n"
            "360p three 640 800k 1200k 1800k 96k\n"
            "480p 480 854 1400X 2100k 3000k 128k\n"
            "# 720p 720 1280 2800k 4200k 6000k 128k\n"
        )
        rows, errs = parse_ladder(text)
        assert [r.label for r in rows] == ["240p"]
        assert len(errs) == 3
        assert "expected 7 columns" in errs[0]
        assert "height and width" in errs[1]
        assert "not a bitrate" in errs[2]

    def test_format_widens_for_custom_labels(self):
        rows, _ = parse_ladder("cinema-1080p 1080 1920 5000k 7500k 10000k 192k")
        out = format_ladder(rows)
        assert out == "cinema-1080p 1080 1920  5000k  7500k 10000k  192k\n"
        assert format_ladder(parse_ladder(out)[0]) == out  # stable


class TestResolveRoots:
    def test_defaults_anchor_to_engine_root(self, tmp_path):
        roots = resolve_roots(tmp_path, {})
        assert roots["input"] == tmp_path / "video"
        assert roots["hls"] == tmp_path / "hls"
        assert roots["work"] == tmp_path / "video-work"
        assert roots["processed"] == tmp_path / "video-done"
        assert roots["encoded"] == tmp_path / "video-work" / "encoded"
        assert roots["state"] == tmp_path / "video-work" / "state"
        assert roots["logs"] == tmp_path / "video-work" / "logs"

    def test_relative_override_anchors_to_engine_root(self, tmp_path):
        roots = resolve_roots(tmp_path, {"INPUT_ROOT": "in", "HLS_ROOT": "./out"})
        assert roots["input"] == tmp_path / "in"
        assert roots["hls"] == tmp_path / "out"

    def test_absolute_paths_pass_through(self, tmp_path):
        roots = resolve_roots(tmp_path, {"INPUT_ROOT": "/srv/videos",
                                         "LOG_ROOT": "/var/log/vhls"})
        assert roots["input"] == Path("/srv/videos")
        assert roots["logs"] == Path("/var/log/vhls")

    def test_posix_resolution_against_wsl_engine_root(self):
        # Windows: PurePosixPath + the /mnt/... engine root, so Linux
        # absolutes are absolute (a WindowsPath would mis-anchor them)
        # and slashes never become backslashes.
        from pathlib import PurePosixPath
        roots = resolve_roots("/mnt/c/app/engine", {
            "INPUT_ROOT": "/home/u/video",
            "HLS_ROOT": "out",
        }, pathcls=PurePosixPath)
        assert roots["input"] == PurePosixPath("/home/u/video")
        assert roots["hls"] == PurePosixPath("/mnt/c/app/engine/out")
        assert all("\\" not in str(v) for v in roots.values())
        assert roots["logs"] == PurePosixPath(
            "/mnt/c/app/engine/video-work/logs")

    def test_work_root_override_flows_into_derived_roots(self, tmp_path):
        roots = resolve_roots(tmp_path, {"WORK_ROOT": "mywork"})
        assert roots["work"] == tmp_path / "mywork"
        assert roots["encoded"] == tmp_path / "mywork" / "encoded"

    def test_explicit_derived_override_wins(self, tmp_path):
        roots = resolve_roots(tmp_path, {"ENCODED_ROOT": "/srv/enc"})
        assert roots["encoded"] == Path("/srv/enc")
        # The symbolic default expression resolves via the work root too.
        roots = resolve_roots(tmp_path, {"ENCODED_ROOT": "$WORK_ROOT/encoded",
                                         "WORK_ROOT": "w"})
        assert roots["encoded"] == tmp_path / "w" / "encoded"

    def test_packaged_defaults_use_the_home_videos_tree(self, tmp_path, monkeypatch):
        monkeypatch.setattr(config.Path, "home", staticmethod(lambda: tmp_path))
        engine = "/tmp/.mount_CurbStoFkLIN/usr/bin/share/videohls-controlroom/engine"
        roots = resolve_roots(engine, {})
        base = tmp_path / "Videos" / "curbstream"
        assert roots["work"] == base
        assert roots["hls"] == base / "hls"
        assert roots["processed"] == base / "video-done"
        assert roots["input"] == base / "video"
        assert roots["encoded"] == base / "encoded"
        assert roots["state"] == base / "state"
        assert roots["logs"] == base / "logs"
        assert all("/.mount_" not in str(path) for path in roots.values())
        assert all("share/videohls-controlroom" not in str(path) for path in roots.values())

    def test_packaged_engine_keeps_an_outside_absolute_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr(config.Path, "home", staticmethod(lambda: tmp_path))
        engine = "/tmp/.mount_CurbStoFkLIN/usr/bin/share/videohls-controlroom/engine"
        roots = resolve_roots(engine, {"HLS_ROOT": "/home/ubuntu/Videos/maammy"})
        assert roots["hls"] == Path("/home/ubuntu/Videos/maammy")
        assert roots["work"] == tmp_path / "Videos" / "curbstream"

    def test_installed_share_tree_is_packaged_too(self, tmp_path, monkeypatch):
        monkeypatch.setattr(config.Path, "home", staticmethod(lambda: tmp_path))
        engine = "/opt/CurbStream/share/videohls-controlroom/engine"
        roots = resolve_roots(engine, {})
        assert roots["work"] == tmp_path / "Videos" / "curbstream"
        batch = config.relocate_batch_path(
            engine, "ENCODING_WORK_DIR", f"{engine}/encode-working")
        assert batch == tmp_path / "Videos" / "curbstream" / "batch" / "encode-working"

    def test_empty_value_falls_back_to_default(self, tmp_path):
        roots = resolve_roots(tmp_path, {"INPUT_ROOT": ""})
        assert roots["input"] == tmp_path / "video"


class TestAppSettings:
    def test_roundtrip_and_missing(self, tmp_path, monkeypatch):
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
        assert load_app_settings() == {}
        settings = {"engine_path": "/repo", "ffmpeg_dir": "/usr/bin",
                    "window_size": [1280, 800], "last_view": "library",
                    "bundled_roots_base": "/srv"}
        save_app_settings(settings)
        assert load_app_settings() == settings

    def test_corrupt_file_yields_empty(self, tmp_path, monkeypatch):
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
        path = tmp_path / "videohls-controlroom" / "app.json"
        path.parent.mkdir(parents=True)
        path.write_text("{not json")
        assert load_app_settings() == {}

    def test_xdg_default_location(self, tmp_path, monkeypatch):
        monkeypatch.setenv("XDG_CONFIG_HOME", "")
        monkeypatch.setattr(config.Path, "home", staticmethod(lambda: tmp_path))
        save_app_settings({"a": 1})
        assert (tmp_path / ".config" / "videohls-controlroom" / "app.json").exists()
