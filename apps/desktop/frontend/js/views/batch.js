// Control Room — views/batch.js
// EXIT 04 · RE-ENCODER. encode-batch.sh: shrink a folder tree into plain
// MKV/MP4s. Config renders from the settings spec (generic per-kind controls),
// the launch bar drives the engine, and the live panel parses ffmpeg -stats
// lines (frame=/time=) into a meter plus per-job [i/N] lanes.

import { api } from '../api.js';
import { state, bus } from '../shell.js';
import {
  chip, kv, btn, pageHeader, micro, emptyState, raw, esc, table, card, sectionHead, laneRow,
} from '../components/ui.js';
import { logStream, progressLane } from '../components/progress.js';
import * as edu from '../content.js';

const CSS = `
.bx-pathrow { display:flex; align-items:center; gap:var(--s-4); padding:var(--s-4) 0; border-bottom:1px dashed var(--hairline); }
.bx-pathrow:last-of-type { border-bottom:none; padding-bottom:0; }
.bx-pathrow .bx-plabel { flex:none; width:118px; color:var(--amber); }
.bx-path { flex:1; min-width:0; font-family:var(--font-mono); font-size:12px; letter-spacing:0.02em; color:var(--ink-2); overflow-wrap:anywhere; }
.bx-pathrow .bx-rowbtns { display:flex; gap:var(--s-2); flex:none; }
.bx-pathrow .bx-rowbtns .btn { padding:0.42rem 0.8rem; }
.bx-overlap { display:flex; gap:var(--s-3); align-items:center; margin-top:var(--s-4); }
.bx-group { padding:var(--s-5) var(--s-6); background:var(--bg-panel); border:1px solid var(--hairline); }
.bx-group + .bx-group { margin-top:var(--s-5); }
.bx-group > .micro { display:block; margin-bottom:var(--s-5); color:var(--amber); }
.bx-fields { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(360px,100%),1fr)); gap:var(--s-5) var(--s-6); }
.bx-field { display:flex; flex-direction:column; gap:0.45rem; min-width:0; }
.bx-field .bx-flabel { color:var(--ink-2); }
.bx-field .bx-flabel .micro { color:var(--ink-3); }
.bx-field.danger .bx-flabel .micro { color:var(--danger); }
.bx-ctl { display:flex; gap:var(--s-2); align-items:center; min-width:0; }
.bx-ctl .finput { flex:1; min-width:0; }
.bx-help { font-size:12px; line-height:1.5; color:var(--ink-4); }
.bx-hint { font-family:var(--font-mono); font-size:10px; letter-spacing:0.12em; text-transform:uppercase; color:var(--amber-2); }
.bx-hint.warn { color:var(--danger); }
.seg { display:inline-flex; flex-wrap:wrap; border:1px solid var(--hairline); background:var(--bg-panel); width:fit-content; max-width:100%; }
.seg > button {
  padding:0.45rem 0.85rem; border-right:1px solid var(--hairline);
  font-family:var(--font-mono); font-size:11px; font-weight:500; letter-spacing:0.12em; text-transform:uppercase;
  color:var(--ink-4); transition:color var(--dur-fast) var(--ease-standard), background var(--dur-fast) var(--ease-standard);
}
.seg > button:last-child { border-right:none; }
.seg > button:hover { color:var(--ink-2); background:var(--bg-raise); }
.seg > button[aria-selected="true"] { color:var(--amber); background:var(--amber-a08); }
.seg.danger > button[aria-selected="true"] { color:var(--danger); background:#ff646714; }
.bx-launch-chips { display:flex; flex-wrap:wrap; gap:var(--s-3); align-items:center; min-width:0; }
.bx-live { display:flex; flex-direction:column; gap:var(--s-5); margin-top:var(--s-5); }
.bx-readout { font-family:var(--font-mono); font-size:12px; letter-spacing:0.04em; color:var(--ink-3); overflow-wrap:anywhere; }
.bx-readout .t { color:var(--amber); }
.bx-lanebox { display:flex; flex-direction:column; }
.bx-live .logbox { min-height: 220px; max-height: 40vh; }
.bx-sumchips { display:flex; flex-wrap:wrap; gap:0.5rem; }
`;

