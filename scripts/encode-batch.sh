#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# Recursive batch re-encoder - any codec, any accelerator.
#
# Shrinks a library of videos in place-ish: walks INPUT_DIR, re-encodes
# each file, and leaves OUTPUT_DIR holding only finished files. Unlike
# ./run.sh (which produces streaming HLS packages), this produces plain
# playable files - use it for archiving or transcoding a collection.
#
# Important output rule:
# - OUTPUT_DIR contains ONLY complete, ffprobe-validated files.
# - No .partial files are written to OUTPUT_DIR.
# - No .reserved files are written to OUTPUT_DIR.
# - No logs, locks, temp files, or marker files are written to OUTPUT_DIR.
#
# Workflow:
# 1. Find video files in INPUT_DIR
# 2. Move each source file into ./encode-working/sources/
# 3. Encode from ./encode-working/sources/
# 4. Write temporary encoded output to ./encode-working/partials/
# 5. Validate temporary output with ffprobe
# 6. Atomically move the complete file into OUTPUT_DIR
# 7. Move original to ./review-originals/ or delete with DELETE_ORIGINALS=true
#
# Local state directories are created under the directory where this
# script is executed:
#
#   ./encode-working/{sources,partials,reservations}/
#   ./review-originals/
#   ./error-originals/
#   ./encode-logs/
#
# Codec selection mirrors ./run.sh:
#
#   VIDEO_CODEC=h264|hevc|av1        (default av1)
#   AUDIO_CODEC=opus|aac             (default opus)
#   HWACCEL=auto|nvenc|qsv|vaapi|videotoolbox|none
#   VIDEO_ENCODER=<literal ffmpeg encoder>   bypasses the two above
#
# Examples:
#
#   INPUT_DIR=./raw OUTPUT_DIR=./encoded ./scripts/encode-batch.sh
#
#   # H.264 for maximum compatibility, CPU only, 1080p cap
#   VIDEO_CODEC=h264 AUDIO_CODEC=aac HWACCEL=none MAX_HEIGHT=1080 \
#   INPUT_DIR=./raw OUTPUT_DIR=./encoded ./scripts/encode-batch.sh
#
#   # Delete originals after a successful, validated encode
#   DELETE_ORIGINALS=true ./scripts/encode-batch.sh
#
# Run with --check to probe the machine and exit without encoding.
# ============================================================

# ----------------------------
# Run-local state paths
# ----------------------------

RUN_DIR="$(pwd -P)"

ENCODING_WORK_DIR="${ENCODING_WORK_DIR:-$RUN_DIR/encode-working}"
ENCODING_SOURCE_DIR="${ENCODING_SOURCE_DIR:-$ENCODING_WORK_DIR/sources}"
ENCODING_PARTIAL_DIR="${ENCODING_PARTIAL_DIR:-$ENCODING_WORK_DIR/partials}"
RESERVATION_DIR="${RESERVATION_DIR:-$ENCODING_WORK_DIR/reservations}"

ORIGINALS_REVIEW_DIR="${ORIGINALS_REVIEW_DIR:-$RUN_DIR/review-originals}"
ERROR_DIR="${ERROR_DIR:-$RUN_DIR/error-originals}"
LOG_DIR="${LOG_DIR:-$RUN_DIR/encode-logs}"

# ----------------------------
# Main paths
# ----------------------------

INPUT_DIR="${INPUT_DIR:-$RUN_DIR/notencoded}"
OUTPUT_DIR="${OUTPUT_DIR:-$RUN_DIR/encoded}"

# ----------------------------
# Encoding settings
# ----------------------------

# mkv holds anything; mp4 is more portable but cannot carry every codec.
OUTPUT_EXTENSION="${OUTPUT_EXTENSION:-mkv}"

