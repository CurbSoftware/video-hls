# video-hls

Turn any video into adaptive-bitrate HLS with one command.

Drop files into `video/`, run `./run.sh`, and get streaming-ready packages in
`hls/` - a master playlist, one variant per quality tier, and segments that all
cut at the same timestamps so players can switch tiers without stuttering.

```bash
git clone https://github.com/CurbSoftware/video-hls.git
cd video-hls
cp .env.example .env      # optional - defaults work as-is
./run.sh --check          # confirm ffmpeg and your encoders
cp ~/Videos/talk.mp4 video/
./run.sh
```

```
hls/talk/
├── master.m3u8          ← point your player here
├── 360p/index.m3u8 + seg_000000.ts …
├── 720p/index.m3u8 + seg_000000.ts …
├── 1080p/index.m3u8 + seg_000000.ts …
└── package.json         ← what was produced, and how
```

---

## Why this exists

Putting video on a site normally means renting a video platform - Mux,
Cloudflare Stream, api.video, Vimeo. You upload, they transcode, they host, and
you pay per minute stored *and* per minute delivered, forever. It works, but
your content lives on someone else's platform, costs scale with every view, and
the URLs and player are theirs.

This project does the transcoding half yourself. The output is a plain folder of
static files - playlists and segments, nothing else. Push it to S3, Cloudflare
R2, Backblaze B2, DigitalOcean Spaces, or your own nginx, and serve it like any
other static asset. No API, no account, no per-minute billing. Storage and
bandwidth you are already paying for.

Every path inside a package is relative, so a package is location-independent:
move it, rename it, or drop it behind a CDN and it still plays.

### What HLS buys you over an MP4 file

**Less bandwidth.** A progressive `.mp4` makes every viewer download the whole
file at full size - a phone on cellular pulls the same 1080p bytes as a
desktop. HLS ships the tier that matches the viewer's screen and connection, in
~6-second segments. Someone who watches 30 seconds and leaves costs you 30
seconds of transfer, not a 500 MB file. On a large library that is usually the
single biggest hosting saving.

**Multiple resolutions, chosen automatically.** One package holds every tier.
The player measures throughput and switches mid-playback - no buffering spinner
when the wifi dips, no manual quality selector.

**Instant start and seeking.** Playback begins after one small segment instead
of buffering a large file header, and seeking fetches only the segments needed.

### Access control and signed URLs

This is what matters for paid content like online courses, and it works
naturally here - but the details are worth getting right, because one playback
is many HTTP requests (a master playlist, a variant playlist, then every
segment).

- **Signed cookies - the right default.** CloudFront signed cookies, Cloudflare
  signed cookies, or an equivalent authorize a whole *path prefix* in one go.
  Issue the cookie when a student opens a lesson, and every playlist and segment
  under that prefix is covered. Works with these packages unmodified.
- **Per-URL presigning.** Plain S3 presigned URLs sign one object each, so you
  must generate playlists per viewer with signatures already substituted in, or
  put a small signing proxy in front. Doable, just more moving parts than people
  expect.
- **Edge tokens.** A Cloudflare Worker, nginx `secure_link`, or a tiny auth
  service in front of the bucket, checking a short-lived token before serving.
  Common for course platforms that already have a login.

Because the pipeline emits relative URIs and a predictable directory per video,
any of these slot in without touching the packages themselves.

**One caveat, stated plainly:** signed URLs are access control, not DRM. They
stop a link from being pasted into a group chat; they do not stop a determined
user from downloading the segments. Real DRM (Widevine, PlayReady, FairPlay)
needs encryption plus a license server - that is genuine, hard infrastructure,
and it is where the hosted platforms actually earn their fee.

### What you give up

