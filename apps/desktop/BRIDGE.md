# BRIDGE.md — the Qt ↔ HTML contract (frozen)

Control Room embeds the frontend in a `QWebEngineView`. Python exposes exactly
one object over a `QWebChannel`: id **`api`**. Every slot takes and returns
**strings** (`QString`); every payload is **JSON** encoded in UTF-8. Async
slots return immediately (JS gets `undefined`); results stream back as
signals.

Do not change payload field names. Additive fields may appear — ignore ones
you do not know.

## JS bootstrap

```html
<script src="qrc:///qtwebchannel/qwebchannel.js"></script>
<script>
new QWebChannel(qt.webChannelTransport, ch => {
  const api = ch.objects.api;          // the ONE object
  const boot = JSON.parse(api.getBootstrap());
  api.lineReady.connect((channel, text) => { ... });   // signals: .connect(fn)
  api.reportReady.connect((channel, json) => { ... }); // json string, parse it
  api.stateChanged.connect(json => { ... });
});
</script>
```

Sync slots return their JSON string directly from the call. Async slots
return nothing; watch the signals. Slot calls never throw into JS — errors
come back as `{"ok": false, "error": "..."}` payloads (or inline `error`
fields on list items).

## Signals (Qt → JS)

### `lineReady(QString channel, QString text)`

One raw output line from an engine subprocess or a tailed file.

| channel  | source                                                        |
|----------|---------------------------------------------------------------|
| `run`    | `run.sh` full pipeline (stdout+stderr)                        |
| `batch`  | `scripts/encode-batch.sh`                                     |
| `check`  | `run.sh --check`                                              |
| `dryrun` | `run.sh --dry-run`                                            |
| `tail`   | live tail started via `tailStart(path)`                       |

`text` is the raw line, no prefixing, newline stripped.

### `reportReady(QString channel, QString json)`

Completed work. `json` shapes per channel:

- **`check`** — CheckReport. On failure to launch/refusal: `{"error": "busy"}`
  or `{"error": "<reason>"}`. Shape (parsed from `run.sh --check` output):

  ```json
  {
    "ok": true,
    "exit_code": 0,
    "commands": [{"name": "ffmpeg", "ok": true, "path": "/usr/bin/ffmpeg"},
                  {"name": "ffprobe", "ok": false, "path": null}],
    "ffmpeg_version": "6.1.1",
    "bash_version": "5.2.15",
    "hardware": [["NVIDIA", "present"], ["VAAPI", "not found"]],
    "video_encoders": [{"codec": "h264", "encoder": "libx264",
                         "status": "USABLE"}],
    "audio_encoders": [{"codec": "audio", "encoder": "aac",
                         "status": "available"}],
    "active": {"VIDEO_CODEC": "h264", "AUDIO_CODEC": "aac",
               "HWACCEL": "auto", "QUALITY": "28",
               "video_encoder": "libx264", "audio_encoder": "aac",
               "segment_type": "mpegts"},
    "paths": {"input": "/abs/video", "output": "/abs/hls",
              "work": "/abs/video-work", "archive": "/abs/video-done"},
    "ready": true
  }
  ```

  `ok` is `ready && exit_code == 0`. `status` values: `USABLE`,
  `not built`, `built, not usable here`, `available`.

- **`dryrun`** — DryRunReport. Same error envelope. Shape:

  ```json
  {
    "ok": true,
    "exit_code": 0,
    "total": 2,
    "encoder": "libx264",
    "audio_encoder": "aac",
    "segment_type": "mpegts",
    "ladder_labels": ["480p", "720p"],
    "output_root": "/abs/hls",
    "videos": [
      {"rel": "a.mp4", "source_height": 720,
       "tiers": [{"label": "480p", "action": "encode"},
                  {"label": "720p", "action": "encode"}]},
      {"rel": "b.mp4", "source_height": 400,
       "tiers": [{"label": "480p", "action": "encode"},
                  {"label": "720p", "action": "skip"}]}
    ]
  }
  ```

