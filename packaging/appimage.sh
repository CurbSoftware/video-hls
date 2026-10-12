#!/usr/bin/env bash
# Build the Control Room AppImage.
#
#   packaging/appimage.sh
#
# Idempotent: dist/, build/, the AppDir and smoke output are rebuilt from
# scratch each run; packaging/icon-512.png is re-rendered only when the
# source SVG changes; linuxdeploy is cached in packaging/cache/.
#
# Requirements: apps/desktop/.venv (uv sync --extra dev), network on first
# run for linuxdeploy. No FUSE is needed (APPIMAGE_EXTRACT_AND_RUN is used
# everywhere).

set -Eeuo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$PKG_DIR/.." && pwd)"
DESKTOP_APP="$REPO/apps/desktop"
VENV_PY="$DESKTOP_APP/.venv/bin/python"
APP_NAME="videohls-controlroom"
DIST="$DESKTOP_APP/dist/$APP_NAME"
APPDIR="$PKG_DIR/$APP_NAME.AppDir"
CACHE="$PKG_DIR/cache"
SMOKE="$PKG_DIR/smoke"
SHARE="share/$APP_NAME"
APP_VERSION="$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$DESKTOP_APP/pyproject.toml" | head -n1)"
APPIMAGE_PATH="$PKG_DIR/CurbStream-${APP_VERSION}-x86_64.AppImage"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

[[ -x "$VENV_PY" ]] || die "no venv python at $VENV_PY — run: cd apps/desktop && uv sync --extra dev"
[[ -n "$APP_VERSION" ]] || die "no version in $DESKTOP_APP/pyproject.toml"
[[ -f "$REPO/run.sh" ]] || die "run.sh not found at $REPO"

# --- icon: SVG -> PNG via the venv's QtSvg (committed; re-render on change) --

render_icon() {
  local svg="$DESKTOP_APP/frontend/assets/icon.svg" out="$PKG_DIR/icon-512.png"
  [[ -f "$svg" ]] || die "icon source missing: $svg"
  if [[ -s "$out" && ! "$svg" -nt "$out" ]]; then return 0; fi
  log "rendering $out from icon.svg"
  QT_QPA_PLATFORM=offscreen "$VENV_PY" - "$svg" "$out" <<'PY'
import sys
from PySide6.QtCore import Qt
from PySide6.QtGui import QImage, QPainter
from PySide6.QtSvg import QSvgRenderer

svg, out = sys.argv[1], sys.argv[2]
renderer = QSvgRenderer(svg)
image = QImage(512, 512, QImage.Format_ARGB32)
image.fill(Qt.transparent)
painter = QPainter(image)
renderer.render(painter)
painter.end()
if not image.save(out, "PNG"):
    sys.exit("could not write " + out)
PY
}

# --- PyInstaller onedir build -------------------------------------------------

build_bundle() {
  log "pyinstaller build (this takes a few minutes)"
  (
    cd "$DESKTOP_APP"
    # Entry is packaging/entry.py, not src/controlroom/__main__.py: the
    # package's relative imports only resolve as `python -m controlroom`,
    # which the launcher reproduces. --paths src lets PyInstaller see the
    # controlroom package (src layout, not installed).
    .venv/bin/pyinstaller --noconfirm --windowed --onedir \
      --name "$APP_NAME" \
      --paths src \
      --add-data "frontend:$SHARE/frontend" \
      --add-data "$REPO/run.sh:$SHARE/engine" \
      --add-data "$REPO/scripts:$SHARE/engine/scripts" \
      --add-data "$REPO/.env.example:$SHARE/engine" \
      --add-data "$REPO/README.md:$SHARE/engine" \
      "$PKG_DIR/entry.py"
  )

  # The #1 WebEngine packaging failure is a missing helper process.
  local helper
  helper="$(find "$DIST" -type f -name QtWebEngineProcess -print -quit)"
  [[ -n "$helper" ]] || die "QtWebEngineProcess not found under $DIST — \
QtWebEngine was not collected; the AppImage would render a blank window."
  chmod +x "$helper"

  # PyInstaller 6 lands --add-data under _internal/, but the frozen app
  # resolves share/ relative to the bundle root (sys.prefix.parent).
  if [[ -d "$DIST/_internal/$SHARE" && ! -d "$DIST/$SHARE" ]]; then
    mkdir -p "$DIST/share"
    mv "$DIST/_internal/$SHARE" "$DIST/$SHARE"
  fi
  local engine="$DIST/$SHARE/engine"
  [[ -f "$engine/run.sh" ]] || die "engine copy missing at $engine"
  chmod +x "$engine/run.sh" "$engine/scripts/encode-batch.sh"
  {
    echo "git-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown) \
run.sh=sha256:$(sha256sum "$engine/run.sh" | cut -c1-12) \
built=$(date +%F)"
  } > "$engine/ENGINE_MANIFEST"
  log "bundle: $(du -sh "$DIST" | cut -f1); manifest: $(head -n1 "$engine/ENGINE_MANIFEST")"
}

