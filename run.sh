#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# video-hls — one-command adaptive-bitrate HLS pipeline.
#
#   1. Drop video(s) into $INPUT_ROOT (video/).
#   2. Run:  ./run.sh
#   3. HLS packages land in $HLS_ROOT (hls/).
#      Successfully processed sources move to $PROCESSED_ROOT
#      (video-done/). Sources that fail stay in $INPUT_ROOT.
#
# Configuration: copy .env.example to .env and edit. Every
# setting can also be overridden per-run from the environment:
#
#   VIDEO_CODEC=hevc HWACCEL=none ./run.sh
#
# Precedence: environment > .env > built-in defaults.
#
# Run ./run.sh --help for options, --check to probe your system.
# ============================================================

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

# ------------------------------------------------------------
# Configuration
# ------------------------------------------------------------
# .env uses ${VAR:-value} form, so anything already exported in
# the environment survives sourcing.
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

# Directory layout — all relative to the repo by default, so the
# project works anywhere without editing paths.
INPUT_ROOT="${INPUT_ROOT:-$SCRIPT_DIR/video}"
WORK_ROOT="${WORK_ROOT:-$SCRIPT_DIR/video-work}"
ENCODED_ROOT="${ENCODED_ROOT:-$WORK_ROOT/encoded}"
HLS_ROOT="${HLS_ROOT:-$SCRIPT_DIR/hls}"
STATE_ROOT="${STATE_ROOT:-$WORK_ROOT/state}"
LOG_ROOT="${LOG_ROOT:-$WORK_ROOT/logs}"
PROCESSED_ROOT="${PROCESSED_ROOT:-$SCRIPT_DIR/video-done}"

# Codec selection
VIDEO_CODEC="${VIDEO_CODEC:-h264}"          # h264 | hevc | av1
AUDIO_CODEC="${AUDIO_CODEC:-aac}"           # aac | opus
HWACCEL="${HWACCEL:-auto}"                  # auto | nvenc | qsv | vaapi | videotoolbox | none
VIDEO_ENCODER="${VIDEO_ENCODER:-}"          # explicit override, e.g. libx264
VAAPI_DEVICE="${VAAPI_DEVICE:-/dev/dri/renderD128}"

# Quality. Meaning depends on the encoder family:
#   nvenc  -> -cq   (0-51, lower is better, ~28 is a good VOD default)
#   qsv    -> -global_quality
#   vaapi  -> -qp
#   x264/5 -> -crf  (~23 default, ~28 for smaller files)
#   svt-av1-> -crf  (~30 is roughly equivalent to x264 crf 23)
QUALITY="${QUALITY:-28}"
NVENC_PRESET="${NVENC_PRESET:-p6}"          # p1 fastest .. p7 best quality
X264_PRESET="${X264_PRESET:-medium}"        # ultrafast .. veryslow (libx264/libx265)
SVTAV1_PRESET="${SVTAV1_PRESET:-8}"         # 0 slowest/best .. 13 fastest
AOM_CPU_USED="${AOM_CPU_USED:-6}"           # libaom-av1: 0 slowest .. 8 fastest
QSV_PRESET="${QSV_PRESET:-medium}"

# HLS packaging
HLS_TIME="${HLS_TIME:-6}"
HLS_PLAYLIST_TYPE="${HLS_PLAYLIST_TYPE:-vod}"
HLS_SEGMENT_TYPE="${HLS_SEGMENT_TYPE:-auto}"  # auto | mpegts | fmp4

# Rendition ladder. One row drives BOTH encoding and the master
# playlist, so a tier can never be half-defined.
#   label height width video_bitrate maxrate bufsize audio_bitrate
LADDER="${LADDER:-$(cat <<'LADDER_EOF'
240p   240  426   400k   600k   900k   64k
360p   360  640   800k  1200k  1800k   96k
480p   480  854  1400k  2100k  3000k  128k
720p   720 1280  2800k  4200k  6000k  128k
1080p 1080 1920  5000k  7500k 10000k  192k
1440p 1440 2560  9000k 13500k 18000k  192k
2160p 2160 3840 16000k 24000k 32000k  256k
LADDER_EOF
)}"

MAX_RESOLUTION_HEIGHT="${MAX_RESOLUTION_HEIGHT:-1080}"
MIN_RESOLUTION_HEIGHT="${MIN_RESOLUTION_HEIGHT:-360}"

# Concurrency
PARALLEL_VIDEOS="${PARALLEL_VIDEOS:-1}"
PARALLEL_RENDITIONS="${PARALLEL_RENDITIONS:-3}"

# File management
VIDEO_EXTENSIONS_REGEX="${VIDEO_EXTENSIONS_REGEX:-.*\.(mp4|mov|mkv|avi|webm|m4v|mpg|mpeg|ts|m2ts|flv|wmv)$}"
SKIP_EXISTING="${SKIP_EXISTING:-true}"
ARCHIVE_SOURCE="${ARCHIVE_SOURCE:-true}"
KEEP_RENDITIONS="${KEEP_RENDITIONS:-true}"
FFMPEG_LOGLEVEL="${FFMPEG_LOGLEVEL:-error}"

