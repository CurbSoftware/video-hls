"""EngineRunner against stub engines (no real ffmpeg), plus FileTail."""

import os
import stat
import threading
import time
from pathlib import Path

import pytest

from controlroom import engine_paths
from controlroom.engine_paths import EnginePaths
from controlroom.runner import EngineBusy, EngineRunner
from controlroom.tail import FileTail


# --- engine_paths ---------------------------------------------------------


def test_locate_engine_bundled_dev_checkout():
    """From this repo's tests, the bundled engine is the repo itself."""
    paths, err = engine_paths.locate_engine({})
    assert err is None and paths is not None
    assert paths.source == "bundled"
    assert paths.run_sh.is_file()
    assert paths.encode_batch.is_file()
    assert paths.env_example.is_file()


def test_locate_engine_external(tmp_path):
    (tmp_path / "run.sh").write_text("#!/usr/bin/env bash\n")
    paths, err = engine_paths.locate_engine({"engine_path": str(tmp_path)})
    assert err is None
    assert paths.source == "external"
    assert paths.root == tmp_path


def test_locate_engine_bad_external(tmp_path):
    paths, err = engine_paths.locate_engine({"engine_path": str(tmp_path / "missing")})
    assert paths is None and "run.sh" in err


def test_engine_version_manifest_and_hash(tmp_path):
    (tmp_path / "run.sh").write_text("#!/usr/bin/env bash\n")
    engine = EnginePaths(root=tmp_path, source="external")
    hashed = engine_paths.engine_version(engine)
    assert hashed.startswith("sha256-") and len(hashed.split()[0]) == 15

    (tmp_path / "ENGINE_MANIFEST").write_text("abc123+deadbeef…2026-08-15\nline two\n")
    assert engine_paths.engine_version(engine) == "abc123+deadbeef…2026-08-15"

    gone = EnginePaths(root=tmp_path / "nowhere", source="external")
    assert engine_paths.engine_version(gone).startswith("unknown")


def write_engine(tmp_path: Path, run_sh: str, batch_sh: str = "exit 0") -> EnginePaths:
    root = tmp_path / "engine"
    (root / "scripts").mkdir(parents=True)
    (root / "run.sh").write_text("#!/usr/bin/env bash\n" + run_sh)
    (root / "scripts" / "encode-batch.sh").write_text("#!/usr/bin/env bash\n" + batch_sh)
    return EnginePaths(root=root, source="external")


