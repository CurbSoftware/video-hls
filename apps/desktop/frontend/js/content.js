// Control Room — content.js
// Education copy, sourced from the repo README.md. Every view imports from
// here; views never restate an explanation. Keep strings terse and factual.

export const gopCoupling = {
  headline: 'GOP = round(fps × HLS_TIME)',
  body:
    'The keyframe interval is computed once per source and applied to every ' +
    'rendition. Packaging is a stream copy, so the segmenter can only cut on ' +
    'existing keyframes — identical GOPs are what make all tiers share ' +
    'segment boundaries and let players switch without stuttering. HLS_TIME ' +
    'feeds both the encode and the segmenter; change one, the other follows.',
};

export const segmentTypes = {
  headline: 'MPEG-TS vs fMP4',
  body:
    'MPEG-TS carries only H.264 + AAC and writes version-3 playlists. HEVC, ' +
    'AV1 and Opus need fMP4/CMAF segments, which bump the master playlist to ' +
    '#EXT-X-VERSION:7. HLS_SEGMENT_TYPE=auto upgrades automatically; forcing ' +
    'mpegts with those codecs is rejected before anything encodes.',
};

export const codecTradeoffs = [
  { codec: 'h264', compatibility: 'Everything, everywhere', size: 'Largest', speed: 'Fastest',
    note: 'The safe default. Plays in every browser, TV and phone.' },
  { codec: 'hevc', compatibility: 'Safari, iOS, TVs', size: '~40% smaller', speed: 'Medium',
    note: 'Not supported by Chrome or Firefox on the open web — a stream that plays in VLC but not a browser is usually HEVC.' },
  { codec: 'av1', compatibility: 'Modern browsers only', size: 'Smallest', speed: 'Slowest in software',
    note: 'Best quality per bit. Hardware encoders are rare; expect long CPU encodes.' },
];

export const qualityRanges = {
  headline: 'QUALITY — one knob, per family',
  body:
    'Lower is better and bigger, in every family. x264: CRF 18 is visually ' +
    'lossless, 23 the default, 28 noticeably smaller. For x265 and AV1 add ' +
    'about 5 to reach comparable quality — AV1 CRF ~30 ≈ x264 CRF 23. NVENC ' +
    'sane range is 19–32.',
  families: [
    { family: 'nvenc', flag: '-cq', range: '19–32 (default 28)' },
    { family: 'qsv', flag: '-global_quality', range: 'same scale' },
    { family: 'vaapi', flag: '-qp', range: 'same scale' },
    { family: 'libx264 / libx265', flag: '-crf', range: '18 lossless-ish / 23 default / 28 small' },
    { family: 'libsvtav1 / libaom', flag: '-crf', range: '~30 ≈ x264 23' },
  ],
  batch: [
    { tier: 'CQ 32–34', meaning: 'archive grade — near-transparent' },
    { tier: 'CQ 35–37', meaning: 'the sweet spot for most libraries' },
    { tier: 'CQ 38+', meaning: 'aggressive — visible at 1080p, fine for 480p' },
  ],
};

export const accelKinds = [
  { kind: 'nvenc', line: 'NVIDIA dedicated silicon. Fastest option when present; consumer cards cap concurrent sessions.' },
  { kind: 'qsv', line: 'Intel Quick Sync, via the media driver. Common on laptops and NUCs.' },
  { kind: 'vaapi', line: 'Linux generic video API through a render node such as /dev/dri/renderD128.' },
  { kind: 'videotoolbox', line: 'macOS framework; the reason Apple hardware encodes without ffmpeg extras.' },
  { kind: 'none', line: 'Pure CPU: libx264/libx265/SVT-AV1. Works everywhere — what CI and most users hit.' },
];

export const parallelNote = {
  headline: 'PARALLEL_VIDEOS × PARALLEL_RENDITIONS',
  body:
    'That product is your simultaneous encoder session count. Consumer ' +
    'NVIDIA cards cap concurrent NVENC sessions, so raising both multiplies ' +
    'quickly. For software encoding leave PARALLEL_VIDEOS=1 and let libx264 ' +
    'use the cores itself.',
};

// Troubleshooting map — keyed by the symptom a user sees.
export const troubleshooting = [
  { symptom: 'No usable h264 encoder found',
    fix: 'Run a systems check. If every hardware option says "built, not usable here", the driver is missing or unreachable — use HWACCEL=none.' },
  { symptom: 'Stream plays in VLC but not a browser',
    fix: 'Usually HEVC or AV1, which Chrome and Firefox often refuse. Re-encode with VIDEO_CODEC=h264.' },
  { symptom: 'Player stutters when switching quality',
    fix: 'Segment boundaries are misaligned — renditions encoded at different HLS_TIME values across runs while SKIP_EXISTING=true. Delete video-work/encoded/<name>/ and re-run.' },
  { symptom: 'A video failed',
    fix: 'It stays in video/. The reason is in video-work/logs/encode_<name>_<timestamp>.log — see DISPATCH.' },
  { symptom: 'Start completely fresh',
    fix: 'rm -rf video-work/ deletes only scratch data; published packages in hls/ are untouched.' },
];

// Shared micro-copy
export const copy = {
  checkLede: 'Probe the machine. Truth over advertisement — each encoder is verified by encoding five real frames.',
  dispatchLede: 'Every departure is logged. Tails run live; archives stay on file.',
};
