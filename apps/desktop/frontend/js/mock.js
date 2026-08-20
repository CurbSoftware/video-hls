// Control Room — mock.js
// Stands in for the QWebChannel bridge when ?mock=1 (or plain browser dev).
// Payload shapes mirror BRIDGE.md 1:1 (the frozen contract) so views built
// against the mock behave identically against Qt. Scenario data is modelled
// on this machine's real demo run ("PressedMail Demo": h264_nvenc, mpegts,
// GOP 180, 6s segments) plus one queued input ("Route 66 Demo", 720p25).
//
// Signals (same normalisation as api.js applies in Qt):
//   lineReady    {channel:'run'|'batch'|'check'|'dryrun'|'tail', text}
//   reportReady  {channel:'check'|'dryrun'|'run.summary'|'batch.summary'|'verify', data}
//   stateChanged {busy, kind:'runsh'|'batch'|null, started, engine_version, tools}

const listeners = new Map();

export function on(signal, fn) {
  if (!listeners.has(signal)) listeners.set(signal, []);
  listeners.get(signal).push(fn);
  return () => {
    const arr = listeners.get(signal);
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
}

function emit(signal, payload) {
  for (const fn of [...(listeners.get(signal) || [])]) fn(payload);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => '[' + new Date().toISOString().slice(0, 19).replace('T', ' ') + ']';
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// Fixtures — every root absolute, no home dirs, no personal names.
// ---------------------------------------------------------------------------

const REPO = '/opt/video-hls';

const TOOLS = {
  ffmpeg: '/usr/bin/ffmpeg',
  ffprobe: '/usr/bin/ffprobe',
  python3: '/usr/bin/python3',
};

const FFMPEG_VERSION = 'ffmpeg version 7.1.1-3ubuntu1 Copyright (c) 2000-2025 the FFmpeg developers';

const ROOTS = {
  input: `${REPO}/video`,
  hls: `${REPO}/hls`,
  work: `${REPO}/video-work`,
  processed: `${REPO}/video-done`,
  encoded: `${REPO}/video-work/encoded`,
  state: `${REPO}/video-work/state`,
  logs: `${REPO}/video-work/logs`,
};

const DISK = {
  free_gb: 33.1, used_gb: 48.9, total_gb: 82,
};

const BOOTSTRAP = {
  engine: { root: REPO, source: 'auto', version: '0.9.4' },
  tools: { ...TOOLS },
  roots: { ...ROOTS },
  disk: {
    input: { ...DISK, tree_bytes: 155317760 },
    hls: { ...DISK, tree_bytes: 133588582 },
    work: { ...DISK, tree_bytes: 402653184 },
    processed: { ...DISK, tree_bytes: 258642806 },
    encoded: { ...DISK, tree_bytes: 346130842 },
    state: { ...DISK, tree_bytes: 524288 },
    logs: { ...DISK, tree_bytes: 12671232 },
  },
  busy: false,
  app_settings: { engine_path: '', ffmpeg_dir: '', batch_values: {} },
  env_path: `${REPO}/.env`,
  env_writable: true,
};

// -- systems-check report (BRIDGE.md "check") -------------------------------

const CHECK = {
  ok: true,
  exit_code: 0,
  commands: [
    { name: 'ffmpeg', ok: true, path: TOOLS.ffmpeg },
    { name: 'ffprobe', ok: true, path: TOOLS.ffprobe },
    { name: 'python3', ok: true, path: TOOLS.python3 },
  ],
  ffmpeg_version: FFMPEG_VERSION,
  bash_version: '5.2.21(1)-release',
  hardware: [
    ['NVIDIA', 'NVIDIA GeForce RTX 3060'],
    ['VAAPI', '/dev/dri/renderD128 present'],
  ],
  video_encoders: [
    { codec: 'h264', encoder: 'h264_nvenc', status: 'USABLE' },
    { codec: 'h264', encoder: 'h264_qsv', status: 'built, not usable here' },
    { codec: 'h264', encoder: 'h264_vaapi', status: 'USABLE' },
    { codec: 'h264', encoder: 'h264_videotoolbox', status: 'not built' },
    { codec: 'h264', encoder: 'libx264', status: 'USABLE' },
    { codec: 'hevc', encoder: 'hevc_nvenc', status: 'USABLE' },
    { codec: 'hevc', encoder: 'hevc_qsv', status: 'built, not usable here' },
    { codec: 'hevc', encoder: 'hevc_vaapi', status: 'USABLE' },
    { codec: 'hevc', encoder: 'hevc_videotoolbox', status: 'not built' },
    { codec: 'hevc', encoder: 'libx265', status: 'USABLE' },
    { codec: 'av1', encoder: 'av1_nvenc', status: 'not built' },
    { codec: 'av1', encoder: 'av1_qsv', status: 'not built' },
    { codec: 'av1', encoder: 'av1_vaapi', status: 'not built' },
    { codec: 'av1', encoder: 'av1_videotoolbox', status: 'not built' },
    { codec: 'av1', encoder: 'libsvtav1', status: 'USABLE' },
    { codec: 'av1', encoder: 'libaom-av1', status: 'USABLE' },
  ],
  audio_encoders: [
    { codec: 'audio', encoder: 'aac', status: 'available' },
    { codec: 'audio', encoder: 'libopus', status: 'available' },
  ],
  active: {
    VIDEO_CODEC: 'h264',
    AUDIO_CODEC: 'aac',
    HWACCEL: 'auto',
    QUALITY: '28',
    video_encoder: 'h264_nvenc',
    audio_encoder: 'aac',
    segment_type: 'mpegts',
  },
  paths: { input: ROOTS.input, output: ROOTS.hls, work: ROOTS.work, archive: ROOTS.processed },
  ready: true,
};

// Verbatim run.sh --check stream, as lineReady('check') delivers it.
const CHECK_LINES = [
  'video-hls system check',
  '======================',
  '',
  'Required commands:',
  `  ffmpeg     OK   ${TOOLS.ffmpeg}`,
  `  ffprobe    OK   ${TOOLS.ffprobe}`,
  `  python3    OK   ${TOOLS.python3}`,
  '',
  `  ffmpeg: ${FFMPEG_VERSION}`,
  '  bash:   5.2.21(1)-release',
  '',
  'Hardware:',
  '  NVIDIA    NVIDIA GeForce RTX 3060',
  '  VAAPI     /dev/dri/renderD128 present',
  '',
  'Video encoders (compiled in / actually usable):',
  '  h264',
  '    h264_nvenc             USABLE',
  '    h264_qsv               built, not usable here',
  '    h264_vaapi             USABLE',
  '    h264_videotoolbox      not built',
  '    libx264                USABLE',
  '  hevc',
  '    hevc_nvenc             USABLE',
  '    hevc_qsv               built, not usable here',
  '    hevc_vaapi             USABLE',
  '    hevc_videotoolbox      not built',
  '    libx265                USABLE',
  '  av1',
  '    av1_nvenc              not built',
  '    av1_qsv                not built',
  '    av1_vaapi              not built',
  '    av1_videotoolbox       not built',
  '    libsvtav1              USABLE',
  '    libaom-av1             USABLE',
  '',
  'Audio encoders:',
  '    aac                    available',
  '    libopus                available',
  '',
  'Active configuration:',
  '  VIDEO_CODEC=h264  AUDIO_CODEC=aac  HWACCEL=auto  QUALITY=28',
  '  resolved video encoder: h264_nvenc',
  '  resolved audio encoder: aac',
  '  segment type:           mpegts',
  '',
  'Paths:',
  `  input   ${ROOTS.input}`,
  `  output  ${ROOTS.hls}`,
  `  work    ${ROOTS.work}`,
  `  archive ${ROOTS.processed}`,
  '',
  'Result: ready.',
];

// -- inputs (BRIDGE.md listInputs) -------------------------------------------

const INPUTS = [
  {
    rel: 'Route 66 Demo.mp4',
    abs: `${ROOTS.input}/Route 66 Demo.mp4`,
    size_bytes: 155317760,
    width: 1280,
    height: 720,
    fps: 25.0,
    has_audio: true,
    duration_s: 164.4,
    error: null,
  },
];

// -- dry-run report (BRIDGE.md "dryrun") ---------------------------------------

const DRYRUN = {
  ok: true,
  exit_code: 0,
  total: 1,
  encoder: 'h264_nvenc',
  audio_encoder: 'aac',
  segment_type: 'mpegts',
  ladder_labels: ['360p', '480p', '720p'],
  output_root: ROOTS.hls,
  videos: [
    {
      rel: 'Route 66 Demo.mp4',
      source_height: 720,
      tiers: [
        { label: '360p', action: 'encode' },
        { label: '480p', action: 'encode' },
        { label: '720p', action: 'encode' },
      ],
    },
  ],
};

// -- library (BRIDGE.md libraryList / packageDetail) ----------------------------
// Modelled on the real demo package: h264_nvenc, mpegts, GOP 180, 6s segments.

const LIBRARY = [
  {
    name: 'PressedMail Demo',
    path: `${ROOTS.hls}/PressedMail Demo`,
    meta: {
      source: 'PressedMail Demo.mp4',
      source_width: 1920,
      source_height: 1080,
      video_encoder: 'h264_nvenc',
      audio_codec: null,
      segment_type: 'mpegts',
      segment_duration: 6,
      gop_size: 180,
      playlist_version: 3,
    },
    tier_count: 4,
    mtime: '2026-08-15T20:55:43',
    error: null,
  },
];

const PACKAGE_DETAIL = {
  name: 'PressedMail Demo',
  path: `${ROOTS.hls}/PressedMail Demo`,
  meta: LIBRARY[0].meta,
  tiers: [
    { uri: '360p/index.m3u8', bandwidth: 1200000, avg_bandwidth: 800000, resolution: '640x360', codecs: 'avc1.4D401E' },
    { uri: '480p/index.m3u8', bandwidth: 2100000, avg_bandwidth: 1400000, resolution: '854x480', codecs: 'avc1.4D401F' },
    { uri: '720p/index.m3u8', bandwidth: 4200000, avg_bandwidth: 2800000, resolution: '1280x720', codecs: 'avc1.4D401F' },
    { uri: '1080p/index.m3u8', bandwidth: 7500000, avg_bandwidth: 5000000, resolution: '1920x1080', codecs: 'avc1.4D4028' },
  ],
  master: `${ROOTS.hls}/PressedMail Demo/master.m3u8`,
};

// -- logs (BRIDGE.md logsList / logRead) ------------------------------------------

const LOGS = [
  {
    engine: 'runsh',
    name: 'encode_PressedMail_Demo_20260815_205530.log',
    path: `${ROOTS.logs}/encode_PressedMail_Demo_20260815_205530.log`,
    size_bytes: 4021,
    mtime: '2026-08-15T20:55:43',
  },
  {
    engine: 'runsh',
    name: 'encode_Route_66_Demo_20260814_110208.log',
    path: `${ROOTS.logs}/encode_Route_66_Demo_20260814_110208.log`,
    size_bytes: 1188,
    mtime: '2026-08-14T11:03:02',
  },
  {
    engine: 'batch',
    name: 'batch_20260817_161230.log',
    path: '/opt/encode-batch-run/encode-logs/batch_20260817_161230.log',
    size_bytes: 7460,
    mtime: '2026-08-17T16:35:41',
  },
];

const LOG_TEXTS = {
  [LOGS[0].path]: [
    '[2026-08-15 20:55:30] [INFO] [1/1] Processing: PressedMail Demo.mp4 (1920x1080, audio=false, gop=180)',
    '[2026-08-15 20:55:30] [START] Encoding 360p with h264_nvenc',
    '[2026-08-15 20:55:30] [START] Encoding 480p with h264_nvenc',
    '[2026-08-15 20:55:30] [START] Encoding 720p with h264_nvenc',
    '[2026-08-15 20:55:34] [DONE] 360p -> video-work/encoded/PressedMail Demo/renditions/360p.mp4',
    '[2026-08-15 20:55:34] [START] Encoding 1080p with h264_nvenc',
    '[2026-08-15 20:55:35] [DONE] 480p -> video-work/encoded/PressedMail Demo/renditions/480p.mp4',
    '[2026-08-15 20:55:36] [DONE] 720p -> video-work/encoded/PressedMail Demo/renditions/720p.mp4',
    '[2026-08-15 20:55:42] [DONE] 1080p -> video-work/encoded/PressedMail Demo/renditions/1080p.mp4',
    '[2026-08-15 20:55:42] [DONE] Packaged 480p',
    '[2026-08-15 20:55:42] [DONE] Packaged 360p',
    '[2026-08-15 20:55:42] [DONE] Packaged 720p',
    '[2026-08-15 20:55:42] [DONE] Packaged 1080p',
    '[2026-08-15 20:55:43] [DONE] [1/1] HLS package: hls/PressedMail Demo/master.m3u8',
    '[2026-08-15 20:55:43] [DONE] [1/1] Source archived: video-done/PressedMail Demo.mp4',
  ].join('\n'),
  [LOGS[1].path]: [
    '[2026-08-14 11:02:08] [INFO] [1/1] Processing: Route 66 Demo.mp4 (1280x720, audio=true, gop=150)',
    '[2026-08-14 11:02:08] [START] Encoding 360p with h264_nvenc',
    '[2026-08-14 11:02:08] [START] Encoding 480p with h264_nvenc',
    '[2026-08-14 11:02:13] [ERROR] ffprobe could not read video-work/state/partials/360p.mp4.part: Invalid data found when processing input',
    '[2026-08-14 11:02:13] [WARN] Retrying 360p once',
    '[2026-08-14 11:02:19] [ERROR] ffprobe could not read video-work/state/partials/360p.mp4.part: Invalid data found when processing input',
    '[2026-08-14 11:02:19] [FATAL] [1/1] Failed: Route 66 Demo.mp4 - encoder produced unreadable output (driver reset?)',
    '[2026-08-14 11:02:19] [INFO] [1/1] Source left in video/ for retry',
  ].join('\n'),
  [LOGS[2].path]: [
    '[2026-08-17 16:12:30] [INFO] encode-batch starting: 14 files, av1 / opus, CQ 35',
    '[2026-08-17 16:12:30] [START] [1/14] keynotes-2019.mkv',
    '[2026-08-17 16:12:31] [START] [2/14] keynotes-2021.mkv',
    '[2026-08-17 16:13:04] [SKIP] [3/14] legacy-intro.mp4 - output exists',
    '[2026-08-17 16:14:12] [DONE] [2/14] keynotes-2021.mkv -> encoded/keynotes-2021.mkv (CQ 35, 1.9 GB -> 612 MB)',
    '[2026-08-17 16:15:47] [DONE] [1/14] keynotes-2019.mkv -> encoded/keynotes-2019.mkv (CQ 35, 2.4 GB -> 748 MB)',
    '[2026-08-17 16:15:47] [START] [4/14] workshop-cam-a.mp4',
    '[2026-08-17 16:15:47] [START] [5/14] workshop-cam-b.mp4',
    '[2026-08-17 16:21:33] [WARN] [4/14] subtitle stream had no codec tag; dropped',
    '[2026-08-17 16:22:58] [DONE] [4/14] workshop-cam-a.mp4 -> encoded/workshop-cam-a.mp4',
    '[2026-08-17 16:24:10] [DONE] [5/14] workshop-cam-b.mp4 -> encoded/workshop-cam-b.mp4',
    '[2026-08-17 16:24:10] [INFO] batch complete: 5 encoded, 1 skipped, 0 failed in 11m40s',
  ].join('\n'),
};

// -- settings spec (BRIDGE.md settingsGet) -----------------------------------
// kind ∈ str|int|bool|enum|path|bitrate|ladder. Help text follows .env.example.

const S = (engine, name, label, group, kind, def, current, help, choices = []) =>
  ({ engine, name, label, group, kind, default: def, current, help, choices });

const RUNSH_SPECS = [
  S('runsh', 'INPUT_ROOT', 'Input root', 'paths', 'path', './video', ROOTS.input, 'Where sources are found (recursive). Subfolders mirror into the output.'),
  S('runsh', 'HLS_ROOT', 'HLS output root', 'paths', 'path', './hls', ROOTS.hls, 'Published packages land here. Serve this directory over HTTP.'),
  S('runsh', 'WORK_ROOT', 'Work root', 'paths', 'path', './video-work', ROOTS.work, 'Scratch tree. Safe to delete at any time.'),
  S('runsh', 'PROCESSED_ROOT', 'Archive root', 'paths', 'path', './video-done', ROOTS.processed, 'Sources move here after a successful run.'),
  S('runsh', 'ENCODED_ROOT', 'Encoded root', 'paths', 'path', '$WORK_ROOT/encoded', ROOTS.encoded, 'Intermediate renditions, reused when SKIP_EXISTING=true.'),
  S('runsh', 'STATE_ROOT', 'State root', 'paths', 'path', '$WORK_ROOT/state', ROOTS.state, 'Partial files and job status.'),
  S('runsh', 'LOG_ROOT', 'Log root', 'paths', 'path', '$WORK_ROOT/logs', ROOTS.logs, 'One timestamped log per video. Surfaced in DISPATCH.'),
  S('runsh', 'VIDEO_CODEC', 'Video codec', 'codecs', 'enum', 'h264', 'h264', 'h264 plays everywhere, biggest files. hevc is ~40% smaller but not supported by Chrome/Firefox on the open web. av1 is smallest, slowest in software.', ['h264', 'hevc', 'av1']),
  S('runsh', 'AUDIO_CODEC', 'Audio codec', 'codecs', 'enum', 'aac', 'aac', 'aac is universal. opus is better per bit but forces fMP4 segments.', ['aac', 'opus']),
  S('runsh', 'HWACCEL', 'Hardware acceleration', 'codecs', 'enum', 'auto', 'auto', 'auto probes nvenc, qsv, vaapi, videotoolbox in order and falls back to software. none requires CPU encoding.', ['auto', 'nvenc', 'qsv', 'vaapi', 'videotoolbox', 'none']),
  S('runsh', 'VIDEO_ENCODER', 'Video encoder override', 'codecs', 'str', '', '', 'Literal ffmpeg encoder name (libx264, h264_nvenc, hevc_vaapi, libsvtav1, ...). Overrides VIDEO_CODEC/HWACCEL entirely.'),
  S('runsh', 'VAAPI_DEVICE', 'VAAPI render node', 'codecs', 'path', '/dev/dri/renderD128', '/dev/dri/renderD128', 'Render node used by the vaapi encoders.'),
  S('runsh', 'QUALITY', 'Quality', 'quality', 'int', '28', '28', 'One knob per encoder family: -cq on nvenc (sane 19-32), -global_quality on qsv, -qp on vaapi, -crf on software. Lower = better and bigger. x264: 18 visually lossless, 23 default, 28 small; AV1 ~30 equals x264 23.'),
  S('runsh', 'NVENC_PRESET', 'NVENC preset', 'quality', 'enum', 'p6', 'p6', 'p1 fastest ... p7 best.', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
  S('runsh', 'X264_PRESET', 'x264/x265 preset', 'quality', 'enum', 'medium', 'medium', 'ultrafast ... veryslow (libx264/libx265).', ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']),
  S('runsh', 'SVTAV1_PRESET', 'SVT-AV1 preset', 'quality', 'int', '8', '8', '0 slowest/best ... 13 fastest.'),
  S('runsh', 'AOM_CPU_USED', 'libaom cpu-used', 'quality', 'int', '6', '6', 'libaom-av1: 0 slowest ... 8 fastest.'),
  S('runsh', 'QSV_PRESET', 'QSV preset', 'quality', 'enum', 'medium', 'medium', 'Intel Quick Sync speed preset.', ['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']),
  S('runsh', 'HLS_TIME', 'Segment length', 'packaging', 'int', '6', '6', 'Segment length in seconds. Also sets the keyframe interval (fps x HLS_TIME), keeping every rendition’s segment boundaries identical. 2-4 = faster startup; 6-10 = fewer files.'),
  S('runsh', 'HLS_PLAYLIST_TYPE', 'Playlist type', 'packaging', 'enum', 'vod', 'vod', 'vod or event.', ['vod', 'event']),
  S('runsh', 'HLS_SEGMENT_TYPE', 'Segment type', 'packaging', 'enum', 'auto', 'auto', 'mpegts works only for h264+aac; auto picks fmp4 for hevc, av1 or opus because MPEG-TS cannot carry them.', ['auto', 'mpegts', 'fmp4']),
  S('runsh', 'MAX_RESOLUTION_HEIGHT', 'Max resolution', 'ladder', 'int', '1080', '1080', 'Caps the ladder. Tiers taller than the source are always skipped — the pipeline never upscales.'),
  S('runsh', 'MIN_RESOLUTION_HEIGHT', 'Min resolution', 'ladder', 'int', '360', '360', 'Trims small tiers off the ladder.'),
  S('runsh', 'LADDER', 'Rendition ladder', 'ladder', 'ladder', '', '', 'One row per tier: label height width video_bitrate maxrate bufsize audio_bitrate. Overrides the built-in table.'),
  S('runsh', 'PARALLEL_VIDEOS', 'Parallel videos', 'concurrency', 'int', '1', '1', 'Videos processed at once. Sessions = PARALLEL_VIDEOS x PARALLEL_RENDITIONS; consumer NVIDIA cards cap concurrent NVENC sessions.'),
  S('runsh', 'PARALLEL_RENDITIONS', 'Parallel renditions', 'concurrency', 'int', '3', '3', 'Tiers encoded at once within a video.'),
  S('runsh', 'VIDEO_EXTENSIONS_REGEX', 'Video extensions', 'files', 'str', '.*\\.(mp4|mov|mkv|avi|webm|m4v|mpg|mpeg|ts|m2ts|flv|wmv)$', '.*\\.(mp4|mov|mkv|avi|webm|m4v|mpg|mpeg|ts|m2ts|flv|wmv)$', 'Which filenames count as video sources.'),
  S('runsh', 'SKIP_EXISTING', 'Skip existing renditions', 'files', 'bool', 'true', 'true', 'Reuse renditions already encoded (resume after interruption).'),
  S('runsh', 'ARCHIVE_SOURCE', 'Archive source', 'files', 'bool', 'true', 'true', 'false leaves successful sources in the input root.'),
  S('runsh', 'KEEP_RENDITIONS', 'Keep renditions', 'files', 'bool', 'true', 'true', 'false deletes intermediate MP4s after packaging.'),
  S('runsh', 'FFMPEG_LOGLEVEL', 'ffmpeg log level', 'files', 'enum', 'error', 'error', 'Verbosity of raw ffmpeg output in the logs.', ['quiet', 'error', 'warning', 'info', 'verbose', 'debug']),
];

const BATCH_SPECS = [
  S('batch', 'INPUT_DIR', 'Input directory', 'paths', 'path', './notencoded', '/opt/encode-batch-run/notencoded', 'Sources to re-encode (recursive).'),
  S('batch', 'OUTPUT_DIR', 'Output directory', 'paths', 'path', './encoded', '/opt/encode-batch-run/encoded', 'Verified outputs only ever appear here.'),
  S('batch', 'ORIGINALS_REVIEW_DIR', 'Originals review', 'paths', 'path', './review-originals', '/opt/encode-batch-run/review-originals', 'Originals move here after a successful encode, unless DELETE_ORIGINALS=true.'),
  S('batch', 'ERROR_DIR', 'Error originals', 'paths', 'path', './error-originals', '/opt/encode-batch-run/error-originals', 'Where failed originals are parked so they are not re-attempted forever.'),
  S('batch', 'LOG_DIR', 'Log directory', 'paths', 'path', './encode-logs', '/opt/encode-batch-run/encode-logs', 'Batch engine logs. Surfaced in DISPATCH.'),
  S('batch', 'VIDEO_CODEC', 'Video codec', 'codecs', 'enum', 'av1', 'av1', 'Same family trade-offs as the pipeline. av1 default: this tool exists to shrink libraries.', ['h264', 'hevc', 'av1']),
  S('batch', 'AUDIO_CODEC', 'Audio codec', 'codecs', 'enum', 'opus', 'opus', 'opus, aac, or copy to leave the audio untouched.', ['opus', 'aac', 'copy']),
  S('batch', 'HWACCEL', 'Hardware acceleration', 'codecs', 'enum', 'auto', 'auto', 'Same resolution order as the pipeline.', ['auto', 'nvenc', 'qsv', 'vaapi', 'videotoolbox', 'none']),
  S('batch', 'VIDEO_ENCODER', 'Video encoder override', 'codecs', 'str', '', '', 'Literal ffmpeg encoder name; overrides the two above.'),
  S('batch', 'VAAPI_DEVICE', 'VAAPI render node', 'codecs', 'path', '/dev/dri/renderD128', '/dev/dri/renderD128', 'Render node for the vaapi encoders.'),
  S('batch', 'CQ', 'Quality (CQ)', 'quality', 'int', '35', '35', 'Lower = better quality, bigger files. 32-34 archive grade, 35-37 the sweet spot, 38+ aggressive.'),
  S('batch', 'NVENC_PRESET', 'NVENC preset', 'quality', 'enum', 'p7', 'p7', 'p1 fastest ... p7 best.', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
  S('batch', 'X264_PRESET', 'x264/x265 preset', 'quality', 'enum', 'medium', 'medium', 'ultrafast ... veryslow.', ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']),
  S('batch', 'SVTAV1_PRESET', 'SVT-AV1 preset', 'quality', 'int', '6', '6', '0 slowest/best ... 13 fastest.'),
  S('batch', 'AOM_CPU_USED', 'libaom cpu-used', 'quality', 'int', '5', '5', 'libaom-av1: 0 slowest ... 8 fastest.'),
  S('batch', 'QSV_PRESET', 'QSV preset', 'quality', 'enum', 'medium', 'medium', 'Intel Quick Sync speed preset.', ['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']),
  S('batch', 'MAX_HEIGHT', 'Max height', 'output', 'int', '720', '720', 'Anything taller is scaled down; never upscaled.'),
  S('batch', 'AUDIO_BITRATE', 'Audio bitrate', 'output', 'bitrate', '160k', '160k', 'Target audio bitrate, e.g. 96k / 128k / 160k.'),
  S('batch', 'OUTPUT_EXTENSION', 'Output container', 'output', 'enum', 'mkv', 'mkv', 'mkv or mp4.', ['mkv', 'mp4']),
  S('batch', 'FPS_MODE', 'FPS mode', 'output', 'enum', 'vfr', 'vfr', 'vfr keeps source timing; cfr forces constant frame rate.', ['vfr', 'cfr']),
  S('batch', 'COLOR_RANGE', 'Color range', 'output', 'enum', 'tv', 'tv', 'tv (limited) or pc (full). Mismatches wash video out.', ['tv', 'pc']),
  S('batch', 'PARALLEL_JOBS', 'Parallel jobs', 'behaviour', 'int', '4', '4', 'Concurrent encodes. Each is a full encoder session.'),
  S('batch', 'SKIP_EXISTING', 'Skip existing', 'behaviour', 'bool', 'true', 'true', 'Skip sources whose output already exists.'),
  S('batch', 'DELETE_ORIGINALS', 'Delete originals', 'behaviour', 'bool', 'false', 'false', 'Delete originals after the encode validates, instead of moving them to review.'),
  S('batch', 'FFMPEG_LOGLEVEL', 'ffmpeg log level', 'behaviour', 'enum', 'warning', 'warning', 'Verbosity of raw ffmpeg output in the logs.', ['quiet', 'error', 'warning', 'info', 'verbose', 'debug']),
];

function settingsSnapshot() {
  const snap = { specs: { runsh: [], batch: [] }, values: { runsh: {}, batch: {} }, defaults: { runsh: {}, batch: {} } };
  for (const arr of [RUNSH_SPECS, BATCH_SPECS]) {
    for (const f of arr) {
      snap.specs[f.engine].push({ name: f.name, default: f.default, kind: f.kind, choices: f.choices, help: f.help, label: f.label, group: f.group });
      snap.values[f.engine][f.name] = f.current;
      snap.defaults[f.engine][f.name] = f.default;
    }
  }
  return snap;
}

const ENV_TEXT = [
  '# video-hls configuration — managed by Control Room',
  'VIDEO_CODEC=h264',
  'HWACCEL=auto',
  'QUALITY=28',
  'HLS_TIME=6',
  'PARALLEL_RENDITIONS=3',
].join('\n');

// ---------------------------------------------------------------------------
// Mutable engine state + scripted simulator
// ---------------------------------------------------------------------------

const engine = { busy: false, kind: null, started: null };
let inputs = clone(INPUTS);
let library = clone(LIBRARY);
let logs = clone(LOGS);
let logTexts = { ...LOG_TEXTS };
let timers = [];
let tailTimer = null;
let tailFrame = 0;
let lastCheck = null;
let lastDryrun = null;

function setState(patch) {
  Object.assign(engine, patch);
  emit('stateChanged', {
    busy: engine.busy,
    kind: engine.kind,
    started: engine.started,
    engine_version: BOOTSTRAP.engine.version,
    tools: { ...TOOLS },
  });
}

const line = (channel, text) => emit('lineReady', { channel, text });
const at = (ms, fn) => timers.push(setTimeout(fn, ms));
function clearTimers() {
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  timers = [];
  if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
}

// ---------------------------------------------------------------------------
// Slots (async, JSON in/out — api.js parses both sides)
// ---------------------------------------------------------------------------

export async function getBootstrap() {
  return { ...clone(BOOTSTRAP), busy: engine.busy };
}

export async function runCheck() {
  if (engine.busy) {
    emit('reportReady', { channel: 'check', data: { error: 'busy' } });
    return;
  }
  setState({ busy: true, kind: 'runsh', started: new Date().toISOString() });
  line('check', 'video-hls system check');
  line('check', '======================');
  for (let i = 0; i < CHECK_LINES.length; i++) {
    line('check', CHECK_LINES[i]);
    await sleep(45);
  }
  lastCheck = clone(CHECK);
  emit('reportReady', { channel: 'check', data: clone(CHECK) });
  setState({ busy: false, kind: null, started: null });
}

export async function dryRun(overrides = null) {
  if (engine.busy) {
    emit('reportReady', { channel: 'dryrun', data: { error: 'busy' } });
    return;
  }
  if (overrides) line('dryrun', `${now()} [INFO] overrides: ${JSON.stringify(overrides)}`);
  setState({ busy: true, kind: 'runsh', started: new Date().toISOString() });
  line('dryrun', 'video-hls dry run');
  line('dryrun', '================');
  await sleep(300);
  line('dryrun', `${now()} [INFO] [1/1] Route 66 Demo.mp4 (1280x720, 25 fps, audio=true)`);
  await sleep(240);
  line('dryrun', `${now()} [INFO] gop=150 - segment 6s - h264_nvenc - mpegts - 3 tiers (1080p dropped: taller than source)`);
  await sleep(240);
  lastDryrun = clone(DRYRUN);
  emit('reportReady', { channel: 'dryrun', data: clone(DRYRUN) });
  setState({ busy: false, kind: null, started: null });
}

export async function launchRun(overrides = null) {
  if (engine.busy) return { ok: false, error: 'busy' };
  if (!TOOLS.ffmpeg) return { ok: false, error: 'ffmpeg missing' };

  const src = inputs[0];
  setState({ busy: true, kind: 'runsh', started: new Date().toISOString() });
  if (overrides) line('run', `${now()} [INFO] overrides: ${JSON.stringify(overrides)}`);

  if (!src) {
    at(300, () => line('run', `${now()} [INFO] no sources in ${ROOTS.input} - nothing to do`));
    at(600, () => {
      emit('reportReady', { channel: 'run.summary', data: { ok: true, exit_code: 0, duration_s: 0.6, cancelled: false, engine: 'runsh', succeeded: 0, failed: 0 } });
      setState({ busy: false, kind: null, started: null });
    });
    return { ok: true, error: null };
  }

  const stem = src.rel.replace(/\.mp4$/, '');
  const script = [
    [400, () => line('run', `${now()} [INFO] [1/1] Processing: ${src.rel} (1280x720, audio=true, gop=150)`)],
    [300, () => line('run', `${now()} [START] Encoding 360p with h264_nvenc`)],
    [300, () => line('run', `${now()} [START] Encoding 480p with h264_nvenc`)],
    [300, () => line('run', `${now()} [START] Encoding 720p with h264_nvenc`)],
    [1500, () => line('run', `${now()} [DONE] 360p -> video-work/encoded/${stem}/renditions/360p.mp4`)],
    [700, () => line('run', `frame= 1896 fps= 294 q=23.0 size=   25514kB time=00:01:09.42 bitrate=3013.5kbits/s speed=11.8x`)],
    [1300, () => line('run', `${now()} [DONE] 480p -> video-work/encoded/${stem}/renditions/480p.mp4`)],
    [1100, () => line('run', `frame= 3600 fps= 281 q=23.0 size=   60103kB time=00:02:19.11 bitrate=3542.9kbits/s speed=11.2x`)],
    [1700, () => line('run', `${now()} [DONE] 720p -> video-work/encoded/${stem}/renditions/720p.mp4`)],
    [600, () => line('run', `${now()} [DONE] Packaged 360p`)],
    [250, () => line('run', `${now()} [DONE] Packaged 480p`)],
    [250, () => line('run', `${now()} [DONE] Packaged 720p`)],
    [700, () => {
      line('run', `${now()} [DONE] [1/1] HLS package: hls/Route 66 Demo/master.m3u8`);
      line('run', `${now()} [DONE] [1/1] Source archived: video-done/${src.rel}`);
    }],
  ];
  let t = 0;
  for (const [dt, fn] of script) { t += dt; at(t, fn); }
  at(t + 500, () => {
    const finished = new Date().toISOString();
    // commit: package joins the library, source leaves the queue, log on file
    library.unshift({
      name: 'Route 66 Demo',
      path: `${ROOTS.hls}/Route 66 Demo`,
      meta: {
        source: src.rel, source_width: 1280, source_height: 720,
        video_encoder: 'h264_nvenc', audio_codec: 'aac',
        segment_type: 'mpegts', segment_duration: 6, gop_size: 150, playlist_version: 3,
      },
      tier_count: 3,
      mtime: finished,
      error: null,
    });
    const logPath = `${ROOTS.logs}/encode_Route_66_Demo_20260818_150000.log`;
    logs.unshift({ engine: 'runsh', name: 'encode_Route_66_Demo_20260818_150000.log', path: logPath, size_bytes: 3811, mtime: finished });
    logTexts[logPath] = '— streaming —';
    inputs = inputs.slice(1);
    emit('reportReady', {
      channel: 'run.summary',
      data: { ok: true, exit_code: 0, duration_s: 9.8, cancelled: false, engine: 'runsh', succeeded: 1, failed: 0 },
    });
    setState({ busy: false, kind: null, started: null });
  });
  return { ok: true, error: null };
}

export async function launchBatch(overrides = null) {
  if (engine.busy) return { ok: false, error: 'busy' };
  setState({ busy: true, kind: 'batch', started: new Date().toISOString() });
  if (overrides) line('batch', `${now()} [INFO] overrides: ${JSON.stringify(overrides)}`);
  const script = [
    [300, () => line('batch', `${now()} [INFO] encode-batch starting: 2 files, av1 / opus, CQ 35`)],
    [400, () => line('batch', `${now()} [START] [1/2] keynotes-2019.mkv`)],
    [300, () => line('batch', `${now()} [START] [2/2] keynotes-2021.mkv`)],
    [2200, () => line('batch', `${now()} [DONE] [2/2] keynotes-2021.mkv -> encoded/keynotes-2021.mkv (CQ 35, 1.9 GB -> 612 MB)`)],
    [2400, () => line('batch', `${now()} [DONE] [1/2] keynotes-2019.mkv -> encoded/keynotes-2019.mkv (CQ 35, 2.4 GB -> 748 MB)`)],
    [500, () => line('batch', `${now()} [INFO] batch complete: 2 encoded, 0 skipped, 0 failed in 5m06s`)],
  ];
  let t = 0;
  for (const [dt, fn] of script) { t += dt; at(t, fn); }
  at(t + 400, () => {
    emit('reportReady', {
      channel: 'batch.summary',
      data: { ok: true, exit_code: 0, duration_s: 5.1, cancelled: false, engine: 'batch', total: 2 },
    });
    setState({ busy: false, kind: null, started: null });
  });
  return { ok: true, error: null };
}

export async function cancelRun() {
  if (!engine.busy) return { ok: true, error: 'not running' };
  clearTimers();
  const ch = engine.kind === 'batch' ? 'batch' : 'run';
  line(ch, `${now()} [WARN] cancelled by operator`);
  emit('reportReady', {
    channel: engine.kind === 'batch' ? 'batch.summary' : 'run.summary',
    data: { ok: false, exit_code: 143, duration_s: 0, cancelled: true, engine: engine.kind },
  });
  setState({ busy: false, kind: null, started: null });
  return { ok: true, error: null };
}

export async function listInputs() { return clone(inputs); }

export async function libraryList() { return clone(library); }

export async function packageDetail(name) {
  if (name !== 'PressedMail Demo' && name !== 'Route 66 Demo') {
    return { error: `no package named ${name}` };
  }
  if (name === 'Route 66 Demo') {
    return {
      name, path: `${ROOTS.hls}/Route 66 Demo`, meta: library[0]?.meta ?? null,
      tiers: [
        { uri: '360p/index.m3u8', bandwidth: 1200000, avg_bandwidth: 800000, resolution: '640x360', codecs: 'avc1.4D401E' },
        { uri: '480p/index.m3u8', bandwidth: 2100000, avg_bandwidth: 1400000, resolution: '854x480', codecs: 'avc1.4D401F' },
        { uri: '720p/index.m3u8', bandwidth: 4200000, avg_bandwidth: 2800000, resolution: '1280x720', codecs: 'avc1.4D401F' },
      ],
      master: `${ROOTS.hls}/Route 66 Demo/master.m3u8`,
    };
  }
  return clone(PACKAGE_DETAIL);
}

export async function archiveList() {
  return [{ rel: 'PressedMail Demo.mp4', size_bytes: 258642806 }];
}

export async function verifyPackage(name) {
  const t0 = Date.now();
  await sleep(3000); // decode every tier of the whole package
  emit('reportReady', {
    channel: 'verify',
    data: {
      name,
      ok: true,
      exit_code: 0,
      stderr_tail: '',
      duration_s: Math.round(((Date.now() - t0) / 1000) * 100) / 100,
    },
  });
}

export async function logsList() { return clone(logs); }

export async function logRead(path, tailBytes = '65536') {
  const text = logTexts[path] ?? '';
  return text ? { path, text } : { path, text: '', error: 'not found' };
}

// tail -f -n +1 semantics: whole file replays, then appends stream.
const TAIL_FRAMES = [
  (n) => `frame= ${1200 + n * 30} fps= 288 q=23.0 size=  ${(18 + n * 1.7).toFixed(0)}014kB time=00:00:${String((n * 2) % 60).padStart(2, '0')}.${String((n * 17) % 100).padStart(2, '0')} bitrate=3401.9kbits/s speed=11.5x`,
  (n) => `frame= ${1500 + n * 30} fps= 275 q=23.0 size=  ${(24 + n * 2.1).toFixed(0)}128kB time=00:01:${String((n * 3) % 60).padStart(2, '0')}.${String((n * 31) % 100).padStart(2, '0')} bitrate=3122.4kbits/s speed=11.0x`,
];

export async function tailStart(path) {
  if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
  tailFrame = 0;
  const text = logTexts[path];
  if (text) for (const l of text.split('\n')) line('tail', l);
  else line('tail', `${now()} [INFO] waiting for ${path} to appear...`);
  tailTimer = setInterval(() => {
    line('tail', TAIL_FRAMES[tailFrame % 2](tailFrame));
    tailFrame++;
  }, 700);
}

export async function tailStop() {
  if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
}

export async function settingsGet() {
  return { ...settingsSnapshot(), env_text: ENV_TEXT, env_path: BOOTSTRAP.env_path, env_writable: true };
}

export async function settingsPreview(values) {
  const errs = [];
  const runsh = { ...(values?.runsh || {}) };
  if (runsh.LADDER && /bitrate 'x'/.test(String(runsh.LADDER))) {
    errs.push("LADDER row 2: bitrate 'x' invalid");
  }
  return {
    errors: errs,
    env_text: ENV_TEXT,
    derived_roots: { ...ROOTS },
    ladder_rows: [
      ['1080p', '1080', '1920', '5000k', '7500k', '10000k', '192k'],
      ['720p', '720', '1280', '2800k', '4200k', '6000k', '128k'],
      ['480p', '480', '854', '1400k', '2100k', '3000k', '128k'],
      ['360p', '360', '640', '800k', '1200k', '1800k', '96k'],
    ],
    ladder_errors: [],
  };
}

export async function settingsSave(values) {
  const preview = await settingsPreview(values);
  if (preview.errors.length) return { ok: false, errors: preview.errors, env_path: BOOTSTRAP.env_path };
  const runsh = values?.runsh || {};
  for (const f of RUNSH_SPECS) {
    if (f.name in runsh) f.current = runsh[f.name];
  }
  const batch = values?.batch || {};
  for (const f of BATCH_SPECS) {
    if (f.name in batch) f.current = batch[f.name];
  }
  return { ok: true, errors: [], env_path: BOOTSTRAP.env_path };
}

export async function setEnginePath(path) {
  if (!path.includes('run.sh') && !path) {
    return { ok: false, error: `run.sh not found in ${path}`, version: 'unknown' };
  }
  return { ok: true, error: null, version: BOOTSTRAP.engine.version };
}

export async function pickDirectory(current = '') {
  await sleep(400); // a real dialog would block here
  return current || REPO;
}

export async function openPath(path) { return { ok: true, path }; }
export async function revealFile(path) { return { ok: true, path }; }
export async function openInPlayer(path) { return { ok: true, path }; }
export async function viewReady(view) { return { ok: true, view }; }

// ---------------------------------------------------------------------------
// APPENDIX — added by the EXIT 03/04 view agent (additive only; remove when
// launchBatch simulates this natively).
//
// Gap: the scripted launchBatch above emits only [START]/[DONE] lines, but the
// real engine tees ffmpeg -stats output, so `frame= … time=…` lines stream on
// the batch channel and the batch view derives its meter and readout from
// them. This wrapper keeps the original script and interleaves two realistic
// encoder progress streams (one per parallel job) while the engine is busy.
// ---------------------------------------------------------------------------
{
  const hmsT = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}`;
  };
  const origLaunchBatch = launchBatch;
  launchBatch = async function (overrides) {
    const res = await origLaunchBatch(overrides);
    if (res && res.ok === false) return res;
    const started = Date.now();
    const jobs = [
      { after: 800, dur: 21.0, speed: 4.4, fps: 96 },  // [1/2] keynotes-2019.mkv
      { after: 1100, dur: 18.6, speed: 8.5, fps: 90 }, // [2/2] keynotes-2021.mkv
    ];
    const tick = setInterval(() => {
      if (!engine.busy || engine.kind !== 'batch') { clearInterval(tick); return; }
      const wall = (Date.now() - started) / 1000;
      for (const j of jobs) {
        const t = (wall - j.after / 1000) * j.speed;
        if (t <= 0 || t >= j.dur) continue;
        line('batch',
          `frame= ${String(Math.round(t * j.fps)).padStart(6)} fps=${Math.round(j.fps * j.speed)} q=34.0 ` +
          `size=${String(Math.round(t * 1980)).padStart(9)}kB time=${hmsT(t)} ` +
          `bitrate=${(7200 - t * 90).toFixed(1)}kbits/s dup=0 drop=0 speed=${j.speed.toFixed(2)}x`);
      }
    }, 300);
    return res;
  };
}

// ---------------------------------------------------------------------------
// APPENDIX 2 — added by the EXIT 03/04 view agent (additive only).
// Gap: BRIDGE.md says batch.summary carries succeeded/failed "merged in when
// the engine output contained a summary line", and the scripted launchBatch
// does print one ("batch complete: 2 encoded, 0 skipped, 0 failed") — but the
// summary payload omits the counts. This wrapper captures the engine's own
// line as it streams and merges the counts into batch.summary, exactly what
// the Python host does. Remove when launchBatch merges them natively.
// ---------------------------------------------------------------------------
{
  const SUMMARY_LINE_RE = /batch complete: (\d+) encoded, (\d+) skipped, (\d+) failed/;
  let batchCounts = null;
  const origEmit = emit;
  emit = function (signal, payload) {
    if (signal === 'lineReady' && payload?.channel === 'batch') {
      const m = SUMMARY_LINE_RE.exec(payload.text || '');
      if (m) batchCounts = { succeeded: +m[1], skipped: +m[2], failed: +m[3] };
    }
    if (signal === 'reportReady' && payload?.channel === 'batch.summary'
        && payload.data && !('succeeded' in payload.data) && batchCounts) {
      payload = { ...payload, data: { ...batchCounts, ...payload.data } };
      batchCounts = null;
    }
    return origEmit(signal, payload);
  };
}