# ------------------------------------------------------------
# CLI
# ------------------------------------------------------------
DRY_RUN=false
DO_CHECK=false

usage() {
  cat <<EOF
video-hls — turn any video into adaptive-bitrate HLS.

Usage: ./run.sh [options]

Options:
  -h, --help      Show this help.
      --check     Probe the system: dependencies, encoders, GPU. Encodes
                  nothing. Use this first on a new machine.
      --dry-run   List the videos that would be processed and the exact
                  rendition ladder each would produce, then exit.

Configuration comes from ./.env (copy .env.example), overridable per run:

  VIDEO_CODEC=hevc HWACCEL=none QUALITY=24 ./run.sh

See README.md for the full list of settings.
EOF
}

while (( $# )); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --check)   DO_CHECK=true ;;
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown option: $1" >&2; echo "Try ./run.sh --help" >&2; exit 2 ;;
  esac
  shift
done

# ------------------------------------------------------------
# Capability probing
# ------------------------------------------------------------
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    return 1
  }
}

# Encoder names ffmpeg was built with (name only, one per line).
ffmpeg_encoder_list() {
  ffmpeg -hide_banner -encoders 2>/dev/null | awk 'NR>2 {print $2}'
}

encoder_compiled_in() {
  ffmpeg_encoder_list | grep -qx -- "$1"
}

# Software encoders for a codec, best-first.
software_encoders_for() {
  case "$1" in
    h264) echo "libx264" ;;
    hevc) echo "libx265" ;;
    av1)  echo "libsvtav1 libaom-av1" ;;
  esac
}

# Actually encode one frame. Being compiled in does not mean the
# hardware is present and usable, so this is the only honest test.
encoder_usable() {
  local enc="$1"
  local -a pre=() vf=(-vf "format=yuv420p")
  case "$enc" in
    *_vaapi)
      [[ -e "$VAAPI_DEVICE" ]] || return 1
      pre=(-vaapi_device "$VAAPI_DEVICE")
      vf=(-vf "format=nv12,hwupload")
      ;;
  esac
  ffmpeg -hide_banner -loglevel error -nostdin "${pre[@]}" \
    -f lavfi -i "testsrc=size=320x240:rate=25:duration=1" \
    "${vf[@]}" -c:v "$enc" -frames:v 5 -f null - >/dev/null 2>&1
}

# Resolve VIDEO_CODEC + HWACCEL into a concrete ffmpeg encoder.
resolve_video_encoder() {
  local codec="$1" accel="$2"
  local -a candidates=()

  case "$accel" in
    nvenc)         candidates=("${codec}_nvenc") ;;
    qsv)           candidates=("${codec}_qsv") ;;
    vaapi)         candidates=("${codec}_vaapi") ;;
    videotoolbox)  candidates=("${codec}_videotoolbox") ;;
    none)          read -r -a candidates <<<"$(software_encoders_for "$codec")" ;;
    auto)
      local -a sw=()
      read -r -a sw <<<"$(software_encoders_for "$codec")"
      candidates=("${codec}_nvenc" "${codec}_qsv" "${codec}_vaapi" "${codec}_videotoolbox" "${sw[@]}")
      ;;
    *) echo "ERROR: unknown HWACCEL '$accel' (auto|nvenc|qsv|vaapi|videotoolbox|none)" >&2; return 1 ;;
  esac

  local enc
  for enc in "${candidates[@]}"; do
    encoder_compiled_in "$enc" || continue
    encoder_usable "$enc" || continue
    echo "$enc"
    return 0
  done
  return 1
}

audio_encoder_for() {
  case "$1" in
    aac)  echo "aac" ;;
    opus) echo "libopus" ;;
    *) echo "ERROR: unknown AUDIO_CODEC '$1' (aac|opus)" >&2; return 1 ;;
  esac
}

