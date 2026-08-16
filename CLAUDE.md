# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

Layout, architecture, invariants and the verification recipe are documented
above. This file adds only what is not there.

## Commands

```bash
./run.sh --check      # probe deps + encoders. Run this before diagnosing anything.
./run.sh --dry-run    # per-tier plan for every input, no encoding
./run.sh              # full pipeline
bash -n run.sh        # syntax check — the closest thing to a test
shellcheck run.sh scripts/encode-batch.sh

INPUT_DIR=./raw OUTPUT_DIR=./encoded ./scripts/encode-batch.sh
./scripts/encode-batch.sh --check
```

There is no build, lint config, package manifest, or test suite. `--check`
actually encodes a test frame per candidate encoder, so it reports what works
rather than what ffmpeg advertises — trust it over `ffmpeg -encoders`.

## Working here

- **Never hand-write a `CODECS` string.** `video_codec_string()` reads profile
  and level back from the encoded file. If you add a codec, extend that
  function; a hardcoded value silently lies to players.
- **Adding an encoder touches three places**: `software_encoders_for` (if it is
  a software encoder), `build_encoder_args` (rate control), and
  `build_gop_args` (fixed-GOP flags). Missing the third breaks segment
  alignment with no error — the stream plays but stutters on tier switches.
- **Test a software path alongside any hardware path.** Hardware results do not
  generalise; `HWACCEL=none` is what most users and CI hit.
- **Verify output by decoding it**, not by checking that files exist:
  `ffmpeg -v fatal -allowed_extensions ALL -i <master.m3u8> -f null -`.
  Note that MPEG-TS output emits a benign `non-existing SPS 0 referenced in
  buffering period` warning on probe — exit code 0 means it is fine, so assert
  on exit status, not on empty stderr.

## Repository hygiene

This repo is public and was scrubbed of machine-specific data. Keep it that
way: no absolute home paths, no personal directory names, no sample media in
tracked files. `.env` is gitignored; put new settings in `.env.example` with a
comment, and document them in the README's configuration tables.