VIDEO_CODEC="${VIDEO_CODEC:-av1}"        # h264 | hevc | av1
AUDIO_CODEC="${AUDIO_CODEC:-opus}"       # opus | aac | copy
HWACCEL="${HWACCEL:-auto}"               # auto | nvenc | qsv | vaapi | videotoolbox | none
VIDEO_ENCODER="${VIDEO_ENCODER:-}"       # literal encoder name; overrides the two above
VAAPI_DEVICE="${VAAPI_DEVICE:-/dev/dri/renderD128}"

NVENC_PRESET="${NVENC_PRESET:-p7}"
X264_PRESET="${X264_PRESET:-medium}"     # libx264 / libx265
SVTAV1_PRESET="${SVTAV1_PRESET:-6}"      # 0 slowest/best .. 13 fastest
AOM_CPU_USED="${AOM_CPU_USED:-5}"
QSV_PRESET="${QSV_PRESET:-medium}"

# Quality. Lower = better quality, bigger files, for every encoder.
# nvenc/qsv/vaapi read it as CQ/global_quality/QP; the software
# encoders read it as CRF.
# 32-34 = higher quality, larger files
# 35-37 = balanced archive compression
# 38+   = smaller files, more visible quality loss
CQ="${CQ:-35}"

MAX_HEIGHT="${MAX_HEIGHT:-720}"
AUDIO_BITRATE="${AUDIO_BITRATE:-160k}"
FPS_MODE="${FPS_MODE:-vfr}"
COLOR_RANGE="${COLOR_RANGE:-tv}"

PARALLEL_JOBS="${PARALLEL_JOBS:-4}"
MAX_PARALLEL_JOBS=8

FFMPEG_LOGLEVEL="${FFMPEG_LOGLEVEL:-warning}"

# true = skip if output already exists
# false = create duplicate output name with __dup001, __dup002, etc.
SKIP_EXISTING="${SKIP_EXISTING:-true}"

# false = move successful originals to ./review-originals/
# true  = delete originals only after successful validated encode
DELETE_ORIGINALS="${DELETE_ORIGINALS:-false}"

# ----------------------------
# Setup
# ----------------------------

INPUT_DIR="$(realpath "$INPUT_DIR")"
OUTPUT_DIR="$(realpath -m "$OUTPUT_DIR")"

ENCODING_WORK_DIR="$(realpath -m "$ENCODING_WORK_DIR")"
ENCODING_SOURCE_DIR="$(realpath -m "$ENCODING_SOURCE_DIR")"
ENCODING_PARTIAL_DIR="$(realpath -m "$ENCODING_PARTIAL_DIR")"
RESERVATION_DIR="$(realpath -m "$RESERVATION_DIR")"

ORIGINALS_REVIEW_DIR="$(realpath -m "$ORIGINALS_REVIEW_DIR")"
ERROR_DIR="$(realpath -m "$ERROR_DIR")"
LOG_DIR="$(realpath -m "$LOG_DIR")"

mkdir -p \
  "$OUTPUT_DIR" \
  "$ENCODING_WORK_DIR" \
  "$ENCODING_SOURCE_DIR" \
  "$ENCODING_PARTIAL_DIR" \
  "$RESERVATION_DIR" \
  "$ORIGINALS_REVIEW_DIR" \
  "$ERROR_DIR" \
  "$LOG_DIR"

TIMESTAMP="$(date +"%Y%m%d_%H%M%S")"
MASTER_LOG="$LOG_DIR/encode-batch-$TIMESTAMP.log"

OUTPUT_LOCK_FILE="$LOG_DIR/output-reservation.lock"
MOVE_LOCK_FILE="$LOG_DIR/move-reservation.lock"

touch "$MASTER_LOG" "$OUTPUT_LOCK_FILE" "$MOVE_LOCK_FILE"

if (( PARALLEL_JOBS > MAX_PARALLEL_JOBS )); then
  echo "PARALLEL_JOBS=$PARALLEL_JOBS is above max recommended value $MAX_PARALLEL_JOBS. Limiting to $MAX_PARALLEL_JOBS." | tee -a "$MASTER_LOG"
  PARALLEL_JOBS="$MAX_PARALLEL_JOBS"
fi