# --- AppDir assembly ----------------------------------------------------------

write_apprun() {
  # linuxdeploy leaves an existing AppRun alone, so ours must be in place
  # before it runs. The Chromium (QtWebEngine) sandbox cannot work inside
  # an AppImage (no user namespaces under FUSE) — force it off, keep any
  # user-provided flags, then exec the binary as the desktop file says.
  cat > "$APPDIR/AppRun" <<'APPRUN'
#!/usr/bin/env bash
HERE="$(dirname "$(readlink -f "$0")")"
export QTWEBENGINE_DISABLE_SANDBOX=1
export QTWEBENGINE_CHROMIUM_FLAGS="${QTWEBENGINE_CHROMIUM_FLAGS:+$QTWEBENGINE_CHROMIUM_FLAGS }--no-sandbox --disable-dev-shm-usage"
exec "$HERE/usr/bin/videohls-controlroom" "$@"
APPRUN
  chmod +x "$APPDIR/AppRun"
}

assemble_appdir() {
  log "assembling $APPDIR"
  rm -rf "$APPDIR"
  mkdir -p "$APPDIR/usr/bin" \
           "$APPDIR/usr/share/icons/hicolor/512x512/apps" \
           "$APPDIR/usr/share/applications"

  # Whole onedir tree into usr/bin: the executable keeps _internal/ next
  # to it, and the frozen app resolves $SHARE relative to it.
  cp -a "$DIST/." "$APPDIR/usr/bin/"
  [[ -x "$APPDIR/usr/bin/$APP_NAME" ]] || die "launcher missing after copy"

  cp "$PKG_DIR/icon-512.png" \
     "$APPDIR/usr/share/icons/hicolor/512x512/apps/$APP_NAME.png"
  cp "$PKG_DIR/icon-512.png" "$APPDIR/$APP_NAME.png"  # linuxdeploy also
                                                      # picks up root icons
  cat > "$APPDIR/$APP_NAME.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Control Room
Comment=Desktop control for the video-hls pipeline
Exec=$APP_NAME
Icon=$APP_NAME
Categories=AudioVideo;Video;Utility;
StartupWMClass=$APP_NAME
Terminal=false
DESKTOP
  write_apprun
}

# --- linuxdeploy ----------------------------------------------------------------

fetch() {  # fetch <url> <dest>; succeeds or leaves nothing behind
  local url="$1" dest="$2"
  [[ -x "$dest" ]] && return 0
  log "downloading $(basename "$dest")"
  if ! curl -fL --retry 2 --connect-timeout 15 -o "$dest" "$url"; then
    rm -f "$dest"
    return 1
  fi
  chmod +x "$dest"
}

deploy() {  # deploy [extra linuxdeploy args...]; returns nonzero on failure
  ( cd "$PKG_DIR" && env APPIMAGE_EXTRACT_AND_RUN=1 \
      "$CACHE/linuxdeploy-x86_64.AppImage" --appdir "$APPDIR" "$@" )
}

find_qmake() {  # plugin-qt needs one; PySide6 wheels ship none
  local q
  for q in qmake qmake6; do
    command -v "$q" 2>/dev/null && return 0
  done
  q="$(find "$DESKTOP_APP/.venv" -type f -name qmake -print -quit 2>/dev/null || true)"
  if [[ -n "$q" ]]; then
    echo "$q"
    return 0
  fi
  return 1
}

