# AGENTS.md

Standalone bash video tooling: an HLS packaging pipeline plus a batch
re-encoder. No build system, no package manager, no test suite. Verify changes
by running the relevant script.

## Layout

- `run.sh` - the HLS pipeline. One self-contained script; this is the project.
- `.env.example` - documented config template. Users copy it to `.env`.
- `scripts/encode-batch.sh` - separate batch re-encoder producing plain files
  rather than HLS. Shares no code with `run.sh`.
- `README.md` - user-facing docs and the full settings reference.
- `video/` `hls/` `video-work/` `video-done/` - input, output, scratch, archive.
  All gitignored and generated at runtime.

## Running

```bash
./run.sh --check      # probe deps + encoders, encode nothing. Start here.
./run.sh --dry-run    # show the per-tier plan for each input
./run.sh              # process everything under INPUT_ROOT
```

Config precedence is **environment > `.env` > built-in defaults**. Every
setting is `${VAR:-default}`, so nothing is required and any value can be
overridden for one run:

```bash
VIDEO_CODEC=av1 AUDIO_CODEC=opus HWACCEL=none ./run.sh
```

`run.sh` resolves its own directory from `BASH_SOURCE` and resolves relative
paths against the repo, so it works from any cwd.

## Architecture

Per video: probe → encode ladder → package → publish → archive. Each stage
writes to a partial path and moves into place only on success.

- **One ladder, not two.** `LADDER` rows carry
  `label height width video_bitrate maxrate bufsize audio_bitrate` and drive
  both encoding and the master playlist, so a tier cannot be half-defined.
  Rows above `MAX_RESOLUTION_HEIGHT`, below `MIN_RESOLUTION_HEIGHT`, or taller
  than the source are dropped.
- **Encoder resolution is dynamic.** `VIDEO_CODEC` + `HWACCEL` resolve to a
  concrete ffmpeg encoder by trying candidates in order (nvenc → qsv → vaapi →
  videotoolbox → software) and *actually encoding a test frame* with each.
  Being compiled in does not mean the hardware is present. `VIDEO_ENCODER`
  bypasses this entirely.
- **Per-encoder flags are table-driven.** `build_encoder_args` and
  `build_gop_args` translate `QUALITY` and the GOP size into the right options
  per family (`-cq`, `-global_quality`, `-qp`, `-crf`; `-x264-params`,
  `-svtav1-params`, …). Adding an encoder means adding a case to both.
- **Segment container follows the codec.** MPEG-TS cannot carry HEVC, AV1 or
  Opus, so `HLS_SEGMENT_TYPE=auto` upgrades to fMP4 and the master playlist
  switches to `#EXT-X-VERSION:7`. Forcing `mpegts` with those codecs is
  rejected at startup.

## Invariants - do not break these

- **GOP alignment.** `GOP = round(fps × HLS_TIME)` is computed once per source
  and applied to every rendition. Packaging is `-c copy`, so ffmpeg can only
  cut at existing keyframes; identical GOPs are what make all tiers share
  segment boundaries and let players switch without stuttering. `HLS_TIME`
  feeds both the encode and the segmenter and must stay coupled.
- **`CODECS` is derived, never hardcoded.** Profile and level are read back
  from each encoded file, and the audio codec is appended only when the source
  actually has audio. A master playlist that advertises audio a stream does not
  contain is rejected by some players.
- **Atomic publish.** Build in `STATE_ROOT/hls-partials`, then
  `rm -rf FINAL && mv PARTIAL FINAL`. Never write into `HLS_ROOT` directly.
- **Failures never publish.** Any encode or packaging failure aborts that video
  before the move, and the source stays in `INPUT_ROOT` for retry. Packaging
  errors are checked - do not reintroduce `>/dev/null 2>&1` there.
- **Status files, not variables.** Background jobs report through
  `.status` files in a `mktemp -d`. The batch wrapper pre-writes `fail` and
  upgrades to `success`, because `fail()` exits the subshell outright and an
  `else` branch would never run.
- **`run.sh` stays one file.** The old numbered stage split (00/10/20/30) was
  collapsed deliberately. Do not reintroduce it.

## Gotchas

- `python3` is a hard runtime dependency: bash cannot evaluate `30000/1001 × 6`
  for the GOP size.
- `set -Eeuo pipefail` is on. `$SOME_BOOL && cmd` at top level aborts the script
  when the variable is false - use `if [[ "$VAR" == "true" ]]`.
- An EXIT trap referencing a function-local variable fires after that local is
  out of scope and dies under `set -u`. Clean up explicitly instead.
- `INPUT_ROOT` is canonicalised before the prefix-strip that derives output
  paths; a trailing slash or symlink would silently flatten the subfolder tree.

## Verifying changes

There is no test suite. `bash -n run.sh` catches syntax. Beyond that, generate
throwaway input and run the thing:

```bash
mkdir -p /tmp/vt/in
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=25:duration=6 \
       -f lavfi -i sine=duration=6 -c:v libx264 -c:a aac -shortest /tmp/vt/in/a.mp4

INPUT_ROOT=/tmp/vt/in HLS_ROOT=/tmp/vt/out WORK_ROOT=/tmp/vt/work \
  PROCESSED_ROOT=/tmp/vt/done ./run.sh

# the real check: does it decode, and do tiers share segment boundaries?
ffmpeg -v fatal -allowed_extensions ALL -i /tmp/vt/out/a/master.m3u8 -f null -
grep -o '#EXTINF:[0-9.]*' /tmp/vt/out/a/*/index.m3u8
```

Always test at least one software path (`HWACCEL=none`) alongside any hardware
path - most contributors and CI machines have no GPU.

## Publishing

This is a public repository. Nothing machine-specific belongs in a commit:
`.env` is gitignored, `.env.example` carries the documented defaults, and the
generated trees are ignored. Keep absolute paths and personal directory names
out of tracked files.