# ------------------------------------------------------------
# --check
# ------------------------------------------------------------
run_check() {
  local rc=0
  echo "video-hls system check"
  echo "======================"
  echo

  echo "Required commands:"
  local c
  for c in ffmpeg ffprobe python3; do
    if command -v "$c" >/dev/null 2>&1; then
      printf '  %-10s OK   %s\n' "$c" "$(command -v "$c")"
    else
      printf '  %-10s MISSING\n' "$c"; rc=1
    fi
  done
  echo

  if command -v ffmpeg >/dev/null 2>&1; then
    echo "  ffmpeg: $(ffmpeg -version 2>/dev/null | head -n1)"
    echo "  bash:   $BASH_VERSION"
    echo
  else
    echo "ffmpeg is required. Install it and re-run --check." >&2
    return 1
  fi

  echo "Hardware:"
  if command -v nvidia-smi >/dev/null 2>&1; then
    printf '  NVIDIA    %s\n' "$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1)"
  else
    echo "  NVIDIA    not detected (no nvidia-smi)"
  fi
  if [[ -e "$VAAPI_DEVICE" ]]; then
    echo "  VAAPI     $VAAPI_DEVICE present"
  else
    echo "  VAAPI     $VAAPI_DEVICE not present"
  fi
  echo

  echo "Video encoders (compiled in / actually usable):"
  local codec enc status
  for codec in h264 hevc av1; do
    printf '  %s\n' "$codec"
    local -a sw=()
    read -r -a sw <<<"$(software_encoders_for "$codec")"
    for enc in "${codec}_nvenc" "${codec}_qsv" "${codec}_vaapi" "${codec}_videotoolbox" "${sw[@]}"; do
      if ! encoder_compiled_in "$enc"; then
        status="not built"
      elif encoder_usable "$enc"; then
        status="USABLE"
      else
        status="built, not usable here"
      fi
      printf '    %-22s %s\n' "$enc" "$status"
    done
  done
  echo

  echo "Audio encoders:"
  for enc in aac libopus; do
    if encoder_compiled_in "$enc"; then
      printf '    %-22s %s\n' "$enc" "available"
    else
      printf '    %-22s %s\n' "$enc" "not built"
    fi
  done
  echo

  echo "Active configuration:"
  printf '  VIDEO_CODEC=%s  AUDIO_CODEC=%s  HWACCEL=%s  QUALITY=%s\n' \
    "$VIDEO_CODEC" "$AUDIO_CODEC" "$HWACCEL" "$QUALITY"
  local resolved
  if [[ -n "$VIDEO_ENCODER" ]]; then
    resolved="$VIDEO_ENCODER (explicit)"
    encoder_compiled_in "$VIDEO_ENCODER" || { resolved="$VIDEO_ENCODER (NOT BUILT)"; rc=1; }
  elif resolved="$(resolve_video_encoder "$VIDEO_CODEC" "$HWACCEL")"; then
    :
  else
    resolved="NONE — no usable encoder for $VIDEO_CODEC"; rc=1
  fi
  printf '  resolved video encoder: %s\n' "$resolved"
  printf '  resolved audio encoder: %s\n' "$(audio_encoder_for "$AUDIO_CODEC" 2>/dev/null || echo INVALID)"
  printf '  segment type:           %s\n' "$(resolve_segment_type)"
  echo

  echo "Paths:"
  printf '  input   %s\n' "$INPUT_ROOT"
  printf '  output  %s\n' "$HLS_ROOT"
  printf '  work    %s\n' "$WORK_ROOT"
  printf '  archive %s\n' "$PROCESSED_ROOT"
  echo

  if (( rc == 0 )); then
    echo "Result: ready."
  else
    echo "Result: problems found (see above)."
  fi
  return $rc
}

# ------------------------------------------------------------
# Segment type: MPEG-TS only supports H.264 + AAC. HEVC, AV1 and
# Opus need fMP4/CMAF, so 'auto' upgrades automatically.
# ------------------------------------------------------------
resolve_segment_type() {
  case "$HLS_SEGMENT_TYPE" in
    mpegts|fmp4) echo "$HLS_SEGMENT_TYPE"; return 0 ;;
  esac
  if [[ "$VIDEO_CODEC" == "h264" && "$AUDIO_CODEC" == "aac" ]]; then
    echo "mpegts"
  else
    echo "fmp4"
  fi
}

# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------
bitrate_to_bps() {
  local v="$1"
  case "$v" in
    *[kK]) echo $(( ${v%[kK]} * 1000 )) ;;
    *[mM]) echo $(( ${v%[mM]} * 1000000 )) ;;
    *)     echo "$v" ;;
  esac
}

# RFC 6381 CODECS attribute, derived from the real encoded file
# rather than hardcoded — a wrong CODECS string makes players
# refuse a stream they could actually play.
video_codec_string() {
  local file="$1" height="$2"
  local profile level
  profile="$(ffprobe -v error -select_streams v:0 -show_entries stream=profile -of csv=p=0 "$file" 2>/dev/null || true)"
  level="$(ffprobe -v error -select_streams v:0 -show_entries stream=level -of csv=p=0 "$file" 2>/dev/null || true)"
  # ffprobe reports -99 or N/A when the level is unknown.
  if [[ ! "$level" =~ ^[0-9]+$ ]]; then
    level=""
  fi

  case "$VIDEO_CODEC" in
    h264)
      local p c
      case "$profile" in
        "Constrained Baseline") p=42; c=40 ;;
        "Baseline")             p=42; c=00 ;;
        "Main")                 p=4D; c=40 ;;
        "High")                 p=64; c=00 ;;
        "High 10")              p=6E; c=00 ;;
        *)                      p=4D; c=40 ;;
      esac
      [[ -z "$level" ]] && level=31
      printf 'avc1.%s%s%02X' "$p" "$c" "$level"
      ;;
    hevc)
      local pidc=1
      [[ "$profile" == "Main 10" ]] && pidc=2
      [[ -z "$level" ]] && level=93
      printf 'hvc1.%d.6.L%d.B0' "$pidc" "$level"
      ;;
    av1)
      # seq_level_idx from resolution (AV1 spec Annex A).
      local idx
      if   (( height <= 240 ));  then idx=0
      elif (( height <= 360 ));  then idx=1
      elif (( height <= 480 ));  then idx=4
      elif (( height <= 720 ));  then idx=5
      elif (( height <= 1080 )); then idx=8
      elif (( height <= 1440 )); then idx=12
      else                            idx=13
      fi
      printf 'av01.0.%02dM.08' "$idx"
      ;;
  esac
}

