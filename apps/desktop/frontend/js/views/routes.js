// Control Room: views/routes.js
// EXIT 02, CONVERT. A step-by-step HLS job. The engine is still run.sh:
// this view only chooses files, sizes, an output folder, and optional upload.

import { api } from '../api.js';
import { state, bus } from '../shell.js';
import {
  chip, kv, card, btn, pageHeader, laneRow, emptyState, raw, esc,
} from '../components/ui.js';
import { meter, progressLane, logStream } from '../components/progress.js';

// Same rule as controlroom.s3.cors_body. Paste this, or apply it to the bucket.
const CORS_POLICY = `[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]`;

const STEPS = [
  { id: 'source', label: 'Source', line: 'Start with a folder of videos, or a single file.' },
  { id: 'choose', label: 'Choose', line: 'These files can be converted. Uncheck any you want to leave out.' },
  { id: 'sizes', label: 'Resolutions', line: 'Each checked size becomes a stream in the package. A size taller than a video is skipped. The app does not enlarge a video to fill a size.' },
  { id: 'output', label: 'Output', line: 'Each video is written as its own folder of HLS files. The folder name starts as the video name. Change it before converting.' },
  { id: 'hardware', label: 'Hardware', line: 'Use a GPU when this machine has one. Otherwise the CPU does the work.' },
  { id: 'delivery', label: 'Delivery', line: 'Leave this off to keep the files in the output folder. Turn it on to upload each finished package to an S3 bucket, including Cloudflare R2.' },
  { id: 'convert', label: 'Convert', line: 'Check the plan, then start. Original files stay where they are.' },
];

const FALLBACK_LADDER = [
  { label: '240p', height: 240, width: 426, video_bitrate: '400k', maxrate: '600k', bufsize: '900k', audio_bitrate: '64k' },
  { label: '360p', height: 360, width: 640, video_bitrate: '800k', maxrate: '1200k', bufsize: '1800k', audio_bitrate: '96k' },
  { label: '480p', height: 480, width: 854, video_bitrate: '1400k', maxrate: '2100k', bufsize: '3000k', audio_bitrate: '128k' },
  { label: '720p', height: 720, width: 1280, video_bitrate: '2800k', maxrate: '4200k', bufsize: '6000k', audio_bitrate: '128k' },
  { label: '1080p', height: 1080, width: 1920, video_bitrate: '5000k', maxrate: '7500k', bufsize: '10000k', audio_bitrate: '192k' },
  { label: '1440p', height: 1440, width: 2560, video_bitrate: '9000k', maxrate: '13500k', bufsize: '18000k', audio_bitrate: '192k' },
  { label: '2160p', height: 2160, width: 3840, video_bitrate: '16000k', maxrate: '24000k', bufsize: '32000k', audio_bitrate: '256k' },
];

const GPU_KINDS = ['nvenc', 'qsv', 'vaapi', 'videotoolbox'];
const GPU_LABEL = {
  nvenc: 'NVIDIA', qsv: 'Intel Quick Sync', vaapi: 'VAAPI', videotoolbox: 'Apple',
};

const pad2 = (n) => String(n).padStart(2, '0');
const stripTs = (t) => String(t).replace(/^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\]\s*/, '');

