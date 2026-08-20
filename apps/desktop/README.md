# Control Room

Desktop GUI for the video-hls pipeline. PySide6 + QtWebEngine: a Python core
drives `../../run.sh` and `../../scripts/encode-batch.sh` (never modified,
never reimplemented), and an HTML/CSS frontend renders inside an embedded
Chromium view. Shipped as an AppImage via `../../packaging/appimage.sh`.

## Develop

```bash
uv sync --extra dev          # creates .venv with PySide6 + pytest + pyinstaller
uv run python -m controlroom                     # launch the app
uv run python -m controlroom --screenshot all --out ../../screenshots  # offscreen render of every view
uv run pytest                                     # headless unit + runner tests
```

The frontend runs in any browser during development:
`python -m http.server -d frontend 8765` then open
`http://localhost:8765/?mock=1` — `mock.js` stands in for the bridge with
recorded fixture data.

Bridge contract (slots, signals, payload shapes): see `BRIDGE.md`.

Design system: `frontend/css/tokens.css` — tokens extracted from
curbsoftware.com; fonts in `frontend/assets/fonts/` are the site's exact
woff2 files (SIL Open Font License, texts alongside).

## Package

```bash
packaging/appimage.sh        # from the repo root (or anywhere; it locates itself)
```

Builds the AppImage end to end and smoke-tests it:

1. renders `packaging/icon-512.png` from `frontend/assets/icon.svg` (via
   the venv's QtSvg; re-rendered when the SVG changes),
2. runs PyInstaller (`--onedir --windowed`) with the frontend and a copy
   of the engine (`run.sh`, `scripts/`, `.env.example`, `README.md` plus a
   generated `ENGINE_MANIFEST`: git commit, run.sh sha256, build date)
   bundled under `share/videohls-controlroom/`, and hard-fails if
   `QtWebEngineProcess` was not collected,
3. assembles the AppDir (launcher in `usr/bin`, `.desktop`, hicolor icon)
   and runs linuxdeploy (+ qt plugin, cached in `packaging/cache/`,
   gitignored). `AppRun` exports `QTWEBENGINE_DISABLE_SANDBOX=1` and
   `--no-sandbox --disable-dev-shm-usage` — the Chromium sandbox cannot
   work under AppImage/FUSE,
4. smoke-tests the result: `--list-views` and
   `--appimage-extract-and-run --screenshot dashboard` must produce a
   non-empty PNG.

Needs the dev venv (`uv sync --extra dev`) and network on the first run
for linuxdeploy; no FUSE required (`APPIMAGE_EXTRACT_AND_RUN` everywhere).
Offline, the script still builds the bundle and AppDir and prints the
remaining manual steps. Output:
`packaging/videohls-controlroom-x86_64.AppImage` (gitignored, as is the
AppDir); `packaging/icon-512.png` is committed.

