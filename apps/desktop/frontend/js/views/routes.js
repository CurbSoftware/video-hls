// Control Room — views/routes.js
// EXIT 02 · ROUTES. The departure deck: survey the input queue, preview the
// ladder (dry run), dial per-run overrides, launch. Live tiers stream in as
// lanes; the summary card is the arrival notice.
//
// Data shapes are normalised to survive both backends: mock.js fixtures
// (inputs[].name, tiers without action, encoder in lastCheck) and the Qt
// bridge (videos[].rel, tiers[].action, encoder in the dryrun report).

import { api } from '../api.js';
import { state, bus } from '../shell.js';
import {
  chip, kv, card, btn, pageHeader, laneRow, emptyState, raw, esc, table,
} from '../components/ui.js';
import { meter, progressLane, logStream } from '../components/progress.js';
import * as edu from '../content.js';

// -- per-run knobs ------------------------------------------------------------

const KNOBS = [
  { name: 'VIDEO_CODEC', kind: 'seg', choices: ['h264', 'hevc', 'av1'] },
  { name: 'AUDIO_CODEC', kind: 'seg', choices: ['aac', 'opus'] },
  { name: 'QUALITY', kind: 'num', min: 0, max: 63, step: 1 },
  { name: 'HLS_TIME', kind: 'num', min: 1, max: 30, step: 1 },
  { name: 'HWACCEL', kind: 'seg', choices: ['auto', 'nvenc', 'qsv', 'vaapi', 'videotoolbox', 'none'] },
];
const KNOB_DEFAULTS = {
  VIDEO_CODEC: 'h264', AUDIO_CODEC: 'aac', QUALITY: '28', HLS_TIME: '6', HWACCEL: 'auto',
};
const CODEC_TIP = Object.fromEntries(edu.codecTradeoffs.map((c) => [c.codec, c.note]));
const ACCEL_TIP = Object.fromEntries(edu.accelKinds.map((a) => [a.kind, a.line]));
const TIP = {
  VIDEO_CODEC: edu.codecTradeoffs.map((c) => `${c.codec}: ${c.compatibility} · ${c.size}`).join(' — '),
  AUDIO_CODEC: 'aac plays everywhere · opus is better per bit but forces fMP4 segments',
  QUALITY: edu.qualityRanges.body,
  HLS_TIME: 'Segment length in seconds — also sets the keyframe interval (GOP = fps × HLS_TIME). 2–4 = faster startup, 6–10 = fewer files.',
  HWACCEL: 'auto probes nvenc → qsv → vaapi → videotoolbox and falls back to software · none forces CPU encoding',
};
function choiceTip(name, val) {
  if (name === 'VIDEO_CODEC') return CODEC_TIP[val] || TIP.VIDEO_CODEC;
  if (name === 'HWACCEL') return ACCEL_TIP[val] || TIP.HWACCEL;
  if (name === 'AUDIO_CODEC') {
    return val === 'opus' ? edu.segmentTypes.body : 'aac plays everywhere; keeps MPEG-TS segments';
  }
  return TIP[name];
}