- **`run.summary`** / **`batch.summary`** — end of a launched engine run:

  ```json
  {"ok": true, "exit_code": 0, "duration_s": 91.4, "cancelled": false,
   "engine": "runsh", "succeeded": 3, "failed": 0}
  ```

  `cancelled` is true when the user called `cancelRun()`. The parser counts
  (`engine`/`succeeded`/`failed`, or `total` for batch) are merged in when
  the engine output contained a summary line.

- **`verify`** — decode check of one package (see `verifyPackage`):

  ```json
  {"name": "beach-clip", "ok": true, "exit_code": 0,
   "stderr_tail": "", "duration_s": 2.31}
  ```

### `stateChanged(QString json)`

```json
{
  "busy": false,
  "kind": null,
  "started": null,
  "engine_version": "unknown",
  "tools": {"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe",
            "python3": "/usr/bin/python3"}
}
```

`kind` is `"runsh"`, `"batch"` or `null`. `started` is an ISO-8601 timestamp
or `null`. `tools.*` are absolute paths or `null` when missing. Emitted on
run start/finish/cancel and engine changes. `engine_version` may be
`"unknown"` when the engine cannot report one.

## Slots (JS → Qt)

### `QString getBootstrap()`

Everything a view needs on first paint.

```json
{
  "engine": {"root": "/abs/repo", "source": "auto|setting",
             "version": "unknown"},
  "tools": {"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe",
            "python3": "/usr/bin/python3"},
  "roots": {
    "input": "/abs/repo/video", "hls": "/abs/repo/hls",
    "work": "/abs/repo/video-work", "processed": "/abs/repo/video-done",
    "encoded": "/abs/repo/video-work/encoded",
    "state": "/abs/repo/video-work/state",
    "logs": "/abs/repo/video-work/logs"
  },
  "disk": {
    "input":  {"free_gb": 412.5, "used_gb": 87.5, "total_gb": 500.0,
               "tree_bytes": 812345678},
    "hls":    {"free_gb": 412.5, "used_gb": 87.5, "total_gb": 500.0,
               "tree_bytes": 12345678},
    "work":    {"...": "same shape, one entry per roots key"},
    "processed": {"...": "..."}, "encoded": {"...": "..."},
    "state": {"...": "..."}, "logs": {"...": "..."}
  },
  "busy": false,
  "app_settings": {"engine_path": "", "ffmpeg_dir": "", "batch_values": {}},
  "env_path": "/abs/repo/.env",
  "env_writable": true
}
```

`engine.source`: `"auto"` (detected by walking up from the app) or
`"setting"` (user set it via `setEnginePath`); when no engine was found,
`engine.root` is `null` and `engine.error` carries the reason. `disk` may be
cached; it is refreshed after each run/batch/verify and engine change. A
missing root yields `{"error": "not found: /abs/path"}` instead of the usage
fields. `app_settings.batch_values` holds the effective batch settings (same
shape as `settingsGet().values.batch`).

**run.sh settings persist to the engine's `.env`; batch settings do not**
(encode-batch.sh does not read `.env`) — they persist in the app settings and
are applied as environment overrides on every `launchBatch`.

### `void runCheck()` — async

Refused when an engine is already running → single
`reportReady("check", {"error": "busy"})`. Otherwise streams
`lineReady("check", line)` per output line, then one `reportReady("check",
report)`.

### `void dryRun(QString overrides_json)` — async

