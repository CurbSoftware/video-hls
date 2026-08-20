// Control Room — views/dashboard.js
// EXIT 01 · SYSTEMS. The machine, probed honestly. Renders what bootstrap
// knows instantly; RUN SYSTEMS CHECK streams the probe and renders the report.
// Payload shapes: BRIDGE.md (getBootstrap, reportReady "check").

import { api } from '../api.js';
import { state, bus } from '../shell.js';
import {
  chip, kv, card, btn, pageHeader, laneRow, emptyState, raw, esc,
} from '../components/ui.js';
import { meter, logStream } from '../components/progress.js';
import * as edu from '../content.js';

// run.sh status strings -> lane states
const ENC_LANE = { 'USABLE': 'ok', 'built, not usable here': 'warn', 'not built': 'idle' };

export async function render(root) {
  const subs = [];
  let boot = state.bootstrap;
  try { boot = boot ?? await api.getBootstrap(); } catch { /* engine gone — handled below */ }
  boot = boot && !boot.error ? boot : null;

  let report = state.lastCheck; // null until a check report arrives

  root.innerHTML = `
    ${pageHeader({ exit: '01', title: 'Systems check', lede: edu.copy.checkLede, coords: '44.06°N 121.31°W' })}
    ${!boot || !boot.engine?.root ? engineMissingPanel() : `
    <div class="status-moment">
      <span id="dash-chip"></span>
      <span class="ffmpeg-line" id="dash-ffmpeg"></span>
      <span class="grow"></span>
      ${btn({ label: 'Run systems check', kind: 'primary', id: 'dash-check', icon: '▸', tip: 'Encode five frames per candidate encoder', attrs: 'data-tip-end' })}
    </div>
    <div class="card-grid" id="dash-cards"></div>
    <section class="section" id="dash-log-section" hidden>
      <div class="section-head">
        <span class="section-num" aria-hidden="true">07</span>
        <h2>Probe output</h2>
        <span class="micro" id="dash-log-meta">CHECK RUNNING</span>
      </div>
      <div id="dash-log"></div>
    </section>`}
  `;

  if (!boot || !boot.engine?.root) {
    root.querySelector('[data-goto="settings"]')?.addEventListener('click', () => {
      location.hash = '#/settings';
    });
    return;
  }

  const cardsEl = root.querySelector('#dash-cards');
  const chipEl = root.querySelector('#dash-chip');
  const ffmpegEl = root.querySelector('#dash-ffmpeg');
  const checkBtn = root.querySelector('#dash-check');
  const logSection = root.querySelector('#dash-log-section');
  const logMeta = root.querySelector('#dash-log-meta');
  const stream = logStream(root.querySelector('#dash-log'));

  // -- status moment ---------------------------------------------------------

  function renderStatus() {
    const missing = state.toolsMissing;
    if (state.lastCheck) {
      chipEl.innerHTML = state.lastCheck.ok
        ? chip('ok', 'SYSTEMS ONLINE', { lg: true })
        : chip('err', 'PROBLEMS FOUND', { lg: true });
      ffmpegEl.textContent = state.lastCheck.ffmpeg_version || '';
    } else if (missing.length) {
      chipEl.innerHTML = chip('err', 'TOOLS MISSING', { lg: true });
      ffmpegEl.textContent = `not on PATH: ${missing.join(' · ')}`;
    } else {
      chipEl.innerHTML = chip('idle', 'SYSTEMS UNCHECKED', { lg: true });
      ffmpegEl.textContent = 'no probe on record — run the check';
    }
    renderBusy();
  }

  function renderBusy() {
    const busy = state.busy;
    checkBtn.setAttribute('aria-disabled', busy ? 'true' : 'false');
    checkBtn.dataset.tip = busy
      ? (state.kind === 'batch' ? 'Engine busy — batch in progress' : 'Engine busy — probing or a route is in progress')
      : 'Encode five frames per candidate encoder';
  }

  // -- cards -------------------------------------------------------------------

  function pendingCard(num, title, eyebrow) {
    return card({
      num, title, eyebrow: 'RUN THE CHECK TO SURVEY THIS MACHINE',
      children: '<p class="dim" style="font-size:var(--text-sm)">The probe encodes five real frames per candidate encoder — it reports what works, not what ffmpeg advertises.</p>',
    });
  }

  function toolsFromBootstrap() {
    const tools = boot.tools || {};
    return Object.entries(tools).map(([name, path]) => laneRow({
      label: name,
      status: path ? 'ok' : 'err',
      detail: path || 'MISSING — install and re-run',
    })).join('');
  }

  function renderCards() {
    // Paths + disk come from bootstrap (always fresh); the rest from the report.
    const roots = boot.roots || {};
    const disk = (key) => (boot.disk || {})[key];

    const pathRows = [
      ['INPUT', roots.input, disk('input')],
      ['OUTPUT', roots.hls, disk('hls')],
      ['WORK', roots.work, disk('work')],
      ['ARCHIVE', roots.processed, disk('processed')],
    ].map(([label, path, d]) => {
      const pct = d && d.total_gb ? Math.round((d.used_gb / d.total_gb) * 100) : 0;
      return `
        <div class="diskrow">
          <span class="dk-label">${esc(label)}</span>
          ${meter(pct)}
          <span class="dk-free">${d && d.total_gb ? `${d.free_gb.toFixed(0)} GB FREE / ${d.total_gb} GB` : 'UNKNOWN'}</span>
          <span class="dk-path">${esc(path || '—')}</span>
        </div>`;
    }).join('');

    if (!report) {
      cardsEl.innerHTML = [
        card({ num: '01', title: 'Required commands', eyebrow: 'FFMPEG · FFPROBE · PYTHON3', children: `<div class="lane-list">${toolsFromBootstrap()}</div>` }),
        pendingCard('02', 'Hardware', 'ACCELERATORS PRESENT'),
        pendingCard('03', 'Video encoders', 'COMPILED IN / ACTUALLY USABLE'),
        pendingCard('04', 'Audio encoders', 'AAC · LIBOPUS'),
        pendingCard('05', 'Active configuration', 'WHAT THE NEXT RUN WILL USE'),
        card({ num: '06', title: 'Paths', eyebrow: 'THE FOUR ROOTS', children: pathRows }),
      ].join('');
      return;
    }

    const toolLanes = (report.commands || []).map((c) => laneRow({
      label: c.name,
      status: c.ok ? 'ok' : 'err',
      detail: c.ok ? (c.path || 'OK') : 'MISSING — install and re-run',
    })).join('');

    const hwLanes = (report.hardware || []).map(([name, val]) => laneRow({
      label: name,
      status: /^not/i.test(val) ? 'idle' : 'ok',
      detail: val.toUpperCase(),
    })).join('');

    const byCodec = new Map();
    for (const e of report.video_encoders || []) {
      if (!byCodec.has(e.codec)) byCodec.set(e.codec, []);
      byCodec.get(e.codec).push(e);
    }
    const videoGroups = [...byCodec.entries()].map(([codec, encs]) => `
      <div class="lane-group">
        <span class="micro">${esc(codec.toUpperCase())}</span>
        ${encs.map((e) => laneRow({
          label: e.encoder,
          status: ENC_LANE[e.status] || 'idle',
          detail: e.status.toUpperCase(),
        })).join('')}
      </div>`).join('');

    const audioLanes = (report.audio_encoders || []).map((e) => laneRow({
      label: e.encoder,
      status: e.status === 'available' ? 'ok' : 'idle',
      detail: e.status.toUpperCase(),
    })).join('');

    const a = report.active || {};
    const configKv = kv([
      ['VIDEO_CODEC', raw(`<span class="mono">${esc(a.VIDEO_CODEC)}</span>`)],
      ['AUDIO_CODEC', raw(`<span class="mono">${esc(a.AUDIO_CODEC)}</span>`)],
      ['HWACCEL', raw(`<span class="mono">${esc(a.HWACCEL)}</span>`)],
      ['QUALITY', raw(`<span class="mono">${esc(a.QUALITY)}</span> <span class="dim">· one knob, per family</span>`)],
      ['RESOLVED VIDEO', raw(`<span class="mono amber-text">${esc(a.video_encoder)}</span> <span class="dim">· verified by encode</span>`)],
      ['RESOLVED AUDIO', raw(`<span class="mono">${esc(a.audio_encoder)}</span>`)],
      ['SEGMENT TYPE', raw(`<span class="mono">${esc(a.segment_type)}</span> <span class="dim">· follows the codec</span>`)],
    ]);

    cardsEl.innerHTML = [
      card({ num: '01', title: 'Required commands', eyebrow: 'FFMPEG · FFPROBE · PYTHON3', children: `<div class="lane-list">${toolLanes}</div>` }),
      card({ num: '02', title: 'Hardware', eyebrow: 'ACCELERATORS PRESENT', children: `<div class="lane-list">${hwLanes}</div>` }),
      card({ num: '03', title: 'Video encoders', eyebrow: 'COMPILED IN / ACTUALLY USABLE', children: videoGroups }),
      card({ num: '04', title: 'Audio encoders', eyebrow: 'AAC · LIBOPUS', children: `<div class="lane-list">${audioLanes}</div><p class="micro" style="color:var(--ink-4);line-height:1.9">AAC RIDES MPEG-TS · OPUS FORCES FMP4 SEGMENTS</p>` }),
      card({ num: '05', title: 'Active configuration', eyebrow: 'WHAT THE NEXT RUN WILL USE', children: configKv }),
      card({ num: '06', title: 'Paths', eyebrow: 'THE FOUR ROOTS', children: pathRows }),
    ].join('');
  }

  function engineMissingPanel() {
    return emptyState({
      code: '!!',
      headline: 'Engine not found',
      guidance: 'CONTROL ROOM CANNOT SEE RUN.SH — POINT IT AT THE PIPELINE FROM EXIT 05 · SETTINGS',
      action: btn({ label: 'Open settings', kind: 'ghost', attrs: 'data-goto="settings"' }),
    });
  }

  function renderAll() { renderStatus(); renderCards(); }

  // -- interactions ---------------------------------------------------------------

  checkBtn.addEventListener('click', () => {
    if (checkBtn.getAttribute('aria-disabled') === 'true' || state.busy) return;
    logSection.hidden = false;
    logMeta.textContent = 'CHECK RUNNING';
    stream.clear();
    api.runCheck().catch((err) => {
      stream.append(`[ERROR] ${err?.message || err}`);
      logMeta.textContent = 'CHECK FAILED';
    });
  });

  // -- live wiring -------------------------------------------------------------------

  subs.push(bus.on('line', (l) => {
    if (l.channel !== 'check') return;
    if (logMeta.textContent === 'CHECK RUNNING') stream.append(l.text);
  }));

  subs.push(bus.on('report:check', (r) => {
    report = r && !r.error ? r : report;
    logMeta.textContent = r && r.error ? `CHECK REFUSED — ${r.error}` : 'CHECK COMPLETE';
    stream.append(r && r.error ? `[ERROR] ${r.error}` : '[DONE] result: ready.');
    renderAll();
  }));

  subs.push(bus.on('state', renderBusy));

  renderAll();
  return () => subs.forEach((off) => off());
}
