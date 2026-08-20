"""Tests for envfile.py: quoting, round-trips, minimal diff, atomicity."""

from __future__ import annotations

import os

import pytest

from controlroom import envfile
from controlroom.config import HELP_HEADER, RUNSH_SPECS


def default_values(specs):
    return {name: spec.default for name, spec in specs.items()}


def test_env_example_roundtrip(tmp_path, env_example_values):
    # .env.example documents the defaults, so every value must equal the
    # spec default (LADDER is commented out there, hence absent).
    for name, value in env_example_values.items():
        assert name in RUNSH_SPECS, f"unknown key in .env.example: {name}"
        assert value == RUNSH_SPECS[name].default, name

    target = tmp_path / ".env"
    envfile.write_env(target, env_example_values, RUNSH_SPECS, tmp_path, HELP_HEADER)

    # All values equal defaults -> a minimal-diff file has no managed lines.
    assert envfile.read_env(target) == {}
    # The engine's regex default survives the ${...} unwrapping verbatim.
    assert "VIDEO_EXTENSIONS_REGEX" not in envfile.read_env(target).keys()


def test_only_diff_keys_written(tmp_path):
    values = default_values(RUNSH_SPECS)
    values["VIDEO_CODEC"] = "av1"
    values["QUALITY"] = "30"
    target = tmp_path / ".env"
    envfile.write_env(target, values, RUNSH_SPECS, tmp_path, HELP_HEADER)

    written = envfile.read_env(target)
    assert written == {"VIDEO_CODEC": "av1", "QUALITY": "30"}
    text = target.read_text()
    assert 'VIDEO_CODEC="${VIDEO_CODEC:-av1}"' in text
    assert 'QUALITY="${QUALITY:-30}"' in text
    assert text.startswith("#")  # header regenerated
    # Removing an override (back to default) drops the line on rewrite.
    values["QUALITY"] = RUNSH_SPECS["QUALITY"].default
    envfile.write_env(target, values, RUNSH_SPECS, tmp_path, HELP_HEADER)
    assert envfile.read_env(target) == {"VIDEO_CODEC": "av1"}


def test_torture_values_roundtrip(tmp_path):
    values = default_values(RUNSH_SPECS)
    values["VIDEO_ENCODER"] = 'lib"x264`$\\'
    values["INPUT_ROOT"] = "/tmp/a dir/ünïcode"
    values["X264_PRESET"] = ""  # empty string must survive as an override
    values["HLS_ROOT"] = "${WEIRD} brace"
    values["VIDEO_EXTENSIONS_REGEX"] = r".*\.(mp4|mkv)$"
    target = tmp_path / ".env"
    envfile.write_env(target, values, RUNSH_SPECS, tmp_path, HELP_HEADER)

    overridden = {k: v for k, v in values.items() if v != RUNSH_SPECS[k].default}
    assert envfile.read_env(target) == overridden
    # Escaping is really present in the file, not just invisible.
    raw = target.read_text()
    assert 'VIDEO_ENCODER="${VIDEO_ENCODER:-lib\\"x264\\`\\$\\\\}"' in raw
    assert 'X264_PRESET="${X264_PRESET:-}"' in raw


def test_written_file_is_valid_bash(tmp_path):
    """The file is sourced by bash; let bash itself be the judge."""
    values = default_values(RUNSH_SPECS)
    values["VIDEO_EXTENSIONS_REGEX"] = r".*\.(mp4|mkv)$"
    values["INPUT_ROOT"] = "/tmp/a dir"
    target = tmp_path / ".env"
    envfile.write_env(target, values, RUNSH_SPECS, tmp_path, HELP_HEADER)

    import subprocess
    res = subprocess.run(
        ["bash", "-c", f'source "{target}" && printf "%s\\n" "$VIDEO_EXTENSIONS_REGEX" "$INPUT_ROOT"'],
        capture_output=True, text=True,
    )
    assert res.returncode == 0, res.stderr
    assert res.stdout == r".*\.(mp4|mkv)$" + "\n/tmp/a dir\n"


def test_unknown_and_comment_lines_preserved(tmp_path):
    existing = (
        "# old header line one\n"
        "# old header line two\n"
        'VIDEO_CODEC="${VIDEO_CODEC:-hevc}"\n'
        "\n"
        "# hand-written note\n"
        'MY_CUSTOM_VAR="keep me $verbatim"\n'
        "GARBAGE LINE WITHOUT EQUALS\n"
    )
    target = tmp_path / ".env"
    target.write_text(existing)

    values = default_values(RUNSH_SPECS)
    values["VIDEO_CODEC"] = "av1"
    envfile.write_env(target, values, RUNSH_SPECS, tmp_path, HELP_HEADER)

    text = target.read_text()
    assert "# hand-written note" in text
    assert 'MY_CUSTOM_VAR="keep me $verbatim"' in text
    assert "GARBAGE LINE WITHOUT EQUALS" in text
    assert "old header line" not in text  # header replaced
    assert 'hevc' not in text  # old managed value replaced
    assert 'VIDEO_CODEC="${VIDEO_CODEC:-av1}"' in text


def test_env_preview_matches_written_file(tmp_path):
    values = default_values(RUNSH_SPECS)
    values["VIDEO_CODEC"] = "hevc"
    target = tmp_path / ".env"
    envfile.write_env(target, values, RUNSH_SPECS, tmp_path, HELP_HEADER)
    assert envfile.env_preview(values, RUNSH_SPECS, tmp_path, HELP_HEADER) == target.read_text()


def test_write_is_atomic_on_failure(tmp_path):
    target = tmp_path / ".env"
    target.write_text("ORIGINAL\n")
    values = default_values(RUNSH_SPECS)
    values["VIDEO_CODEC"] = "co\ndec"  # newlines cannot round-trip
    with pytest.raises(ValueError):
        envfile.write_env(target, values, RUNSH_SPECS, tmp_path, HELP_HEADER)
    assert target.read_text() == "ORIGINAL\n"
    assert [p.name for p in tmp_path.iterdir()] == [".env"]  # no tmp litter


def test_env_file_path(tmp_path, monkeypatch):
    engine = tmp_path / "engine"
    engine.mkdir()
    assert envfile.env_file_path(engine) == engine / ".env"

    config_home = tmp_path / "config"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(config_home))
    monkeypatch.setattr(os, "access", lambda *a, **k: False)
    assert envfile.env_file_path(engine) == config_home / "videohls-controlroom" / "engine.env"


def test_read_env_missing_file(tmp_path):
    assert envfile.read_env(tmp_path / "nope.env") == {}