run_linuxdeploy() {
  mkdir -p "$CACHE"
  if ! fetch "https://github.com/linuxdeploy/linuxdeploy/releases/latest/download/linuxdeploy-x86_64.AppImage" \
             "$CACHE/linuxdeploy-x86_64.AppImage"; then
    cat >&2 <<TODO

TODO: linuxdeploy could not be downloaded (offline?).
The AppDir is fully assembled at $APPDIR — to finish the AppImage,
download into $CACHE/:
  https://github.com/linuxdeploy/linuxdeploy/releases/latest/download/linuxdeploy-x86_64.AppImage
(chmod +x), then from $PKG_DIR run:
  APPIMAGE_EXTRACT_AND_RUN=1 cache/linuxdeploy-x86_64.AppImage \
    --appdir $APP_NAME.AppDir --output appimage
Continuing without the AppImage.

TODO
    return 1
  fi
  rm -f "$PKG_DIR"/*-x86_64.AppImage  # linuxdeploy names it after the
                                      # desktop Name=; we rename below

  local -a extra=()
  local qmake
  if qmake="$(find_qmake)"; then
    local plugin="$CACHE/linuxdeploy-plugin-qt-x86_64.AppImage"
    if fetch "https://github.com/linuxdeploy/linuxdeploy-plugin-qt/releases/latest/download/linuxdeploy-plugin-qt-x86_64.AppImage" "$plugin"; then
      extra=(--plugin qt)
      export QMAKE="$qmake"  # plugin-qt honours $QMAKE
    fi
  else
    echo "NOTE: no qmake — skipping linuxdeploy --plugin qt (it targets \
system-Qt builds; PyInstaller already bundles all of Qt here)" >&2
  fi

  log "running linuxdeploy ${extra[*]:-}"
  if ! deploy "${extra[@]}" --output appimage; then
    if [[ ${extra[*]} == *"--plugin qt"* ]]; then
      echo "WARNING: linuxdeploy --plugin qt failed; retrying without it" >&2
      assemble_appdir  # the failed plugin run may have moved things
      deploy --output appimage || die "linuxdeploy failed"
    else
      die "linuxdeploy failed"
    fi
  fi
  grep -q QTWEBENGINE_DISABLE_SANDBOX "$APPDIR/AppRun" \
    || die "linuxdeploy replaced our AppRun — check the built image"

  local produced="" candidate mtime newest=0
  local -a candidates=()
  shopt -s nullglob
  candidates+=("$PKG_DIR"/*-x86_64.AppImage)
  [[ -d "$HOME/Documents" ]] && candidates+=("$HOME/Documents"/*-x86_64.AppImage)
  shopt -u nullglob
  for candidate in "${candidates[@]}"; do
    case "$(basename "$candidate")" in
      linuxdeploy*|linuxdeploy-plugin*) continue ;;
    esac
    mtime="$(stat -c %Y "$candidate")"
    if (( mtime > newest )); then
      newest=$mtime
      produced=$candidate
    fi
  done
  [[ -n "$produced" ]] || die "linuxdeploy reported success but produced no AppImage"
  [[ "$produced" == "$APPIMAGE_PATH" ]] || mv "$produced" "$APPIMAGE_PATH"
  chmod +x "$APPIMAGE_PATH"
  printf 'AppImage: %s  (%s)\n' "$APPIMAGE_PATH" "$(du -h "$APPIMAGE_PATH" | cut -f1)"
}

# --- post-build smoke -------------------------------------------------------------

smoke() {
  local appimage="$APPIMAGE_PATH"
  [[ -f "$appimage" ]] || { echo "SMOKE: skipped (no AppImage)" >&2; return 0; }
  log "smoke: --list-views"
  "$appimage" --appimage-extract-and-run --list-views >/dev/null \
    || die "AppImage --list-views failed"

  log "smoke: --screenshot dashboard"
  rm -rf "$SMOKE"; mkdir -p "$SMOKE"
  "$appimage" --appimage-extract-and-run \
    --screenshot dashboard --out "$SMOKE" \
    || die "AppImage screenshot failed"
  local png="$SMOKE/dashboard.png"
  [[ -s "$png" ]] || die "smoke PNG missing/empty: $png"
  printf 'SMOKE: OK  %s  (%s bytes)\n' "$png" "$(stat -c%s "$png")"
}

main() {
  render_icon
  build_bundle
  assemble_appdir
  run_linuxdeploy || true
  smoke
  log "done"
}

main