const FRAME_RE = /frame=\s*(\d+)/;
const TIME_RE = /time=\s*(\d+):(\d{2}):([\d.]+)/;
const JOB_RE = /\[(\d+)\/(\d+)\]/;
const CANCEL_TIP =
  'Sends SIGINT — the engine traps it, stops child ffmpeg processes and finishes cleanup. rc 130 = cancelled.';

const fmtHMS = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(x)).padStart(2, '0')}`;
};
const fmtGB = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
const pad2 = (n) => String(n).padStart(2, '0');

// CQ band, from content.js qualityRanges (32–34 / 35–37 / 38+).
function cqBand(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n <= 34) return { text: 'CQ 32–34 · ARCHIVE GRADE', cls: 'ok' };
  if (n <= 37) return { text: 'CQ 35–37 · THE SWEET SPOT', cls: 'ok' };
  return { text: 'CQ 38+ · AGGRESSIVE', cls: 'warn' };
}

export async function render(root) {
  const subs = [];
  const engineReady = state.engineReady;
  const ffmpegMissing = state.toolsMissing.includes('ffmpeg');

  let specs = [];          // batch FieldSpecs, normalised
  let form = {};           // name -> literal string value
  let groups = [];         // [groupLabel, [spec…]] in encounter order
  let confirmArmed = false;
  let confirmTimer = null;

  // live-run model, rebuilt per launch
  let live = false;
  let summarySeen = false;
  const prog = { frame: 0, time: 0, est: 0, jobTotal: 0 };
  let lanes = new Map();   // index -> {label, status, detail}

  root.innerHTML = `
    <style>${CSS}</style>
    ${pageHeader({
      exit: '04', title: 'Plain files, re-encoded',
      lede: 'The batch engine compresses a folder tree into plain MKV/MP4s — validated before anything replaces your originals. Successful originals move to review, failures park in error-originals, nothing unvalidated lands in the output.',
      coords: '44.06°N 121.31°W',
    })}
    ${!engineReady ? emptyState({
      code: '!!',
      headline: 'Engine not found',
      guidance: 'CONTROL ROOM CANNOT SEE THE ENGINE — POINT IT AT THE PIPELINE FROM EXIT 05 · SETTINGS',
      action: btn({ label: 'Open settings', kind: 'ghost', attrs: 'data-goto="settings"' }),
    }) : ''}

    <div class="section">
      ${sectionHead({ num: '01', title: 'Route paths', meta: 'INPUT_DIR · OUTPUT_DIR' })}
      <div class="bx-group" id="bx-paths"></div>
    </div>

    <div class="section">
      ${sectionHead({ num: '02', title: 'Config', meta: 'PERSISTED AS APP SETTINGS · APPLIED AS ENV OVERRIDES' })}
      <div id="bx-config"><span class="micro">READING SPEC …</span></div>
    </div>

    <div class="section">
      ${sectionHead({ num: '03', title: 'Launch + live', meta: 'ONE ENGINE AT A TIME' })}
      <div class="status-moment" id="bx-launch">
        <div class="bx-launch-chips" id="bx-launch-chips"></div>
        <span class="grow"></span>
        <span id="bx-launch-btns">
          ${btn({ label: 'Launch batch', kind: 'primary', icon: '▸', id: 'bx-go', tip: 'encode-batch.sh with the values above as environment overrides' })}
          ${btn({ label: 'Cancel', kind: 'danger', icon: '×', id: 'bx-cancel', tip: CANCEL_TIP, attrs: 'data-tip-end hidden' })}
        </span>
      </div>
      <div class="bx-live" id="bx-live" hidden>
        <div id="bx-meter"></div>
        <div class="bx-readout" id="bx-readout">time= --:--:-- / ≈--:--:-- · frame —</div>
        <div class="bx-lanebox" id="bx-lanes"></div>
        <div id="bx-log"></div>
        <div id="bx-summary"></div>
      </div>
    </div>
  `;

  const pathsEl = root.querySelector('#bx-paths');
  const configEl = root.querySelector('#bx-config');
  const chipsEl = root.querySelector('#bx-launch-chips');
  const goBtn = root.querySelector('#bx-go');
  const cancelBtn = root.querySelector('#bx-cancel');
  const liveEl = root.querySelector('#bx-live');
  const meterEl = root.querySelector('#bx-meter');
  const readoutEl = root.querySelector('#bx-readout');
  const lanesEl = root.querySelector('#bx-lanes');
  const summaryEl = root.querySelector('#bx-summary');
  const stream = logStream(root.querySelector('#bx-log'), {});

  root.querySelector('[data-goto="settings"]')?.addEventListener('click', () => {
    location.hash = '#/settings';
  });

  // -- settings spec: normalise both shapes -----------------------------------
  // mock.js returns a flat array ({engine, name, current, …}); the bridge
  // contract returns {specs:{batch:[…]}, values:{batch:{…}}}.

  async function loadSpec() {
    let sg = null;
    try { sg = await api.settingsGet(); } catch { sg = null; }
    if (Array.isArray(sg)) {
      specs = sg.filter((s) => !s.engine || s.engine === 'batch');
      for (const s of specs) form[s.name] = String(s.current ?? s.default ?? '');
    } else {
      specs = sg?.specs?.batch ?? [];
      const vals = { ...(sg?.defaults?.batch ?? {}), ...(sg?.values?.batch ?? {}) };
      for (const s of specs) form[s.name] = String(vals[s.name] ?? s.default ?? '');
    }
    const seen = new Map();
    for (const s of specs) {
      const g = String(s.group ?? 'general').replace(/^batch-/, '');
      if (!seen.has(g)) seen.set(g, []);
      seen.get(g).push(s);
    }
    groups = [...seen.entries()];
  }

  // -- section 01: route paths --------------------------------------------------

  function pathRow(name, label) {
    const spec = specs.find((s) => s.name === name);
    const v = form[name] ?? '';
    return `
      <div class="bx-pathrow">
        <span class="micro bx-plabel">${esc(label)}</span>
        <span class="bx-path" data-path="${esc(name)}">${esc(v || '—')}</span>
        <span class="bx-rowbtns">
          ${btn({ label: 'Pick', kind: 'ghost', attrs: `data-pick="${esc(name)}"`, tip: spec?.help || 'Native directory picker' })}
          ${btn({ label: 'Open', kind: 'ghost', attrs: `data-open="${esc(name)}"`, tip: 'Open this directory with the desktop default' })}
        </span>
      </div>`;
  }

  function overlap() {
    const a = (form.INPUT_DIR || '').replace(/\/+$/, '');
    const b = (form.OUTPUT_DIR || '').replace(/\/+$/, '');
    if (!a || !b || a === b) return a && b ? { cls: 'err', text: 'PATHS IDENTICAL — THE ENGINE REFUSES; OUTPUT WOULD EAT ITS INPUT' } : null;
    if (a.startsWith(b + '/') || b.startsWith(a + '/')) return { cls: 'warn', text: 'PATHS OVERLAP — ONE TREE LIVES INSIDE THE OTHER; THE ENGINE ALSO GUARDS THIS' };
    return null;
  }

  function renderPaths() {
    if (!specs.length) {
      pathsEl.innerHTML = `<span class="micro">SPEC UNAVAILABLE — SETTINGS COULD NOT BE READ</span>`;
      return;
    }
    const ov = overlap();
    pathsEl.innerHTML =
      pathRow('INPUT_DIR', 'INPUT_DIR') +
      pathRow('OUTPUT_DIR', 'OUTPUT_DIR') +
      (ov ? `<div class="bx-overlap">${chip(ov.cls, ov.text)}</div>` : '');
  }

  pathsEl.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const name = pick.dataset.pick;
      let res = null;
      try { res = await api.pickDirectory(form[name] ?? ''); } catch { res = null; }
      const p = typeof res === 'string' ? res : res?.path;
      if (p) { form[name] = p; renderPaths(); }
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open && form[open.dataset.open]) api.openPath(form[open.dataset.open]).catch(() => {});
  });

  // -- section 02: config, generic per-kind controls ------------------------------

  function controlFor(s) {
    const v = form[s.name] ?? '';
    const id = `bx-f-${esc(s.name)}`;
    switch (s.kind) {
      case 'enum': {
        const choices = s.choices?.length ? s.choices : [v || s.default || '—'];
        return `<div class="seg${s.name === 'DELETE_ORIGINALS' ? ' danger' : ''}" role="group" aria-label="${esc(s.label)}" data-seg="${esc(s.name)}">` +
          choices.map((c) =>
            `<button type="button" aria-selected="${String(v) === String(c)}" data-val="${esc(c)}">${esc(c)}</button>`).join('') +
          `</div>`;
      }
      case 'bool':
        return `<div class="seg${s.name === 'DELETE_ORIGINALS' ? ' danger' : ''}" role="group" aria-label="${esc(s.label)}" data-seg="${esc(s.name)}">` +
          `<button type="button" aria-selected="${v === 'true'}" data-val="true">true</button>` +
          `<button type="button" aria-selected="${v === 'false'}" data-val="false">false</button>` +
          `</div>`;
      case 'int':
        return `<div class="bx-ctl"><input class="finput" id="${id}" type="number" step="1" value="${esc(v)}" data-in="${esc(s.name)}" aria-label="${esc(s.label)}"></div>`;
      default: // str | path | bitrate | ladder
        return `<div class="bx-ctl"><input class="finput" id="${id}" type="text" value="${esc(v)}" data-in="${esc(s.name)}" aria-label="${esc(s.label)}"${s.kind === 'bitrate' ? ' placeholder="e.g. 160k"' : ''}>` +
          (s.kind === 'path' ? btn({ label: 'Pick', kind: 'ghost', attrs: `data-fpick="${esc(s.name)}"` }) : '') +
          `</div>`;
    }
  }

  function hintsFor(s) {
    const out = [];
    if (s.name === 'CQ') {
      const band = cqBand(form.CQ);
      if (band) out.push(`<span class="bx-hint${band.cls === 'warn' ? ' warn' : ''}">${band.text}</span>`);
    }
    if (s.name === 'PARALLEL_JOBS' && Number(form.PARALLEL_JOBS) > 8) {
      out.push(`<span class="bx-hint warn">ABOVE 8 — THE ENGINE CLAMPS TO 8 (MAX RECOMMENDED)</span>`);
    }
    if (s.name === 'DELETE_ORIGINALS' && form.DELETE_ORIGINALS === 'true') {
      out.push(`<span class="bx-hint warn">DESTRUCTIVE — ORIGINALS DELETED ONLY AFTER FFPROBE VALIDATES; LAUNCH WILL DEMAND CONFIRMATION</span>`);
    }
    return out.join('');
  }

  function fieldHTML(s) {
    const tipAttrs = s.name === 'CQ' && edu.qualityRanges?.batch
      ? ` data-tip="${esc(edu.qualityRanges.batch.map((b) => `${b.tier} — ${b.meaning}`).join(' · '))}"` : '';
    return `
      <div class="bx-field${s.name === 'DELETE_ORIGINALS' ? ' danger' : ''}" data-field="${esc(s.name)}">
        <span class="bx-flabel"${tipAttrs}><span class="micro">${esc(s.label ?? s.name)}${s.kind === 'bitrate' ? ' · BITRATE' : ''}</span></span>
        ${controlFor(s)}
        ${s.help ? `<span class="bx-help">${esc(s.help)}</span>` : ''}
        <span data-hints="${esc(s.name)}">${hintsFor(s)}</span>
      </div>`;
  }

  function renderConfig() {
    if (!specs.length) {
      configEl.innerHTML = emptyState({
        code: '02',
        headline: 'Config unavailable',
        guidance: 'THE SETTINGS SPEC COULD NOT BE READ — CHECK THE ENGINE IN EXIT 05 · SETTINGS',
      });
      return;
    }
    const routeFields = new Set(['INPUT_DIR', 'OUTPUT_DIR']);
    configEl.innerHTML = groups.map(([g, fields]) => {
      const rest = fields.filter((f) => !routeFields.has(f.name));
      if (!rest.length) return '';
      return `<div class="bx-group"><span class="micro">${esc(g.toUpperCase())}</span><div class="bx-fields">${rest.map(fieldHTML).join('')}</div></div>`;
    }).join('');
  }

  configEl.addEventListener('click', (e) => {
    const segBtn = e.target.closest('[data-seg] button');
    if (segBtn) {
      const name = segBtn.closest('[data-seg]').dataset.seg;
      form[name] = segBtn.dataset.val;
      for (const b of segBtn.parentElement.querySelectorAll('button')) {
        b.setAttribute('aria-selected', b === segBtn ? 'true' : 'false');
      }
      refreshField(name);
      if (name === 'DELETE_ORIGINALS') disarmConfirm();
      return;
    }
    const fpick = e.target.closest('[data-fpick]');
    if (fpick) {
      const name = fpick.dataset.fpick;
      api.pickDirectory(form[name] ?? '').then((res) => {
        const p = typeof res === 'string' ? res : res?.path;
        if (p) { form[name] = p; renderConfig(); }
      }).catch(() => {});
    }
  });
  configEl.addEventListener('input', (e) => {
    const inp = e.target.closest('[data-in]');
    if (!inp) return;
    form[inp.dataset.in] = inp.value;
    refreshField(inp.dataset.in);
  });

  function refreshField(name) {
    // spec names are plain identifiers ([A-Z0-9_]) — safe in an attr selector
    const host = configEl.querySelector(`[data-hints="${name}"]`);
    const spec = specs.find((s) => s.name === name);
    if (host && spec) host.innerHTML = hintsFor(spec);
    if (name === 'INPUT_DIR' || name === 'OUTPUT_DIR') renderPaths();
  }

  // -- section 03: launch + live ---------------------------------------------------

  function renderLaunchBar() {
    const busy = state.busy;
    const chips = [];
    if (ffmpegMissing) chips.push(chip('err', 'FFMPEG MISSING — INSTALL, THEN RE-RUN THE SYSTEMS CHECK'));
    if (busy) {
      chips.push(chip('warn', live || state.kind === 'batch'
        ? 'BATCH IN PROGRESS'
        : `ENGINE BUSY — ${state.kind === 'runsh' ? 'ROUTE' : 'WORKING'}`));
    } else if (summarySeen) {
      chips.push(chip('ok', 'LAST BATCH COMPLETE — SEE AFTER-ACTION BELOW'));
    } else {
      chips.push(chip('idle', `${Object.keys(form).length || '—'} SETTINGS STAGED`));
    }
    const ov = overlap();
    if (ov) chips.push(chip(ov.cls, ov.text));
    chipsEl.innerHTML = chips.join('');
    goBtn.setAttribute('aria-disabled', (busy || ffmpegMissing || !specs.length) ? 'true' : 'false');
    goBtn.dataset.tip = busy && state.kind !== 'batch' && !live
      ? 'Engine busy — one engine (run.sh or batch) runs at a time'
      : ffmpegMissing ? 'ffmpeg was not found by the systems check'
      : 'encode-batch.sh with the values above as environment overrides';
    cancelBtn.hidden = !(busy && live);
  }

  function disarmConfirm() {
    confirmArmed = false;
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
    goBtn.classList.remove('danger');
    goBtn.innerHTML = `<span class="glyph" aria-hidden="true">▸</span>Launch batch`;
  }

  goBtn.addEventListener('click', async () => {
    if (goBtn.getAttribute('aria-disabled') === 'true') return;
    if (form.DELETE_ORIGINALS === 'true' && !confirmArmed) {
      confirmArmed = true;
      goBtn.classList.add('danger');
      goBtn.innerHTML = `<span class="glyph" aria-hidden="true">×</span>Confirm — originals will be deleted`;
      confirmTimer = setTimeout(disarmConfirm, 6000);
      return;
    }
    disarmConfirm();
    startLive();
    try {
      const ack = await api.launchBatch({ ...form });
      if (ack && ack.ok === false) {
        stream.append(`[ERROR] launch refused — ${ack.error || 'unknown reason'}`);
        renderLaunchBar();
      }
    } catch (err) {
      stream.append(`[ERROR] launch failed — ${err?.message || err}`);
      renderLaunchBar();
    }
  });

  cancelBtn.addEventListener('click', () => {
    api.cancelRun().catch(() => {});
  });

  function startLive() {
    live = true;
    summarySeen = false;
    prog.frame = 0; prog.time = 0; prog.est = 0; prog.jobTotal = 0;
    lanes = new Map();
    liveEl.hidden = false;
    summaryEl.innerHTML = '';
    lanesEl.innerHTML = '';
    stream.clear();
    renderMeter();
    renderLanes();
    renderLaunchBar();
  }

  // -- live parsing -----------------------------------------------------------------

  const LANE_STATUS = {
    START: 'warn', STAGE: 'warn', DONE: 'ok', SKIP: 'idle',
    WARN: 'warn', ERROR: 'err', FATAL: 'err',
  };
  const LANE_DETAIL = { DONE: 'encoded', SKIP: 'skipped — output exists', WARN: 'warning', ERROR: 'failed → error-originals', FATAL: 'failed → error-originals' };

  function onBatchLine(text) {
    // logStream colours INFO/START/DONE/…; STAGE is engine vocabulary → INFO.
    stream.append(text.includes('[STAGE]') ? text.replaceAll('[STAGE]', '[INFO]') : text);

    const fm = FRAME_RE.exec(text);
    const tm = TIME_RE.exec(text);
    if (fm || tm) {
      if (fm) prog.frame = Number(fm[1]);
      if (tm) {
        const t = Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3]);
        prog.time = t;
        prog.est = Math.max(prog.est, t); // longest timeline seen ≈ the total
      }
      renderReadout();
      renderMeter();
    }

    const jm = JOB_RE.exec(text);
    if (jm) {
      const idx = Number(jm[1]);
      prog.jobTotal = Number(jm[2]);
      const tag = (/\[(INFO|START|STAGE|DONE|SKIP|WARN|ERROR|FATAL)\]/.exec(text) || [])[1];
      if (tag && tag !== 'INFO') {
        lanes.set(idx, {
          label: `${pad2(idx)}/${pad2(prog.jobTotal)} ${(text.split(`${jm[0]} `)[1] || '').split(' -> ')[0].split(' ; ')[0].slice(0, 42)}`,
          status: LANE_STATUS[tag] ?? 'warn',
          detail: LANE_DETAIL[tag] ?? '',
        });
        renderLanes();
        renderMeter();
      }
    }
  }

  function renderReadout() {
    readoutEl.innerHTML =
      `time= <span class="t">${fmtHMS(prog.time)}</span> / ≈${fmtHMS(prog.est)} · frame ${prog.frame.toLocaleString('en-US')}`;
  }

  function renderMeter() {
    const done = [...lanes.values()].filter((l) => l.status === 'ok' || l.status === 'idle').length;
    // Step per finished file; the in-flight job is estimated from parsed
    // time= against the longest timeline seen so far (≈ the job duration).
    let pct = 0;
    if (summarySeen) pct = 100;
    else if (prog.jobTotal) {
      const inflight = prog.est > 0 ? Math.min(1, prog.time / prog.est) : 0;
      pct = Math.min(99, ((done + inflight) / prog.jobTotal) * 100);
    }
    meterEl.innerHTML = progressLane({
      label: 'BATCH PROGRESS',
      pct,
      status: summarySeen ? 'COMPLETE' : `${done}/${prog.jobTotal || '?'} FILES`,
    });
  }

  function renderLanes() {
    lanesEl.innerHTML = [...lanes.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, l]) => laneRow(l)).join('');
  }

  function renderSummary(d) {
    summarySeen = true;
    // The bridge merges engine counts into the summary "when the engine output
    // contained a summary line" — absent counts fall back to the parsed lanes.
    const laneTally = (st) => [...lanes.values()].filter((l) => l.status === st).length;
    const ok = d.succeeded ?? d.encoded ?? laneTally('ok');
    const failed = d.failed ?? laneTally('err');
    const skipped = d.skipped ?? laneTally('idle');
    const total = d.total ?? prog.jobTotal ?? (ok + failed + skipped);
    const dur = d.duration_s != null ? `${d.duration_s.toFixed ? d.duration_s.toFixed(1) : d.duration_s}s` : '';

    const chips = [
      chip('idle', `TOTAL ${total}`),
      chip(ok ? 'ok' : 'idle', `SUCCESSFUL ${ok}`),
      failed ? chip('err', `FAILED ${failed}`) : chip('idle', 'FAILED 0'),
      skipped ? chip('warn', `SKIPPED ${skipped}`) : '',
      d.cancelled ? chip('warn', 'CANCELLED — RC 130') : '',
    ].join('');

    const reviewDir = form.ORIGINALS_REVIEW_DIR || 'review-originals';
    const errDir = form.ERROR_DIR || 'error-originals';
    const logDir = form.LOG_DIR || '';
    const kvRows = [
      ['ORIGINALS (OK)', form.DELETE_ORIGINALS === 'true'
        ? raw('<span class="mono" style="color:var(--danger)">DELETED AFTER VALIDATION</span>')
        : raw(`moved to <span class="mono">${esc(reviewDir)}</span> for review`)],
      ...(failed ? [['ORIGINALS (FAILED)', raw(`parked in <span class="mono">${esc(errDir)}</span> — not re-attempted`)]] : []),
      ['OUTPUT', raw(`only complete, ffprobe-validated files reach <span class="mono">${esc(form.OUTPUT_DIR || 'OUTPUT_DIR')}</span>`)],
      ...(logDir ? [['LOGS', raw(`<span class="mono">${esc(logDir)}</span>`)]] : []),
    ];

    const files = Array.isArray(d.files) && d.files.length ? table(
      ['FILE', 'FROM', 'TO', 'RESULT'],
      d.files.map((f) => [
        raw(`<span class="mono">${esc(f.name ?? f.rel ?? '—')}</span>`),
        f.from_mb != null ? esc(fmtGB(f.from_mb)) : '—',
        f.to_mb != null ? esc(fmtGB(f.to_mb)) : '—',
        raw(f.ok === false
          ? chip('err', 'FAILED')
          : chip('ok', f.to_mb && f.from_mb ? `${Math.round((1 - f.to_mb / f.from_mb) * 100)}% SMALLER` : 'OK')),
      ]),
    ) : '';

    summaryEl.innerHTML = card({
      num: '04', title: 'After action', eyebrow: dur ? `RUN COMPLETE · ${dur.toUpperCase()}` : 'RUN COMPLETE',
      right: '',
      children: `
        <div class="bx-sumchips">${chips}</div>
        ${kv(kvRows)}
        ${files}
        ${logDir ? `<div>${btn({ label: 'Open logs folder', kind: 'ghost', id: 'bx-open-logs', tip: 'Batch engine logs — one master log plus per-job logs' })}</div>` : ''}`,
    });
    summaryEl.querySelector('#bx-open-logs')?.addEventListener('click', () => {
      api.openPath(form.LOG_DIR).catch(() => {});
    });
    renderMeter();
    renderLaunchBar();
  }

  // -- wiring -------------------------------------------------------------------------

  subs.push(bus.on('line', (l) => {
    if (l.channel !== 'batch') return;
    if (!live) startLive(); // arrived mid-run / launched elsewhere
    onBatchLine(l.text);
  }));
  subs.push(bus.on('state', (s) => {
    renderLaunchBar();
    if (!s.busy && live && !summarySeen) {
      stream.append('[INFO] — engine exited —');
    }
  }));
  subs.push(bus.on('report:batch.summary', (d) => {
    if (!live) return;
    renderSummary(d ?? {});
  }));

  // -- boot -----------------------------------------------------------------------------

  await loadSpec();
  renderPaths();
  renderConfig();
  renderLaunchBar();
  if (state.busy && state.kind === 'batch') startLive(); // arrived mid-run

  return () => {
    if (confirmTimer) clearTimeout(confirmTimer);
    subs.forEach((off) => off());
  };
}