log() {
  local level="$1"
  shift
  printf '[%s] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$level" "$*" | tee -a "$MASTER_LOG"
}

fail() {
  log "FATAL" "$*"
  exit 1
}

# ----------------------------
# Dependency checks
# ----------------------------

command -v ffmpeg >/dev/null 2>&1 || fail "ffmpeg not found. Install with: sudo apt install -y ffmpeg"
command -v ffprobe >/dev/null 2>&1 || fail "ffprobe not found. Install with: sudo apt install -y ffmpeg"
command -v flock >/dev/null 2>&1 || fail "flock not found. Install with: sudo apt install -y util-linux"
command -v realpath >/dev/null 2>&1 || fail "realpath not found. Install with: sudo apt install -y coreutils"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum not found. Install with: sudo apt install -y coreutils"

FFMPEG_ENCODERS="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"

encoder_compiled_in() {
  awk 'NR>2 {print $2}' <<< "$FFMPEG_ENCODERS" | grep -qx -- "$1"
}

software_encoders_for() {
  case "$1" in
    h264) echo "libx264" ;;
    hevc) echo "libx265" ;;
    av1)  echo "libsvtav1 libaom-av1" ;;
    *) return 1 ;;
  esac
}

# Compiled in != usable. A build can advertise nvenc on a machine with no
# NVIDIA card, so encode a throwaway frame and see what actually happens.
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

resolve_video_encoder() {
  local codec="$1" accel="$2"
  local -a candidates=() sw=()
  read -r -a sw <<< "$(software_encoders_for "$codec")"
  case "$accel" in
    nvenc)        candidates=("${codec}_nvenc") ;;
    qsv)          candidates=("${codec}_qsv") ;;
    vaapi)        candidates=("${codec}_vaapi") ;;
    videotoolbox) candidates=("${codec}_videotoolbox") ;;
    none)         candidates=("${sw[@]}") ;;
    auto)         candidates=("${codec}_nvenc" "${codec}_qsv" "${codec}_vaapi" "${codec}_videotoolbox" "${sw[@]}") ;;
    *) return 1 ;;
  esac
  local enc
  for enc in "${candidates[@]}"; do
    encoder_compiled_in "$enc" && encoder_usable "$enc" && { echo "$enc"; return 0; }
  done
  return 1
}

case "$VIDEO_CODEC" in
  h264|hevc|av1) ;;
  *) fail "VIDEO_CODEC must be h264, hevc or av1 (got '$VIDEO_CODEC')" ;;
esac

case "$AUDIO_CODEC" in
  opus) AUDIO_ENCODER="libopus" ;;
  aac)  AUDIO_ENCODER="aac" ;;
  copy) AUDIO_ENCODER="copy" ;;
  *) fail "AUDIO_CODEC must be opus, aac or copy (got '$AUDIO_CODEC')" ;;
esac

if [[ "$AUDIO_ENCODER" != "copy" ]] && ! encoder_compiled_in "$AUDIO_ENCODER"; then
  fail "ffmpeg does not provide audio encoder '$AUDIO_ENCODER'. Install an ffmpeg built with it."
fi

if [[ -n "$VIDEO_ENCODER" ]]; then
  encoder_compiled_in "$VIDEO_ENCODER" \
    || fail "ffmpeg does not provide video encoder '$VIDEO_ENCODER'. Check your ffmpeg build."
else
  VIDEO_ENCODER="$(resolve_video_encoder "$VIDEO_CODEC" "$HWACCEL")" \
    || fail "No usable $VIDEO_CODEC encoder for HWACCEL='$HWACCEL'. Try HWACCEL=none for CPU encoding."
fi

if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1 || true)"
  log "INFO" "NVIDIA GPU detected: ${GPU_NAME:-unknown}"
fi
log "INFO" "Video encoder: $VIDEO_ENCODER   Audio: $AUDIO_ENCODER"

if [[ "${1:-}" == "--check" ]]; then
  echo "encode-batch: ready. video=$VIDEO_ENCODER audio=$AUDIO_ENCODER container=$OUTPUT_EXTENSION"
  exit 0