audio_codec_string() {
  case "$AUDIO_CODEC" in
    aac)  echo "mp4a.40.2" ;;
    opus) echo "Opus" ;;
  esac
}

# Per-encoder quality/rate-control flags -> ENC_ARGS
build_encoder_args() {
  local enc="$1" bitrate="$2" maxrate="$3" bufsize="$4"
  ENC_ARGS=()
  case "$enc" in
    *_nvenc)
      ENC_ARGS=(-preset "$NVENC_PRESET" -rc vbr -cq "$QUALITY"
                -b:v "$bitrate" -maxrate "$maxrate" -bufsize "$bufsize")
      ;;
    *_qsv)
      ENC_ARGS=(-preset "$QSV_PRESET" -global_quality "$QUALITY"
                -b:v "$bitrate" -maxrate "$maxrate" -bufsize "$bufsize")
      ;;
    *_vaapi)
      ENC_ARGS=(-rc_mode VBR -qp "$QUALITY"
                -b:v "$bitrate" -maxrate "$maxrate" -bufsize "$bufsize")
      ;;
    *_videotoolbox)
      ENC_ARGS=(-b:v "$bitrate" -maxrate "$maxrate" -bufsize "$bufsize")
      ;;
    libx264|libx265)
      ENC_ARGS=(-preset "$X264_PRESET" -crf "$QUALITY"
                -maxrate "$maxrate" -bufsize "$bufsize")
      ;;
    libsvtav1)
      ENC_ARGS=(-preset "$SVTAV1_PRESET" -crf "$QUALITY")
      ;;
    libaom-av1)
      ENC_ARGS=(-crf "$QUALITY" -b:v 0 -cpu-used "$AOM_CPU_USED" -row-mt 1)
      ;;
    *)
      ENC_ARGS=(-b:v "$bitrate" -maxrate "$maxrate" -bufsize "$bufsize")
      ;;
  esac
}

# Fixed-GOP flags -> GOP_ARGS. Every rendition must cut keyframes at
# identical timestamps or ABR switching stutters; packaging is -c copy
# so ffmpeg can only split on existing keyframes.
build_gop_args() {
  local enc="$1" gop="$2"
  GOP_ARGS=(-g "$gop" -keyint_min "$gop")
  case "$enc" in
    *_nvenc)    GOP_ARGS+=(-forced-idr 1 -no-scenecut 1) ;;
    libx264)    GOP_ARGS+=(-x264-params "keyint=$gop:min-keyint=$gop:scenecut=0") ;;
    libx265)    GOP_ARGS+=(-x265-params "keyint=$gop:min-keyint=$gop:scenecut=0") ;;
    libsvtav1)  GOP_ARGS+=(-svtav1-params "keyint=$gop:scd=0") ;;
    libaom-av1) GOP_ARGS+=(-aom-params "kf-max-dist=$gop:kf-min-dist=$gop") ;;
    *)          GOP_ARGS+=(-sc_threshold 0) ;;
  esac
}

# ------------------------------------------------------------
# Startup validation
# ------------------------------------------------------------
require_cmd ffmpeg
require_cmd ffprobe
require_cmd python3

if $DO_CHECK; then
  run_check
  exit $?
fi

case "$VIDEO_CODEC" in
  h264|hevc|av1) ;;
  *) echo "ERROR: VIDEO_CODEC must be h264, hevc or av1 (got '$VIDEO_CODEC')" >&2; exit 2 ;;
esac

AUDIO_ENCODER="$(audio_encoder_for "$AUDIO_CODEC")"
encoder_compiled_in "$AUDIO_ENCODER" || {
  echo "ERROR: audio encoder '$AUDIO_ENCODER' is not available in this ffmpeg build." >&2
  exit 1
}

if [[ -n "$VIDEO_ENCODER" ]]; then
  encoder_compiled_in "$VIDEO_ENCODER" || {
    echo "ERROR: VIDEO_ENCODER='$VIDEO_ENCODER' is not available in this ffmpeg build." >&2
    echo "Run ./run.sh --check to see what is." >&2
    exit 1
  }
else
  VIDEO_ENCODER="$(resolve_video_encoder "$VIDEO_CODEC" "$HWACCEL")" || {
    echo "ERROR: no usable $VIDEO_CODEC encoder found for HWACCEL='$HWACCEL'." >&2
    echo "Run ./run.sh --check for a full report." >&2
    exit 1
  }
fi

SEGMENT_TYPE="$(resolve_segment_type)"
if [[ "$SEGMENT_TYPE" == "mpegts" && ( "$VIDEO_CODEC" != "h264" || "$AUDIO_CODEC" != "aac" ) ]]; then
  echo "ERROR: HLS_SEGMENT_TYPE=mpegts only supports h264+aac." >&2
  echo "       Use HLS_SEGMENT_TYPE=fmp4 (or auto) for $VIDEO_CODEC/$AUDIO_CODEC." >&2
  exit 2
fi

if [[ "$SEGMENT_TYPE" == "fmp4" ]]; then
  SEGMENT_EXT="m4s"
  HLS_VERSION=7
else
  SEGMENT_EXT="ts"
  HLS_VERSION=3
fi

