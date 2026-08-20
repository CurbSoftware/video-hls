// Control Room — views/settings.js
// EXIT 05 · SETTINGS. Typed settings for both engines, written as a minimal
// diff. Two engine tabs render generically from settingsGet() FieldSpecs;
// every edit is previewed (validation, write plan, derived roots, .env text)
// before anything is written.
//
// The view tolerates both payload generations: the frozen bridge shape
// ({specs, values, defaults, env_text, …}) and the older flat-array mock
// (fields carrying `engine` + `current`). normSettings() folds either into
// one internal shape; preview fields the backend does not supply (mock mode)
// are derived locally so the panel is never a guess.

import { api } from '../api.js';
import { state } from '../shell.js';
import { esc, chip, btn, kv, card, pageHeader, raw } from '../components/ui.js';

// The engine's documented built-in ladder (.env.example) — the effective
// table when LADDER is unset and the spec default is empty.
const BUILTIN_LADDER = [
  ['240p', '240', '426', '400k', '600k', '900k', '64k'],
  ['360p', '360', '640', '800k', '1200k', '1800k', '96k'],
  ['480p', '480', '854', '1400k', '2100k', '3000k', '128k'],
  ['720p', '720', '1280', '2800k', '4200k', '6000k', '128k'],
  ['1080p', '1080', '1920', '5000k', '7500k', '10000k', '192k'],
  ['1440p', '1440', '2560', '9000k', '13500k', '18000k', '192k'],
  ['2160p', '2160', '3840', '16000k', '24000k', '32000k', '256k'],
];
const LADDER_COLS = ['label', 'height', 'width', 'video_bitrate', 'maxrate', 'bufsize', 'audio_bitrate'];
const BITRATE_RE = /^\d+[kmg]?$/i;
const INT_RE = /^-?\d+$/;

// ---------------------------------------------------------------------------
// payload normalisation
// ---------------------------------------------------------------------------

const normKind = (k) => (k === 'string' ? 'str' : k === 'boolean' ? 'bool' : k || 'str');
const isLadderSpec = (f) => f.kind === 'ladder' || f.name === 'LADDER';