fi

# ----------------------------
# Cleanup on interruption
# ----------------------------

cleanup() {
  log "WARN" "Interrupted. Stopping child ffmpeg processes..."
  pkill -P $$ ffmpeg 2>/dev/null || true
  pkill -P $$ 2>/dev/null || true
  exit 130
}

trap cleanup SIGINT SIGTERM

# ----------------------------
# Helper functions
# ----------------------------

get_relative_path() {
  local file="$1"
  printf '%s\n' "${file#$INPUT_DIR/}"
}

without_extension() {
  local path="$1"
  local base
  base="$(basename "$path")"
  printf '%s\n' "${base%.*}"
}

safe_name() {
  local name="$1"
  name="${name//\//__}"
  name="${name// /_}"
  name="${name//:/_}"
  name="${name//;/_}"
  name="${name//\'/_}"
  name="${name//\"/_}"
  printf '%s\n' "$name"
}

hash_string() {
  local value="$1"
  printf '%s' "$value" | sha256sum | awk '{print $1}'
}

reservation_marker_for_output() {
  local output_path="$1"
  local hash
  hash="$(hash_string "$output_path")"
  printf '%s/%s.lock' "$RESERVATION_DIR" "$hash"
}

reserve_output_path() {
  local desired="$1"
  local dir base stem ext candidate counter marker

  dir="$(dirname "$desired")"
  base="$(basename "$desired")"

  if [[ "$base" == *.* ]]; then
    stem="${base%.*}"
    ext=".${base##*.}"
  else
    stem="$base"
    ext=""
  fi

  mkdir -p "$dir"

  (
    flock -x 200

    if [[ "$SKIP_EXISTING" == "true" && -f "$desired" ]]; then
      printf 'SKIP:%s\n' "$desired"
      exit 0
    fi

    marker="$(reservation_marker_for_output "$desired")"

    if [[ ! -e "$desired" && ! -e "$marker" ]]; then
      printf '%s\n' "$desired" > "$marker"
      printf '%s\n' "$desired"
      exit 0
    fi

    counter=1

    while true; do
      candidate="$(printf '%s/%s__dup%03d%s' "$dir" "$stem" "$counter" "$ext")"
      marker="$(reservation_marker_for_output "$candidate")"

      if [[ "$SKIP_EXISTING" == "true" && -f "$candidate" ]]; then
        ((counter++))
        continue
      fi

      if [[ ! -e "$candidate" && ! -e "$marker" ]]; then
        printf '%s\n' "$candidate" > "$marker"
        printf '%s\n' "$candidate"
        exit 0
      fi

      ((counter++))
    done
  ) 200>"$OUTPUT_LOCK_FILE"
}

release_output_reservation() {
  local output_path="$1"
  local marker
  marker="$(reservation_marker_for_output "$output_path")"
  rm -f -- "$marker"
}

reserve_move_path() {
  local desired="$1"
  local dir base stem ext candidate counter

  dir="$(dirname "$desired")"
  base="$(basename "$desired")"

  if [[ "$base" == *.* ]]; then
    stem="${base%.*}"
    ext=".${base##*.}"
  else
    stem="$base"
    ext=""
  fi

  mkdir -p "$dir"

  (
    flock -x 201

    if [[ ! -e "$desired" ]]; then
      printf '%s\n' "$desired"
      exit 0
    fi

    counter=1

    while true; do
      candidate="$(printf '%s/%s__dup%03d%s' "$dir" "$stem" "$counter" "$ext")"

      if [[ ! -e "$candidate" ]]; then
        printf '%s\n' "$candidate"
        exit 0
      fi

      ((counter++))
    done
  ) 201>"$MOVE_LOCK_FILE"
}

move_to_encoding_source_dir() {
  local input_file="$1"
  local rel="$2"
  local desired_source_path source_path

  desired_source_path="$ENCODING_SOURCE_DIR/$rel"
  source_path="$(reserve_move_path "$desired_source_path")"

  mkdir -p "$(dirname "$source_path")"

  if mv -- "$input_file" "$source_path"; then
    printf '%s\n' "$source_path"
    return 0
  fi

  return 1
}