function fmtSize(bytes) {
  if (bytes == null) return '-';
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}
function fmtDur(d) {
  if (d == null) return '-';
  const s = Math.round(d);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function stemOf(rel) {
  const base = String(rel || '').split(/[/\\]/).pop();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}
function joinPath(dir, name) {
  return `${String(dir || '').replace(/[\\/]+$/, '')}/${name}`;
}
function nameProblem(name, all) {
  const n = String(name ?? '');
  if (n !== n.trim()) return 'The name cannot start or end with a space.';
  if (!n || n === '.' || n === '..') return 'Use a folder name.';
  if (/[/\\\u0000]/.test(n)) return 'Folder names cannot contain slashes.';
  if (all.filter((x) => x === n).length > 1) return 'Two videos would share this folder.';
  return '';
}
function usableGpu(report) {
  const found = [];
  for (const e of report?.video_encoders || []) {
    if (e.status !== 'USABLE') continue;
    for (const k of GPU_KINDS) {
      if (String(e.encoder || '').includes(k) && !found.includes(k)) found.push(k);
    }
  }
  return found;
}

export async function render(root) {
  const subs = [];
  const boot = state.bootstrap || {};
  const ladder = (boot.builtin_ladder && boot.builtin_ladder.length)
    ? boot.builtin_ladder : FALLBACK_LADDER;

  let step = 0;
  let source = null;
  let probe = null;
  let probing = false;
  let selected = new Set();
  const tiers = new Set(['360p', '480p', '720p', '1080p']);
  let outputDir = boot.roots?.hls || '';
  let names = {};
  let clashes = [];
  let clashTimer = 0;
  let hw = 'cpu';
  let hwTouched = false;
  let checkPending = false;
  let deliveryOn = false;
  let secretDraft = '';
  let deliveryOk = false;
  let deliverySig = '';
  let deliveryMsg = '';
  let deliveryBusy = false;
  let applyBusy = false;
  let form = {
    provider: 'aws', access_key_id: '', bucket: '', region: 'us-east-1',
    endpoint: '', account_id: '', prefix: '', public_base_url: '',
    path_style: true, secret_set: false,
  };
  let deliveryLoaded = false;
  let phase = 'review'; // review | running | upload | done
  let live = null;
  let runReport = null;
  let uploads = new Map();
  let uploadFinal = null;
  let startError = '';
  let stagingRoot = null;

  root.innerHTML = `
    ${pageHeader({
      exit: '02', title: 'Convert', coords: '44.06°N 121.31°W',
      lede: 'Turn videos into HLS in a few steps. Original files stay where they are.',
    })}
    <div id="wz-rail" class="wz-rail" role="tablist" aria-label="Conversion steps"></div>
    <div id="wz-body"></div>
    <div id="wz-log" hidden></div>
    <div id="wz-foot" class="wz-foot"></div>
  `;

  const rail = root.querySelector('#wz-rail');
  const body = root.querySelector('#wz-body');
  const foot = root.querySelector('#wz-foot');
  const logEl = root.querySelector('#wz-log');
  const runStream = logStream(logEl, {});

  const convertible = () => (probe?.items || []).filter((it) => it.convertible);
  const rejected = () => (probe?.items || []).filter((it) => !it.convertible);
  const selectedItems = () => convertible().filter((it) => selected.has(it.abs));
  const chosenTiers = () => ladder.filter((r) => tiers.has(r.label));
  const nameValues = () => selectedItems().map((it) => names[it.abs] ?? '');

  function stranded() {
    const rows = chosenTiers();
    if (!rows.length) return [];
    return selectedItems().filter((v) => rows.every((t) => t.height > (v.height || 0)));
  }
  function tiersTooTall() {
    const items = selectedItems();
    if (!items.length) return [];
    return chosenTiers().filter((t) => items.every((v) => t.height > (v.height || 0)));
  }

  function syncNames() {
    const next = {};
    for (const it of selectedItems()) {
      next[it.abs] = Object.prototype.hasOwnProperty.call(names, it.abs)
        ? names[it.abs] : stemOf(it.rel || it.abs);
    }
    names = next;
  }

  function formSignature() {
    return JSON.stringify({ ...form, secret: secretDraft, on: deliveryOn });
  }
  function deliveryReady() {
    if (!deliveryOn) return true;
    if (!form.access_key_id.trim() || !form.bucket.trim()) return false;
    if (!secretDraft && !form.secret_set) return false;
    if (form.provider === 'r2' && !form.account_id.trim()) return false;
    if (form.provider === 'other' && !form.endpoint.trim()) return false;
    if (form.provider !== 'r2' && !form.region.trim()) return false;
    return deliveryOk && deliverySig === formSignature();
  }

  function stepValid() {
    if (step === 0) return !!source?.path;
    if (step === 1) return !probing && selected.size > 0;
    if (step === 2) return tiers.size > 0 && stranded().length === 0;
    if (step === 3) {
      if (!outputDir) return false;
      const vals = nameValues();
      return vals.length > 0 && vals.every((n) => !nameProblem(n, vals));
    }
    if (step === 4) return !checkPending;
    if (step === 5) return !deliveryBusy && deliveryReady();
    return phase === 'review';
  }

  function applyHwDefault() {
    if (hwTouched) return;
    hw = usableGpu(state.lastCheck).length ? 'gpu' : 'cpu';
  }

  function paintRail() {
    rail.innerHTML = STEPS.map((s, i) => {
      const current = i === step;
      const canJump = i < step && phase !== 'running' && phase !== 'upload';
      return `<button type="button" role="tab" data-goto="${i}" ` +
        `aria-selected="${current}" ${current ? 'aria-current="step"' : ''} ` +
        `${canJump ? '' : 'disabled'}>${i + 1} ${esc(s.label)}</button>`;
    }).join('');
  }

  function paintFoot() {
    const running = phase === 'running' || phase === 'upload' || state.busy && step === 6 && phase !== 'review' && phase !== 'done';
    const showNext = step < 6 && phase !== 'running' && phase !== 'upload';
    const showStart = step === 6 && phase === 'review';
    foot.innerHTML =
      (step > 0 && phase !== 'running' && phase !== 'upload'
        ? btn({ label: 'Back', kind: 'ghost', attrs: 'data-act="back"' }) : '') +
      `<span class="grow"></span>` +
      (running && state.busy
        ? btn({ label: 'Cancel', kind: 'danger', attrs: 'id="wz-cancel"' }) : '') +
      (showNext ? btn({
        label: probing ? 'Checking' : 'Continue',
        kind: 'primary', id: 'wz-next',
        disabled: !stepValid() || probing,
      }) : '') +
      (showStart ? btn({
        label: 'Start conversion', kind: 'primary', id: 'wz-start',
        disabled: state.busy,
      }) : '') +
      (phase === 'done' ? btn({
        label: 'Start another', kind: 'ghost', attrs: 'data-act="another"',
      }) : '');
  }

  function sourceHtml() {
    const picked = source
      ? `<p class="wz-path">${esc(source.path)}</p>`
      : '';
    const path = STEPS.map((s, i) =>
      `<li><span class="micro">${i + 1} ${esc(s.label)}</span><span>${esc(s.line)}</span></li>`).join('');
    return `
      <p class="wz-line">${esc(STEPS[0].line)}</p>
      <div class="wz-choices">
        ${btn({ label: 'Choose a folder', kind: 'primary', attrs: 'data-act="pick-dir"' })}
        ${btn({ label: 'Choose one video', kind: 'ghost', attrs: 'data-act="pick-file"' })}
      </div>
      ${picked}
      <ol class="wz-pathlist">${path}</ol>
    `;
  }

  function chooseHtml() {
    if (probing) {
      return `<p class="wz-line">Checking the videos. This reads each file and does not convert anything.</p>`;
    }
    if (probe?.error) {
      return emptyState({
        code: '02', headline: 'Could not read that location',
        guidance: probe.error,
      });
    }
    const good = convertible();
    const bad = rejected();
    if (!good.length && !bad.length) {
      return emptyState({
        code: '02', headline: 'No videos found',
        guidance: 'Choose a folder that contains video files, or pick a single video.',
      });
    }
    const rows = good.map((it) => {
      const on = selected.has(it.abs);
      const box = `<label><input type="checkbox" data-pick="${esc(it.abs)}" ${on ? 'checked' : ''}> ` +
        `<span class="mono">${esc(it.rel || it.abs)}</span></label>`;
      return [
        raw(box),
        raw(`<span class="mono">${esc(fmtSize(it.size_bytes))}</span>`),
        it.width ? raw(`<span class="mono">${it.width}×${it.height}</span>`) : '-',
        raw(`<span class="mono">${esc(fmtDur(it.duration_s))}</span>`),
        it.has_audio ? raw(chip('ok', 'AUDIO')) : raw(chip('idle', 'MUTE')),
      ];
    });
    const tableHead = '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      ['', 'size', 'resolution', 'duration', 'audio'].map((h) => `<th>${esc(h)}</th>`).join('') +
      `</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c && c.__raw ? c.html : esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    const badList = bad.length
      ? `<h3 class="wz-sub">Could not use</h3><div class="lane-list">${bad.map((it) => laneRow({
          label: it.rel || it.abs,
          status: 'err',
          detail: it.reason || 'Could not read the file.',
        })).join('')}</div>`
      : '';
    return `
      <p class="wz-line">${esc(STEPS[1].line)}</p>
      <div class="wz-choices" style="margin-bottom:var(--s-4)">
        ${btn({ label: 'Select all', kind: 'ghost', attrs: 'data-act="all"' })}
        ${btn({ label: 'Clear', kind: 'ghost', attrs: 'data-act="none"' })}
        <span class="micro">${selected.size} selected</span>
      </div>
      ${tableHead}
      ${badList}
    `;
  }

  function sizesHtml() {
    const tall = tiersTooTall();
    const stuck = stranded();
    const boxes = ladder.map((r) => {
      const on = tiers.has(r.label);
      return `<button type="button" class="tchip" data-tier="${esc(r.label)}" aria-pressed="${on}">${esc(r.label)}</button>`;
    }).join('');
    const tallNote = tall.length
      ? `<p class="wz-line">${esc(tall.map((t) => t.label).join(', '))} ${tall.length === 1 ? 'is' : 'are'} taller than every selected video, so ${tall.length === 1 ? 'it' : 'they'} will be skipped.</p>`
      : '';
    const stuckNote = stuck.length
      ? `<p class="wz-err">${esc(stuck.map((v) => stemOf(v.rel)).join(', '))} ${stuck.length === 1 ? 'is' : 'are'} shorter than every checked size. Check a smaller size so each video gets a stream.</p>`
      : '';
    return `
      <p class="wz-line">${esc(STEPS[2].line)}</p>
      <div class="wz-tiers">${boxes}</div>
      <p class="wz-line" style="margin-top:var(--s-5)">Streams are H.264 video and AAC audio, so they play in a browser.</p>
      ${tallNote}${stuckNote}
    `;
  }

  function fitWidth(text) {
    // Extra characters cover the input's padding and letter-spacing so the
    // value is not clipped at the edge of the box.
    const n = Math.max(String(text || '').length + 4, 12);
    return `width:max(100%, ${n}ch);max-width:none`;
  }

  function outputHtml() {
    const vals = nameValues();
    const rows = selectedItems().map((it) => {
      const name = names[it.abs] ?? '';
      const problem = nameProblem(name, vals);
      const clash = clashes.includes(name);
      return `<div class="wz-name" data-name-row="${esc(it.abs)}">
          <input class="finput" data-name="${esc(it.abs)}" value="${esc(name)}" aria-label="Folder name for ${esc(it.rel || it.abs)}" style="${fitWidth(name)}">
          <p class="wz-path">${esc(joinPath(outputDir || 'output', name || '…'))}/master.m3u8</p>
          <p class="wz-err" data-name-err="${esc(it.abs)}">${esc(problem)}</p>
          ${clash ? '<p class="wz-line">A folder with this name is already in the output directory. The new package will replace it.</p>' : ''}
      </div>`;
    }).join('');
    return `
      <p class="wz-line">${esc(STEPS[3].line)}</p>
      <div class="wz-field">
        <label class="micro" for="wz-out">Output folder</label>
        <input id="wz-out" class="finput" readonly value="${esc(outputDir)}" style="${fitWidth(outputDir)}">
        <div class="wz-choices">
          ${btn({ label: 'Choose folder', kind: 'ghost', attrs: 'data-act="pick-out"' })}
        </div>
      </div>
      ${rows}
    `;
  }

  function hardwareHtml() {
    if (checkPending) {
      return `<p class="wz-line">Checking this machine for a GPU encoder.</p>`;
    }
    const gpus = usableGpu(state.lastCheck);
    if (!gpus.length) {
      const why = state.lastCheck
        ? 'No GPU encoder is available on this machine. This run uses the CPU.'
        : 'Could not confirm a GPU, so this run uses the CPU.';
      return `<p class="wz-line">${esc(why)}</p>`;
    }
    const names = gpus.map((k) => GPU_LABEL[k] || k).join(', ');
    return `
      <p class="wz-line">A GPU encoder is available (${esc(names)}). Use it, or stay on the CPU.</p>
      <div class="wz-choices">
        <button type="button" class="tchip" data-hw="gpu" aria-pressed="${hw === 'gpu'}">Use the GPU</button>
        <button type="button" class="tchip" data-hw="cpu" aria-pressed="${hw === 'cpu'}">Use the CPU</button>
      </div>
    `;
  }

  function field(id, label, value, opts = {}) {
    const type = opts.secret ? 'password' : 'text';
    const placeholder = opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : '';
    return `<div class="wz-field">
      <label class="micro" for="${id}">${esc(label)}</label>
      <input id="${id}" class="finput" type="${type}" data-field="${esc(opts.key)}" value="${esc(value)}"${placeholder} style="max-width:28rem" autocomplete="off">
    </div>`;
  }

  function deliveryHtml() {
    const on = deliveryOn;
    const provider = form.provider;
    const extra = provider === 'r2'
      ? field('wz-account', 'Cloudflare account id', form.account_id, { key: 'account_id' })
      : provider === 'other'
        ? field('wz-endpoint', 'Endpoint', form.endpoint, { key: 'endpoint', placeholder: 'https://s3.example.com' }) +
          field('wz-region', 'Region', form.region, { key: 'region' }) +
          `<label class="wz-line"><input type="checkbox" data-field="path_style" ${form.path_style ? 'checked' : ''}> Path-style addresses</label>`
        : field('wz-region', 'Region', form.region, { key: 'region' });
    const secretPh = form.secret_set && !secretDraft ? 'Saved on this machine' : '';
    return `
      <p class="wz-line">${esc(STEPS[5].line)}</p>
      <label class="wz-line"><input type="checkbox" data-act="delivery-toggle" ${on ? 'checked' : ''}> Upload finished packages</label>
      ${on ? `
        <div class="wz-tiers" style="margin-bottom:var(--s-5)">
          ${['aws', 'r2', 'other'].map((p) => {
            const label = p === 'aws' ? 'Amazon S3' : p === 'r2' ? 'Cloudflare R2' : 'Other S3';
            return `<button type="button" class="tchip" data-provider="${p}" aria-pressed="${provider === p}">${label}</button>`;
          }).join('')}
        </div>
        ${field('wz-key', 'Access key', form.access_key_id, { key: 'access_key_id' })}
        ${field('wz-secret', 'Secret key', secretDraft, { key: 'secret', secret: true, placeholder: secretPh })}
        ${field('wz-bucket', 'Bucket', form.bucket, { key: 'bucket' })}
        ${extra}
        ${field('wz-prefix', 'Key prefix (optional)', form.prefix, { key: 'prefix', placeholder: 'videos' })}
        ${field('wz-public', 'Public base URL (optional)', form.public_base_url, { key: 'public_base_url', placeholder: 'https://cdn.example.com/videos' })}
        <p class="wz-line">The playback URL is the public base, then the prefix, the folder, and master.m3u8. If the website is on another address, the bucket has to allow GET and HEAD. Apply to this bucket replaces its CORS rules with the policy below. Replace * with the website's address in the policy first when other sites should not read the files.</p>
        <pre class="wz-cors">${esc(CORS_POLICY)}</pre>
        <div class="wz-choices" style="margin-bottom:var(--s-4)">
          ${btn({ label: 'Copy CORS policy', kind: 'ghost', attrs: 'data-act="copy-cors"' })}
          ${btn({ label: applyBusy ? 'Applying' : 'Apply to this bucket', kind: 'ghost', attrs: 'data-act="apply-cors"', disabled: deliveryBusy })}
        </div>
        <div class="wz-choices">
          ${btn({ label: deliveryBusy ? 'Testing' : 'Test connection', kind: 'ghost', attrs: 'data-act="test-s3"', disabled: deliveryBusy })}
          ${deliveryMsg ? `<span class="micro">${esc(deliveryMsg)}</span>` : ''}
        </div>
      ` : ''}
    `;
  }

  function summaryHtml() {
    const items = selectedItems();
    const gpu = usableGpu(state.lastCheck);
    const hwLine = hw === 'gpu' && gpu.length
      ? `GPU (${gpu.map((k) => GPU_LABEL[k] || k).join(', ')})`
      : 'CPU';
    const deliver = deliveryOn
      ? `${form.provider === 'r2' ? 'Cloudflare R2' : form.provider === 'other' ? 'S3' : 'Amazon S3'} · ${form.bucket}`
      : 'Output folder only';
    const list = items.map((it) => `<li class="mono">${esc(joinPath(outputDir, names[it.abs]))}/master.m3u8</li>`).join('');
    return `
      <p class="wz-line">${esc(STEPS[6].line)}</p>
      ${kv([
        ['Videos', String(items.length)],
        ['Sizes', chosenTiers().map((t) => t.label).join(', ') || '-'],
        ['Output', outputDir || '-'],
        ['Encoder', hwLine],
        ['Upload', deliver],
      ])}
      <ul class="wz-list">${list}</ul>
      ${startError ? `<p class="wz-err">${esc(startError)}</p>` : ''}
    `;
  }

  function liveHtml() {
    if (!live) return `<p class="wz-line">Preparing the videos.</p>`;
    return live.videos.map((v, i) => {
      const units = v.tiers.reduce((n, t) => n + (t.state === 'done' || t.state === 'skipped' ? 1
        : t.state === 'encoding' ? 0.5 : 0), 0);
      const frac = v.tiers.length ? Math.round((units / v.tiers.length) * 100) : 0;
      const pct = v.state === 'done' ? 100 : frac;
      const right = v.state === 'done' ? chip('ok', 'DONE') : v.state === 'failed' ? chip('err', 'FAILED') : '';
      const tiersHtml = v.tiers.length
        ? v.tiers.map((t) => {
          const p = t.state === 'done' ? 100 : t.state === 'encoding' ? 45 : 0;
          const status = { done: 'DONE', encoding: 'ENCODING', skipped: 'SKIPPED', failed: 'FAILED', pending: 'QUEUED' }[t.state] || '';
          return `<div class="tp tp-${t.state}" style="margin-bottom:var(--s-3)">${progressLane({ label: t.label, pct: p, status })}</div>`;
        }).join('')
        : laneRow({ label: 'Waiting for the encoder', status: 'idle' });
      const meterRow = `<div style="display:flex;align-items:center;gap:var(--s-3);margin-top:var(--s-2)">` +
        `<span class="micro">FILE</span><span style="flex:1">${meter(pct)}</span>` +
        `<span class="micro">${pct}%</span></div>`;
      return card({ num: pad2(i + 1), title: v.name, right: raw(right), children: tiersHtml + meterRow });
    }).join('');
  }

  function doneHtml() {
    const r = runReport || {};
    const cancelled = !!r.cancelled;
    const failed = r.failed || 0;
    const succeeded = r.succeeded || 0;
    const title = cancelled ? 'Conversion cancelled'
      : failed > 0 ? `${succeeded} finished, ${failed} failed`
        : succeeded > 0 ? `${succeeded} finished`
          : 'Nothing was converted';
    const rows = selectedItems().map((it) => {
      const name = names[it.abs];
      const local = `${joinPath(outputDir, name)}/master.m3u8`;
      const up = uploads.get(name);
      const url = up?.url
        ? `<div><a href="${esc(up.url)}">${esc(up.url)}</a></div>`
        : up?.error ? `<p class="wz-err">${esc(up.error)}</p>` : '';
      const prog = phase === 'upload' && up && up.total && !up.url
        ? `<p class="micro">${up.done || 0} / ${up.total} files uploaded</p>` : '';
      return `<li><span class="mono">${esc(local)}</span>${prog}${url}</li>`;
    }).join('');
    const uploadNote = phase === 'upload' ? '<p class="wz-line">Uploading the finished packages.</p>' : '';
    const finalNote = uploadFinal?.error ? `<p class="wz-err">${esc(uploadFinal.error)}</p>` : '';
    return `
      ${card({
        num: failed || cancelled ? '!' : 'OK',
        title,
        eyebrow: r.duration_s != null ? `${Number(r.duration_s).toFixed(1)}s` : '',
        children: `${uploadNote}<ul class="wz-list">${rows}</ul>${finalNote}`,
      })}
    `;
  }

  function paintBody() {
    const views = [sourceHtml, chooseHtml, sizesHtml, outputHtml, hardwareHtml, deliveryHtml];
    if (step < 6) body.innerHTML = views[step]();
    else if (phase === 'review') body.innerHTML = summaryHtml();
    else if (phase === 'done' || phase === 'upload') body.innerHTML = doneHtml() + (phase !== 'review' ? '' : '');
    else body.innerHTML = liveHtml();
    logEl.hidden = phase === 'review' || step < 6;
    if (phase === 'running' || phase === 'done' || phase === 'upload') {
      for (const el of body.querySelectorAll('.tp-done .plane-track > i')) el.style.background = 'var(--success)';
    }
  }

  function paint() {
    paintRail();
    paintBody();
    paintFoot();
  }

  function scheduleClash() {
    window.clearTimeout(clashTimer);
    clashTimer = window.setTimeout(async () => {
      if (!outputDir) { clashes = []; return; }
      const wanted = nameValues().filter(Boolean);
      try {
        const res = await api.outputClash({ dir: outputDir, names: wanted });
        clashes = res?.existing || [];
      } catch {
        clashes = [];
      }
      if (step === 3) {
        const active = document.activeElement;
        const key = active?.dataset?.name;
        const pos = active?.selectionStart;
        paint();
        if (key) {
          const again = body.querySelector(`[data-name="${CSS.escape(key)}"]`);
          if (again) {
            again.focus();
            if (pos != null) again.setSelectionRange(pos, pos);
          }
        }
      }
    }, 200);
  }

  async function ensureCheck() {
    applyHwDefault();
    if (state.lastCheck || checkPending) return;
    checkPending = true;
    if (step === 4) paint();
    try { await api.runCheck(); }
    catch {
      checkPending = false;
      if (step === 4) paint();
    }
  }

  async function loadDelivery() {
    if (deliveryLoaded) return;
    deliveryLoaded = true;
    try {
      const saved = await api.s3Get();
      if (saved && !saved.error) {
        form = { ...form, ...saved, secret_set: !!saved.secret_set };
        if (!form.region && form.provider !== 'r2') form.region = 'us-east-1';
      }
    } catch { /* empty form is fine */ }
    if (step === 5) paint();
  }

  function deliveryPayload() {
    return {
      provider: form.provider,
      access_key_id: form.access_key_id,
      bucket: form.bucket,
      region: form.region,
      endpoint: form.endpoint,
      account_id: form.account_id,
      prefix: form.prefix,
      public_base_url: form.public_base_url,
      path_style: !!form.path_style,
      secret: secretDraft,
    };
  }

  function runOverrides(inputRoot) {
    const rows = chosenTiers();
    const heights = rows.map((r) => r.height);
    return {
      INPUT_ROOT: inputRoot,
      HLS_ROOT: outputDir,
      LADDER: rows.map((r) => [
        r.label, r.height, r.width, r.video_bitrate, r.maxrate, r.bufsize, r.audio_bitrate,
      ].join(' ')).join('\n'),
      MIN_RESOLUTION_HEIGHT: String(Math.min(...heights)),
      MAX_RESOLUTION_HEIGHT: String(Math.max(...heights)),
      VIDEO_CODEC: 'h264',
      AUDIO_CODEC: 'aac',
      HWACCEL: hw === 'gpu' ? 'auto' : 'none',
      ARCHIVE_SOURCE: 'false',
    };
  }

  async function goNext() {
    if (!stepValid()) return;
    if (step === 0) {
      const path = source.path;
      step = 1;
      probing = true;
      probe = null;
      paint();
      let report = null;
      try { report = await api.probeSources(path); } catch (err) {
        report = { root: path, items: [], error: String(err?.message || err) };
      }
      if (source?.path !== path) return;
      probe = report || { items: [], error: 'Could not check the videos.' };
      probing = false;
      selected = new Set(convertible().map((it) => it.abs));
      syncNames();
      paint();
      return;
    }
    step += 1;
    if (step === 3) { syncNames(); scheduleClash(); }
    if (step === 4) ensureCheck();
    if (step === 5) loadDelivery();
    paint();
  }

  function goBack() {
    if (step === 0 || phase === 'running' || phase === 'upload') return;
    if (phase === 'done') phase = 'review';
    step -= 1;
    paint();
  }

  function beginLive() {
    if (live) return;
    const rows = chosenTiers();
    live = {
      videos: selectedItems().map((it) => ({
        name: names[it.abs] || stemOf(it.rel),
        rel: it.rel,
        state: 'pending',
        tiers: rows.map((t) => ({
          label: t.label,
          state: (it.height && t.height > it.height) ? 'skipped' : 'pending',
        })),
      })),
    };
    phase = 'running';
    paint();
  }

  function findVideo(fileName) {
    if (!live) return null;
    const stem = String(fileName).replace(/\.[^.]+$/, '');
    return live.videos.find((v) => v.name === fileName || v.name === stem || v.rel === fileName) || null;
  }

  // ponytail: run lines carry no video id. Tier lines attach to the video
  // named by the latest "Processing" line. Fine at one video at a time.
  let currentName = null;
  function onRunLine(text) {
    if (!live) beginLive();
    const t = stripTs(text);
    let m;
    if ((m = /\[INFO\] \[(\d+)\/(\d+)\] Processing: (.+?) \((\d+)x(\d+), audio=\w+, gop=(\d+)\)/.exec(t))) {
      currentName = m[3];
      const v = findVideo(m[3]);
      if (v && v.state === 'pending') v.state = 'encoding';
    } else if ((m = /\[START\] Encoding (\S+) with/.exec(t))) {
      const v = findVideo(currentName) || live.videos[live.videos.length - 1];
      const tier = v?.tiers.find((x) => x.label === m[1]);
      if (tier && tier.state !== 'skipped') tier.state = 'encoding';
    } else if ((m = /\[DONE\] (\S+?) -> /.exec(t))) {
      const v = findVideo(currentName) || live.videos[live.videos.length - 1];
      const tier = v?.tiers.find((x) => x.label === m[1]);
      if (tier) tier.state = 'done';
    } else if ((m = /\[SKIP\] (\S+?)(?: skipped| exists)/.exec(t))) {
      const v = findVideo(currentName) || live.videos[live.videos.length - 1];
      const tier = v?.tiers.find((x) => x.label === m[1]);
      if (tier) tier.state = 'skipped';
    } else if ((m = /\[ERROR\] (\S+?)(?: failed| produced)/.exec(t))) {
      const v = findVideo(currentName) || live.videos[live.videos.length - 1];
      const tier = v?.tiers.find((x) => x.label === m[1]);
      if (tier) tier.state = 'failed';
    } else if (/\[FATAL\]/.test(t)) {
      const v = findVideo(currentName);
      if (v) v.state = 'failed';
    } else if (/\[DONE\] \[\d+\/\d+\] HLS package:/.test(t)) {
      const v = findVideo(currentName);
      if (v) v.state = 'done';
    }
    if (step === 6 && phase === 'running') paintBody();
  }

  async function beginUpload() {
    phase = 'upload';
    uploads = new Map();
    uploadFinal = null;
    paint();
    const packages = selectedItems().map((it) => ({
      name: names[it.abs],
      path: joinPath(outputDir, names[it.abs]),
    }));
    try { await api.uploadPackages({ packages }); }
    catch (err) {
      uploadFinal = { ok: false, error: String(err?.message || err), final: true };
      phase = 'done';
      paint();
    }
  }

  function finishRun(r) {
    runReport = r || { ok: false, error: 'The conversion failed.' };
    const cancelled = !!r?.cancelled;
    const succeeded = r?.succeeded || 0;
    phase = 'done';
    paint();
    if (deliveryOn && !cancelled && succeeded > 0) beginUpload();
  }

  async function start() {
    if (state.busy || phase === 'running' || phase === 'upload') return;
    startError = '';
    phase = 'running';
    live = null;
    runReport = null;
    paint();
    if (deliveryOn) {
      const saved = await api.s3Save(deliveryPayload());
      if (!saved?.ok) {
        phase = 'review';
        startError = saved?.error || 'Could not save the delivery settings.';
        paint();
        return;
      }
    }
    const items = selectedItems().map((it) => ({ src: it.abs, name: names[it.abs] }));
    const staged = await api.stageJob({ items });
    if (!staged?.ok) {
      phase = 'review';
      startError = staged?.error || 'Could not prepare the videos.';
      paint();
      return;
    }
    stagingRoot = staged.input_root;
    let ack = null;
    try { ack = await api.launchRun(runOverrides(staged.input_root)); }
    catch (err) { ack = { ok: false, error: err?.message || String(err) }; }
    if (!ack || ack.ok === false) {
      try { await api.clearJob(stagingRoot); } catch { /* the engine also clears on a real run */ }
      stagingRoot = null;
      phase = 'review';
      startError = ack?.error || 'Could not start the conversion.';
      paint();
      return;
    }
    beginLive();
  }

  function copyCors(button) {
    const mark = (label) => {
      if (!button) return;
      button.textContent = label;
      window.setTimeout(() => { button.textContent = 'Copy CORS policy'; }, 1400);
    };
    navigator.clipboard.writeText(CORS_POLICY).then(() => mark('Copied')).catch(() => {
      const pre = body.querySelector('.wz-cors');
      if (!pre) return;
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      mark('Selected');
    });
  }

  async function applyCors() {
    deliveryBusy = true;
    applyBusy = true;
    deliveryMsg = '';
    paint();
    const saved = await api.s3Save(deliveryPayload());
    if (!saved?.ok) {
      deliveryBusy = false;
      applyBusy = false;
      deliveryMsg = saved?.error || 'Could not save those settings.';
      paint();
      return;
    }
    if (saved.profile) form.secret_set = !!saved.profile.secret_set;
    const res = await api.s3ApplyCors();
    deliveryBusy = false;
    applyBusy = false;
    deliveryMsg = res?.ok
      ? 'CORS updated. The previous rules on this bucket were replaced.'
      : (res?.error || 'Could not update CORS.');
    paint();
  }

  async function testDelivery() {
    deliveryBusy = true;
    deliveryMsg = '';
    deliveryOk = false;
    paint();
    const saved = await api.s3Save(deliveryPayload());
    if (!saved?.ok) {
      deliveryBusy = false;
      deliveryMsg = saved?.error || 'Could not save those settings.';
      paint();
      return;
    }
    if (saved.profile) form.secret_set = !!saved.profile.secret_set;
    const res = await api.s3Check();
    deliveryBusy = false;
    deliveryOk = !!res?.ok;
    deliverySig = formSignature();
    deliveryMsg = res?.ok ? 'Connection works.' : (res?.error || 'Could not reach the bucket.');
    paint();
  }

  function resetAnother() {
    step = 0;
    source = null;
    probe = null;
    selected = new Set();
    names = {};
    phase = 'review';
    live = null;
    runReport = null;
    uploads = new Map();
    uploadFinal = null;
    startError = '';
    stagingRoot = null;
    secretDraft = '';
    deliveryOk = false;
    paint();
  }

  const ac = new AbortController();
  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const goto = e.target.closest('[data-goto]');
    if (goto && !goto.disabled) {
      const n = Number(goto.dataset.goto);
      if (n < step && phase !== 'running' && phase !== 'upload') {
        if (phase === 'done') phase = 'review';
        step = n;
        paint();
      }
      return;
    }
    if (e.target.closest('#wz-next')) { goNext(); return; }
    if (e.target.closest('#wz-start')) { start(); return; }
    if (e.target.closest('#wz-cancel')) { api.cancelRun().catch(() => {}); return; }
    if (act === 'back') { goBack(); return; }
    if (act === 'another') { resetAnother(); return; }
    if (act === 'pick-dir' || act === 'pick-file') {
      const pick = act === 'pick-dir' ? api.pickDirectory(outputDir || boot.roots?.input || '') : api.pickFile(boot.roots?.input || '');
      pick.then((path) => {
        if (!path) return;
        source = { kind: act === 'pick-dir' ? 'dir' : 'file', path };
        probe = null;
        selected = new Set();
        names = {};
        paint();
      }).catch(() => {});
      return;
    }
    if (act === 'pick-out') {
      api.pickDirectory(outputDir || '').then((path) => {
        if (!path) return;
        outputDir = path;
        scheduleClash();
        paint();
      }).catch(() => {});
      return;
    }
    if (act === 'all') {
      selected = new Set(convertible().map((it) => it.abs));
      syncNames();
      paint();
      return;
    }
    if (act === 'none') {
      selected = new Set();
      syncNames();
      paint();
      return;
    }
    if (act === 'copy-cors') { copyCors(e.target.closest('[data-act="copy-cors"]')); return; }
    if (act === 'apply-cors') { applyCors(); return; }
    if (act === 'test-s3') { testDelivery(); return; }
    const tier = e.target.closest('[data-tier]');
    if (tier) {
      const label = tier.dataset.tier;
      if (tiers.has(label)) tiers.delete(label); else tiers.add(label);
      paint();
      return;
    }
    const hwBtn = e.target.closest('[data-hw]');
    if (hwBtn) {
      hw = hwBtn.dataset.hw;
      hwTouched = true;
      paint();
      return;
    }
    const provider = e.target.closest('[data-provider]');
    if (provider) {
      form.provider = provider.dataset.provider;
      if (form.provider === 'r2') form.region = 'auto';
      if (form.provider === 'aws' && (!form.region || form.region === 'auto')) form.region = 'us-east-1';
      deliveryOk = false;
      paint();
    }
  }, { signal: ac.signal });

  root.addEventListener('change', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      if (pick.checked) selected.add(pick.dataset.pick);
      else selected.delete(pick.dataset.pick);
      syncNames();
      paint();
      return;
    }
    if (e.target.matches('[data-act="delivery-toggle"]')) {
      deliveryOn = e.target.checked;
      deliveryOk = false;
      paint();
      return;
    }
    if (e.target.matches('[data-field="path_style"]')) {
      form.path_style = e.target.checked;
      deliveryOk = false;
      paintFoot();
    }
  }, { signal: ac.signal });

  root.addEventListener('input', (e) => {
    const nameInput = e.target.closest('[data-name]');
    if (nameInput) {
      names[nameInput.dataset.name] = nameInput.value;
      const vals = nameValues();
      for (const input of body.querySelectorAll('[data-name]')) {
        const err = body.querySelector(`[data-name-err="${CSS.escape(input.dataset.name)}"]`);
        if (err) err.textContent = nameProblem(names[input.dataset.name] ?? input.value, vals);
        input.style.width = `max(100%, ${Math.max(input.value.length + 4, 12)}ch)`;
        const row = input.closest('.wz-name');
        const preview = row?.querySelector('.wz-path');
        if (preview) preview.textContent = `${joinPath(outputDir || 'output', input.value || '…')}/master.m3u8`;
      }
      scheduleClash();
      paintFoot();
      return;
    }
    const fieldEl = e.target.closest('[data-field]');
    if (!fieldEl || fieldEl.dataset.field === 'path_style') return;
    if (fieldEl.dataset.field === 'secret') secretDraft = fieldEl.value;
    else form[fieldEl.dataset.field] = fieldEl.value;
    deliveryOk = false;
    paintFoot();
  }, { signal: ac.signal });

  subs.push(bus.on('line', (l) => {
    if (l.channel !== 'run') return;
    if (step !== 6) return;
    if (!live) beginLive();
    runStream.append(l.text);
    onRunLine(l.text);
  }));
  subs.push(bus.on('report:check', () => {
    checkPending = false;
    applyHwDefault();
    if (step === 4) paint();
  }));
  subs.push(bus.on('report:run.summary', (r) => {
    if (step !== 6) return;
    if (!live && phase === 'running') beginLive();
    finishRun(r);
  }));
  subs.push(bus.on('report:upload', (data) => {
    if (!data) return;
    if (data.final) {
      uploadFinal = data;
      phase = 'done';
      paint();
      return;
    }
    if (data.name) {
      const prev = uploads.get(data.name) || {};
      uploads.set(data.name, { ...prev, ...data });
    }
    if (step === 6) paintBody();
  }));
  subs.push(bus.on('state', () => {
    if (step === 6) paintFoot();
  }));

  paint();
  return () => {
    ac.abort();
    window.clearTimeout(clashTimer);
    subs.forEach((off) => off());
  };
}

export default { id: 'routes', title: 'Convert', render };
