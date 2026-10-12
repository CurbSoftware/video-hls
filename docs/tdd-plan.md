# CurbStream conversion tests

This is the test plan for the Control Room convert wizard in the desktop
app. The pipeline scripts (`run.sh`, `scripts/encode-batch.sh`) stay
outside it. The wizard only chooses files, sizes, an output folder, and
an optional upload, then points the existing engine at a staging directory.

Run the suite from `apps/desktop`:

```bash
uv sync --extra dev
uv run pytest
```

That is the only runner. The desktop project already depends on pytest.
Page behavior that needs a browser uses the same offscreen Qt WebEngine
as `tests/test_smoke.py`. Pure page helpers run in Qt's JavaScript
engine. Do not add Vitest, Jest, Playwright, or a second `package.json`
test script.

When a behavior below changes, change the named test first so
`uv run pytest` fails, then change the one module that owns it and run
the same command again.

## Convert steps

The rail is seven steps, in this order. The id is what the page uses.
The label is what the button shows.

| Step | Id | Label | Continue is allowed when |
| --- | --- | --- | --- |
| 1 | `source` | Source | A folder or a single file has been picked |
| 2 | `choose` | Choose | Probing has finished and at least one convertible file is selected |
| 3 | `sizes` | Resolutions | At least one size is checked, and every selected video is tall enough for one of them |
| 4 | `output` | Output | The output directory is set, and every folder name passes the checks below |
| 5 | `hardware` | Hardware | The encoder check is finished |
| 6 | `delivery` | Delivery | Upload is off, or the connection test for the current form has succeeded |
| 7 | `convert` | Convert | The summary is on screen and a conversion is not already running |

`tests/test_wizard_frontend.py::test_steps_are_source_choose_resolutions_output_hardware_delivery_convert`
locks the ids, labels, and the convert-step line "Original files stay
where they are." `tests/test_wizard_ui.py::test_convert_wizard_headless`
walks the real page with `?mock=1` and checks each step.

### Source

The step offers "Choose a folder" and "Choose one video". The picked
path is shown on its own row. The same step lists the seven steps so a
reader can see the whole job before picking anything.

### Choose

`controlroom.convert.classify` decides which files can be converted:

- The extension has to match the engine allowlist.
- ffprobe has to return a width, a height, and a codec, with no error.
- An audio-only file is rejected with "Audio only, no video stream."
- A probe error is "Could not read the file."
- Anything else the converter cannot use is "Not a video file this converter can read."

A directory scan skips extensions the engine would ignore. A single
picked file is always reported, so a text file shows up as rejected
instead of disappearing. A missing path returns `error: "not found"`
and no items. The bridge returns "Choose a file or a folder." when the
page sends an empty path.

Convertible files start selected. Rejected files are listed under
"Could not use" and have no checkbox.

### Resolutions

The sizes come from `getBootstrap().builtin_ladder`. If that list is
empty the page uses `FALLBACK_LADDER`, which has the same labels as
`convert.builtin_ladder()`: 240p, 360p, 480p, 720p, 1080p, 1440p, 2160p.

The page starts with 360p, 480p, 720p, and 1080p checked. A checked
size taller than every selected video is described as skipped. If a
selected video is shorter than every checked size, Continue stays
disabled and the page asks for a smaller size. The app does not scale
a video up to fill a size.

The launch payload forces `VIDEO_CODEC=h264` and `AUDIO_CODEC=aac`, and
sets `MIN_RESOLUTION_HEIGHT` and `MAX_RESOLUTION_HEIGHT` from the
checked rows. `tests/test_wizard_frontend.py::test_run_overrides_keep_originals_and_force_browser_codecs`
locks that payload.

### Hardware

The step calls the existing systems check. A usable `nvenc`, `qsv`,
`vaapi`, or `videotoolbox` encoder offers "Use the GPU" and "Use the
CPU". The GPU choice sends `HWACCEL=auto`. The CPU choice sends
`HWACCEL=none`. With no usable GPU encoder the page says the run uses
the CPU and does not show the two buttons. Software encoders such as
`libx264` do not count as a GPU.