| | Hosted platform | This project |
|---|---|---|
| Transcoding | Managed | Yours (this repo) |
| Storage & delivery | Theirs, metered | Any S3-compatible store or server |
| Cost model | Per minute stored + delivered | Flat storage + bandwidth |
| Per-viewer analytics | Built in | Wire up yourself |
| Auto captions / transcription | Built in | Bring your own `.vtt` |
| DRM & license server | Built in | Not included |
| Live streaming | Built in | Not included (VOD only) |
| Thumbnails / storyboards | Built in | Not included |
| Global CDN | Built in | Put one in front of your bucket |

If you need live streaming, DRM, or turnkey analytics, a hosted platform is the
right call. If you have a library of finished videos and want to own the files
and the bill, this is the missing piece.

---

## Features

- **Any codec, any accelerator.** H.264, HEVC and AV1 across NVENC, Intel QSV,
  VAAPI, VideoToolbox, or pure CPU. `HWACCEL=auto` probes your machine and
  picks the fastest working encoder, falling back to software.
- **Runs anywhere.** No GPU required. Zero dependencies beyond `ffmpeg`,
  `ffprobe`, `python3` and bash.
- **Never upscales.** A 720p source produces 720p and below. Tiers taller than
  the source are skipped automatically, so you don't ship a blurry "1080p".
- **Correct `CODECS` metadata.** Profile and level are read back from each
  encoded rendition rather than hardcoded, and audio is only advertised when
  the source actually has some - the two most common causes of a stream that
  plays in VLC but not in a browser.
- **Seamless tier switching.** Keyframe interval is locked to `fps × HLS_TIME`
  for every rendition, so segment boundaries line up exactly.
- **Right container, automatically.** MPEG-TS for H.264+AAC; fMP4/CMAF whenever
  you pick HEVC, AV1 or Opus, which MPEG-TS cannot carry.
- **Subtitles.** Drop `myvideo.en.vtt` next to `myvideo.mp4` and it is wired
  into the master playlist. First one found becomes the default track.
- **Atomic publishing.** Packages are built in a scratch directory and swapped
  into place, so a web server never sees a half-written package.
- **Safe to interrupt.** Finished renditions are reused on the next run.
  Failed sources stay put for retry; only successes are archived.
- **Batch friendly.** Recurses subfolders and mirrors the structure into the
  output. Per-video and per-rendition concurrency are both tunable.

---

## Requirements

| | |
|---|---|
| `ffmpeg` + `ffprobe` | 5.0 or newer. Must include the encoders you intend to use. |
| `python3` | Computes the keyframe interval from fractional frame rates (e.g. 30000/1001). |
| `bash` | 4.4+ (`mapfile -d`, `wait -n`). macOS ships bash 3.2 - `brew install bash`. |

```bash
# Debian / Ubuntu
sudo apt install ffmpeg python3

# macOS
brew install ffmpeg python3 bash
```

Hardware encoding needs the matching driver: NVIDIA for NVENC, `/dev/dri`
render node for VAAPI, Intel media driver for QSV. None of it is required -
`HWACCEL=none` uses libx264/libx265/SVT-AV1 and works everywhere.

Check what your machine can actually do:

```bash
./run.sh --check
```

This encodes a throwaway frame with each candidate encoder, so it reports what
genuinely works rather than what ffmpeg merely claims to support:

```
Video encoders (compiled in / actually usable):
  h264
    h264_nvenc             USABLE
    h264_qsv               built, not usable here
    h264_vaapi             USABLE
    libx264                USABLE
```

---

## Usage

```bash
./run.sh              # process everything under video/
./run.sh --check      # probe dependencies, encoders, GPU; encode nothing
./run.sh --dry-run    # list what would be produced, per tier
./run.sh --help
```

Any setting can be overridden for a single run:

```bash
VIDEO_CODEC=av1 AUDIO_CODEC=opus ./run.sh       # smallest files
VIDEO_CODEC=h264 HWACCEL=none QUALITY=23 ./run.sh   # CPU, higher quality
MAX_RESOLUTION_HEIGHT=720 ./run.sh              # cap the ladder at 720p
INPUT_ROOT=~/footage HLS_ROOT=/srv/www/hls ./run.sh  # different locations
```