// -- formatting ----------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');
const stripTs = (t) => String(t).replace(/^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\]\s*/, '');
const fmtSize = (it) => {
  const mb = it.size_mb ?? (it.size_bytes != null ? it.size_bytes / 1048576 : null);
  if (mb == null) return '—';
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
};
const fmtDur = (d) => {
  if (d == null) return '—';
  const s = Math.round(d);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export async function render(root) {
  const subs = [];
  const boot = state.bootstrap;
  const inputRoot = boot?.roots?.input || boot?.paths?.input_root || 'video/';
  const hlsRoot = boot?.roots?.hls || boot?.paths?.hls_root || '';
  // engine logs print paths relative to the repo root; hls root is <root>/hls
  const engineRoot = hlsRoot ? hlsRoot.replace(/\/hls\/?$/, '') : '';
  const resolvePath = (p) => (!p || p.startsWith('/')) ? (p || '') : (engineRoot ? `${engineRoot}/${p}` : p);

  let inputs = [];
  let plan = null;       // normalised dry-run report
  let live = null;       // live run model: { videos: [...], cur }
  const dryFacts = { gop: null, segment: null }; // enriched from dry-run lines
  const engineVals = {}; // effective values from the engine's settings
  const ovr = {};        // knob values (start at engine values, diverge on edit)

  // -- skeleton -----------------------------------------------------------------

  root.innerHTML = `
    ${pageHeader({
      exit: '02 — ROUTES', title: 'Departures', coords: '44.06°N 121.31°W',
      lede: 'Queue sources, preview the ladder, launch a route. The pipeline encodes every tier, packages HLS, and archives on success.',
    })}

    <section class="section">
      <div class="section-head">
        <span class="section-num" aria-hidden="true">01</span><h2>Queue</h2>
        <span class="micro" id="rt-q-count"></span>
      </div>
      <div class="status-moment">
        <span class="ffmpeg-line">${esc(inputRoot)}</span>
        <span class="grow"></span>
        ${btn({ label: 'Open folder', kind: 'ghost', icon: '▸', tip: 'Open INPUT_ROOT in the file manager', attrs: `data-open="${esc(inputRoot)}"` })}
      </div>
      <div id="rt-queue"></div>
    </section>

    <section class="section">
      <div class="section-head">
        <span class="section-num" aria-hidden="true">02</span><h2>Flight plan</h2>
        <span class="micro" id="rt-plan-meta">NO PLAN ON FILE</span>
      </div>
      <div class="status-moment">
        <span class="ffmpeg-line" id="rt-plan-facts">run.sh --dry-run plans every tier without encoding a frame</span>
        <span class="grow"></span>
        ${btn({ label: 'Preview route', kind: 'ghost', id: 'rt-preview', icon: '▸', tip: 'run.sh --dry-run — plan every tier, encode nothing' })}
      </div>
      <div id="rt-dry-log" hidden style="margin-bottom:var(--s-5)"></div>
      <div id="rt-plan-cards" class="card-grid"></div>
    </section>

    <section class="section">
      <div class="section-head">
        <span class="section-num" aria-hidden="true">03</span><h2>Overrides</h2>
        <span class="micro">THIS RUN ONLY · .ENV UNTOUCHED · PASSED AS {VAR: VALUE}</span>
      </div>
      <div class="card" id="rt-knobs" style="padding:var(--s-5) var(--s-6)"></div>
    </section>

    <section class="section">
      <div class="section-head">
        <span class="section-num" aria-hidden="true">04</span><h2>Launch</h2>
        <span class="micro" id="rt-live-meta">STANDING BY</span>
      </div>
      <div class="status-moment">
        <span id="rt-launch-chip"></span>
        <span class="ffmpeg-line" id="rt-launch-note">Every tier encodes, packages to HLS, archives on success.</span>
        <span class="grow"></span>
        <span id="rt-cancel"></span>
        ${btn({ label: 'Launch route', kind: 'primary', id: 'rt-launch', icon: '▸', tip: 'Encode every tier, package HLS, archive sources', attrs: 'style="padding:.8rem 1.5rem;font-size:12px"' })}
      </div>
      <div id="rt-summary" style="margin-top:var(--s-5)"></div>
      <div id="rt-live" hidden style="margin-top:var(--s-5)">
        <div class="card-grid" id="rt-videos"></div>
        <div id="rt-run-log" style="margin-top:var(--s-5)"></div>
      </div>
    </section>
  `;

  const $ = (sel) => root.querySelector(sel);
  const qEl = $('#rt-queue'), qCount = $('#rt-q-count');
  const planMeta = $('#rt-plan-meta'), planFacts = $('#rt-plan-facts'), planCards = $('#rt-plan-cards');
  const dryWrap = $('#rt-dry-log');
  const dryStream = logStream(dryWrap, {});
  const previewBtn = $('#rt-preview');
  const knobsEl = $('#rt-knobs');
  const launchBtn = $('#rt-launch'), launchChip = $('#rt-launch-chip'), launchNote = $('#rt-launch-note');
  const cancelWrap = $('#rt-cancel');
  const liveWrap = $('#rt-live'), videosEl = $('#rt-videos'), liveMeta = $('#rt-live-meta');
  const runStream = logStream($('#rt-run-log'), {});
  const summaryEl = $('#rt-summary');

  // -- section 01 · queue ---------------------------------------------------------

  async function loadQueue() {
    try { inputs = await api.listInputs() || []; } catch { inputs = []; }
    renderQueue();
  }

  function renderQueue() {
    qCount.textContent = inputs.length
      ? `${inputs.length} SOURCE${inputs.length === 1 ? '' : 'S'} QUEUED` : 'EMPTY';
    if (!inputs.length) {
      qEl.innerHTML = emptyState({
        code: '02',
        headline: 'No routes queued',
        guidance: 'DROP SOURCES INTO THE INPUT FOLDER AND THEY’LL APPEAR HERE',
        action: raw(btn({ label: 'Open input folder', kind: 'ghost', icon: '▸', attrs: `data-open="${esc(inputRoot)}"` })),
      });
      return;
    }
    qEl.innerHTML = table(
      ['source', 'size', 'resolution', 'fps', 'audio', 'duration'],
      inputs.map((it) => {
        const name = it.name || it.rel || it.abs || '—';
        const src = `<span class="mono">${esc(name)}</span>` +
          (it.error ? ` ${chip('warn', 'PROBE FAILED')} <span class="micro">${esc(it.error)}</span>` : '');
        return [
          raw(src),
          raw(`<span class="mono">${esc(fmtSize(it))}</span>`),
          it.width ? raw(`<span class="mono">${it.width}×${it.height}</span>`) : '—',
          it.fps != null ? raw(`<span class="mono">${Math.round(it.fps)}</span>`) : '—',
          it.has_audio == null ? '—' : raw(it.has_audio ? chip('ok', 'AUDIO') : chip('idle', 'MUTE')),
          raw(`<span class="mono">${esc(fmtDur(it.duration_s))}</span>`),
        ];
      }));
  }

  // -- section 02 · flight plan -----------------------------------------------------

  function normalizePlan(r) {
    const cfg = state.lastCheck?.active || state.lastCheck?.config || {};
    const vids = (r.videos || r.inputs || []).map((v, i) => {
      const sh = v.source_height ?? v.height ?? 0;
      const tiers = (v.tiers || []).map((t) => ({
        label: t.label,
        height: t.height ?? (Number(String(t.label || '').replace(/\D/g, '')) || 0),
        action: t.action || ((sh > 0 && (t.height ?? 0) <= sh) ? 'encode' : 'skip'),
        video_bitrate: t.video_bitrate || null,
      }));
      return {
        name: v.rel || v.name || `video ${i + 1}`, source_height: sh,
        width: v.width ?? null, fps: v.fps ?? null, tiers,
      };
    });
    return {
      videos: vids, total: vids.length,
      encoder: r.encoder || cfg.video_encoder || cfg.resolved_video_encoder || '—',
      audio: r.audio_encoder || cfg.audio_encoder || '—',
      segment_type: r.segment_type || cfg.segment_type || 'auto',
      gop: r.gop ?? dryFacts.gop,
      segment_duration: r.segment_duration ?? dryFacts.segment,
      output_root: r.output_root || hlsRoot || '—',
      labels: r.ladder_labels || [...new Set(vids.flatMap((v) => v.tiers.map((t) => t.label)))],
    };
  }

  function factsHtml(p) {
    const fmp4 = /fmp4/i.test(p.segment_type);
    const segTip = `${edu.segmentTypes.headline} — ${edu.segmentTypes.body}`;
    const dot = ' <span class="dim">·</span> ';
    return `<span class="mono amber-text">${esc(p.encoder)}</span>${dot}` +
      `<span class="mono">${esc(p.audio)}</span>${dot}` +
      `<span data-tip="${esc(segTip)}">${chip('ok', fmp4 ? 'FMP4 SEGMENTS' : 'MPEG-TS')}</span>${dot}` +
      (p.gop != null ? `<span class="mono">GOP ${p.gop}</span>${dot}` : '') +
      `<span class="mono">LADDER ${esc(p.labels.join('/'))}</span>${dot}` +
      `<span class="mono">${esc(p.output_root)}</span>`;
  }

  function applyPlan(r) {
    plan = normalizePlan(r);
    dryWrap.hidden = true;
    const enc = plan.videos.reduce((n, v) => n + v.tiers.filter((t) => t.action === 'encode').length, 0);
    planMeta.textContent = `PLAN ON FILE · ${plan.total} VIDEO${plan.total === 1 ? '' : 'S'} · ${enc} TIERS TO ENCODE`;
    planFacts.innerHTML = factsHtml(plan);
    planCards.innerHTML = plan.videos.map((v, i) => card({
      num: pad2(i + 1),
      title: v.name,
      eyebrow: `SOURCE HEIGHT ${v.source_height}${v.width ? ` · ${v.width}×${v.source_height}` : ''}${v.fps ? ` · ${v.fps} FPS` : ''}`,
      children: `<div class="lane-list">${v.tiers.map((t) => (
        t.action === 'encode'
          ? laneRow({
            label: t.label, status: 'ok',
            detail: `-> ${t.label}/index.m3u8${t.video_bitrate ? ` · ${t.video_bitrate}` : ''}`,
          })
          : laneRow({ label: t.label, status: 'idle', detail: `SKIP — WOULD UPSCALE FROM ${v.source_height}P` })
      )).join('')}</div>`,
    })).join('');
  }

  function dryFail(msg) {
    planMeta.textContent = 'SURVEY FAILED';
    dryWrap.hidden = false;
    dryStream.append(`[ERROR] ${msg}`);
  }

  previewBtn.addEventListener('click', async () => {
    if (previewBtn.getAttribute('aria-disabled') === 'true' || state.busy) return;
    const o = buildOverrides();
    previewBtn.setAttribute('aria-disabled', 'true');
    planMeta.textContent = 'SURVEYING — RUN.SH --DRY-RUN';
    dryWrap.hidden = false;
    dryStream.clear();
    try {
      const res = await api.dryRun(Object.keys(o).length ? o : null);
      if (res && (res.videos || res.inputs)) applyPlan(res); // mock returns it; Qt reports via signal
    } catch (err) {
      dryFail(err?.message || String(err));
    } finally {
      previewBtn.setAttribute('aria-disabled', 'false');
    }
  });

  // -- section 03 · overrides ------------------------------------------------------

  const hintHtml = (name) => {
    const cur = String(ovr[name] ?? '');
    const base = String(engineVals[name] ?? KNOB_DEFAULTS[name]);
    return cur !== base
      ? chip('warn', 'OVERRIDE')
      : `<span class="micro" style="color:var(--ink-4)">ENV ${esc(base || '—')}</span>`;
  };

  function knobRowHtml(k) {
    const cur = String(ovr[k.name] ?? '');
    const base = String(engineVals[k.name] ?? KNOB_DEFAULTS[k.name]);
    const dirty = cur !== base;
    const label = `<label class="micro" ${k.kind === 'num' ? `for="rt-k-${esc(k.name)}"` : ''} data-tip="${esc(TIP[k.name])}"` +
      ` style="flex:none;width:9.5rem;color:var(--ink-3)">${esc(k.name)}<span data-dirty>${dirty ? ' *' : ''}</span></label>`;
    let control;
    if (k.kind === 'seg') {
      control = `<span role="group" aria-label="${esc(k.name)}" style="display:inline-flex;flex-wrap:wrap;gap:0.35rem">` +
        k.choices.map((c) => `<button type="button" class="tchip" data-knob="${esc(k.name)}" data-val="${esc(c)}"` +
          ` aria-pressed="${c === cur}" data-tip="${esc(choiceTip(k.name, c))}">${esc(c)}</button>`).join('') +
        '</span>';
    } else {
      control = `<input id="rt-k-${esc(k.name)}" class="finput" type="number" inputmode="numeric" min="${k.min}"` +
        ` max="${k.max}" step="${k.step}" value="${esc(cur)}" data-knob="${esc(k.name)}" data-tip="${esc(TIP[k.name])}" style="width:7.5rem">`;
    }
    return `<div data-row="${esc(k.name)}" style="display:flex;flex-wrap:wrap;align-items:center;gap:var(--s-3) var(--s-5);padding:0.65rem 0;border-bottom:1px dashed var(--hairline)">` +
      `${label}${control}<span style="flex:1"></span><span data-hint>${hintHtml(k.name)}</span></div>`;
  }

  const gopPanelHtml = () => `
    <div style="margin:var(--s-4) 0;padding:var(--s-4) var(--s-5);border:1px dashed var(--hairline-strong)">
      <span class="micro" style="color:var(--amber)">${esc(edu.gopCoupling.headline)}</span>
      <p class="dim" style="margin-top:var(--s-2);max-width:72ch;font-size:var(--text-sm);line-height:var(--leading-relaxed)">${esc(edu.gopCoupling.body)}</p>
    </div>`;

  function renderKnobs() {
    // the GOP explainer sits directly under the HLS_TIME knob it describes
    knobsEl.innerHTML =
      KNOBS.slice(0, 4).map(knobRowHtml).join('') + gopPanelHtml() + KNOBS.slice(4).map(knobRowHtml).join('');
  }

  function updateRow(name) {
    const row = knobsEl.querySelector(`[data-row="${name}"]`);
    if (!row) return;
    const cur = String(ovr[name] ?? '');
    for (const c of row.querySelectorAll('.tchip')) c.setAttribute('aria-pressed', String(c.dataset.val === cur));
    row.querySelector('[data-dirty]').textContent = cur !== String(engineVals[name] ?? KNOB_DEFAULTS[name]) ? ' *' : '';
    row.querySelector('[data-hint]').innerHTML = hintHtml(name);
  }

  knobsEl.addEventListener('click', (e) => {
    const c = e.target.closest('.tchip[data-knob]');
    if (!c) return;
    ovr[c.dataset.knob] = c.dataset.val;
    updateRow(c.dataset.knob);
  });
  knobsEl.addEventListener('input', (e) => {
    const inp = e.target.closest('input[data-knob]');
    if (!inp) return;
    ovr[inp.dataset.knob] = inp.value;
    updateRow(inp.dataset.knob);
  });

  async function loadEngineValues() {
    try {
      const res = await api.settingsGet();
      const fields = Array.isArray(res)
        ? res.filter((f) => f.engine === 'runsh')
        : [
          ...(res.specs?.runsh || []),
          ...Object.entries(res.values?.runsh || {}).map(([name, current]) => ({ name, current })),
        ];
      for (const k of KNOBS) {
        const f = fields.find((x) => x.name === k.name);
        engineVals[k.name] = String(f?.current ?? f?.default ?? KNOB_DEFAULTS[k.name]);
      }
    } catch {
      for (const k of KNOBS) engineVals[k.name] ??= KNOB_DEFAULTS[k.name];
    }
    for (const k of KNOBS) ovr[k.name] = engineVals[k.name] ?? KNOB_DEFAULTS[k.name];
    renderKnobs();
  }

  function buildOverrides() {
    const o = {};
    for (const k of KNOBS) {
      const cur = String(ovr[k.name] ?? '');
      if (cur !== '' && cur !== String(engineVals[k.name] ?? KNOB_DEFAULTS[k.name])) o[k.name] = cur;
    }
    return o;
  }

  // -- section 04 · launch + live run -------------------------------------------------

  function launchError(msg) {
    const m = String(msg || 'unknown').slice(0, 90);
    launchChip.innerHTML = chip(/busy/i.test(m) ? 'warn' : 'err', `LAUNCH REFUSED — ${m}`);
  }

  launchBtn.addEventListener('click', async () => {
    if (state.busy) return;
    launchChip.innerHTML = '';
    const o = buildOverrides();
    let ack = null;
    try { ack = await api.launchRun(Object.keys(o).length ? o : null); }
    catch (err) { ack = { ok: false, error: err?.message || String(err) }; }
    if (!ack || ack.ok === false) { launchError(ack?.error || 'launch refused'); return; }
    beginLive();
  });

  function beginLive() {
    summaryEl.innerHTML = '';
    live = {
      cur: -1,
      videos: plan ? plan.videos.map((v) => ({
        name: v.name, idx: null, total: plan.total, w: v.width, h: v.source_height,
        gop: plan.gop, state: 'pending', output: '', archived: '',
        tiers: v.tiers.map((t) => ({ label: t.label, state: t.action === 'skip' ? 'skipped' : 'pending' })),
      })) : [],
    };
    liveWrap.hidden = false;
    runStream.clear();
    liveMeta.textContent = 'ROUTE IN PROGRESS';
    renderLive();
    renderBusyBars(); // the busy state arrived before this ack — re-word the bar
  }

  const curVideo = () => live.videos[live.cur] || live.videos[live.videos.length - 1] || null;

  function ensureVideo(name, info = {}) {
    let v = live.videos.find((x) => x.name === name);
    if (!v) {
      v = { name, idx: null, total: null, w: null, h: null, gop: null, state: 'encoding', output: '', archived: '', tiers: [] };
      live.videos.push(v);
    }
    if (v.state === 'pending') v.state = 'encoding';
    Object.assign(v, info);
    live.cur = live.videos.indexOf(v);
    return v;
  }

  function ensureTier(label, st) {
    const v = curVideo();
    if (!v) return;
    let t = v.tiers.find((x) => x.label === label);
    if (!t) { t = { label, state: st }; v.tiers.push(t); }
    else if (t.state === 'pending' || st === 'failed') t.state = st;
  }

  // ponytail: run lines carry no video id — tier lines attach to the most
  // recently announced video. Fine at PARALLEL_VIDEOS=1; revisit if the
  // engine ever interleaves per-video output.
  function onRunLine(text) {
    const t = stripTs(text);
    let m;
    if ((m = /\[INFO\] \[(\d+)\/(\d+)\] Processing: (.+?) \((\d+)x(\d+), audio=\w+, gop=(\d+)\)/.exec(t))) {
      ensureVideo(m[3], { idx: +m[1], total: +m[2], w: +m[4], h: +m[5], gop: +m[6] });
    } else if ((m = /\[START\] Encoding (\S+) with/.exec(t))) {
      ensureTier(m[1], 'encoding');
    } else if ((m = /\[DONE\] (\S+?) -> (.+)/.exec(t))) {
      const v = curVideo();
      const tier = v?.tiers.find((x) => x.label === m[1]);
      if (tier) tier.state = 'done';
    } else if ((m = /\[SKIP\] (\S+?)(?: skipped| exists)/.exec(t))) {
      ensureTier(m[1], 'skipped');
    } else if ((m = /\[ERROR\] (\S+?)(?: failed| produced)/.exec(t))) {
      const v = curVideo();
      const tier = v?.tiers.find((x) => x.label === m[1]);
      if (tier) tier.state = 'failed';
    } else if ((m = /\[FATAL\]/.exec(t))) {
      const v = curVideo();
      if (v) v.state = 'failed';
    } else if ((m = /\[DONE\] \[(\d+)\/(\d+)\] HLS package: (.+)/.exec(t))) {
      const v = curVideo();
      if (v) { v.output = m[3]; v.state = 'done'; }
    } else if ((m = /\[DONE\] \[\d+\/\d+\] Source archived: (.+)/.exec(t))) {
      const v = curVideo();
      if (v) v.archived = m[1];
    }
    renderLive();
  }

  function tierPlane(t) {
    const pct = t.state === 'done' ? 100 : t.state === 'encoding' ? 45 : 0;
    const status = {
      done: 'DONE', encoding: 'ENCODING', skipped: 'SKIPPED', failed: 'FAILED', pending: 'QUEUED',
    }[t.state] || '';
    return `<div class="tp tp-${t.state}" style="${t.state === 'skipped' ? 'opacity:.45;' : ''}margin-bottom:var(--s-3)">` +
      `${progressLane({ label: t.label, pct, status })}</div>`;
  }

  function renderLive() {
    if (!live) return;
    videosEl.innerHTML = live.videos.map((v, i) => {
      // no bridge progress signal — read the lanes: done tiers count whole,
      // in-flight ones half, so the meter moves while encoders run
      const units = v.tiers.reduce((n, t) => n + (t.state === 'done' || t.state === 'skipped' ? 1
        : t.state === 'encoding' ? 0.5 : 0), 0);
      const frac = v.tiers.length ? Math.round((units / v.tiers.length) * 100) : 0;
      const pct = v.state === 'done' ? 100 : frac;
      const eyebrow = [
        v.w && v.h ? `SOURCE ${v.w}×${v.h}` : '',
        v.gop ? `GOP ${v.gop}` : '',
      ].filter(Boolean).join(' · ') || 'ENCODING';
      const right = (v.idx ? `<span class="micro">[${v.idx}/${v.total}]</span> ` : '') +
        (v.state === 'done' ? chip('ok', 'ARRIVED') : v.state === 'failed' ? chip('err', 'FAILED') : '');
      const tiers = v.tiers.length
        ? v.tiers.map(tierPlane).join('')
        : laneRow({ label: 'awaiting tier output', status: 'idle' });
      const meterRow = `<div style="display:flex;align-items:center;gap:var(--s-3);margin-top:var(--s-2)">` +
        `<span class="micro">ROUTE</span><span style="flex:1">${meter(pct)}</span>` +
        `<span class="micro" style="color:var(--amber)">${pct}%</span></div>`;
      return card({ num: pad2(i + 1), title: v.name, eyebrow, right: raw(right), children: tiers + meterRow });
    }).join('');
    // states the shared component cannot express inline: green dones, red
    // failures, amber pulse while encoding
    for (const el of videosEl.querySelectorAll('.tp-done .plane-track > i')) el.style.background = 'var(--success)';
    for (const el of videosEl.querySelectorAll('.tp-done .plane-pct')) el.style.color = 'var(--success)';
    for (const el of videosEl.querySelectorAll('.tp-done .plane-label')) el.style.color = 'var(--ink-2)';
    for (const el of videosEl.querySelectorAll('.tp-failed .plane-track > i')) el.style.background = 'var(--danger)';
    for (const el of videosEl.querySelectorAll('.tp-failed .plane-pct')) el.style.color = 'var(--danger)';
    for (const el of videosEl.querySelectorAll('.tp-encoding .plane-label')) el.style.color = 'var(--amber-2)';
    for (const el of videosEl.querySelectorAll('.tp-encoding .plane-pct')) {
      el.style.color = 'var(--amber)';
      el.style.animation = 'banner-pulse 1.15s var(--ease-standard) infinite';
    }
  }

  function finishRun(r) {
    const doneN = live ? live.videos.filter((v) => v.state === 'done').length : 0;
    const succeeded = r.succeeded ?? (Array.isArray(r.inputs) ? r.inputs.filter((x) => x.ok).length : doneN);
    const failed = r.failed ?? 0;
    const cancelled = !!r.cancelled;
    const out = r.inputs?.find((x) => x.output)?.output || live?.videos.find((v) => v.output)?.output || '';
    const arch = live?.videos.find((v) => v.archived)?.archived || '';
    const dur = r.duration_s ?? (r.started_at && r.finished_at
      ? (new Date(r.finished_at) - new Date(r.started_at)) / 1000 : null);
    const all = !cancelled && failed === 0 && succeeded > 0;
    const title = cancelled ? 'Run cancelled'
      : all ? `Done — ${succeeded} succeeded, ${failed} failed`
        : failed > 0 ? `Departure incomplete — ${succeeded} succeeded, ${failed} failed`
          : 'Nothing departed — the queue was empty';
    const retry = edu.troubleshooting.find((x) => x.symptom === 'A video failed');

    summaryEl.innerHTML = card({
      num: all ? '✓' : '!',
      title,
      eyebrow: `ENGINE RUN.SH${dur != null ? ` · ${dur.toFixed(1)}S` : ''}`,
      children: `
        <div style="display:flex;flex-wrap:wrap;gap:var(--s-3)">
          ${chip(all ? 'ok' : 'warn', `${succeeded} SUCCEEDED`)}
          ${failed > 0 ? chip('err', `${failed} FAILED`) : ''}
          ${cancelled ? chip('warn', 'CANCELLED') : ''}
        </div>
        ${kv([
          ['HLS OUTPUT', out
            ? raw(`<span class="mono">${esc(out)}</span> ` +
              btn({ label: 'Open folder', kind: 'ghost', attrs: `data-open="${esc(resolvePath(out.replace(/\/[^/]*$/, '')))}"` }) + ' ' +
              btn({ label: 'Play', kind: 'ghost', tip: 'Open master.m3u8 in mpv or vlc', attrs: `data-play="${esc(resolvePath(out))}"` }))
            : raw('<span class="dim">no package written</span>')],
          ['ARCHIVED', arch
            ? raw(`<span class="mono">${esc(arch)}</span> ` +
              btn({ label: 'Reveal', kind: 'ghost', attrs: `data-reveal="${esc(resolvePath(arch))}"` }))
            : raw('<span class="dim">sources stay in INPUT_ROOT until they succeed</span>')],
        ])}
        ${failed > 0 || cancelled ? `
          <div style="margin-top:var(--s-4);padding:var(--s-3) var(--s-5);border:1px solid var(--amber-a24);background:var(--amber-a04)">
            <span class="micro" style="color:var(--amber)">SOURCES REMAIN FOR RETRY</span>
            <p class="dim" style="margin-top:var(--s-2);font-size:var(--text-sm);line-height:var(--leading-relaxed);max-width:72ch">${esc(retry?.fix || '')}</p>
          </div>` : ''}
      `,
    });
    liveMeta.textContent = 'RUN COMPLETE';
    loadQueue(); // sources archived away — the deck changed
  }

  function renderBusyBars() {
    const busy = state.busy;
    launchBtn.disabled = busy;
    previewBtn.setAttribute('aria-disabled', busy ? 'true' : 'false');
    cancelWrap.innerHTML = busy ? btn({ label: 'Cancel run', kind: 'danger', icon: '■', tip: 'SIGTERM, then SIGKILL' }) : '';
    launchNote.textContent = live && busy ? 'Route in progress — output streams below.'
      : busy ? `Engine busy — ${state.kind === 'batch' ? 'batch in progress' : 'probing or a route in progress'}.`
        : 'Every tier encodes, packages to HLS, archives on success.';
  }

  // -- delegated actions (openers live throughout the view) ---------------------------

  const ac = new AbortController();
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-open]');
    if (el?.dataset.open) { api.openPath(el.dataset.open).catch(() => {}); return; }
    const rv = e.target.closest('[data-reveal]');
    if (rv?.dataset.reveal) { api.revealFile(rv.dataset.reveal).catch(() => {}); return; }
    const pl = e.target.closest('[data-play]');
    if (pl?.dataset.play) { api.openInPlayer(pl.dataset.play).catch(() => {}); return; }
    if (e.target.closest('#rt-cancel .btn')) api.cancelRun().catch(() => {});
  }, { signal: ac.signal });

  // -- live wiring ---------------------------------------------------------------------

  subs.push(bus.on('line', (l) => {
    if (l.channel === 'dryrun') {
      dryWrap.hidden = false;
      dryStream.append(l.text);
      // the report carries no GOP; the dry-run stream does ("gop=150 - segment 6s")
      const g = /gop=(\d+)/.exec(l.text);
      if (g) dryFacts.gop = +g[1];
      const s = /segment (\d+(?:\.\d+)?)s/.exec(l.text);
      if (s) dryFacts.segment = +s[1];
    } else if (l.channel === 'run') {
      if (!live) beginLive(); // opened mid-route: first output line opens the deck
      runStream.append(l.text);
      onRunLine(l.text);
    }
  }));
  subs.push(bus.on('report:dryrun', (r) => {
    if (!r || r.error) { dryFail(r?.error || 'dry run failed'); return; }
    applyPlan(r);
  }));
  subs.push(bus.on('report:run.summary', (r) => {
    if (!r) { launchError('run failed'); return; }
    if (r.ok === false && !r.cancelled) { launchError(r.error || 'run failed'); return; }
    finishRun(r);
  }));
  subs.push(bus.on('state', renderBusyBars));

  // -- boot ------------------------------------------------------------------------------

  renderKnobs();       // defaults paint instantly; engine values refine them
  renderQueue();
  renderBusyBars();
  loadEngineValues();
  loadQueue();
  planCards.innerHTML = laneRow({
    label: 'no plan on file — preview to survey',
    status: 'idle',
    detail: 'EVERY TIER · GOP · SEGMENT TYPE — NOTHING ENCODED',
  });

  return () => { ac.abort(); subs.forEach((off) => off()); };
}