### Delivery

Upload starts off. Off means the packages stay in the output folder and
Continue is enabled. On shows Amazon S3, Cloudflare R2, and Other S3,
plus the CORS policy whose `AllowedMethods` are `GET` and `HEAD`.
Continue stays disabled until "Test connection" succeeds for the
current fields. Switching provider clears that success. R2 also needs
the Cloudflare account id. Turning upload back off returns to the
folder-only path.

The running summary then shows either "Output folder only" or the
bucket. `ARCHIVE_SOURCE` stays `false` either way, so the engine does
not move the original file.

### Convert

The summary shows the video count, the checked sizes, the output
directory, the encoder (CPU or GPU), and the upload line. Each package
is listed as `<output>/<folder>/master.m3u8`. Start stages the symlinks,
then launches `run.sh`. A staging or launch error is shown on the
summary and the run does not begin. After a real start the page shows
one card per video.

## Work directory

A checkout keeps the engine default: `<repo>/video-work`, with encoded
files, state, and logs underneath it.

An AppImage is different. The mount is read-only, and a literal `~` in
a path would stay unexpanded there. `config.user_media_root()` expands
the home directory first and returns:

```text
~/Videos/curbstream
```

That directory is the work root itself. It is not `video-work` inside
the mount, and it is not a path under any of these:

- `/.mount_` (the FUSE mount)
- `/tmp/appimage_extracted_` (the extract-and-run tree)
- `/share/videohls-controlroom` (the installed copy)

`config.is_packaged_path` is true for those three shapes.
`resolve_roots` then moves the packaged defaults:

| Root | Packaged default |
| --- | --- |
| work | `~/Videos/curbstream` |
| input | `~/Videos/curbstream/video` |
| hls | `~/Videos/curbstream/hls` |
| processed | `~/Videos/curbstream/video-done` |
| encoded | `~/Videos/curbstream/encoded` |
| state | `~/Videos/curbstream/state` |
| logs | `~/Videos/curbstream/logs` |

An absolute path the user set outside the package is left alone. A
checkout is left alone too.

The wizard's start payload sets `INPUT_ROOT` and `HLS_ROOT` and does
not set `WORK_ROOT`. `Api._parse_overrides` fills every root from
`resolve_roots` before `run.sh` starts, so the engine cannot fall back
to creating `video-work` on the mount. For a packaged engine the
process working directory is `~/Videos/curbstream` as well. For a
checkout the working directory stays unset and `WORK_ROOT` stays
`<repo>/video-work`.

`stage_job` writes `<work>/jobs/<id>/in/<folder><suffix>`. The bridge
passes the host view of that work root. On a packaged engine that is
the home tree above.

Tests: `TestResolveRoots` in `tests/test_config.py`,
`tests/test_wizard_backend.py::test_packaged_bootstrap_work_root_is_home_videos`,
`test_packaged_launch_keeps_scratch_off_the_mount`, and
`test_checkout_launch_keeps_the_repo_work_tree`.

## Output step layout

Each selected video is one column (`.wz-name` is `flex-direction:
column`):

1. One text field. Its value is the folder name. The name is not also
   drawn as a heading, a label, or a second copy of the same text.
2. The next row (`.wz-path`) is the full file path
   `<output directory>/<folder name>/master.m3u8`.
3. A validation line, empty when the name is fine.
4. When the folder already exists, a line that the new package replaces it.

The output directory is a separate readonly field (`#wz-out`) above
those rows, shown once. The page widens the name field with the text,
and the path row wraps (`overflow-wrap: anywhere`) so a long directory
stays on that row.

Folder names, checked in the page (`nameProblem`) and again in
`convert.name_error` / `stage_job`:

