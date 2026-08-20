// Control Room — components/progress.js
// Live-output primitives: meter, progressLane, logStream.

import { esc } from './ui.js';

// meter(pct) — thin amber bar on an ink rail.
export function meter(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return `<span class="meter" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></span>`;
}

// progressLane({label, pct, status}) — a highway lane filling with amber.
export function progressLane({ label, pct, status = '' }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return `<div class="plane">` +
    `<div class="plane-top"><span class="plane-label">${esc(label)}</span>` +
    (status ? `<span class="micro">${esc(status)}</span>` : '') +
    `<span class="plane-pct">${p}%</span></div>` +
    `<div class="plane-track" role="progressbar" aria-label="${esc(label)}" aria-valuenow="${p}"><i style="width:${p}%"></i></div>` +
    `</div>`;
}

// logStream(el, {height}) — auto-scrolling log box.
// Levels are parsed from [TAG] markers; untagged lines render as RAW (dim).
// Returns { append, set, clear, setLevels, el }. Buffer is capped at 4000 lines.
const LINE_RE = /^(\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\])?\s*(?:\[(INFO|START|DONE|SKIP|WARN|ERROR|FATAL)\])?\s*(.*)$/;
const LEVELS = new Set(['INFO', 'START', 'DONE', 'SKIP', 'WARN', 'ERROR', 'FATAL']);
const MAX_LINES = 4000;

export function logStream(el, { minLines = 12 } = {}) {
  el.classList.add('logbox');
  el.setAttribute('tabindex', '0');
  el.setAttribute('role', 'log');
  el.setAttribute('aria-live', 'polite');

  let lines = [];          // { ts, tag, text, raw }
  let hidden = new Set();  // filtered-out level names ('RAW' = untagged)
  let stick = true;        // follow output unless the user scrolled up

  el.addEventListener('scroll', () => {
    stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
  }, { passive: true });

  function fmt({ ts, tag, text }) {
    const t = ts ? `<span class="ts">${esc(ts)}</span> ` : '';
    if (tag) {
      const body = LEVELS.has(tag) ? `<span class="tag tag-${tag.toLowerCase()}">[${tag}]</span> ${esc(text)}`
                                   : `${esc(text)}`;
      return `<span class="ln${tag === 'FATAL' ? ' fatal' : ''}">${t}${body}</span>`;
    }
    return `<span class="ln raw">${t}${esc(text)}</span>`;
  }

  function render() {
    el.innerHTML = lines
      .filter((l) => !hidden.has(l.tag || 'RAW'))
      .map(fmt)
      .join('') || `<span class="ln raw">—</span>`;
    if (stick) el.scrollTop = el.scrollHeight;
  }

  function push(text) {
    const m = LINE_RE.exec(String(text).trimEnd());
    lines.push({ ts: m?.[1] || '', tag: m?.[2] || '', text: m?.[3] ?? String(text) });
    if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  }

  return {
    el,
    append(text) { (Array.isArray(text) ? text : [text]).forEach(push); render(); },
    set(text) {
      lines = [];
      (Array.isArray(text) ? text : String(text).split('\n')).forEach((l) => { if (l.length) push(l); });
      stick = true; render();
    },
    clear() { lines = []; render(); },
    setLevels(hiddenSet) { hidden = new Set(hiddenSet); render(); },
    get lineCount() { return lines.length; },
  };
}