function normSettings(p) {
  if (Array.isArray(p)) {
    // legacy mock shape: flat field list with engine + current baked in
    const out = { specs: { runsh: [], batch: [] }, values: { runsh: {}, batch: {} },
      defaults: { runsh: {}, batch: {} }, env_text: '', env_path: '', env_writable: null };
    for (const f of p) {
      const eng = f.engine === 'batch' ? 'batch' : 'runsh';
      out.specs[eng].push({
        name: f.name, label: f.label ?? f.name, group: f.group ?? 'General',
        kind: normKind(f.kind), choices: f.choices ?? [], help: f.help ?? '',
        default: String(f.default ?? ''),
      });
      out.values[eng][f.name] = String(f.current ?? f.default ?? '');
      out.defaults[eng][f.name] = String(f.default ?? '');
    }
    return out;
  }
  const out = { specs: { runsh: [], batch: [] }, values: { runsh: {}, batch: {} },
    defaults: { runsh: {}, batch: {} }, env_text: p?.env_text ?? '',
    env_path: p?.env_path ?? '', env_writable: p?.env_writable ?? null };
  for (const eng of ['runsh', 'batch']) {
    out.specs[eng] = (p?.specs?.[eng] ?? []).map((f) => ({
      name: f.name, label: f.label ?? f.name, group: f.group ?? 'General',
      kind: normKind(f.kind), choices: f.choices ?? [], help: f.help ?? '',
      default: String(f.default ?? ''),
    }));
    out.values[eng] = { ...(p?.values?.[eng] ?? {}) };
    out.defaults[eng] = { ...(p?.defaults?.[eng] ?? {}) };
    for (const f of out.specs[eng]) {
      if (!(f.name in out.values[eng])) out.values[eng][f.name] = f.default;
      if (!(f.name in out.defaults[eng])) out.defaults[eng][f.name] = f.default;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ladder text <-> rows
// ---------------------------------------------------------------------------

function parseLadder(str) {
  const rows = [];
  for (const line of String(str ?? '').split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cols = t.split(/\s+/);
    while (cols.length < 7) cols.push('');
    rows.push(cols.slice(0, 7));
  }
  return rows;
}

const serLadder = (rows) => rows.map((r) => r.map((c) => c.trim()).join(' ')).filter((l) => l.trim()).join('\n');

function ladderRowErrors(rows) {
  const errs = [];
  rows.forEach((r, i) => {
    const n = i + 1;
    if (r.some((c) => c === '')) errs.push({ row: n, msg: `LADDER row ${n}: expected 7 columns` });
    if (r[1] !== '' && !INT_RE.test(r[1])) errs.push({ row: n, msg: `LADDER row ${n}: height '${r[1]}' is not a number` });
    if (r[2] !== '' && !INT_RE.test(r[2])) errs.push({ row: n, msg: `LADDER row ${n}: width '${r[2]}' is not a number` });
    for (const [ci, col] of [[3, 'video_bitrate'], [4, 'maxrate'], [5, 'bufsize'], [6, 'audio_bitrate']]) {
      if (r[ci] !== '' && !BITRATE_RE.test(r[ci])) {
        errs.push({ row: n, msg: `LADDER row ${n}: ${col} '${r[ci]}' is not a bitrate (e.g. 1400k)` });
      }
    }
  });
  return errs;
}

// ---------------------------------------------------------------------------
// module state (one live view at a time; destroyed on navigation)
// ---------------------------------------------------------------------------

let cleanupFn = null;

export async function render(root) {
  if (cleanupFn) { try { cleanupFn(); } catch {} cleanupFn = null; }

  const css = ensureStyles();
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  let dead = false;

  // -- data -------------------------------------------------------------------
  let boot = state.bootstrap;
  try { boot = boot ?? await api.getBootstrap(); } catch { /* engine card degrades */ }

  let sget;
  try { sget = normSettings(await api.settingsGet()); } catch (e) {
    root.innerHTML = pageHeader({ exit: '05 — SETTINGS', title: 'Configuration', lede: 'Typed settings for both engines, written as a minimal diff. Environment still wins over .env — per-run overrides live on EXIT 02.' }) +
      `<div class="empty"><span class="empty-code">!!</span><h2>Settings unavailable</h2>` +
      `<p class="empty-guidance">${esc(String(e?.message || e))}</p></div>`;
    return () => { ac.abort(); css.remove(); };
  }

  const specs = sget.specs;                          // {runsh:[FieldSpec], batch:[…]}
  const defs = sget.defaults;                        // built-in defaults (diff baseline for "custom")
  const vals = structuredClone(sget.values);         // working values — always strings
  const baseline = structuredClone(sget.values);     // last loaded/saved effective values (write baseline)
  let envText = sget.env_text || '';
  let active = 'runsh';                              // active tab
  let saveMsg = null;                                // {kind:'ok'|'err', text|list}
  let resetArmed = false;
  let resetTimer = 0;
  let pvTimer = 0;
  let pvSeq = 0;
  let lastBridgeErrs = [];

  const specOrder = (eng) => specs[eng].map((f) => f.name);
  const pending = (eng) => specOrder(eng).filter((n) => vals[eng][n] !== baseline[eng][n]);
  const pendingTotal = () => pending('runsh').length + pending('batch').length;

  // engine identity — the bridge carries it; the mock needs a nudge
  const engineRoot = boot?.engine?.root
    ?? (boot?.paths?.input_root ? boot.paths.input_root.replace(/\/[^/]+$/, '') : null);
  const engineVersion = boot?.engine?.version ?? boot?.version ?? state.engineVersion ?? 'unknown';
  const engineSource = boot?.engine?.source ?? 'auto';
  let envPath = sget.env_path || (engineRoot ? `${engineRoot}/.env` : '.env');
  let envWritable = sget.env_writable ?? true;

  // -- static shell -------------------------------------------------------------
  root.innerHTML = `
    ${pageHeader({
      exit: '05 — SETTINGS', title: 'Configuration',
      lede: 'Typed settings for both engines, written as a minimal diff. Environment still wins over .env — per-run overrides live on EXIT 02.',
      coords: '44.06°N 121.31°W',
    })}
    <div class="st-tabs-row">
      <div class="st-tabs" role="group" aria-label="Engine">
        <button type="button" class="st-tab" data-st-tab="runsh" aria-pressed="true">HLS ENGINE<span class="st-tab-n" hidden></span></button>
        <button type="button" class="st-tab" data-st-tab="batch" aria-pressed="false">BATCH ENGINE<span class="st-tab-n" hidden></span></button>
      </div>
      <div class="st-engmeta">
        <span class="micro" id="st-envmeta" data-tip="Precedence: environment &gt; .env &gt; built-in defaults. Per-run overrides are set on EXIT 02 · ROUTES."></span>
      </div>
    </div>
    <div class="st-wrap">
      <div class="st-groups" id="st-groups"></div>
      <aside class="st-preview" id="st-preview" aria-label="Live preview"></aside>
    </div>
    <section class="section st-engine" id="st-engine"></section>
  `;

  const groupsEl = root.querySelector('#st-groups');
  const previewEl = root.querySelector('#st-preview');
  const engineEl = root.querySelector('#st-engine');
  const envMetaEl = root.querySelector('#st-envmeta');

  // ===========================================================================
  // field rendering (shared, per-kind)
  // ===========================================================================

  function fieldControl(f, eng) {
    const v = vals[eng][f.name] ?? '';
    const id = `st-in-${eng}-${f.name}`;
    const labelAttrs = `id="${id}" data-eng="${eng}" data-name="${f.name}"`;
    switch (f.kind) {
      case 'enum':
        return `<div class="st-seg" role="group" aria-label="${esc(f.name)}">` +
          f.choices.map((c) =>
            `<button type="button" class="st-seg-btn" data-eng="${eng}" data-name="${esc(f.name)}" data-val="${esc(c)}" aria-pressed="${String(c) === v}">${esc(String(c).toUpperCase())}</button>`).join('') +
          `</div>`;
      case 'bool':
        return `<div class="st-seg" role="group" aria-label="${esc(f.name)}" data-tip="The engine compares literally — anything except the exact string true reads as false">` +
          ['true', 'false'].map((c) =>
            `<button type="button" class="st-seg-btn" data-eng="${eng}" data-name="${esc(f.name)}" data-val="${c}" aria-pressed="${c === v}">${c.toUpperCase()}</button>`).join('') +
          `</div>`;
      case 'path':
        return `<div class="st-fctl">` +
          `<input class="st-in" ${labelAttrs} value="${esc(v)}" spellcheck="false" autocomplete="off" aria-label="${esc(f.label)}">` +
          btn({ label: 'Pick', kind: 'ghost', attrs: `data-st-pick data-eng="${eng}" data-name="${esc(f.name)}" data-tip="Open a native directory picker"` }) +
          btn({ label: 'Open', kind: 'ghost', attrs: `data-st-open data-eng="${eng}" data-name="${esc(f.name)}" data-tip="Open this path with the desktop default"` }) +
          `</div>`;
      default: // str | int | bitrate
        return `<div class="st-fctl">` +
          `<input class="st-in" ${labelAttrs} value="${esc(v)}" spellcheck="false" autocomplete="off"` +
          (f.kind === 'int' ? ' inputmode="numeric"' : '') +
          ` aria-label="${esc(f.label)}">` +
          (f.kind === 'bitrate' || /BITRATE$/.test(f.name)
            ? `<span class="st-hint">e.g. ${esc(v && BITRATE_RE.test(v) ? v : '5000k')}</span>` : '') +
          `</div>`;
    }
  }

  function fieldHtml(f, eng) {
    const v = vals[eng][f.name] ?? '';
    const def = defs[eng][f.name] ?? '';
    const custom = v !== def;
    const tag = custom
      ? `<button type="button" class="st-ftag custom" data-eng="${eng}" data-name="${esc(f.name)}" data-tip="Value differs from the built-in default — click to reset"><span class="d" aria-hidden="true"></span>CUSTOM</button>`
      : `<span class="st-ftag default" data-tip="Held at the built-in default"><span class="d" aria-hidden="true"></span>DEFAULT</span>`;
    return `
      <div class="st-field" id="st-f-${eng}-${f.name}" data-eng="${eng}" data-name="${esc(f.name)}">
        <div class="st-fhead">
          <label class="st-flabel" for="st-in-${eng}-${f.name}" data-tip="${esc(f.name)}">${esc(f.label)}</label>
          ${tag}
        </div>
        ${fieldControl(f, eng)}
        ${f.help ? `<p class="st-fhelp">${esc(f.help)}</p>` : ''}
        <p class="st-ferr" hidden></p>
      </div>`;
  }

  // ===========================================================================
  // ladder editor (runsh)
  // ===========================================================================

  function ladderRows() { return parseLadder(vals.runsh.LADDER ?? ''); }
  function effectiveLadder() {
    const set = ladderRows();
    if (set.length) return { rows: set, builtin: false };
    const fromSpec = parseLadder(defs.runsh.LADDER ?? '');
    if (fromSpec.length) return { rows: fromSpec, builtin: false };
    return { rows: BUILTIN_LADDER.map((r) => [...r]), builtin: true };
  }

  function ladderEditorHtml() {
    const rows = ladderRows();
    const errs = ladderRowErrors(rows);
    const errByRow = new Map();
    for (const e of errs) errByRow.set(e.row, [...(errByRow.get(e.row) ?? []), e.msg]);
    const cells = rows.map((r, i) => `
      <tr class="st-lrow${errByRow.has(i + 1) ? ' st-rowbad' : ''}" data-row="${i}">
        ${r.map((c, ci) => `<td><input class="st-lcell${c !== '' && ladderCellBad(ci, c) ? ' st-bad' : ''}" data-row="${i}" data-col="${ci}" value="${esc(c)}" aria-label="${esc(LADDER_COLS[ci])} row ${i + 1}"></td>`).join('')}
        <td class="st-lrmcell"><button type="button" class="st-lrm" data-st-lrm data-row="${i}" data-tip="Remove tier ${i + 1}" aria-label="Remove tier ${i + 1}">&#215;</button></td>
      </tr>`).join('');
    return `
      <div class="st-ladder" id="st-f-runsh-LADDER">
        <div class="st-fhead">
          <span class="st-flabel" data-tip="LADDER">Rendition ladder</span>
          ${vals.runsh.LADDER !== (defs.runsh.LADDER ?? '')
            ? `<button type="button" class="st-ftag custom" data-eng="runsh" data-name="LADDER" data-tip="Value differs from the built-in default — click to reset"><span class="d" aria-hidden="true"></span>CUSTOM</button>`
            : `<span class="st-ftag default" data-tip="Held at the built-in default"><span class="d" aria-hidden="true"></span>DEFAULT</span>`}
        </div>
        <div class="tbl-wrap st-ltable"><table class="tbl">
          <thead><tr>${LADDER_COLS.map((c) => `<th>${esc(c.replace('_', ' '))}</th>`).join('')}<th aria-hidden="true"></th></tr></thead>
          <tbody>${cells || `<tr><td colspan="8" class="st-lblank">LADDER is unset — the engine's built-in table below is used.</td></tr>`}</tbody>
        </table></div>
        <div class="st-lerrs" id="st-ladder-errs">${errs.map((e) => `<p class="st-lerr">${esc(e.msg)}</p>`).join('')}</div>
        <div class="st-lactions">
          ${btn({ label: 'Add tier', kind: 'ghost', attrs: 'data-st-ladd data-tip="Append one row to LADDER"' })}
          ${rows.length === 0 ? btn({ label: 'Use built-in table', kind: 'ghost', attrs: 'data-st-lbuiltin data-tip="Load the seven documented default tiers into the editor"' }) : ''}
          <span class="st-hint">columns: ${LADDER_COLS.join(' ')} — whitespace-separated</span>
        </div>
        <div class="st-active" id="st-active">${activeLadderHtml()}</div>
      </div>`;
  }

  function ladderCellBad(ci, c) {
    if ([1, 2].includes(ci)) return !INT_RE.test(c);
    if ([3, 4, 5, 6].includes(ci)) return !BITRATE_RE.test(c);
    return false;
  }

  function activeLadderHtml() {
    const { rows, builtin } = effectiveLadder();
    const maxH = INT_RE.test(vals.runsh.MAX_RESOLUTION_HEIGHT ?? '') ? parseInt(vals.runsh.MAX_RESOLUTION_HEIGHT, 10) : null;
    const minH = INT_RE.test(vals.runsh.MIN_RESOLUTION_HEIGHT ?? '') ? parseInt(vals.runsh.MIN_RESOLUTION_HEIGHT, 10) : null;
    const lanes = rows.map((r) => {
      const h = parseInt(r[1], 10);
      const dropped = (maxH != null && h > maxH) || (minH != null && h < minH);
      return `<div class="st-arow${dropped ? ' dropped' : ''}">
        <span class="al">${esc(r[0])}</span>
        <span class="ad">${esc(r[2])}&times;${esc(r[1])} · ${esc(r[3])} video · ${esc(r[6])} audio</span>
        ${dropped ? `<span class="atag">DROPPED &mdash; OUTSIDE ${minH != null && h < minH ? 'MIN' : 'MAX'} BOUND</span>` : '<span class="atag ok">ACTIVE</span>'}
      </div>`;
    }).join('');
    return `
      <div class="st-fhead"><span class="micro">ACTIVE LADDER AT NEXT RUN</span>
        ${builtin ? '<span class="st-hint">BUILT-IN TABLE (LADDER UNSET)</span>' : ''}</div>
      ${lanes}
      <p class="st-fhelp">Rows surviving the MIN/MAX resolution bounds. Tiers taller than the source are additionally skipped per video at run time — the pipeline never upscales.</p>`;
  }

  // ===========================================================================
  // tab rendering
  // ===========================================================================

  function renderTab() {
    const eng = active;
    const groups = new Map();
    for (const f of specs[eng]) {
      if (!groups.has(f.group)) groups.set(f.group, []);
      groups.get(f.group).push(f);
    }
    let html = '';
    if (eng === 'batch') {
      html += `<div class="banner"><span class="micro">NOTE</span>
        <p class="micro st-batchnote">encode-batch.sh reads no .env — batch settings persist in the app and apply as environment on launch.</p></div>`;
    }
    let n = 0;
    for (const [g, fields] of groups) {
      n++;
      html += card({
        num: String(n).padStart(2, '0'), title: g.toUpperCase(),
        eyebrow: `${fields.length} SETTINGS`,
        children: fields.map((f) => (isLadderSpec(f) ? ladderEditorHtml() : fieldHtml(f, eng))).join(''),
      });
    }
    groupsEl.innerHTML = html;
    applyFieldErrors();
    renderTabCounts();
  }

  function renderTabCounts() {
    for (const tab of root.querySelectorAll('.st-tab')) {
      const cnt = pending(tab.dataset.stTab).length;
      const badge = tab.querySelector('.st-tab-n');
      badge.hidden = cnt === 0;
      badge.textContent = String(cnt);
    }
  }

  // ===========================================================================
  // validation + preview
  // ===========================================================================

  function localErrors() {
    const errs = [];
    for (const eng of ['runsh', 'batch']) {
      for (const f of specs[eng]) {
        const v = vals[eng][f.name] ?? '';
        if (f.kind === 'int' && !INT_RE.test(v)) errs.push(`${f.name}: expected an integer, got "${v}"`);
        if (f.kind === 'enum' && f.choices.length && !f.choices.includes(v)) errs.push(`${f.name}: "${v}" is not one of ${f.choices.join(', ')}`);
        if (f.kind === 'bool' && v !== 'true' && v !== 'false') errs.push(`${f.name}: must be exactly "true" or "false"`);
      }
    }
    for (const e of ladderRowErrors(ladderRows())) errs.push(e.msg);
    return errs;
  }

  function applyFieldErrors() {
    for (const eng of ['runsh', 'batch']) {
      for (const f of specs[eng]) {
        const fieldEl = root.querySelector(`#st-f-${eng}-${f.name}`);
        if (!fieldEl) continue;
        const v = vals[eng][f.name] ?? '';
        const bad = (f.kind === 'int' && !INT_RE.test(v))
          || (f.kind === 'enum' && f.choices.length && !f.choices.includes(v))
          || (f.kind === 'bool' && v !== 'true' && v !== 'false');
        const input = fieldEl.querySelector('.st-in');
        if (input) input.classList.toggle('st-bad', bad);
        const errEl = fieldEl.querySelector('.st-ferr');
        if (errEl) {
          errEl.hidden = !bad;
          errEl.textContent = bad ? `Invalid value for ${f.name} — ${f.kind === 'int' ? 'expected an integer' : `expected ${f.choices.join(' / ') || '"true" / "false"'}`}` : '';
        }
      }
    }
  }

  function localDerivedRoots() {
    const resolve = (v, work) => {
      let s = String(v ?? '').replace(/\$WORK_ROOT/g, work || '…');
      if (!s || s.startsWith('$')) return s || '';
      if (s.startsWith('/')) return s;
      if (s.startsWith('./')) s = s.slice(2);
      return engineRoot ? `${engineRoot}/${s}` : s;
    };
    if (active === 'batch') {
      const b = vals.batch;
      return [
        ['INPUT', resolve(b.INPUT_DIR)],
        ['OUTPUT', resolve(b.OUTPUT_DIR)],
        ['REVIEW', resolve(b.ORIGINALS_REVIEW_DIR)],
        ['ERRORS', resolve(b.ERROR_DIR)],
        ['LOGS', resolve(b.LOG_DIR)],
      ];
    }
    const r = vals.runsh;
    const work = resolve(r.WORK_ROOT);
    return [
      ['INPUT', resolve(r.INPUT_ROOT)],
      ['HLS', resolve(r.HLS_ROOT)],
      ['WORK', work],
      ['PROCESSED', resolve(r.PROCESSED_ROOT)],
      ['ENCODED', resolve(r.ENCODED_ROOT, work)],
      ['STATE', resolve(r.STATE_ROOT, work)],
      ['LOGS', resolve(r.LOG_ROOT, work)],
    ];
  }

  function synthEnvText() {
    const keys = pending('runsh');
    if (!keys.length) return envText || '# .env is empty — every value sits at its built-in default';
    return ['# Control Room — minimal diff. Precedence: environment > .env > defaults.',
      ...keys.map((k) => `${k}=${vals.runsh[k]}`)].join('\n');
  }

  // Post-write .env: current file with the pending runsh diff applied — keys
  // returning to default drop out (the write is minimal).
  function mergeEnvPreview() {
    const keys = pending('runsh');
    if (!keys.length) return envText || '# .env is empty — every value sits at its built-in default';
    const map = new Map();
    const order = [];
    for (const l of (envText || '').split('\n')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l.trim());
      if (m && !map.has(m[1])) { map.set(m[1], m[2]); order.push(m[1]); }
    }
    for (const k of keys) {
      if (!order.includes(k)) order.push(k);
      const v = vals.runsh[k];
      if (v === (defs.runsh[k] ?? '')) map.delete(k);
      else map.set(k, v.includes('\n') ? `"${v.replace(/"/g, '\\"')}"` : v);
    }
    return ['# Control Room — post-write preview. Precedence: environment > .env > defaults.',
      ...order.filter((k) => map.has(k)).map((k) => `${k}=${map.get(k)}`)].join('\n');
  }

  function diffLine(name, v) {
    const shown = v.includes('\n') ? `${v.split('\n').length} rows` : (v === '' ? '""' : v);
    return `<span class="st-diffline"><span class="k">${esc(name)}</span><span class="v">=${esc(shown)}</span></span>`;
  }

  function errorTarget(msg) {
    for (const eng of ['runsh', 'batch']) {
      for (const tok of msg.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? []) {
        if (tok in vals[eng] && root.querySelector(`#st-f-${eng}-${tok}`)) return `st-f-${eng}-${tok}`;
      }
    }
    return root.querySelector('#st-f-runsh-LADDER') ? 'st-f-runsh-LADDER' : null;
  }

  // batch settings ride as environment on launch — show the whole applied set
  function synthBatchEnv() {
    return ['# Applied as environment when the batch engine launches.',
      ...specOrder('batch').map((k) => `${k}=${vals.batch[k]}`)].join('\n');
  }

  function renderPreview(pv) {
    // local field validation always gates; engine-reported errors join it
    const bridgeErrs = Array.isArray(pv?.errors) ? pv.errors.map(String) : [];
    const bridgeLadder = Array.isArray(pv?.ladder_errors) ? pv.ladder_errors.map(String) : [];
    const allErrs = [...new Set([...localErrors(), ...bridgeErrs, ...bridgeLadder])];

    const pr = pending('runsh');
    const pb = pending('batch');
    const mine = active === 'runsh' ? pr : pb;
    const other = active === 'runsh' ? pb : pr;
    const otherLabel = active === 'runsh' ? 'BATCH' : 'HLS';
    const total = pr.length + pb.length;

    const errHtml = allErrs.length
      ? `<div class="st-errlist">${allErrs.map((m) =>
          `<button type="button" class="st-errchip" data-st-err="${esc(m)}"><span class="chip err"><span class="dot" aria-hidden="true"></span>${esc(m)}</span></button>`).join('')}</div>`
      : `<p class="st-dimline">No problems — every value parses.</p>`;

    const writeHtml = total === 0
      ? `<p class="st-dimline">Nothing queued — every value matches what is on disk.</p>`
      : [
          ...mine.map((k) => diffLine(k, vals[active][k])),
          other.length ? `<p class="st-dimline">+ ${other.length} ${otherLabel} key${other.length === 1 ? '' : 's'} pending</p>` : '',
        ].join('');

    // bridge derived_roots describe the run.sh tree; batch roots come from the
    // batch path settings themselves
    const roots = (active === 'runsh' && pv?.derived_roots && Object.keys(pv.derived_roots).length)
      ? [['INPUT', 'input'], ['HLS', 'hls'], ['WORK', 'work'], ['PROCESSED', 'processed'], ['ENCODED', 'encoded'], ['STATE', 'state'], ['LOGS', 'logs']]
          .map(([label, k]) => [label, pv.derived_roots[k]])
      : localDerivedRoots();
    const rootsHtml = roots.map(([k, v]) =>
      `<div class="st-root"><span class="rk">${esc(k)}</span><span class="rv">${esc(v || '—')}</span></div>`).join('');

    const envPreview = active === 'runsh'
      ? (pv?.env_text ? mergeEnvPreview() : synthEnvText())
      : synthBatchEnv();
    const saveable = allErrs.length === 0 && total > 0;
    const save = btn({
      label: total > 0 ? `Write ${total} key${total === 1 ? '' : 's'}` : 'Nothing to write',
      kind: 'primary', id: 'st-save', disabled: !saveable,
      tip: allErrs.length ? 'Fix the validation errors first' : 'Write the minimal diff',
    });
    const reset = btn({
      label: resetArmed ? 'Confirm reset?' : 'Reset all', kind: resetArmed ? 'danger' : 'ghost',
      id: 'st-resetall', attrs: 'data-tip="Return every field of both engines to its built-in default"',
    });

    previewEl.innerHTML = `
      <div class="st-pv-head">
        <span class="micro">LIVE PREVIEW</span>
        <span class="grow"></span>
        ${allErrs.length ? chip('err', `${allErrs.length} INVALID`) : chip('ok', 'VALID')}
      </div>
      ${saveMsg ? `<div class="st-savemsg">${saveMsg.kind === 'ok'
        ? chip('ok', saveMsg.text)
        : `<div class="st-errlist">${saveMsg.list.map((m) => `<span class="chip err"><span class="dot"></span>${esc(m)}</span>`).join('')}</div>`}</div>` : ''}
      <div class="st-pv-sec">
        <span class="micro">VALIDATION${allErrs.length ? ` — ${allErrs.length} PROBLEM${allErrs.length === 1 ? '' : 'S'}` : ''}</span>
        ${errHtml}
      </div>
      <div class="st-pv-sec">
        <span class="micro">WILL WRITE ${total} KEY${total === 1 ? '' : 'S'}${active === 'runsh' ? ' TO .ENV' : ' TO APP SETTINGS'}</span>
        ${writeHtml}
      </div>
      <div class="st-pv-sec"><span class="micro">DERIVED ROOTS</span>${rootsHtml}</div>
      <details class="st-env">
        <summary class="micro">${active === 'runsh' ? '.ENV' : 'APPLIED ENVIRONMENT'} PREVIEW</summary>
        <pre class="st-envpre">${esc(envPreview)}</pre>
      </details>
      <div class="st-actions">${save}${reset}</div>
    `;
  }

  // engine-reported ladder errors attach to their rows (local ones already do)
  function applyLadderErrors(msgs) {
    const box = root.querySelector('#st-ladder-errs');
    if (!box) return;
    const merged = [...new Set([...ladderRowErrors(ladderRows()).map((e) => e.msg), ...msgs])];
    box.innerHTML = merged.map((m) => `<p class="st-lerr">${esc(m)}</p>`).join('');
    for (const tr of root.querySelectorAll('.st-lrow')) tr.classList.remove('st-rowbad');
    for (const m of merged) {
      const rm = /row (\d+)/i.exec(m);
      if (rm) root.querySelector(`.st-lrow[data-row="${Number(rm[1]) - 1}"]`)?.classList.add('st-rowbad');
    }
  }

  function schedulePreview() {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(runPreview, 200);
  }

  async function runPreview() {
    const seq = ++pvSeq;
    renderPreview(null); // local truth immediately
    let pv = null;
    try {
      pv = await api.settingsPreview({ runsh: { ...vals.runsh }, batch: { ...vals.batch } });
    } catch { pv = null; }
    if (dead || seq !== pvSeq) return;
    if (pv && typeof pv === 'object') {
      lastBridgeErrs = [...(Array.isArray(pv.errors) ? pv.errors.map(String) : []),
        ...(Array.isArray(pv.ladder_errors) ? pv.ladder_errors.map(String) : [])];
      renderPreview(pv);
      applyLadderErrors(lastBridgeErrs);
    }
    renderTabCounts();
  }

  // ===========================================================================
  // engine section
  // ===========================================================================

  function renderEngine(ver = engineVersion, src = engineSource, msgHtml = '') {
    const writableChip = envWritable
      ? chip('ok', 'WRITABLE')
      : chip('err', 'READ-ONLY');
    engineEl.innerHTML = `
      <div class="card">
        <header class="card-head">
          <span class="num" aria-hidden="true">08</span>
          <div><h3>Current engine</h3><span class="micro">THE PIPELINE CHECKOUT THIS APP DRIVES</span></div>
        </header>
        <div class="st-engbody">
          ${kv([
            ['ROOT', raw(`<span class="mono">${esc(engineRoot ?? 'not found')}</span>`)],
            ['SOURCE', raw(src === 'setting'
              ? chip('ok', 'SET IN APP')
              : chip('idle', 'AUTO DETECTED'))],
            ['VERSION', raw(`<span class="mono">${esc(ver ?? 'unknown')}</span>`)],
            ['ENV FILE', raw(`<span class="mono">${esc(envPath)}</span> ${writableChip}`)],
          ])}
          <p class="st-fhelp" data-tip="Bundled: the engine directory shipped alongside the app, found by walking up from the executable. External: any checkout containing run.sh, chosen below. The app never modifies run.sh or encode-batch.sh.">
            ${envWritable
              ? 'run.sh settings persist to the .env above — a minimal diff against the built-in defaults.'
              : 'The engine root is read-only, so run.sh settings persist to ~/.config/videohls-control-room/ instead.'}
            The bundled engine travels with the app; an external one is any checkout containing run.sh — point at it below.
          </p>
          <div class="st-setrow">
            <input class="st-in" id="st-engin" value="${esc(engineRoot ?? '')}" spellcheck="false" aria-label="Engine path">
            ${btn({ label: 'Pick', kind: 'ghost', id: 'st-enginepick', tip: 'Choose the engine directory' })}
            ${btn({ label: 'Apply', kind: 'ghost', id: 'st-apply-engine', tip: 'Point the app at this checkout (must contain run.sh)' })}
            <span id="st-engmsg" class="st-savemsg">${msgHtml}</span>
          </div>
        </div>
      </div>`;
  }

  // ===========================================================================
  // edits
  // ===========================================================================

  function setVal(eng, name, v) {
    vals[eng][name] = v;
    saveMsg = null;
    const fieldEl = root.querySelector(`#st-f-${eng}-${name}`);
    if (fieldEl) {
      const def = defs[eng][name] ?? '';
      const tag = fieldEl.querySelector('.st-fhead');
      if (tag && !isLadderSpec(specs[eng].find((f) => f.name === name))) {
        // refresh the custom/default tag in place
        const custom = v !== def;
        const existing = tag.querySelector('.st-ftag');
        if (existing) existing.remove();
        tag.insertAdjacentHTML('beforeend', custom
          ? `<button type="button" class="st-ftag custom" data-eng="${eng}" data-name="${esc(name)}" data-tip="Value differs from the built-in default — click to reset"><span class="d" aria-hidden="true"></span>CUSTOM</button>`
          : `<span class="st-ftag default" data-tip="Held at the built-in default"><span class="d" aria-hidden="true"></span>DEFAULT</span>`);
      }
    }
    applyFieldErrors();
    if (name === 'LADDER' || name === 'MAX_RESOLUTION_HEIGHT' || name === 'MIN_RESOLUTION_HEIGHT') {
      const act = root.querySelector('#st-active');
      if (act) act.innerHTML = activeLadderHtml();
    }
    schedulePreview();
  }

  function flash(id) {
    const el = root.querySelector(`#${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('st-flash');
    void el.offsetWidth;
    el.classList.add('st-flash');
  }

  // ===========================================================================
  // delegated events
  // ===========================================================================

  root.addEventListener('click', async (e) => {
    const t = e.target;

    const tab = t.closest('[data-st-tab]');
    if (tab) {
      active = tab.dataset.stTab;
      for (const b of root.querySelectorAll('.st-tab')) b.setAttribute('aria-pressed', String(b === tab));
      saveMsg = null;
      renderTab();
      runPreview();
      return;
    }

    const seg = t.closest('.st-seg-btn');
    if (seg) {
      const { eng, name } = seg.dataset;
      const val = seg.dataset.val;
      vals[eng][name] = val; // bools emit exactly "true"/"false" — the engine compares literally
      for (const b of seg.parentElement.querySelectorAll('.st-seg-btn')) b.setAttribute('aria-pressed', String(b.dataset.val === val));
      setVal(eng, name, val);
      return;
    }

    const tagBtn = t.closest('button.st-ftag.custom');
    if (tagBtn) {
      const { eng, name } = tagBtn.dataset;
      if (name === 'LADDER') { vals.runsh.LADDER = defs.runsh.LADDER ?? ''; renderTab(); schedulePreview(); return; }
      const fieldEl = tagBtn.closest('.st-field');
      const input = fieldEl?.querySelector('.st-in');
      if (input) input.value = defs[eng][name] ?? '';
      setVal(eng, name, defs[eng][name] ?? '');
      return;
    }

    const pick = t.closest('[data-st-pick]');
    if (pick) {
      const { eng, name } = pick.dataset;
      const input = root.querySelector(`#st-in-${eng}-${name}`);
      try {
        const r = await api.pickDirectory(vals[eng][name] || '');
        const p = typeof r === 'string' ? r : (r && r.path) || '';
        if (p) { input.value = p; setVal(eng, name, p); }
      } catch { /* cancelled */ }
      return;
    }

    const open = t.closest('[data-st-open]');
    if (open) {
      const v = vals[open.dataset.eng]?.[open.dataset.name];
      if (v) api.openPath(v).catch(() => {});
      return;
    }

    const lrm = t.closest('[data-st-lrm]');
    if (lrm) {
      const rows = ladderRows();
      rows.splice(Number(lrm.dataset.row), 1);
      vals.runsh.LADDER = serLadder(rows);
      renderTab();
      schedulePreview();
      return;
    }

    if (t.closest('[data-st-ladd]')) {
      const rows = ladderRows();
      const last = rows[rows.length - 1] ?? ['480p', '480', '854', '1400k', '2100k', '3000k', '128k'];
      rows.push([...last]);
      vals.runsh.LADDER = serLadder(rows);
      renderTab();
      schedulePreview();
      return;
    }

    if (t.closest('[data-st-lbuiltin]')) {
      vals.runsh.LADDER = serLadder(BUILTIN_LADDER.map((r) => [...r]));
      renderTab();
      schedulePreview();
      return;
    }

    const errChip = t.closest('[data-st-err]');
    if (errChip) {
      flash(errorTarget(errChip.dataset.stErr) ?? 'st-groups');
      return;
    }

    if (t.closest('#st-resetall')) {
      if (!resetArmed) {
        resetArmed = true;
        renderPreview(null);
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => { resetArmed = false; if (!dead) renderPreview(null); }, 3500);
      } else {
        resetArmed = false;
        clearTimeout(resetTimer);
        for (const eng of ['runsh', 'batch']) {
          for (const f of specs[eng]) vals[eng][f.name] = defs[eng][f.name] ?? '';
        }
        saveMsg = null;
        renderTab();
        runPreview();
      }
      return;
    }

    if (t.closest('#st-save')) {
      if (localErrors().length || lastBridgeErrs.length || pendingTotal() === 0) return;
      try {
        const res = await api.settingsSave({ runsh: { ...vals.runsh }, batch: { ...vals.batch } });
        if (res && res.ok === false) {
          saveMsg = { kind: 'err', list: Array.isArray(res.errors) && res.errors.length ? res.errors : [res.error || 'save refused'] };
        } else {
          const n = Array.isArray(res?.saved) && res.saved.length ? res.saved.length : pendingTotal();
          if (typeof res?.env_path === 'string' && res.env_path) envPath = res.env_path;
          saveMsg = { kind: 'ok', text: `WRITTEN — ${n} KEY${n === 1 ? '' : 'S'} · ${envPath}` };
          for (const eng of ['runsh', 'batch']) baseline[eng] = { ...vals[eng] };
          try {
            const again = normSettings(await api.settingsGet());
            if (again.env_text) envText = again.env_text;
            if (again.env_path) envPath = again.env_path;
            if (again.env_writable != null) envWritable = again.env_writable;
          } catch { /* keep local view */ }
        }
      } catch (err) {
        saveMsg = { kind: 'err', list: [String(err?.message || err)] };
      }
      renderPreview(null);
      renderTabCounts();
      return;
    }

    if (t.closest('#st-enginepick')) {
      const input = root.querySelector('#st-engin');
      try {
        const r = await api.pickDirectory(input.value || '');
        const p = typeof r === 'string' ? r : (r && r.path) || '';
        if (p) input.value = p;
      } catch { /* cancelled */ }
      return;
    }

    if (t.closest('#st-apply-engine')) {
      const input = root.querySelector('#st-engin');
      const msg = root.querySelector('#st-engmsg');
      const path = input.value.trim();
      if (!path) { msg.innerHTML = chip('err', 'ENTER A PATH'); return; }
      try {
        const res = await api.setEnginePath(path);
        if (res && res.ok === false) {
          msg.innerHTML = chip('err', String(res.error || 'not accepted').toUpperCase());
        } else {
          const ver = res?.version ?? engineVersion;
          renderEngine(ver, 'setting', chip('ok', `ENGINE SET — ${ver !== 'unknown' ? 'V' + ver : 'VERSION UNKNOWN'}`));
        }
      } catch (err) {
        msg.innerHTML = chip('err', String(err?.message || err).toUpperCase());
      }
      return;
    }
  }, sig);

  root.addEventListener('input', (e) => {
    const t = e.target;

    if (t.classList?.contains('st-in') && t.dataset.eng) {
      setVal(t.dataset.eng, t.dataset.name, t.value);
      return;
    }

    if (t.classList?.contains('st-lcell')) {
      const rows = ladderRows();
      const r = Number(t.dataset.row);
      const c = Number(t.dataset.col);
      if (rows[r]) {
        rows[r][c] = t.value;
        vals.runsh.LADDER = serLadder(rows);
        t.classList.toggle('st-bad', t.value !== '' && ladderCellBad(c, t.value));
        const errs = ladderRowErrors(rows);
        const errBox = root.querySelector('#st-ladder-errs');
        if (errBox) errBox.innerHTML = errs.map((er) => `<p class="st-lerr">${esc(er.msg)}</p>`).join('');
        const act = root.querySelector('#st-active');
        if (act) act.innerHTML = activeLadderHtml();
        const tag = root.querySelector('#st-f-runsh-LADDER .st-fhead');
        if (tag) {
          tag.querySelector('.st-ftag')?.remove();
          tag.insertAdjacentHTML('beforeend', vals.runsh.LADDER !== (defs.runsh.LADDER ?? '')
            ? `<button type="button" class="st-ftag custom" data-eng="runsh" data-name="LADDER" data-tip="Value differs from the built-in default — click to reset"><span class="d" aria-hidden="true"></span>CUSTOM</button>`
            : `<span class="st-ftag default" data-tip="Held at the built-in default"><span class="d" aria-hidden="true"></span>DEFAULT</span>`);
        }
        schedulePreview();
      }
    }
  }, sig);

  // ===========================================================================
  // paint
  // ===========================================================================

  envMetaEl.textContent = `${envWritable ? '.ENV WRITABLE' : '.ENV READ-ONLY'} · ENGINE V${engineVersion ?? '?'}`;
  renderTab();
  renderEngine();
  runPreview();

  cleanupFn = () => {
    dead = true;
    ac.abort();
    clearTimeout(pvTimer);
    clearTimeout(resetTimer);
    css.remove();
  };
  return cleanupFn;
}