| Input | Page | `stage_job` |
| --- | --- | --- |
| Empty, `.`, `..` | "Use a folder name." | "Folder name is empty." or "Folder name is not allowed." |
| Leading or trailing space | "The name cannot start or end with a space." | "Folder name is empty." |
| `/`, `\`, or a NUL | "Folder names cannot contain slashes." | "Folder names cannot contain slashes." |
| The same name twice | "Two videos would share this folder." | "'Name' is used by more than one video." |

Continue stays disabled while any of those page messages is showing.
The two layers use different sentences on purpose. A test that expects
one string from the other layer is wrong.

`tests/test_wizard_frontend.py::test_output_row_shows_the_folder_name_once_and_the_path_on_the_next_row`
and `test_output_rows_stack_the_path_under_the_name` lock the markup
and the CSS. The headless walk checks the live DOM: one input per row,
the next element is the path, the name occurs once in the row text, and
that occurrence is the path.

## Staging and read-only failures

`stage_job` symlinks. It does not copy the bytes. The link target is
the resolved source file. The link name keeps the source suffix
(`Clip.mov` for a `.mov`).

These inputs fail before any job directory is created:

- No items: "Choose at least one video."
- A missing source: "Missing source: ..."
- A rejected folder name, or two videos with the same name
- No engine set on the bridge: "No engine is set."

If creating `~/Videos/curbstream` (or whatever work root the caller
passed) raises `OSError`, or creating a symlink raises `OSError`, the
result is `ok: false`, `input_root: null`, and
`Could not stage the videos: ...`. The read-only case is that error
with the OS text, including `Read-only file system` when the link
callback raises it. The partial `jobs/<id>` directory is removed. The
original files are still the same bytes.

`clear_job` deletes `work/jobs/<id>` only when the path is
`work/jobs/<id>/in`. A path outside that shape, including a symlink
under `jobs/` that resolves somewhere else, returns "Refusing to delete
outside a job." and leaves the other directory in place.

`outputClash` lists folder names that already exist in the output
directory. The page shows the replace warning for those names. An empty
directory argument returns no names.

Tests live in `tests/test_convert.py` (the symlink and `OSError`
cases) and `tests/test_wizard_backend.py` (the bridge, the packaged
home tree, and a mode-555 work directory).

## AppImage file name

`packaging/appimage.sh` reads `version` from
`apps/desktop/pyproject.toml` and writes:

```text
packaging/CurbStream-${APP_VERSION}-x86_64.AppImage
```

For the current desktop app that version is `0.1.0`, and
`controlroom.__version__` is the same string, so the file is:

```text
CurbStream-0.1.0-x86_64.AppImage
```

linuxdeploy names the binary from the desktop entry. The script moves
that file onto `APPIMAGE_PATH`. The unversioned name
`CurbStream-x86_64.AppImage` is not the output path.

`.github/workflows/release.yml` uploads
`packaging/CurbStream-*-x86_64.AppImage`, which matches the versioned
file. `packaging/*.AppImage` is gitignored. Do not commit the binary.

`tests/test_appimage_name.py` locks the script line, the sed the script
uses, the `0.1.0` pair, and the workflow glob.

## What each file covers

| File | Layer |
| --- | --- |
| `tests/test_convert.py` | Classification, folder names, symlink staging, read-only cleanup |
| `tests/test_config.py` | `~/Videos/curbstream` and the three packaged-path shapes |
| `tests/test_wizard_backend.py` | Bridge probe, clash, stage, and the roots passed to `run.sh` |
| `tests/test_wizard_frontend.py` | Step list, name rules, output markup, CSS, launch payload, delivery copy |
| `tests/test_wizard_ui.py` | Offscreen click-through of all seven steps, including a CPU-only machine |
| `tests/test_appimage_name.py` | `CurbStream-0.1.0-x86_64.AppImage` |

`tests/test_e2e.py` still runs the real engine when ffmpeg is on `PATH`.
This plan does not replace that. It covers the wizard around the engine.

## Out of scope

- A second test framework.
- Building the AppImage inside pytest. The name is checked from the
  script and the version field. The binary stays untracked.
- Disknot, CurbXlets, the buttons extension, and the marketing sites.
- Re-encoding. Hardware tests use the systems-check report the page
  already understands. They do not require a GPU on the machine running
  pytest.