Precedence is **environment > `.env` > built-in defaults**, so a `.env` can
hold your normal setup while you still override per run.

### Workflow

1. Put video files in `video/`. Subfolders are allowed and preserved:
   `video/course/lesson-1.mp4` → `hls/course/lesson-1/master.m3u8`.
2. Run `./run.sh`.
3. Serve `hls/` over HTTP and point a player at `master.m3u8`.

Successful sources move to `video-done/`, so `video/` is empty and ready for
the next batch. Failures stay in `video/` - fix and re-run.

### Playing the result

HLS needs to be served over HTTP; opening `master.m3u8` from disk will not
work. For a quick local check:

```bash
cd hls && python3 -m http.server 8000
# then open http://localhost:8000/talk/master.m3u8
```

Safari plays HLS natively. Chrome and Firefox need a player such as
[hls.js](https://github.com/video-dev/hls.js) or Video.js.

### Hosting the output

`hls/` is static files. Copy it to any object store or web server:

```bash
aws s3 sync hls/ s3://my-bucket/videos/          # S3
rclone sync hls/ r2:my-bucket/videos/            # Cloudflare R2, B2, Spaces…
rsync -av hls/ server:/var/www/videos/           # your own nginx
```

Two things trip people up, and both produce a stream that works locally and
fails in production:

**Content types.** Many buckets default to `application/octet-stream`, which
some players refuse. Set them explicitly:

| Extension | Content-Type |
|---|---|
| `.m3u8` | `application/vnd.apple.mpegurl` |
| `.ts` | `video/mp2t` |
| `.m4s` | `video/iso.segment` |
| `.mp4` (fMP4 init) | `video/mp4` |
| `.vtt` | `text/vtt` |

```bash
aws s3 cp hls/ s3://my-bucket/videos/ --recursive \
  --exclude "*" --include "*.m3u8" \
  --content-type application/vnd.apple.mpegurl --metadata-directive REPLACE
```

**CORS.** If the page and the files are on different origins, the bucket must
send CORS headers - hls.js fetches playlists and segments over XHR, and Safari
needs them cross-origin too. Allow `GET` and `HEAD` from your site's origin.

Everything is immutable once published, so cache it hard
(`Cache-Control: public, max-age=31536000, immutable`) and let a CDN absorb the
traffic. Republishing a video replaces the whole directory, so use a new path
or purge that prefix.

---

## Configuration

Copy `.env.example` to `.env` and edit. Everything below is optional.

### Paths

| Variable | Default | Purpose |
|---|---|---|
| `INPUT_ROOT` | `./video` | Where sources are found (recursive). |
| `HLS_ROOT` | `./hls` | Published packages. Serve this directory. |
| `WORK_ROOT` | `./video-work` | Scratch tree. Safe to delete at any time. |
| `PROCESSED_ROOT` | `./video-done` | Sources moved here after success. |
| `ENCODED_ROOT` | `$WORK_ROOT/encoded` | Intermediate renditions. |
| `STATE_ROOT` | `$WORK_ROOT/state` | Partial files and job status. |
| `LOG_ROOT` | `$WORK_ROOT/logs` | One timestamped log per video. |

Relative paths resolve against the repository, not your shell's working
directory, so `./run.sh` behaves identically from anywhere.

### Codecs

| Variable | Default | Values |
|---|---|---|
| `VIDEO_CODEC` | `h264` | `h264` · `hevc` · `av1` |
| `AUDIO_CODEC` | `aac` | `aac` · `opus` |
| `HWACCEL` | `auto` | `auto` · `nvenc` · `qsv` · `vaapi` · `videotoolbox` · `none` |
| `VIDEO_ENCODER` | *(empty)* | Literal ffmpeg encoder (`libx264`, `hevc_vaapi`, …). Overrides the two above. |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | Render node for VAAPI. |

Choosing a video codec:

| | Compatibility | Size | Encode speed |
|---|---|---|---|
| **h264** | Everything, everywhere | Largest | Fastest |
| **hevc** | Safari/iOS/TVs; **not** Chrome or Firefox on the open web | ~40% smaller | Medium |
| **av1** | Modern browsers and players only | Smallest | Slowest in software |

`auto` resolves in order: NVENC → QSV → VAAPI → VideoToolbox → software, using
the first that passes a live encode test.

### Quality

| Variable | Default | Notes |
|---|---|---|
| `QUALITY` | `28` | One knob for every encoder. Lower = better and bigger. |
| `NVENC_PRESET` | `p6` | `p1` fastest … `p7` best. |
| `X264_PRESET` | `medium` | `ultrafast` … `veryslow` (libx264/libx265). |
| `SVTAV1_PRESET` | `8` | `0` slowest/best … `13` fastest. |
| `AOM_CPU_USED` | `6` | libaom-av1: `0` slowest … `8` fastest. |
| `QSV_PRESET` | `medium` | |

`QUALITY` maps to `-cq` on NVENC, `-global_quality` on QSV, `-qp` on VAAPI, and
`-crf` on the software encoders. Rough equivalents: x264 CRF 18 is visually
lossless, 23 is the default, 28 is noticeably smaller. For x265 and AV1, add
about 5 to reach comparable quality.

### HLS packaging

| Variable | Default | Notes |
|---|---|---|
| `HLS_TIME` | `6` | Segment length in seconds. Also sets the keyframe interval. |
| `HLS_PLAYLIST_TYPE` | `vod` | `vod` or `event`. |
| `HLS_SEGMENT_TYPE` | `auto` | `auto` · `mpegts` · `fmp4`. |

Shorter segments start faster and switch tiers more responsively but create
many more files; 2–4s suits live-ish content, 6–10s suits long-form VOD.

`auto` picks `mpegts` for H.264+AAC and `fmp4` otherwise. Forcing `mpegts` with
HEVC, AV1 or Opus is rejected up front - MPEG-TS cannot carry them.

### Rendition ladder

| Variable | Default |
|---|---|
| `MAX_RESOLUTION_HEIGHT` | `1080` |
| `MIN_RESOLUTION_HEIGHT` | `360` |
| `LADDER` | see below |

Built-in tiers - `label height width video_bitrate maxrate bufsize audio_bitrate`:

```
240p   240  426   400k   600k   900k   64k
360p   360  640   800k  1200k  1800k   96k
480p   480  854  1400k  2100k  3000k  128k
720p   720 1280  2800k  4200k  6000k  128k
1080p 1080 1920  5000k  7500k 10000k  192k
1440p 1440 2560  9000k 13500k 18000k  192k
2160p 2160 3840 16000k 24000k 32000k  256k
```

One row drives both the encode and the master playlist, so a tier can never be
half-defined. Tiers taller than the source are always skipped. Override the
whole table by setting `LADDER` in `.env`.

### Concurrency and file handling

| Variable | Default | Notes |
|---|---|---|
| `PARALLEL_VIDEOS` | `1` | Videos processed at once. |
| `PARALLEL_RENDITIONS` | `3` | Tiers encoded at once within a video. |
| `SKIP_EXISTING` | `true` | Reuse renditions already encoded (resume). |
| `ARCHIVE_SOURCE` | `true` | `false` leaves sources in `INPUT_ROOT`. |
| `KEEP_RENDITIONS` | `true` | `false` deletes intermediate MP4s after packaging. |
| `VIDEO_EXTENSIONS_REGEX` | mp4, mov, mkv, avi, webm, m4v, mpg, mpeg, ts, m2ts, flv, wmv | |
| `FFMPEG_LOGLEVEL` | `error` | |

Simultaneous encoder sessions are `PARALLEL_VIDEOS × PARALLEL_RENDITIONS`.
Consumer NVIDIA cards cap concurrent NVENC sessions, so raising both multiplies
quickly. For software encoding, leave `PARALLEL_VIDEOS=1` and let libx264 use
all cores itself.

---

## Subtitles

Place WebVTT files beside the source, named `<stem>.<lang>.vtt`:

```
video/lesson.mp4
video/lesson.en.vtt
video/lesson.pt-BR.vtt
```

Both are copied into the package and referenced from `master.m3u8`. The first
becomes `DEFAULT=YES`. Sidecars are archived along with their video.

---

## Batch re-encoding

`scripts/encode-batch.sh` is a separate tool for shrinking a library into plain
playable files rather than HLS packages. It stages each source, encodes,
validates with ffprobe, and moves the result into place - so `OUTPUT_DIR` only
ever contains complete, verified files.

```bash
INPUT_DIR=./raw OUTPUT_DIR=./encoded ./scripts/encode-batch.sh

VIDEO_CODEC=h264 AUDIO_CODEC=aac HWACCEL=none MAX_HEIGHT=1080 \
  INPUT_DIR=./raw OUTPUT_DIR=./encoded ./scripts/encode-batch.sh
```

Settings: `INPUT_DIR`, `OUTPUT_DIR`, `VIDEO_CODEC`, `AUDIO_CODEC` (`opus`/`aac`/
`copy`), `HWACCEL`, `VIDEO_ENCODER`, `CQ`, `MAX_HEIGHT`, `AUDIO_BITRATE`,
`OUTPUT_EXTENSION` (`mkv`/`mp4`), `PARALLEL_JOBS`, `SKIP_EXISTING`,
`DELETE_ORIGINALS`, `FPS_MODE`, `COLOR_RANGE`.

Originals move to `./review-originals/` unless `DELETE_ORIGINALS=true`, which
deletes them only after the encode validates. Needs `flock`, `realpath` and
`sha256sum` in addition to ffmpeg.

---

## Troubleshooting

**`No usable h264 encoder found`** - run `./run.sh --check`. If every hardware
option says "built, not usable here", the driver is missing or unreachable; use
`HWACCEL=none`.

**Stream plays in VLC but not a browser** - usually HEVC or AV1, which Chrome
and Firefox often refuse. Re-encode with `VIDEO_CODEC=h264`.

**Player stutters when switching quality** - segment boundaries are misaligned.
This happens if renditions were encoded at different `HLS_TIME` values across
runs while `SKIP_EXISTING=true`. Delete `video-work/encoded/<name>/` and re-run.

**A video failed** - it stays in `video/`. The reason is in
`video-work/logs/encode_<name>_<timestamp>.log`.

**Start completely fresh** - `rm -rf video-work/` deletes only scratch data;
published packages in `hls/` are untouched.

---

## How it works

`run.sh` is a single self-contained script. Per video:

1. **Probe** - ffprobe reads dimensions, frame rate and whether audio exists.
2. **Plan** - `GOP = round(fps × HLS_TIME)` fixes the keyframe interval; ladder
   tiers above the source height are dropped.
3. **Encode** - one MP4 per tier, written to a partial path and moved into
   place only once ffprobe confirms it is readable.
4. **Package** - each rendition is segmented with `-c copy`, so packaging never
   re-encodes and can only cut on the keyframes placed in step 3.
5. **Publish** - the master playlist is assembled with `CODECS` read back from
   the real files, then the whole package is moved into `hls/` in one step.
6. **Archive** - the source, and any subtitle sidecars, move to `video-done/`.

Any failure aborts that video before publishing, leaving the source in place.
Other videos in the batch are unaffected.

---

## License

[MIT](LICENSE) © 2026 CurbSoftware Tech Innovations. Use it, change it, ship it
commercially - just keep the copyright notice.