# Resolve every root against the repo, not the caller's cwd, so a relative
# path in .env means the same thing no matter where ./run.sh is invoked
# from. INPUT_ROOT in particular must be canonical: the prefix-strip that
# derives each output path is a plain string operation, and a stray
# trailing slash or symlink would silently flatten the subfolder tree.
abs_path() {
  case "$1" in
    /*) realpath -m -- "$1" ;;
    *)  realpath -m -- "$SCRIPT_DIR/$1" ;;
  esac
}
INPUT_ROOT="$(abs_path "$INPUT_ROOT")"
HLS_ROOT="$(abs_path "$HLS_ROOT")"
WORK_ROOT="$(abs_path "$WORK_ROOT")"
ENCODED_ROOT="$(abs_path "$ENCODED_ROOT")"
STATE_ROOT="$(abs_path "$STATE_ROOT")"
LOG_ROOT="$(abs_path "$LOG_ROOT")"
PROCESSED_ROOT="$(abs_path "$PROCESSED_ROOT")"

mkdir -p "$INPUT_ROOT" "$ENCODED_ROOT" "$HLS_ROOT" "$STATE_ROOT" "$LOG_ROOT"
if [[ "$ARCHIVE_SOURCE" == "true" ]]; then
  mkdir -p "$PROCESSED_ROOT"
fi

# ------------------------------------------------------------
# Build the active ladder from LADDER, filtered by MIN/MAX height
# ------------------------------------------------------------
ACTIVE_LADDER=()
while read -r label height width vbitrate maxrate bufsize abitrate; do
  [[ -z "${label:-}" || "$label" == \#* ]] && continue
  (( height > MAX_RESOLUTION_HEIGHT )) && continue
  (( height < MIN_RESOLUTION_HEIGHT )) && continue
  ACTIVE_LADDER+=("$label $height $width $vbitrate $maxrate $bufsize $abitrate")
done <<<"$LADDER"

if (( ${#ACTIVE_LADDER[@]} == 0 )); then
  echo "ERROR: no ladder tiers between MIN_RESOLUTION_HEIGHT=$MIN_RESOLUTION_HEIGHT and MAX_RESOLUTION_HEIGHT=$MAX_RESOLUTION_HEIGHT." >&2
  exit 2
fi

# ------------------------------------------------------------
# Discover inputs
# ------------------------------------------------------------
mapfile -d '' VIDEO_FILES < <(
  find "$INPUT_ROOT" -type f -regextype posix-extended -iregex "$VIDEO_EXTENSIONS_REGEX" -print0 | sort -z
)

total="${#VIDEO_FILES[@]}"
if (( total == 0 )); then
  echo "No videos found in $INPUT_ROOT"
  echo "Drop files there and re-run, or set INPUT_ROOT to point elsewhere."
  exit 0
fi

echo "video-hls: $total video(s) to process"
echo "  encoder:  $VIDEO_ENCODER + $AUDIO_ENCODER  (segments: $SEGMENT_TYPE)"
echo "  ladder:   $(printf '%s ' "${ACTIVE_LADDER[@]%% *}")"
echo "  output:   $HLS_ROOT"
echo

if $DRY_RUN; then
  echo "Dry run — nothing will be encoded."
  echo
  for f in "${VIDEO_FILES[@]}"; do
    src_h="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$f" 2>/dev/null | head -n1 || true)"
    src_h="${src_h:-0}"
    printf '%s  (source height: %s)\n' "${f#"$INPUT_ROOT"/}" "${src_h:-unknown}"
    for row in "${ACTIVE_LADDER[@]}"; do
      # shellcheck disable=SC2086
      set -- $row
      if (( src_h > 0 && $2 > src_h )); then
        printf '    %-6s skip (would upscale from %sp)\n' "$1" "$src_h"
      else
        printf '    %-6s encode -> %s/index.m3u8\n' "$1" "$1"
      fi
    done
  done
  exit 0
fi

# ----------------------------
# Process one video end-to-end
# ----------------------------
process_video() {
  local SOURCE="$1" idx="$2"
  SOURCE="$(realpath -- "$SOURCE")"

  local rel rel_no_ext safe_name
  rel="${SOURCE#"$INPUT_ROOT"/}"
  [[ "$rel" == "$SOURCE" ]] && rel="$(basename -- "$SOURCE")"
  rel_no_ext="${rel%.*}"
  safe_name="$(printf '%s' "$rel_no_ext" | tr '/ :' '___')"

  # Guard the rm -rf below: an empty key would target the roots.
  if [[ -z "$rel_no_ext" || "$rel_no_ext" == "." || "$rel_no_ext" == /* ]]; then
    echo "ERROR: refusing to process '$SOURCE' — unsafe derived name '$rel_no_ext'" >&2
    return 1
  fi

  local OUT_DIR RENDITION_DIR PARTIAL_DIR MASTER_LOG
  OUT_DIR="$ENCODED_ROOT/$rel_no_ext"
  RENDITION_DIR="$OUT_DIR/renditions"
  PARTIAL_DIR="$STATE_ROOT/partials/$rel_no_ext"
  MASTER_LOG="$LOG_ROOT/encode_${safe_name}_$(date '+%Y%m%d_%H%M%S').log"
  mkdir -p "$RENDITION_DIR" "$PARTIAL_DIR"

  log() { printf '[%s] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "${*:2}" | tee -a "$MASTER_LOG"; }
  fail() { log "FATAL" "$*"; exit 1; }

  # Stale .partial files from a killed run are never valid input.
  rm -f "$PARTIAL_DIR"/*.partial.* 2>/dev/null || true

  # ---- Probe source ----
  local source_h source_w fps_raw GOP_SIZE has_audio
  source_h="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$SOURCE" | head -n1)"
  source_w="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$SOURCE" | head -n1)"
  fps_raw="$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$SOURCE" | head -n1 || echo '25/1')"
  [[ -z "$source_h" ]] && fail "Could not read source resolution"

  if ffprobe -v error -select_streams a:0 -show_entries stream=index -of csv=p=0 "$SOURCE" 2>/dev/null | grep -q .; then
    has_audio=true
  else
    has_audio=false
  fi

  # Keyframe interval = fps * segment duration, so every rendition
  # gets identical segment boundaries. bash can't do 30000/1001*6.
  GOP_SIZE="$(python3 -c 'import sys, fractions; print(max(1, round(float(fractions.Fraction(sys.argv[1])) * float(sys.argv[2]))))' "$fps_raw" "$HLS_TIME")"

  log "INFO" "[$idx/$total] Processing: $rel (${source_w}x${source_h}, audio=$has_audio, gop=$GOP_SIZE)"

  # ---- Encode renditions (parallel, no upscaling) ----
  encode_one() {
    local label="$1" target_h="$2" bitrate="$4" maxrate="$5" bufsize="$6" audio_bitrate="$7"

    if (( target_h > source_h )); then
      log "SKIP" "$label skipped; source height ${source_h}px < target ${target_h}px. Avoiding upscale."
      return 0
    fi

    local final="$RENDITION_DIR/$label.mp4"
    local partial="$PARTIAL_DIR/$label.partial.mp4"

    [[ "$SKIP_EXISTING" == "true" && -s "$final" ]] && { log "SKIP" "$label exists"; return 0; }

    build_encoder_args "$VIDEO_ENCODER" "$bitrate" "$maxrate" "$bufsize"
    build_gop_args "$VIDEO_ENCODER" "$GOP_SIZE"

    local -a pre=() vf=() audio=() tag=()
    case "$VIDEO_ENCODER" in
      *_vaapi)
        pre=(-vaapi_device "$VAAPI_DEVICE")
        vf=(-vf "scale=-2:${target_h}:flags=lanczos,format=nv12,hwupload")
        ;;
      *)
        vf=(-vf "scale=-2:${target_h}:flags=lanczos,format=yuv420p" -pix_fmt yuv420p)
        ;;
    esac
    # hvc1 tag: Apple players reject hev1-tagged HEVC in HLS.
    [[ "$VIDEO_CODEC" == "hevc" ]] && tag=(-tag:v hvc1)
    [[ "$VIDEO_CODEC" == "av1" ]] && tag=(-tag:v av01)

    if $has_audio; then
      audio=(-map 0:a:0 -c:a "$AUDIO_ENCODER" -b:a "$audio_bitrate" -ac 2 -ar 48000)
    else
      audio=(-an)
    fi

    log "START" "Encoding $label with $VIDEO_ENCODER"
    if ! ffmpeg -hide_banner -nostdin -y -loglevel "$FFMPEG_LOGLEVEL" "${pre[@]}" -i "$SOURCE" \
      -map 0:v:0 -map_metadata 0 -map_chapters 0 \
      "${vf[@]}" -c:v "$VIDEO_ENCODER" "${ENC_ARGS[@]}" "${GOP_ARGS[@]}" "${tag[@]}" \
      "${audio[@]}" -movflags +faststart \
      "$partial" 2>> "$MASTER_LOG"; then
      log "ERROR" "$label failed (see $MASTER_LOG)"
      return 1
    fi

    # Trust nothing that ffmpeg exited 0 on but wrote no frames.
    if ! ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames,duration -of csv=p=0 "$partial" >/dev/null 2>&1; then
      log "ERROR" "$label produced an unreadable file"
      return 1
    fi

    mv -f "$partial" "$final"
    log "DONE" "$label -> $final"
  }

  # Background jobs cannot write to parent variables, so each job
  # reports through its own status file. Cleaned up explicitly — an
  # EXIT trap would reference a local that is already out of scope
  # by the time the subshell exits.
  local status_dir encode_failed=false
  status_dir="$(mktemp -d "$STATE_ROOT/encode-status.XXXXXX")"

  local row
  for row in "${ACTIVE_LADDER[@]}"; do
    while (( "$(jobs -pr | wc -l)" >= PARALLEL_RENDITIONS )); do wait -n || true; done
    # shellcheck disable=SC2086
    set -- $row
    ( encode_one "$@" && echo success > "$status_dir/$1.status" || echo fail > "$status_dir/$1.status" ) &
  done
  wait

  grep -q "fail" "$status_dir"/*.status 2>/dev/null && encode_failed=true
  rm -rf "$status_dir"
  $encode_failed && fail "[$idx/$total] One or more encodes failed."

  # ---- Package HLS into a partial dir, then publish atomically ----
  local PARTIAL_HLS_DIR FINAL_HLS_DIR
  PARTIAL_HLS_DIR="$STATE_ROOT/hls-partials/$rel_no_ext"
  FINAL_HLS_DIR="$HLS_ROOT/$rel_no_ext"

  rm -rf "$PARTIAL_HLS_DIR"
  mkdir -p "$PARTIAL_HLS_DIR"

  package_one() {
    local label="$1"
    local input="$RENDITION_DIR/$label.mp4"
    local out_dir="$PARTIAL_HLS_DIR/$label"
    [[ -s "$input" ]] || return 0
    mkdir -p "$out_dir"

    local -a seg=()
    if [[ "$SEGMENT_TYPE" == "fmp4" ]]; then
      seg=(-hls_segment_type fmp4 -hls_fmp4_init_filename "init.mp4")
    fi

    # -c copy: packaging never re-encodes, so segment cuts land on the
    # keyframes placed during encoding.
    if ! ffmpeg -hide_banner -nostdin -y -loglevel "$FFMPEG_LOGLEVEL" -i "$input" \
      -map 0:v:0 -map 0:a:0? -c copy \
      -hls_time "$HLS_TIME" -hls_playlist_type "$HLS_PLAYLIST_TYPE" \
      -hls_flags independent_segments "${seg[@]}" \
      -hls_segment_filename "$out_dir/seg_%06d.$SEGMENT_EXT" \
      "$out_dir/index.m3u8" 2>> "$MASTER_LOG"; then
      log "ERROR" "Packaging $label failed"
      return 1
    fi
    [[ -s "$out_dir/index.m3u8" ]] || { log "ERROR" "Packaging $label wrote no playlist"; return 1; }
    log "DONE" "Packaged $label"
  }

  local pkg_status_dir package_failed=false
  pkg_status_dir="$(mktemp -d "$STATE_ROOT/package-status.XXXXXX")"

  for row in "${ACTIVE_LADDER[@]}"; do
    while (( "$(jobs -pr | wc -l)" >= PARALLEL_RENDITIONS )); do wait -n || true; done
    # shellcheck disable=SC2086
    set -- $row
    ( package_one "$1" && echo success > "$pkg_status_dir/$1.status" || echo fail > "$pkg_status_dir/$1.status" ) &
  done
  wait

  grep -q "fail" "$pkg_status_dir"/*.status 2>/dev/null && package_failed=true
  rm -rf "$pkg_status_dir"
  # The old pipeline discarded packaging errors, so a tier could vanish
  # from the master playlist and the source still be archived as a success.
  $package_failed && fail "[$idx/$total] One or more renditions failed to package."

  # ---- Master playlist ----
  # Order matters: header, then EXT-X-MEDIA, then EXT-X-STREAM-INF.
  local master_tmp
  master_tmp="$PARTIAL_HLS_DIR/master.m3u8"
  { echo "#EXTM3U"; echo "#EXT-X-VERSION:$HLS_VERSION"; echo "#EXT-X-INDEPENDENT-SEGMENTS"; } > "$master_tmp"

  # Subtitle sidecars: <source-stem>.<lang>.vtt next to the source.
  local subtitles_dir subtitle_count source_dir source_stem vtt lang default_attr
  subtitles_dir="$PARTIAL_HLS_DIR/subtitles"
  mkdir -p "$subtitles_dir"
  subtitle_count=0
  source_dir="$(dirname -- "$SOURCE")"
  source_stem="$(basename -- "${SOURCE%.*}")"

  shopt -s nullglob
  local -a found_vtts=()
  for vtt in "$source_dir/$source_stem".*.vtt; do
    found_vtts+=("$vtt")
    # lesson.en.vtt -> en ; lesson.pt-BR.vtt -> pt-BR
    lang="$(basename -- "${vtt%.vtt}")"
    lang="${lang##*.}"
    cp -f "$vtt" "$subtitles_dir/$lang.vtt"
    default_attr=$([[ $subtitle_count -eq 0 ]] && echo "YES" || echo "NO")
    echo "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"$lang\",DEFAULT=$default_attr,AUTOSELECT=YES,FORCED=NO,LANGUAGE=\"$lang\",URI=\"subtitles/$lang.vtt\"" >> "$master_tmp"
    subtitle_count=$((subtitle_count + 1))
  done
  shopt -u nullglob
  (( subtitle_count == 0 )) && rmdir "$subtitles_dir" 2>/dev/null || true

  local sub_attr audio_cs codecs bw avg_bw variant_h variant_w
  for row in "${ACTIVE_LADDER[@]}"; do
    # shellcheck disable=SC2086
    set -- $row
    local label="$1" ladder_h="$2" ladder_w="$3" vbitrate="$4" maxrate="$5" abitrate="$7"
    [[ -s "$PARTIAL_HLS_DIR/$label/index.m3u8" ]] || continue

    # Read the real dimensions back — scale=-2 rounds width to even,
    # so the ladder's nominal width can be off by a pixel.
    variant_w="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$RENDITION_DIR/$label.mp4" 2>/dev/null | head -n1)"
    variant_h="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$RENDITION_DIR/$label.mp4" 2>/dev/null | head -n1)"
    variant_w="${variant_w:-$ladder_w}"
    variant_h="${variant_h:-$ladder_h}"

    codecs="$(video_codec_string "$RENDITION_DIR/$label.mp4" "$variant_h")"
    if $has_audio; then
      audio_cs="$(audio_codec_string)"
      codecs="$codecs,$audio_cs"
      avg_bw=$(( $(bitrate_to_bps "$vbitrate") + $(bitrate_to_bps "$abitrate") ))
      bw=$(( $(bitrate_to_bps "$maxrate") + $(bitrate_to_bps "$abitrate") ))
    else
      avg_bw="$(bitrate_to_bps "$vbitrate")"
      bw="$(bitrate_to_bps "$maxrate")"
    fi

    sub_attr=$([[ $subtitle_count -gt 0 ]] && echo ",SUBTITLES=\"subs\"" || echo "")
    echo "#EXT-X-STREAM-INF:BANDWIDTH=$bw,AVERAGE-BANDWIDTH=$avg_bw,RESOLUTION=${variant_w}x${variant_h},CODECS=\"$codecs\"$sub_attr" >> "$master_tmp"
    echo "$label/index.m3u8" >> "$master_tmp"
  done

  grep -q "EXT-X-STREAM-INF" "$master_tmp" || fail "[$idx/$total] No HLS variants written."

  cat > "$PARTIAL_HLS_DIR/package.json" <<JSON
{
  "source": "$rel",
  "source_width": $source_w,
  "source_height": $source_h,
  "video_codec": "$VIDEO_CODEC",
  "video_encoder": "$VIDEO_ENCODER",
  "audio_codec": $($has_audio && echo "\"$AUDIO_CODEC\"" || echo null),
  "segment_type": "$SEGMENT_TYPE",
  "segment_duration": $HLS_TIME,
  "gop_size": $GOP_SIZE,
  "subtitles": $subtitle_count
}
JSON

  # Atomic publish — a web server never sees a half-written package.
  mkdir -p "$(dirname -- "$FINAL_HLS_DIR")"
  rm -rf "$FINAL_HLS_DIR" && mv "$PARTIAL_HLS_DIR" "$FINAL_HLS_DIR"
  log "DONE" "[$idx/$total] HLS package: $FINAL_HLS_DIR/master.m3u8"

  $KEEP_RENDITIONS || rm -rf "$OUT_DIR"

  # ---- Archive the source ----
  if [[ "$ARCHIVE_SOURCE" == "true" ]]; then
    local done_target done_dir done_base done_stem done_ext candidate counter
    done_target="$PROCESSED_ROOT/$rel"
    done_dir="$(dirname -- "$done_target")"
    mkdir -p "$done_dir"

    if [[ -e "$done_target" ]]; then
      done_base="$(basename -- "$rel")"
      if [[ "$done_base" == *.* ]]; then
        done_stem="${done_base%.*}"; done_ext=".${done_base##*.}"
      else
        done_stem="$done_base"; done_ext=""
      fi
      counter=1
      while true; do
        candidate="$done_dir/${done_stem}__dup${counter}${done_ext}"
        if [[ ! -e "$candidate" ]]; then
          done_target="$candidate"
          break
        fi
        counter=$((counter + 1))
      done
    fi

    mv -f -- "$SOURCE" "$done_target"
    # Move sidecars with the source, or they linger in the input tree
    # forever and get re-copied on every later run.
    local v
    for v in ${found_vtts[@]+"${found_vtts[@]}"}; do
      [[ -e "$v" ]] && mv -f -- "$v" "$done_dir/"
    done
    log "DONE" "[$idx/$total] Source archived: $done_target"
  fi
}

# ----------------------------
# Run over all videos
# ----------------------------
batch_status="$(mktemp -d "$STATE_ROOT/batch-status.XXXXXX")"
trap 'rm -rf "$batch_status"' EXIT

for i in "${!VIDEO_FILES[@]}"; do
  while (( "$(jobs -pr | wc -l)" >= PARALLEL_VIDEOS )); do wait -n || true; done
  idx=$((i + 1))
  (
    # Pre-mark as failed, then upgrade on success. process_video's
    # fail() exits the subshell outright, so an else-branch here would
    # never run and the failure would go uncounted.
    echo fail > "$batch_status/$idx.status"
    if process_video "${VIDEO_FILES[$i]}" "$idx"; then
      echo success > "$batch_status/$idx.status"
    fi
  ) &
done
wait

# ----------------------------
# Summary
# ----------------------------
success=0; failed=0
for f in "$batch_status"/*.status; do
  [[ -f "$f" ]] || continue
  if [[ "$(cat "$f")" == "success" ]]; then
    success=$((success + 1))
  else
    failed=$((failed + 1))
  fi
done

echo
echo "Done. $success succeeded, $failed failed."
echo "HLS output:   $HLS_ROOT"
if [[ "$ARCHIVE_SOURCE" == "true" ]]; then
  echo "Archived src: $PROCESSED_ROOT"
fi
if (( failed > 0 )); then
  echo "Failed sources remain in $INPUT_ROOT for retry. Logs: $LOG_ROOT"
  exit 1
fi
exit 0