move_staged_original_success() {
  local staged_file="$1"
  local rel="$2"

  if [[ "$DELETE_ORIGINALS" == "true" ]]; then
    rm -f -- "$staged_file"
    return
  fi

  local desired_review_path review_path
  desired_review_path="$ORIGINALS_REVIEW_DIR/$rel"
  review_path="$(reserve_move_path "$desired_review_path")"

  mkdir -p "$(dirname "$review_path")"
  mv -- "$staged_file" "$review_path"
}

move_staged_original_error() {
  local staged_file="$1"
  local rel="$2"

  local desired_error_path error_path
  desired_error_path="$ERROR_DIR/$rel"
  error_path="$(reserve_move_path "$desired_error_path")"

  mkdir -p "$(dirname "$error_path")"
  mv -- "$staged_file" "$error_path"
}

validate_output() {
  local output_file="$1"

  [[ -s "$output_file" ]] || return 1

  ffprobe -v error \
    -select_streams v:0 \
    -show_entries stream=codec_name,width,height \
    -of default=noprint_wrappers=1 \
    "$output_file" >/dev/null 2>&1
}

# Quality flags differ per encoder family; CQ is the single user-facing knob.
build_quality_args() {
  QUALITY_ARGS=()
  case "$VIDEO_ENCODER" in
    *_nvenc)        QUALITY_ARGS=(-preset "$NVENC_PRESET" -rc vbr -cq "$CQ" -b:v 0) ;;
    *_qsv)          QUALITY_ARGS=(-preset "$QSV_PRESET" -global_quality "$CQ") ;;
    *_vaapi)        QUALITY_ARGS=(-rc_mode CQP -qp "$CQ") ;;
    *_videotoolbox) QUALITY_ARGS=(-q:v "$CQ") ;;
    libx264|libx265) QUALITY_ARGS=(-preset "$X264_PRESET" -crf "$CQ") ;;
    libsvtav1)      QUALITY_ARGS=(-preset "$SVTAV1_PRESET" -crf "$CQ") ;;
    libaom-av1)     QUALITY_ARGS=(-crf "$CQ" -b:v 0 -cpu-used "$AOM_CPU_USED" -row-mt 1) ;;
    *)              QUALITY_ARGS=(-crf "$CQ") ;;
  esac
}

encode_with_ffmpeg() {
  local input_file="$1"
  local temp_output="$2"
  local job_log="$3"

  local -a pre=() vf=() pixfmt=() audio=() tag=()

  case "$VIDEO_ENCODER" in
    *_vaapi)
      pre=(-vaapi_device "$VAAPI_DEVICE")
      vf=(-vf "scale=-2:min(${MAX_HEIGHT}\,ih),format=nv12,hwupload")
      ;;
    *)
      vf=(-vf "scale=-2:min(${MAX_HEIGHT}\,ih),format=yuv420p")
      pixfmt=(-pix_fmt yuv420p)
      ;;
  esac

  if [[ "$AUDIO_ENCODER" == "copy" ]]; then
    audio=(-c:a copy)
  else
    audio=(-c:a "$AUDIO_ENCODER" -b:a "$AUDIO_BITRATE" -ac 2)
  fi

  # mp4 needs the hvc1/av01 tags for Apple players to accept the track.
  if [[ "$OUTPUT_EXTENSION" == "mp4" ]]; then
    case "$VIDEO_CODEC" in
      hevc) tag=(-tag:v hvc1) ;;
      av1)  tag=(-tag:v av01) ;;
    esac
  fi

  build_quality_args

  ffmpeg \
    -hide_banner \
    -nostdin \
    -y \
    -loglevel "$FFMPEG_LOGLEVEL" \
    -stats \
    "${pre[@]}" \
    -i "$input_file" \
    -map 0:v:0 \
    -map 0:a:0? \
    -map_metadata 0 \
    -map_chapters 0 \
    "${vf[@]}" \
    -c:v "$VIDEO_ENCODER" \
    "${QUALITY_ARGS[@]}" \
    "${pixfmt[@]}" \
    -color_range "$COLOR_RANGE" \
    -fps_mode "$FPS_MODE" \
    "${tag[@]}" \
    "${audio[@]}" \
    -sn \
    -dn \
    -max_muxing_queue_size 4096 \
    "$temp_output" \
    2>&1 | tee -a "$job_log"

  return "${PIPESTATUS[0]}"
}