export function destroy() { if (cleanupFn) cleanupFn(); }

export default { id: 'settings', title: 'Settings', render, destroy };

// ---------------------------------------------------------------------------
// scoped styles — injected for this view only, removed on cleanup
// ---------------------------------------------------------------------------

function ensureStyles() {
  let el = document.getElementById('st-css');
  if (!el) {
    el = document.createElement('style');
    el.id = 'st-css';
    el.textContent = CSS;
    document.head.appendChild(el);
  }
  return el;
}

const CSS = `
.st-tabs-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-4); margin-bottom: var(--s-5); }
.st-tabs { display: flex; padding: 3px; border: 1px solid var(--hairline-strong); background: var(--bg-panel); }
.st-tab {
  font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  padding: 0.5rem 1.1rem; color: var(--ink-3); border: 1px solid transparent;
  transition: color var(--dur-fast) var(--ease-standard), background var(--dur-fast) var(--ease-standard),
              border-color var(--dur-fast) var(--ease-standard);
}
.st-tab:hover { color: var(--ink); }
.st-tab[aria-pressed="true"] { color: var(--amber); background: var(--amber-a08); border-color: var(--amber-a40); }
.st-tab .st-tab-n { margin-left: 0.55rem; color: var(--amber); font-weight: 500; }
.st-engmeta { margin-left: auto; display: flex; align-items: center; gap: var(--s-4); }

.st-wrap { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 384px); gap: var(--s-5); align-items: start; }
.st-groups { display: flex; flex-direction: column; gap: var(--s-5); min-width: 0; }
.st-batchnote { color: var(--ink-2); text-transform: none; letter-spacing: 0.06em; }

.st-field { display: grid; gap: 0.45rem; padding: 0.85rem 0; border-bottom: 1px dashed var(--hairline); }
.st-field:last-child { border-bottom: none; padding-bottom: 0.15rem; }
.st-field:first-of-type { padding-top: 0.3rem; }
.st-fhead { display: flex; align-items: center; gap: var(--s-3); }
.st-flabel { font-weight: 500; font-size: var(--text-sm); color: var(--ink); }
.st-ftag {
  display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.15rem 0.5rem;
  font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--muted); border: 1px solid var(--hairline-soft); background: transparent;
}
.st-ftag .d { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
button.st-ftag:hover { color: var(--amber); border-color: var(--amber-a40); }
.st-ftag.custom { color: var(--amber); border-color: var(--amber-a24); background: var(--amber-a04); }
.st-fctl { display: flex; gap: var(--s-2); align-items: center; flex-wrap: wrap; }
.st-in {
  flex: 1; min-width: 0; padding: 0.45rem 0.6rem; background: var(--bg-deep);
  border: 1px solid var(--hairline); color: var(--ink);
  font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.02em;
  transition: border-color var(--dur-fast) var(--ease-standard);
}
.st-in:hover { border-color: var(--hairline-strong); }
.st-in:focus { border-color: var(--amber); }
.st-in.st-bad { border-color: var(--amber); box-shadow: 0 0 0 1px var(--amber-a40); }
.st-ferr { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.06em; color: var(--danger); }
.st-fhelp { font-size: var(--text-sm); color: var(--ink-3); line-height: 1.5; max-width: 68ch; }
.st-hint { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; color: var(--ink-4); white-space: nowrap; }

.st-seg { display: flex; flex-wrap: wrap; gap: 4px; }
.st-seg-btn {
  font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em; padding: 0.4rem 0.8rem;
  border: 1px solid var(--hairline); color: var(--ink-3); background: transparent;
  transition: color var(--dur-fast) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard),
              background var(--dur-fast) var(--ease-standard);
}
.st-seg-btn:hover { color: var(--ink); border-color: var(--hairline-strong); }
.st-seg-btn[aria-pressed="true"] { color: var(--amber); border-color: var(--amber-a40); background: var(--amber-a08); }

.st-field .btn, .st-lactions .btn, .st-setrow .btn { padding: 0.4rem 0.75rem; font-size: 10px; }

/* ladder editor */
.st-ladder { display: flex; flex-direction: column; gap: var(--s-3); margin-top: 0.85rem; padding-top: var(--s-4); border-top: 1px dashed var(--hairline); }
.st-ltable input {
  width: 100%; padding: 0.35rem 0.5rem; background: var(--bg-deep); border: 1px solid var(--hairline);
  font-family: var(--font-mono); font-size: 11.5px; color: var(--ink);
}
.st-ltable input:focus { border-color: var(--amber); }
.st-ltable input.st-bad { border-color: var(--amber); box-shadow: 0 0 0 1px var(--amber-a40); }
.st-ltable td { padding: 0.2rem 0.3rem; border-bottom: 1px solid var(--hairline-soft); }
.st-ltable tr.st-rowbad td { border-bottom-color: var(--amber-a40); }
.st-lblank { padding: var(--s-3) !important; font-family: var(--font-mono); font-size: 11px; color: var(--ink-4); }
.st-lrm { color: var(--muted); font-family: var(--font-mono); font-size: 13px; padding: 0.2rem 0.5rem; }
.st-lrm:hover { color: var(--danger); }
.st-lactions { display: flex; gap: var(--s-2); align-items: center; flex-wrap: wrap; }
.st-lerr { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.06em; color: var(--danger); }
.st-active { display: flex; flex-direction: column; gap: 0.35rem; margin-top: var(--s-2); padding-top: var(--s-3); border-top: 1px solid var(--hairline); }
.st-arow { display: grid; grid-template-columns: minmax(52px, auto) minmax(0, 1fr) auto; gap: var(--s-3); align-items: baseline; font-family: var(--font-mono); font-size: 11px; }
.st-arow .al { color: var(--amber); }
.st-arow .ad { color: var(--ink-3); overflow-wrap: anywhere; }
.st-arow .atag { font-size: 9px; letter-spacing: 0.14em; color: var(--muted); }
.st-arow .atag.ok { color: var(--success); }
.st-arow.dropped { opacity: 0.45; }

/* live preview panel */
.st-preview {
  position: sticky; top: var(--s-2); display: flex; flex-direction: column; gap: var(--s-3);
  padding: var(--s-5); background: var(--bg-panel); border: 1px solid var(--hairline);
  max-height: calc(100vh - 130px); overflow-y: auto;
}
.st-pv-head { display: flex; align-items: center; gap: var(--s-3); }
.st-pv-head .grow { flex: 1; }
.st-pv-sec { display: flex; flex-direction: column; gap: 0.45rem; padding-top: var(--s-3); border-top: 1px dashed var(--hairline); }
.st-errlist { display: flex; flex-direction: column; gap: 0.4rem; align-items: flex-start; }
.st-errchip { padding: 0; text-align: left; }
.st-errchip .chip { transition: border-color var(--dur-fast) var(--ease-standard); }
.st-errchip:hover .chip { border-color: var(--danger); }
.st-diffline { font-family: var(--font-mono); font-size: 11.5px; line-height: 1.7; overflow-wrap: anywhere; }
.st-diffline .k { color: var(--ink-3); }
.st-diffline .v { color: var(--amber); }
.st-dimline { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.04em; color: var(--ink-4); line-height: 1.7; }
.st-root { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 0.6rem; font-family: var(--font-mono); font-size: 11px; line-height: 1.6; }
.st-root .rk { color: var(--ink-4); letter-spacing: 0.1em; }
.st-root .rv { color: var(--ink-2); overflow-wrap: anywhere; }
.st-env summary { cursor: pointer; list-style: none; display: flex; gap: 0.5rem; align-items: center; }
.st-env summary::-webkit-details-marker { display: none; }
.st-env summary::before { content: "+"; color: var(--amber); font-family: var(--font-mono); }
.st-env[open] summary::before { content: "\\2013"; }
.st-envpre {
  margin: 0; margin-top: var(--s-2); padding: var(--s-3); background: var(--bg-deep); border: 1px solid var(--hairline);
  font-family: var(--font-mono); font-size: 11px; line-height: 1.7; color: var(--ink-3);
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto;
}
.st-actions { display: flex; gap: var(--s-2); padding-top: var(--s-3); border-top: 1px solid var(--hairline); }
.st-savemsg { min-height: 1.4rem; display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }

/* engine section */
.st-engine { margin-top: var(--s-10); }
.st-engbody { display: flex; flex-direction: column; gap: var(--s-4); }
.st-setrow { display: flex; gap: var(--s-2); align-items: center; flex-wrap: wrap; padding-top: var(--s-3); border-top: 1px dashed var(--hairline); }
.st-setrow .st-in { flex: 1 1 260px; }

@keyframes st-flash-bg { 0%, 55% { background: var(--amber-a08); } 100% { background: transparent; } }
.st-flash { animation: st-flash-bg 1.2s var(--ease-standard); }

@media (max-width: 1100px) {
  .st-wrap { grid-template-columns: 1fr; }
  .st-preview { position: static; max-height: none; }
}
`;
