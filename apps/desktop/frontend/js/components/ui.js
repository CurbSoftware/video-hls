// Control Room — components/ui.js
// DOM-builder helpers. Most return HTML strings (safe to compose); interactive
// components (logStream, in progress.js) return objects. All text passed
// through esc() unless the caller wraps it in raw()/mono() deliberately.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Mark a value as pre-escaped HTML.
export function raw(html) { return { __raw: true, html: String(html) }; }
const val = (v) => (v && v.__raw ? v.html : esc(v));
const isRaw = (v) => v && v.__raw;

export function micro(text, cls = '') {
  return `<span class="micro ${cls}">${val(text)}</span>`;
}

// chip(state, text) — state: ok | warn | err | idle. Pill + status dot.
export function chip(state, text, { lg = false } = {}) {
  return `<span class="chip ${state}${lg ? ' lg' : ''}"><span class="dot" aria-hidden="true"></span>${val(text)}</span>`;
}

// btn({label, kind, icon, tip, id, disabled}) — kind: primary | ghost | danger.
export function btn({ label, kind = 'ghost', icon = '', tip = '', id = '', disabled = false, attrs = '' }) {
  const tipAttr = tip ? `data-tip="${esc(tip)}"` : '';
  const idAttr = id ? `id="${esc(id)}"` : '';
  const dis = disabled ? 'disabled' : '';
  return `<button type="button" class="btn ${kind}" ${idAttr} ${tipAttr} ${dis} ${attrs}>` +
    (icon ? `<span class="glyph" aria-hidden="true">${val(icon)}</span>` : '') +
    `${val(label)}</button>`;
}

// kv(pairs) — [[key, value], …]; mono keys, sans values. Values may be raw().
export function kv(pairs) {
  return `<dl class="kv">${pairs.map(([k, v]) =>
    `<dt>${val(k)}</dt><dd>${val(v)}</dd>`).join('')}</dl>`;
}

// card({num, title, eyebrow, right, children}) — numbered hairline panel.
export function card({ num, title, eyebrow = '', right = '', children }) {
  return `<section class="card">` +
    `<header class="card-head">` +
    `<span class="num" aria-hidden="true">${val(num)}</span>` +
    `<div><h3>${val(title)}</h3>${eyebrow ? micro(eyebrow) : ''}</div>` +
    (right ? `<span class="spacer">${isRaw(right) ? right.html : esc(right)}</span>` : '<span class="spacer"></span>') +
    `</header>${children}</section>`;
}

// laneRow({label, status, detail}) — status: ok | warn | err | idle.
// The workhorse row for encoders, tools, tiers.
export function laneRow({ label, status = 'idle', detail = '' }) {
  return `<div class="lane ${status}">` +
    `<span class="lane-dot" aria-hidden="true"></span>` +
    `<span class="lane-label">${val(label)}</span>` +
    (detail ? `<span class="lane-detail">${val(detail)}</span>` : '') +
    `</div>`;
}

// table(headers, rows) — utilitarian data table. Cells may be raw().
export function table(headers, rows) {
  const head = headers.map((h) => `<th>${val(h)}</th>`).join('');
  const body = rows.map((r) =>
    `<tr>${r.map((c) => `<td${isRaw(c) ? '' : ''}>${val(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// pageHeader({exit, title, lede, coords}) — every view's top block.
export function pageHeader({ exit, title, lede = '', coords = '' }) {
  return `<header class="page-head">` +
    `<div class="eyebrow"><span class="rule" aria-hidden="true"></span>${micro(`EXIT ${exit}`)}` +
    (coords ? `<span class="micro coords" aria-hidden="true">${val(coords)}</span>` : '') +
    `</div>` +
    `<h1>${val(title)}<span class="amber">.</span></h1>` +
    (lede ? `<p class="lede">${val(lede)}</p>` : '') +
    `</header>`;
}

// emptyState({code, headline, guidance, action}) — the onboarding moment.
export function emptyState({ code, headline, guidance, action = '' }) {
  return `<div class="empty grid-wash">` +
    `<span class="empty-code" aria-hidden="true">${val(code)}</span>` +
    `<h2>${val(headline)}</h2>` +
    (guidance ? `<p class="empty-guidance">${val(guidance)}</p>` : '') +
    (action ? `<div>${isRaw(action) ? action.html : esc(action)}</div>` : '') +
    `</div>`;
}

// sectionHead({num, title, meta}) — in-view section shoulder.
export function sectionHead({ num, title, meta = '' }) {
  return `<div class="section-head"><span class="section-num" aria-hidden="true">${val(num)}</span>` +
    `<h2>${val(title)}</h2>` +
    (meta ? `<span class="micro">${val(meta)}</span>` : '') + `</div>`;
}