process_video() {
  local input_file="$1"
  local index="$2"
  local total="$3"

  local rel rel_dir filename_no_ext output_dir desired_output output_file
  local staged_file temp_output job_log safe_rel_log temp_name output_hash

  rel="$(get_relative_path "$input_file")"
  rel_dir="$(dirname "$rel")"
  filename_no_ext="$(without_extension "$input_file")"

  if [[ "$rel_dir" == "." ]]; then
    output_dir="$OUTPUT_DIR"
  else
    output_dir="$OUTPUT_DIR/$rel_dir"
  fi

  mkdir -p "$output_dir"

  desired_output="$output_dir/$filename_no_ext.$OUTPUT_EXTENSION"
  output_file="$(reserve_output_path "$desired_output")"

  if [[ "$output_file" == SKIP:* ]]; then
    log "SKIP" "[$index/$total] Output already exists, source left in place: ${output_file#SKIP:}"
    return 0
  fi

  safe_rel_log="$(safe_name "$rel")"
  output_hash="$(hash_string "$output_file")"
  temp_name="${output_hash}.${filename_no_ext}.partial.$OUTPUT_EXTENSION"
  temp_output="$ENCODING_PARTIAL_DIR/$temp_name"
  job_log="$LOG_DIR/job_${index}_${safe_rel_log}.log"

  {
    echo "============================================================"
    echo "Job:              $index / $total"
    echo "Started:          $(date)"
    echo "Original input:   $input_file"
    echo "Relative:         $rel"
    echo "Final output:     $output_file"
    echo "Temp output:      $temp_output"
    echo "CQ:               $CQ"
    echo "Preset:           $NVENC_PRESET"
    echo "Max height:       $MAX_HEIGHT"
    echo "Audio:            Opus stereo $AUDIO_BITRATE"
    echo "FPS mode:         $FPS_MODE"
    echo "Color:            $COLOR_RANGE"
    echo "Delete originals: $DELETE_ORIGINALS"
    echo "============================================================"
  } > "$job_log"

  log "STAGE" "[$index/$total] Moving source into encoding work dir: $rel"

  if ! staged_file="$(move_to_encoding_source_dir "$input_file" "$rel")"; then
    log "ERROR" "[$index/$total] Failed to move source into encoding work dir: $rel"
    release_output_reservation "$output_file"
    return 1
  fi

  {
    echo "Staged input:     $staged_file"
    echo "============================================================"
  } >> "$job_log"

  log "START" "[$index/$total] Encoding from staged file: $rel"

  rm -f -- "$temp_output"

  if ! encode_with_ffmpeg "$staged_file" "$temp_output" "$job_log"; then
    log "WARN" "[$index/$total] First encode attempt failed. Retrying once: $rel"
    rm -f -- "$temp_output"

    if ! encode_with_ffmpeg "$staged_file" "$temp_output" "$job_log"; then
      log "ERROR" "[$index/$total] Encode failed: $rel"
      rm -f -- "$temp_output"
      release_output_reservation "$output_file"

      if move_staged_original_error "$staged_file" "$rel"; then
        log "ERROR" "[$index/$total] Failed staged original moved to error directory: $rel"
      else
        log "ERROR" "[$index/$total] Could not move errored staged original. It may remain at: $staged_file"
      fi

      return 1
    fi
  fi

  if ! validate_output "$temp_output"; then
    log "ERROR" "[$index/$total] Output validation failed: $rel"
    rm -f -- "$temp_output"
    release_output_reservation "$output_file"

    if move_staged_original_error "$staged_file" "$rel"; then
      log "ERROR" "[$index/$total] Validation-failed original moved to error directory: $rel"
    else
      log "ERROR" "[$index/$total] Could not move validation-failed original. It may remain at: $staged_file"
    fi

    return 1
  fi

  # Final move:
  # This is the only write into OUTPUT_DIR.
  # At this point the file is a complete, validated .mkv.
  mv -f -- "$temp_output" "$output_file"
  release_output_reservation "$output_file"

  if ! move_staged_original_success "$staged_file" "$rel"; then
    log "WARN" "[$index/$total] Encoded successfully but failed to move/delete staged original: $rel"
    return 1
  fi

  if [[ "$DELETE_ORIGINALS" == "true" ]]; then
    log "DONE" "[$index/$total] $rel -> $output_file ; original deleted"
  else
    log "DONE" "[$index/$total] $rel -> $output_file ; original moved to review"
  fi

  return 0
}