Same protocol on channels `dryrun` / `dryrun`. `overrides_json` shape: see
[Overrides](#overrides).

### `QString launchRun(QString overrides_json)` → sync ack, then async stream

```json
{"ok": true, "error": null}
```

`error` is exactly `"busy"`, `"ffmpeg missing"` or `null`. On `ok: true`,
lines stream on `run` and a final `reportReady("run.summary", ...)` arrives
(even on cancel or crash). On `ok: false` nothing else is emitted.

### `QString launchBatch(QString overrides_json)` → same contract

Channels `batch` / `batch.summary`. Same error strings.

### `QString cancelRun()` → `{"ok": true, "error": null}`

Terminates the running engine (SIGTERM, then SIGKILL). `"error"` is
`"not running"` when idle.

### Overrides

`overrides_json` is a JSON object of engine environment variables. Either
form works:

```json
{"VIDEO_CODEC": "av1", "HWACCEL": "none"}
{"values": {"VIDEO_CODEC": "av1", "HWACCEL": "none"}}
```

Values are strings. Path-like settings (`INPUT_ROOT`, `HLS_ROOT`, …,
`INPUT_DIR`, `OUTPUT_DIR`) are resolved to absolute paths against the engine
root before the engine sees them; relative values are fine. Only one engine
(run.sh or batch) may run at a time.

### `QString listInputs()` → ffprobe of every input file

```json
[
  {"rel": "a.mp4", "abs": "/abs/repo/video/a.mp4", "size_bytes": 1048576,
   "width": 1280, "height": 720, "fps": 25.0, "has_audio": true,
   "duration_s": 6.0, "error": null},
  {"rel": "bad.mov", "abs": "/abs/repo/video/bad.mov", "size_bytes": 0,
   "width": null, "height": null, "fps": null, "has_audio": null,
   "duration_s": null, "error": "ffprobe: exit 1"}
]
```

Never throws; per-file failures are inline. Unknown fields are `null`.

### `QString libraryList()` → packaged HLS libraries

```json
[
  {"name": "beach-clip", "path": "/abs/repo/hls/beach-clip",
   "meta": {"title": "Beach clip", "anything": "parser-defined"},
   "tier_count": 3, "mtime": "2026-08-19T12:00:00",
   "error": null}
]
```

`meta` is the parser's free-form object or `null`.

### `QString packageDetail(QString name)`

```json
{
  "name": "beach-clip",
  "path": "/abs/repo/hls/beach-clip",
  "meta": {"title": "Beach clip"},
  "tiers": [
    {"uri": "720p/index.m3u8", "bandwidth": 3200000,
     "avg_bandwidth": 3000000, "resolution": "1280x720",
     "codecs": "avc1.640020,mp4a.40.2"}
  ],
  "master": "/abs/repo/hls/beach-clip/master.m3u8"
}
```

### `QString archiveList()` → files under the processed root

```json
[{"rel": "a.mp4", "size_bytes": 1048576}]
```

### `void verifyPackage(QString name)` — async

Decodes the package (`ffmpeg -v fatal -allowed_extensions ALL -i master.m3u8
-f null -`) in a worker thread; one
`reportReady("verify", {"name", "ok", "exit_code", "stderr_tail",
"duration_s"})` arrives (see the verify example above). A verify already in
flight yields `{"name": ..., "ok": false, "error": "busy", ...}`.

### `QString logsList()`

```json
[
  {"engine": "runsh", "name": "encode_beach-clip_20260819_120000.log",
   "path": "/abs/repo/video-work/logs/encode_beach-clip_20260819_120000.log",
   "size_bytes": 2048, "mtime": "2026-08-19T12:04:00"},
  {"engine": "batch", "name": "batch-001.log",
   "path": "/abs/run-dir/encode-logs/batch-001.log",
   "size_bytes": 512, "mtime": "2026-08-19T13:00:00"}
]
```

runsh logs come from the run.sh `LOG_ROOT`; batch logs from the batch run
dir resolved from app settings (`batch_run_dir`) or the `LOG_DIR` setting.

### `QString logRead(QString path, QString tail_bytes)`

```json
{"path": "/abs/.../encode_x.log", "text": "…last N bytes…"}
```

`tail_bytes` is a decimal string (default `"65536"`). Reads from the end of
the file, UTF-8 with replacement characters. Unknown paths yield
`{"path": ..., "text": "", "error": "not found"}`.

### `void tailStart(QString path)` / `void tailStop()`

At most one live tail; starting a new one stops the old. Semantics are
`tail -f -n +1`: the **whole file** is replayed first, then appended lines
stream as `lineReady("tail", line)`. A missing file is polled for, so the
tail may start before the engine creates the log. `tailStop()`
ends it; starting a new tail stops the old one. A missing file starts the
tail anyway and streams lines once the file appears.

### `QString settingsGet()`

```json
{
  "specs": {
    "runsh": [
      {"name": "VIDEO_CODEC", "default": "h264", "kind": "enum",
       "choices": ["h264", "hevc", "av1"], "help": "h264 plays everywhere…",
       "label": "Video codec", "group": "codecs"},
      {"name": "LADDER", "default": "240p   240  426 …", "kind": "ladder",
       "choices": [], "help": "One row per tier…", "label": "Rendition ladder",
       "group": "ladder"}
    ],
    "batch": [
      {"name": "CQ", "default": "35", "kind": "int", "choices": [],
       "help": "Lower = better quality, bigger files…", "label": "Quality (CQ)",
       "group": "quality"}
    ]
  },
  "values": {
    "runsh": {"VIDEO_CODEC": "h264", "QUALITY": "28"},
    "batch": {"CQ": "35", "MAX_HEIGHT": "720"}
  },
  "defaults": {
    "runsh": {"VIDEO_CODEC": "h264", "QUALITY": "28"},
    "batch": {"CQ": "35", "MAX_HEIGHT": "720"}
  },
  "env_text": "# .env contents as plain text",
  "env_path": "/abs/repo/.env",
  "env_writable": true
}
```

`kind` is one of `str|int|bool|enum|path|bitrate|ladder` (values are always
the literal strings bash would see — booleans are `"true"`/`"false"`).
`choices` is a list (empty when not an enum). `values` are the effective
settings: built-in defaults overlaid with `.env` (runsh) or the persisted app
settings (batch). `env_text` is the current `.env` file contents (empty when
no file exists).

### `QString settingsPreview(QString values_json)`

`values_json` is `{"runsh": {...}, "batch": {...}}` (missing engines are
fine). Returns the derived state without writing anything:

```json
{
  "errors": ["LADDER row 2: bitrate 'x' invalid"],
  "env_text": "VIDEO_CODEC=av1\n...",
  "derived_roots": {"input": "/abs/video", "hls": "/abs/hls",
                     "work": "/abs/video-work", "processed": "/abs/video-done",
                     "encoded": "/abs/video-work/encoded",
                     "state": "/abs/video-work/state",
                     "logs": "/abs/video-work/logs"},
  "ladder_rows": [
    ["1080p", "1080", "1920", "6000k", "6000k", "12000k", "192k"],
    ["720p", "720", "1280", "3000k", "3000k", "6000k", "128k"]
  ],
  "ladder_errors": []
}
```

`ladder_rows` columns: `label height width video_bitrate maxrate bufsize
audio_bitrate` (raw strings, exactly what `LADDER` would contain).

### `QString settingsSave(QString values_json)` → `{"ok": true, "errors": [], "env_path": "/abs/repo/.env"}`

Writes `.env` atomically. On validation failure `ok` is false, `errors`
lists the problems, nothing is written.

### `QString setEnginePath(QString path)` → `{"ok": true, "error": null, "version": "unknown"}`

Points the app at another engine checkout (a directory containing
`run.sh`). Rebuilds all engine-derived state. `error` is e.g.
`"run.sh not found in <path>"`.

### `QString pickDirectory(QString current)` → `"/chosen/path"` or `""`

Native directory picker (cancelled → `""`). `current` is the dialog's
starting directory (`""` = engine root).

### `void openPath(QString path)` / `void revealFile(QString path)`

`openPath` opens a file or directory with the desktop default. `revealFile`
opens the *directory containing* the file with the desktop file manager.

### `void openInPlayer(QString master)`

Opens `master.m3u8` in `mpv` if present, else `vlc`, else the desktop
default handler.

### `void viewReady(QString view)`

The frontend MUST call this after it has fully rendered a view. The
screenshot harness waits on it. `view` is one of:

`dashboard`, `routes`, `library`, `batch`, `settings`, `dispatch`

The initial view comes from the URL hash: `index.html#/library` renders the
library view (default `#/dashboard`). Re-render on `hashchange` and call
`viewReady` again each time.

## App settings vs engine settings

`app_settings` is the GUI's own JSON file (`~/.config/videohls-controlroom/
app.json`): `engine_path`, `ffmpeg_dir` (prepended to PATH so a bundled
ffmpeg wins), `batch_values`. run.sh settings (`settingsSave`) write the
engine's `.env` (or the config-dir fallback when the engine root is
read-only — see `env_path`); batch settings persist in `app_settings` and
ride as env overrides on `launchBatch`. The GUI never modifies `run.sh` or
`scripts/encode-batch.sh`.