def wait_for(predicate, timeout=10.0, what="condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(f"timeout waiting for {what}")


def run_to_completion(engine, **kwargs):
    lines, done = [], {}
    event = threading.Event()
    handle = engine.launch(
        on_line=lines.append,
        on_done=lambda rc: (done.__setitem__("rc", rc), event.set()),
        **kwargs,
    )
    assert event.wait(10), "on_done never fired"
    return handle, lines, done["rc"]


# --- line delivery ---------------------------------------------------------


def test_lines_in_order_with_cr_endings(tmp_path):
    engine = EngineRunner(
        write_engine(
            tmp_path,
            run_sh="printf 'alpha\\nbeta\\r' ; printf 'gamma\\r\\nfinal no newline'",
        )
    )
    _, lines, rc = run_to_completion(engine, kind="runsh")
    assert lines == ["alpha", "beta", "gamma", "final no newline"]
    assert rc == 0


def test_ansi_escapes_stripped(tmp_path):
    engine = EngineRunner(
        write_engine(tmp_path, run_sh="printf '\\033[31mred\\033[0m plain\\n'")
    )
    _, lines, _ = run_to_completion(engine, kind="runsh")
    assert lines == ["red plain"]


def test_mode_maps_to_arguments(tmp_path):
    root = tmp_path / "engine"
    engine = EngineRunner(
        write_engine(tmp_path, run_sh='printf "%s\\n" "$@" > "$ARGDUMP"')
    )
    # printf '%s\n' with zero args still emits one bare newline.
    for mode, expected in [("check", "--check\n"), ("dry-run", "--dry-run\n"), ("run", "\n"), (None, "\n")]:
        args_file = root / "args.txt"
        args_file.write_text("")
        handle, _, rc = run_to_completion(
            engine, kind="runsh", mode=mode, overrides={"ARGDUMP": str(args_file)}
        )
        assert rc == 0
        assert args_file.read_text() == expected, f"mode={mode!r}"


def test_return_code_passthrough(tmp_path):
    engine = EngineRunner(write_engine(tmp_path, run_sh="exit 42"))
    _, _, rc = run_to_completion(engine, kind="runsh")
    assert rc == 42


def test_missing_script_reports_nonzero(tmp_path):
    # Engine dir exists (so cwd is valid) but holds no run.sh.
    empty_root = tmp_path / "empty-engine"
    empty_root.mkdir()
    engine = EngineRunner(write_engine(tmp_path, run_sh="exit 0"))
    engine.engine = EnginePaths(root=empty_root, source="external")
    _, _, rc = run_to_completion(engine, kind="runsh")
    assert rc != 0


# --- single-flight ----------------------------------------------------------


def test_second_launch_raises_engine_busy(tmp_path):
    engine = EngineRunner(write_engine(tmp_path, run_sh="echo started; sleep 5"))
    lines, event = [], threading.Event()
    engine.launch(kind="runsh", on_line=lines.append, on_done=lambda rc: event.set())
    wait_for(lambda: lines, what="stub output")
    assert engine.is_busy()
    with pytest.raises(EngineBusy):
        engine.launch(kind="runsh", mode="check")
    with pytest.raises(EngineBusy):
        engine.launch(kind="batch", cwd=tmp_path)
    engine.cancel()
    assert event.wait(10)


def test_busy_covers_batch_too(tmp_path):
    engine = EngineRunner(
        write_engine(tmp_path, run_sh="exit 0", batch_sh="echo work; sleep 5")
    )
    lines, event = [], threading.Event()
    engine.launch(kind="batch", cwd=tmp_path, on_line=lines.append, on_done=lambda rc: event.set())
    wait_for(lambda: lines, what="stub output")
    with pytest.raises(EngineBusy):
        engine.launch(kind="runsh")
    engine.cancel()
    assert event.wait(10)


# --- cancel ------------------------------------------------------------------


def test_cancel_kills_stuck_engine(tmp_path):
    engine = EngineRunner(write_engine(tmp_path, run_sh="echo go; sleep 999"))
    lines, done = [], {}
    event = threading.Event()
    engine.launch(kind="runsh", on_line=lines.append,
                  on_done=lambda rc: (done.__setitem__("rc", rc), event.set()))
    wait_for(lambda: lines, what="stub output")
    assert engine.cancel() is True
    assert event.wait(10), "on_done never fired after cancel"
    assert done["rc"] != 0
    wait_for(lambda: not engine.is_busy(), what="engine to die")
    assert engine.cancel() is False  # idle now, nothing to cancel


def test_cancel_while_idle_returns_false(tmp_path):
    engine = EngineRunner(write_engine(tmp_path, run_sh="exit 0"))
    assert engine.cancel() is False


def test_batch_cancel_exit_130_passthrough(tmp_path):
    # encode-batch traps SIGTERM and exits 130; the runner reports it as-is.
    batch = "trap 'echo bye; exit 130' TERM; echo go; sleep 999 & wait"
    engine = EngineRunner(write_engine(tmp_path, run_sh="exit 0", batch_sh=batch))
    lines, done = [], {}
    event = threading.Event()
    engine.launch(kind="batch", cwd=tmp_path, on_line=lines.append,
                  on_done=lambda rc: (done.__setitem__("rc", rc), event.set()))
    wait_for(lambda: lines, what="stub output")
    engine.cancel()
    assert event.wait(10)
    assert done["rc"] == 130


# --- environment ---------------------------------------------------------------


def test_env_file_and_overrides_reach_child(tmp_path):
    env_file = tmp_path / "gui.env"
    env_file.write_text("HLS_ROOT=/from/env/file\n")
    engine = EngineRunner(
        write_engine(
            tmp_path,
            run_sh="env | grep -E '^(ENV_FILE|VIDEO_CODEC|HLS_ROOT)=' | sort",
        ),
        env_file=env_file,
    )
    _, lines, rc = run_to_completion(
        engine,
        kind="runsh",
        overrides={"VIDEO_CODEC": "hevc", "HLS_ROOT": "/from/override"},
    )
    assert rc == 0
    assert lines == [
        f"ENV_FILE={env_file}",
        "HLS_ROOT=/from/override",
        "VIDEO_CODEC=hevc",
    ]


def test_overrides_beat_outer_environment(tmp_path):
    os.environ["CONTROLROOM_TEST_VAR"] = "outer"
    try:
        engine = EngineRunner(
            write_engine(tmp_path, run_sh="echo \"$CONTROLROOM_TEST_VAR\"")
        )
        _, lines, _ = run_to_completion(
            engine, kind="runsh", overrides={"CONTROLROOM_TEST_VAR": "wins"}
        )
        assert lines == ["wins"]
    finally:
        del os.environ["CONTROLROOM_TEST_VAR"]


# --- reader robustness -----------------------------------------------------------


def test_on_line_crash_kills_engine_and_reports_minus_one(tmp_path):
    engine = EngineRunner(write_engine(tmp_path, run_sh="echo boom; sleep 5"))

    def broken(_line):
        raise ValueError("GUI callback bug")

    done = {}
    event = threading.Event()
    engine.launch(kind="runsh", on_line=broken,
                  on_done=lambda rc: (done.__setitem__("rc", rc), event.set()))
    assert event.wait(10)
    assert done["rc"] == -1
    wait_for(lambda: not engine.is_busy(), what="engine killed after reader crash")


def test_on_line_none_still_drains(tmp_path):
    # No callbacks at all: the pipe must still be drained or the child
    # would block on a full pipe.
    engine = EngineRunner(write_engine(
        tmp_path, run_sh="for i in $(seq 1 3000); do echo \"line $i\"; done"
    ))
    _, _, rc = run_to_completion(engine, kind="runsh")
    assert rc == 0


# --- tools_ok ----------------------------------------------------------------------


def test_tools_ok_finds_real_tools(tmp_path):
    engine = EngineRunner(write_engine(tmp_path, run_sh="exit 0"))
    tools = engine.tools_ok()
    assert set(tools) == {"ffmpeg", "ffprobe", "python3"}
    assert tools["python3"]


def test_tools_ok_prepends_directory(tmp_path):
    fake_dir = tmp_path / "bin"
    fake_dir.mkdir()
    fake = fake_dir / "ffmpeg"
    fake.write_text("#!/bin/sh\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    engine = EngineRunner(write_engine(tmp_path, run_sh="exit 0"))
    assert engine.tools_ok(ffmpeg_dir=fake_dir)["ffmpeg"] == str(fake)


# --- FileTail -------------------------------------------------------------------------


def test_tail_streams_appended_lines(tmp_path):
    log = tmp_path / "job.log"
    log.write_text("existing line\n")
    received = []
    ready = threading.Event()
    tail = FileTail(interval=0.05)

    def on_line(line):
        received.append(line)
        if line == "second append":
            ready.set()

    tail.start(log, on_line)
    try:
        # Existing content arrives first (tail -f -n +1 semantics), then
        # whatever gets appended while tailing.
        with open(log, "a") as fh:
            fh.write("first append\n")
            fh.flush()
            fh.write("second append\n")
            fh.flush()
        assert ready.wait(10), f"only got {received}"
        assert received[:3] == ["existing line", "first append", "second append"]
    finally:
        tail.stop()
    time.sleep(0.2)  # a poll interval passes...
    with open(log, "a") as fh:
        fh.write("after stop\n")
    time.sleep(0.3)
    assert "after stop" not in received  # ...and nothing more arrives


def test_tail_missing_then_created(tmp_path):
    log = tmp_path / "not-yet.log"
    received = []
    created = threading.Event()
    tail = FileTail(interval=0.05)
    tail.start(log, lambda line: (received.append(line), created.set()))
    try:
        time.sleep(0.15)
        log.write_text("finally here\n")
        assert created.wait(10)
        assert received == ["finally here"]
    finally:
        tail.stop()


def test_tail_stop_idempotent(tmp_path):
    tail = FileTail()
    tail.start(tmp_path / "x.log", lambda line: None)
    tail.stop()
    tail.stop()
