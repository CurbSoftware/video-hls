// Control Room — views/dispatch.js
// EXIT 06 · DISPATCH. The log record: archives grouped by engine, a reader
// with level filters, live tails, and a live lane while a route is running.

import { api } from '../api.js';
import { state, bus } from '../shell.js';
import { btn, pageHeader, emptyState, micro, esc } from '../components/ui.js';
import { logStream } from '../components/progress.js';
import * as edu from '../content.js';

const LEVEL_CHIPS = ['INFO', 'START', 'DONE', 'SKIP', 'WARN', 'ERROR', 'FATAL', 'RAW'];
const ENGINE_LABELS = { runsh: 'RUN.SH — PIPELINE', batch: 'ENCODE-BATCH — RE-ENCODER' };

const fmtSize = (b) => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined,
  { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export async function render(root) {
  const subs = [];
  let logs = [];
  let selected = null;     // active log entry
  let tailing = false;     // LIVE TAIL armed
  let readerMode = 'file'; // 'file' | 'live'

  root.innerHTML = `
    ${pageHeader({ exit: '06', title: 'Field notes', lede: edu.copy.dispatchLede, coords: '44.06°N 121.31°W' })}
    <div class="banner" id="dispatch-banner" hidden>
      <span class="chip warn"><span class="dot"></span>ROUTE IN PROGRESS</span>
      <span class="micro">STREAMING LIVE OUTPUT INTO THE READER</span>
    </div>
    <div class="dispatch-grid">
      <div class="loglist-col">
        <input class="finput" id="dispatch-filter" type="search"
               placeholder="Filter dispatches" aria-label="Filter log files">
        <div class="loglist" id="dispatch-list"></div>
      </div>
      <div class="reader" id="dispatch-reader"></div>
    </div>
  `;

  const listEl = root.querySelector('#dispatch-list');
  const filterEl = root.querySelector('#dispatch-filter');
  const readerEl = root.querySelector('#dispatch-reader');
  const bannerEl = root.querySelector('#dispatch-banner');

  // -- reader ------------------------------------------------------------------

  readerEl.innerHTML = `
    <div class="reader-head">
      <span class="reader-file" id="reader-file">—</span>
      <span class="spacer"></span>
      <span class="tchips" id="reader-levels" role="group" aria-label="Level filters">
        ${LEVEL_CHIPS.map((l) => `<button class="tchip" data-level="${l}" aria-pressed="true">${l}</button>`).join('')}
      </span>
      ${btn({ label: 'Live tail', kind: 'ghost', id: 'reader-tail', icon: '◉', tip: 'Follow this log as it grows', attrs: 'data-tip-end' })}
    </div>
    <div id="reader-log"></div>
  `;

  const stream = logStream(root.querySelector('#reader-log'), {});
  const fileLabel = root.querySelector('#reader-file');
  const tailBtn = root.querySelector('#reader-tail');
  const levelWrap = root.querySelector('#reader-levels');

  const hidden = new Set();
  levelWrap.addEventListener('click', (e) => {
    const b = e.target.closest('.tchip');
    if (!b) return;
    const lv = b.dataset.level;
    const on = b.getAttribute('aria-pressed') === 'true';
    b.setAttribute('aria-pressed', on ? 'false' : 'true');
    if (on) hidden.add(lv); else hidden.delete(lv);
    stream.setLevels(hidden);
  });

  // -- log list ----------------------------------------------------------------

  function renderList() {
    const q = filterEl.value.trim().toLowerCase();
    const groups = ['runsh', 'batch'].filter((eng) => logs.some((l) => l.engine === eng));
    if (!logs.length) {
      listEl.innerHTML = '';
      readerEl.innerHTML = `
        ${emptyState({
          code: '06',
          headline: 'No dispatches on file',
          guidance: 'ROUTES YOU RUN WILL LOG HERE — DEPART FROM EXIT 02 AND THE RECORD BEGINS',
        })}`;
      return;
    }
    listEl.innerHTML = groups.map((eng) => `
      <div class="engine-head micro">${ENGINE_LABELS[eng] || eng.toUpperCase()}</div>
      ${logs
        .filter((l) => l.engine === eng && (!q || l.name.toLowerCase().includes(q)))
        .map((l) => `
          <button class="logrow${selected?.path === l.path ? ' selected' : ''}" data-path="${esc(l.path)}">
            <span class="lr-name">${esc(l.name)}</span>
            <span class="lr-meta">${fmtSize(l.size_bytes)} · ${fmtDate(l.mtime)}</span>
          </button>`).join('')}
    `).join('');
  }

  async function selectLog(entry) {
    stopTail();
    selected = entry;
    readerMode = 'file';
    fileLabel.textContent = entry.name;
    tailBtn.style.display = '';
    for (const row of listEl.querySelectorAll('.logrow')) {
      row.classList.toggle('selected', row.dataset.path === entry.path);
    }
    try {
      const res = await api.logRead(entry.path, 65536);
      if (readerMode === 'file') stream.set(res.text.split('\n'));
    } catch (err) {
      stream.set([`[ERROR] could not read log: ${err?.message || err}`]);
    }
  }

  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.logrow');
    if (!row) return;
    const entry = logs.find((l) => l.path === row.dataset.path);
    if (entry) selectLog(entry);
  });

  filterEl.addEventListener('input', renderList);

  // -- live tail ------------------------------------------------------------------

  function startTail() {
    if (!selected || tailing) return;
    tailing = true;
    tailBtn.setAttribute('aria-pressed', 'true');
    tailBtn.classList.add('primary');
    stream.clear(); // tailStart replays the whole file, then appends live
    api.tailStart(selected.path).catch(() => {});
  }
  function stopTail() {
    if (!tailing) return;
    tailing = false;
    tailBtn.setAttribute('aria-pressed', 'false');
    tailBtn.classList.remove('primary');
    api.tailStop().catch(() => {});
  }
  tailBtn.addEventListener('click', () => (tailing ? stopTail() : startTail()));

  // -- live runs stream into the reader ----------------------------------------------

  function enterLive(label) {
    readerMode = 'live';
    stopTail();
    fileLabel.textContent = `LIVE — ${label}`;
    tailBtn.style.display = 'none';
    stream.clear();
  }

  subs.push(bus.on('state', (s) => {
    const running = s.busy && (s.kind === 'runsh' || s.kind === 'batch');
    bannerEl.hidden = !running;
    if (running && readerMode !== 'live') {
      enterLive(s.kind === 'batch' ? 'BATCH IN PROGRESS' : 'ROUTE IN PROGRESS');
    } else if (!s.busy && readerMode === 'live') {
      readerMode = 'file';
      fileLabel.textContent = selected ? selected.name : '—';
      tailBtn.style.display = '';
      stream.append('[INFO] — end of live output —');
    }
  }));

  subs.push(bus.on('line', (l) => {
    if (l.channel === 'tail' && tailing) { stream.append(l.text); return; }
    if (readerMode === 'live' && (l.channel === 'run' || l.channel === 'batch')) {
      stream.append(l.text);
    }
  }));

  // -- boot the view -------------------------------------------------------------------

  try {
    logs = await api.logsList();
  } catch { logs = []; }
  if (logs.error) logs = [];
  renderList();
  if (logs.length) await selectLog(logs[0]);

  // initial banner state from whatever is already running
  const runningNow = state.busy && (state.kind === 'runsh' || state.kind === 'batch');
  bannerEl.hidden = !runningNow;
  if (runningNow && readerMode !== 'live') {
    enterLive(state.kind === 'batch' ? 'BATCH IN PROGRESS' : 'ROUTE IN PROGRESS');
  }

  return () => {
    stopTail();
    subs.forEach((off) => off());
  };
}