wait_for_slot() {
  local max_jobs="$1"

  while (( "$(jobs -pr | wc -l)" >= max_jobs )); do
    wait -n || true
  done
}

# ----------------------------
# Safety checks
# ----------------------------

if [[ "$INPUT_DIR" == "$OUTPUT_DIR" ]]; then
  fail "INPUT_DIR and OUTPUT_DIR cannot be the same directory."
fi

if [[ "$OUTPUT_DIR" == "$ENCODING_WORK_DIR" ]] || [[ "$OUTPUT_DIR" == "$ENCODING_SOURCE_DIR" ]] || [[ "$OUTPUT_DIR" == "$ENCODING_PARTIAL_DIR" ]]; then
  fail "OUTPUT_DIR cannot be the same as any encoding work directory."
fi

case "$ENCODING_WORK_DIR" in
  "$OUTPUT_DIR"/*)
    fail "ENCODING_WORK_DIR cannot be inside OUTPUT_DIR. OUTPUT_DIR must contain only complete .mkv files."
    ;;
esac

case "$LOG_DIR" in
  "$OUTPUT_DIR"/*)
    fail "LOG_DIR cannot be inside OUTPUT_DIR. OUTPUT_DIR must contain only complete .mkv files."
    ;;
esac

case "$ORIGINALS_REVIEW_DIR" in
  "$OUTPUT_DIR"/*)
    fail "ORIGINALS_REVIEW_DIR cannot be inside OUTPUT_DIR. OUTPUT_DIR must contain only complete .mkv files."
    ;;
esac

case "$ERROR_DIR" in
  "$OUTPUT_DIR"/*)
    fail "ERROR_DIR cannot be inside OUTPUT_DIR. OUTPUT_DIR must contain only complete .mkv files."
    ;;
esac

if [[ "$INPUT_DIR" == "$ENCODING_SOURCE_DIR" ]]; then
  fail "INPUT_DIR and ENCODING_SOURCE_DIR cannot be the same directory."
fi

if [[ "$INPUT_DIR" == "$ORIGINALS_REVIEW_DIR" ]]; then
  fail "INPUT_DIR and ORIGINALS_REVIEW_DIR cannot be the same directory."
fi

if [[ "$INPUT_DIR" == "$ERROR_DIR" ]]; then
  fail "INPUT_DIR and ERROR_DIR cannot be the same directory."
fi

# ----------------------------
# Startup summary
# ----------------------------

log "INFO" "Run directory:          $RUN_DIR"
log "INFO" "Input:                  $INPUT_DIR"
log "INFO" "Output:                 $OUTPUT_DIR"
log "INFO" "Encoding work dir:      $ENCODING_WORK_DIR"
log "INFO" "Encoding source dir:    $ENCODING_SOURCE_DIR"
log "INFO" "Encoding partial dir:   $ENCODING_PARTIAL_DIR"
log "INFO" "Reservation dir:        $RESERVATION_DIR"
log "INFO" "Review originals:       $ORIGINALS_REVIEW_DIR"
log "INFO" "Error originals:        $ERROR_DIR"
log "INFO" "Logs:                   $LOG_DIR"
log "INFO" "Delete originals:       $DELETE_ORIGINALS"
log "INFO" "Parallel jobs:          $PARALLEL_JOBS"
log "INFO" "CQ:                     $CQ"
log "INFO" "NVENC preset:           $NVENC_PRESET"
log "INFO" "Max height:             $MAX_HEIGHT"
log "INFO" "Output cleanliness:     OUTPUT_DIR receives only complete .mkv files"

# ----------------------------
# Find videos
# ----------------------------

mapfile -d '' VIDEO_FILES < <(
  find "$INPUT_DIR" \
    \( -path "$ENCODING_WORK_DIR" -o \
       -path "$ENCODING_WORK_DIR/*" -o \
       -path "$ORIGINALS_REVIEW_DIR" -o \
       -path "$ORIGINALS_REVIEW_DIR/*" -o \
       -path "$ERROR_DIR" -o \
       -path "$ERROR_DIR/*" \
    \) -prune -o \
    -type f \( \
      -iname "*.mkv"  -o \
      -iname "*.mp4"  -o \
      -iname "*.m4v"  -o \
      -iname "*.mov"  -o \
      -iname "*.avi"  -o \
      -iname "*.wmv"  -o \
      -iname "*.flv"  -o \
      -iname "*.webm" -o \
      -iname "*.mpg"  -o \
      -iname "*.mpeg" -o \
      -iname "*.ts"   -o \
      -iname "*.mts"  -o \
      -iname "*.m2ts" -o \
      -iname "*.vob"  -o \
      -iname "*.3gp"  -o \
      -iname "*.divx" \
    \) -print0 | sort -z
)

TOTAL="${#VIDEO_FILES[@]}"

if (( TOTAL == 0 )); then
  log "INFO" "No video files found."
  exit 0
fi

log "INFO" "Found $TOTAL video file(s)."

SUCCESS_COUNT=0
FAIL_COUNT=0
STATUS_DIR="$(mktemp -d "$LOG_DIR/status.XXXXXX")"

trap 'rm -rf "$STATUS_DIR"; cleanup' SIGINT SIGTERM

# ----------------------------
# Process in parallel
# ----------------------------

for i in "${!VIDEO_FILES[@]}"; do
  wait_for_slot "$PARALLEL_JOBS"

  index="$((i + 1))"
  status_file="$STATUS_DIR/job_$index.status"

  (
    if process_video "${VIDEO_FILES[$i]}" "$index" "$TOTAL"; then
      echo "success" > "$status_file"
    else
      echo "fail" > "$status_file"
    fi
  ) &
done

wait

# ----------------------------
# Summary
# ----------------------------

for status in "$STATUS_DIR"/*.status; do
  [[ -f "$status" ]] || continue

  case "$(cat "$status")" in
    success) SUCCESS_COUNT="$((SUCCESS_COUNT + 1))" ;;
    fail)    FAIL_COUNT="$((FAIL_COUNT + 1))" ;;
  esac
done

rm -rf "$STATUS_DIR"

log "INFO" "============================================================"
log "INFO" "Encoding complete."
log "INFO" "Total files:            $TOTAL"
log "INFO" "Successful files:       $SUCCESS_COUNT"
log "INFO" "Failed files:           $FAIL_COUNT"
log "INFO" "Encoded outputs:        $OUTPUT_DIR"
log "INFO" "Encoding work dir:      $ENCODING_WORK_DIR"
log "INFO" "Partial temp outputs:   $ENCODING_PARTIAL_DIR"
log "INFO" "Review originals:       $ORIGINALS_REVIEW_DIR"
log "INFO" "Errored originals:      $ERROR_DIR"
log "INFO" "Master log:             $MASTER_LOG"
log "INFO" "OUTPUT_DIR rule:        only complete .mkv files are written there"
log "INFO" "============================================================"

if (( FAIL_COUNT > 0 )); then
  exit 1
fi

exit 0
