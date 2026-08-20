// Control Room — views/library.js
// EXIT 03 · LIBRARY. Routes on file: published packages ready to serve.
// PUBLISHED tab is the package grid; ARCHIVE tab lists processed sources.
// Clicking a package opens the detail drawer; DECODE-VERIFY is the hero action
// (ffmpeg decodes every tier to a null muxer — the exit status is the verdict).

import { api } from '../api.js';
import { state, bus } from '../shell.js';
import {
  chip, kv, btn, pageHeader, micro, emptyState, raw, esc, table, laneRow,
} from '../components/ui.js';
import * as edu from '../content.js';

const VERIFY_TIP =
  'ffmpeg -v fatal -allowed_extensions ALL -i master.m3u8 -f null - — asserts on exit status. ' +
  'A benign "non-existing SPS 0 referenced in buffering period" warning on TS probes is normal.';

const CSS = `
.lib-toolbar { display:flex; align-items:center; gap:var(--s-4); margin-bottom:var(--s-5); }
.lib-toolbar .count { margin-left:auto; }
.seg { display:inline-flex; border:1px solid var(--hairline); background:var(--bg-panel); }
.seg > button {
  padding:0.5rem 1.1rem; border-right:1px solid var(--hairline);
  font-family:var(--font-mono); font-size:11px; font-weight:500; letter-spacing:0.14em; text-transform:uppercase;
  color:var(--ink-4); transition:color var(--dur-fast) var(--ease-standard), background var(--dur-fast) var(--ease-standard);
}
.seg > button:last-child { border-right:none; }
.seg > button:hover { color:var(--ink-2); background:var(--bg-raise); }
.seg > button[aria-selected="true"] { color:var(--amber); background:var(--amber-a08); }
.lib-pkg { cursor:pointer; text-align:left; }
.lib-pkg:hover, .lib-pkg:focus-visible { border-color:var(--amber); }
.lib-scrim {
  position:fixed; inset:0; z-index:70; background:var(--bg-glass);
  opacity:0; pointer-events:none; transition:opacity var(--dur-base) var(--ease-standard);
}
.lib-scrim.on { opacity:1; pointer-events:auto; }
.lib-drawer {
  position:fixed; top:0; right:0; bottom:0; z-index:71; width:min(640px,94vw);
  display:flex; flex-direction:column; background:var(--bg-panel);
  border-left:1px solid var(--hairline-strong); box-shadow:var(--shadow-lg);
  transform:translateX(102%); transition:transform var(--dur-slow) var(--ease-out);
}
.lib-drawer.on { transform:none; }
.lib-drawer-head {
  display:flex; align-items:center; gap:var(--s-4);
  padding:var(--s-5) var(--s-6); border-bottom:1px solid var(--hairline);
}
.lib-drawer-head h2 {
  font-family:var(--font-display); font-weight:600; font-size:var(--text-lg);
  letter-spacing:0.01em; line-height:var(--leading-snug); overflow-wrap:anywhere;
}
.lib-drawer-head .spacer { flex:1; }
.lib-drawer-body {
  flex:1; min-height:0; overflow-y:auto; padding:var(--s-6);
  display:flex; flex-direction:column; gap:var(--s-6);
}
.lib-shoulder {
  display:flex; align-items:baseline; gap:var(--s-3);
  padding-bottom:var(--s-2); border-bottom:1px solid var(--hairline);
}
.lib-actions { display:flex; flex-wrap:wrap; gap:var(--s-3); }
.lib-verify {
  display:flex; flex-direction:column; gap:var(--s-4); align-items:flex-start;
  padding:var(--s-5); border:1px dashed var(--hairline-strong);
}
.lib-verify .lib-vres { display:flex; flex-direction:column; gap:var(--s-3); align-self:stretch; }
@keyframes lib-pulse { 0%,100% { opacity:1; } 50% { opacity:0.25; } }
.lib-working .dot { animation:lib-pulse 1.15s var(--ease-standard) infinite; }
.lib-tail {
  max-height:180px; margin:0; overflow:auto; white-space:pre-wrap;
  font-family:var(--font-mono); font-size:11px; line-height:1.6; color:var(--danger);
  background:var(--bg-deep); border:1px solid var(--hairline); padding:var(--s-3) var(--s-4);
}
@media (max-width:1100px) { .lib-drawer { width:min(560px,96vw); } }
`;

const fmtDate = (iso) => iso
  ? new Date(iso).toLocaleString(undefined,
    { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).toUpperCase()
  : '';
const fmtBytes = (b) => (typeof b === 'number'
  ? b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${(b / 1048576).toFixed(1)} MB`
  : '');
const mono = (s) => `<span class="mono">${esc(s)}</span>`;
const pad2 = (n) => String(n).padStart(2, '0');

// Codec family from an encoder name (h264_nvenc → h264) — the list payload
// carries the encoder, not the codec.
const codecOf = (p) => p.video_codec ?? p.meta?.video_codec
  ?? (/(h264|hevc|av1)/.exec(p.video_encoder ?? p.meta?.video_encoder ?? '') || [])[1]
  ?? null;

export async function render(root) {
  const subs = [];
  let tab = 'published';
  let packages = [];
  let archive = [];
  let openName = null;       // package whose drawer is open
  let lastFocus = null;      // element to restore focus to on close
  let verifyT0 = 0;          // performance.now() at verify click

  root.innerHTML = `
    <style>${CSS}</style>
    ${pageHeader({
      exit: '03', title: 'Routes on file',
      lede: 'Published packages ready to serve. Every tier verified, every codec string derived from the encoded frames — never hardcoded.',
      coords: '44.06°N 121.31°W',
    })}
    <div class="lib-toolbar">
      <div class="seg" role="tablist" aria-label="Library sections">
        <button role="tab" id="lib-tab-published" aria-selected="true" aria-controls="lib-body">Published</button>
        <button role="tab" id="lib-tab-archive" aria-selected="false" aria-controls="lib-body">Archive</button>
      </div>
      <span class="micro count" id="lib-count"></span>
    </div>
    <div id="lib-body" role="tabpanel"></div>
    <div class="lib-scrim" id="lib-scrim" aria-hidden="true"></div>
    <aside class="lib-drawer" id="lib-drawer" role="dialog" aria-modal="true" aria-label="Package detail" hidden>
      <div class="lib-drawer-head">
        <h2 id="lib-drawer-name">—</h2>
        <span class="spacer"></span>
        ${btn({ label: 'Close', kind: 'ghost', id: 'lib-drawer-close', icon: '×', tip: 'Esc also closes' })}
      </div>
      <div class="lib-drawer-body" id="lib-drawer-body"></div>
    </aside>
  `;

  const bodyEl = root.querySelector('#lib-body');
  const countEl = root.querySelector('#lib-count');
  const scrimEl = root.querySelector('#lib-scrim');
  const drawerEl = root.querySelector('#lib-drawer');
  const drawerNameEl = root.querySelector('#lib-drawer-name');
  const drawerBodyEl = root.querySelector('#lib-drawer-body');

  const tierCount = (p) => p.tier_count ?? p.tiers?.length ?? null;
  const masterOf = (p) => p.master ?? (p.path ? `${p.path.replace(/\/$/, '')}/master.m3u8` : null);
  const processedRoot = () => state.bootstrap?.roots?.processed ?? '';

  const srcRes = (p) => {
    if (p.source?.width) return `${p.source.width} × ${p.source.height}`;
    if (p.meta?.source_width) return `${p.meta.source_width} × ${p.meta.source_height}`;
    return p.meta?.resolution ?? null;
  };

  // -- grid ------------------------------------------------------------------

  function pkgCard(p, i) {
    const tc = tierCount(p);
    const chips = [
      p.error
        ? chip('err', 'CORRUPT MASTER')
        : chip('ok', `${tc ?? '?'} TIER${tc === 1 ? '' : 'S'}`),
      codecOf(p) ? chip('idle', codecOf(p)) : '',
      (p.segment_type ?? p.meta?.segment_type)
        ? chip('idle', (p.segment_type ?? p.meta.segment_type) === 'fmp4' ? 'fMP4' : (p.segment_type ?? p.meta.segment_type).toUpperCase())
        : '',
    ].join('');
    const gop = p.gop_size ?? p.meta?.gop_size;
    return `
      <article class="card lib-pkg" role="button" tabindex="0" data-name="${esc(p.name)}"
               aria-label="Open package ${esc(p.name)}">
        <header class="card-head">
          <span class="num" aria-hidden="true">${pad2(i + 1)}</span>
          <div>
            <h3>${esc(p.name)}</h3>
            ${micro(`PUBLISHED ${fmtDate(p.mtime ?? p.created) || '—'}`)}
          </div>
          <span class="spacer micro">${gop ? `GOP ${esc(String(gop))}` : ''}</span>
        </header>
        <div class="lib-chips">${chips}</div>
        ${kv([
          ['SOURCE', srcRes(p) ?? '—'],
          ['ENCODER', (p.video_encoder ?? p.meta?.video_encoder)
            ? raw(`<span class="mono amber-text">${esc(p.video_encoder ?? p.meta.video_encoder)}</span>`)
            : '—'],
        ])}
      </article>`;
  }

  function renderGrid() {
    if (!packages.length) {
      bodyEl.innerHTML = emptyState({
        code: '03',
        headline: 'No routes on file',
        guidance: 'RUN A ROUTE FROM EXIT 02 — FINISHED PACKAGES PUBLISH HERE',
        action: btn({ label: 'Go to routes', kind: 'ghost', attrs: 'data-goto="routes"' }),
      });
      return;
    }
    bodyEl.innerHTML = `<div class="card-grid">${packages.map(pkgCard).join('')}</div>`;
  }

  function renderArchive() {
    if (!archive.length) {
      bodyEl.innerHTML = emptyState({
        code: 'A',
        headline: 'Archive empty',
        guidance: 'SOURCES MOVE HERE AFTER A SUCCESSFUL ROUTE — NOTHING ON FILE YET',
      });
      return;
    }
    const root0 = processedRoot();
    const rows = archive.map((a) => {
      const name = a.rel ?? a.name ?? '—';
      const abs = a.path ?? (root0 ? `${root0}/${a.rel}` : name);
      return [
        raw(mono(name)),
        esc(fmtBytes(a.size_bytes) || (a.size_mb != null ? `${a.size_mb} MB` : '—')),
        raw(btn({ label: 'Reveal', kind: 'ghost', attrs: `data-reveal="${esc(abs)}"`, tip: 'Open the containing folder' })),
      ];
    });
    bodyEl.innerHTML = table(['SOURCE', 'SIZE', ''], rows);
  }

  function renderBody() {
    countEl.textContent = tab === 'published'
      ? `${packages.length} PACKAGE${packages.length === 1 ? '' : 'S'}`
      : `${archive.length} SOURCE${archive.length === 1 ? '' : 'S'}`;
    if (tab === 'published') renderGrid(); else renderArchive();
  }

  // -- drawer ------------------------------------------------------------------

  function openDrawer(name, trigger) {
    lastFocus = trigger ?? document.activeElement;
    openName = name;
    drawerNameEl.textContent = name;
    drawerEl.hidden = false;
    requestAnimationFrame(() => {
      drawerEl.classList.add('on');
      scrimEl.classList.add('on');
      scrimEl.setAttribute('aria-hidden', 'false');
    });
    root.querySelector('#lib-drawer-close').focus();
    drawerBodyEl.innerHTML = `<span class="micro">READING ${esc(name)} / master.m3u8 …</span>`;
    loadDetail(name);
  }

  function closeDrawer() {
    if (!openName) return;
    openName = null;
    drawerEl.classList.remove('on');
    scrimEl.classList.remove('on');
    scrimEl.setAttribute('aria-hidden', 'true');
    setTimeout(() => { if (!openName) drawerEl.hidden = true; }, 300);
    lastFocus?.focus?.();
  }

  async function loadDetail(name) {
    let res = null;
    try { res = await api.packageDetail(name); } catch { res = null; }
    if (openName !== name) return; // drawer moved on
    if (!res || res.error || res.ok === false) {
      drawerBodyEl.innerHTML = emptyState({
        code: '!!',
        headline: 'Package unreadable',
        guidance: `MASTER PLAYLIST DID NOT PARSE — ${String(res?.error || 'no detail').toUpperCase()}`,
      });
      return;
    }
    renderDetail(res);
  }

  function renderDetail(res) {
    const p = res.package ?? res;           // bridge: flat; older mocks: wrapped
    const meta = p.meta ?? {};
    const master = res.master ?? p.master ?? masterOf(p) ?? '';
    const tiers = p.tiers ?? [];
    const encoder = p.video_encoder ?? meta.video_encoder ?? null;
    const audio = p.audio_codec ?? meta.audio_codec ?? null;
    const segType = p.segment_type ?? meta.segment_type ?? null;
    const segTip = edu.segmentTypes
      ? `${edu.segmentTypes.headline} — MPEG-TS carries only H.264 + AAC; HEVC, AV1 and Opus force fMP4 and playlist version 7.`
      : 'Container follows the codec';

    drawerBodyEl.innerHTML = `
      <div class="lib-actions">
        ${btn({ label: 'Open in player', kind: 'primary', icon: '▸', id: 'lib-play', tip: 'mpv if present, else vlc, else the desktop default' })}
        ${btn({ label: 'Reveal', kind: 'ghost', id: 'lib-reveal', tip: 'Open the directory containing this package' })}
        ${btn({ label: 'Copy path', kind: 'ghost', id: 'lib-copy', tip: 'Absolute path of master.m3u8' })}
      </div>

      <div class="lib-verify grid-wash">
        <div class="lib-shoulder">
          <span class="micro" style="color:var(--amber)">DECODE-VERIFY</span>
          <span class="micro" style="margin-left:auto">FFMPEG → NULL MUXER</span>
        </div>
        ${btn({ label: 'Decode-verify', kind: 'primary', icon: '▸', id: 'lib-verify-btn', tip: VERIFY_TIP })}
        <div class="lib-vres" id="lib-verify-out"></div>
      </div>

      <div>
        <div class="lib-shoulder"><span class="micro">PACKAGE</span></div>
        ${kv([
          ['SOURCE', meta.source || p.source?.name || '—'],
          ['W × H', srcRes(p) ?? '—'],
          ['VIDEO CODEC', raw(mono(codecOf(p) ?? '—'))],
          ['VIDEO ENCODER', encoder ? raw(`<span class="mono amber-text">${esc(encoder)}</span>`) : '—'],
          ['AUDIO CODEC', audio ? raw(mono(audio)) : raw(`<span class="mono">none (silent source)</span>`)],
          ['SEGMENT TYPE', raw(`<span class="mono" data-tip="${esc(segTip)}">${esc(segType ?? '—')}</span>`)],
          ['SEGMENT DURATION', raw(mono(`${p.segment_duration ?? meta.segment_duration ?? '—'}s`))],
          ['GOP SIZE', raw(`<span class="mono" data-tip="${esc(edu.gopCoupling?.headline ?? 'GOP = round(fps × HLS_TIME)')}">${p.gop_size ?? meta.gop_size ?? '—'}</span>`)],
          ...(p.subtitles != null ? [['SUBTITLES', raw(mono(String(p.subtitles)))]] : []),
          ...(p.playlist_version ?? meta.playlist_version
            ? [['PLAYLIST', raw(mono(`#EXT-X-VERSION:${p.playlist_version ?? meta.playlist_version}`))]] : []),
          ...(p.segments_per_tier != null ? [['SEGMENTS / TIER', raw(mono(String(p.segments_per_tier)))]] : []),
        ])}
      </div>

      <div>
        <div class="lib-shoulder"><span class="micro">VARIANTS — ${tiers.length}</span></div>
        ${table(
          ['URI', 'RESOLUTION', 'BANDWIDTH', 'AVG-BANDWIDTH', 'CODECS'],
          tiers.map((t) => [
            raw(mono(t.uri ?? (t.label ? `${t.label}/index.m3u8` : '—'))),
            raw(mono(t.resolution ?? (t.width ? `${t.width}×${t.height}` : '—'))),
            raw(mono(t.bandwidth != null ? Number(t.bandwidth).toLocaleString('en-US') : '—')),
            raw(mono(t.avg_bandwidth != null ? Number(t.avg_bandwidth).toLocaleString('en-US') : '—')),
            raw(`<span class="mono amber-text" data-tip="Read back from the encoded file — never hardcoded">${esc(t.codecs ?? '—')}</span>`),
          ]),
        )}
      </div>`;

    drawerBodyEl.querySelector('#lib-play').addEventListener('click', () => api.openInPlayer(master).catch(() => {}));
    drawerBodyEl.querySelector('#lib-reveal').addEventListener('click', () => api.revealFile(master).catch(() => {}));
    const copyBtn = drawerBodyEl.querySelector('#lib-copy');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(master);
        copyBtn.textContent = 'COPIED';
        setTimeout(() => { copyBtn.innerHTML = 'COPY PATH'; }, 1400);
      } catch { /* clipboard unavailable — no-op */ }
    });
    drawerBodyEl.querySelector('#lib-verify-btn').addEventListener('click', () => startVerify(p.name));
  }

  // -- decode-verify -------------------------------------------------------------
  // Qt delivers the verdict only via reportReady("verify") — the awaited call
  // resolves to nothing there. Trust the signal; the call just triggers it.

  function startVerify(name) {
    const out = drawerBodyEl.querySelector('#lib-verify-out');
    const vbtn = drawerBodyEl.querySelector('#lib-verify-btn');
    if (!out || !vbtn) return;
    verifyT0 = performance.now();
    vbtn.setAttribute('aria-disabled', 'true');
    out.innerHTML = `
      <span class="chip warn lg lib-working"><span class="dot" aria-hidden="true"></span>DECODING — EVERY TIER, EVERY SEGMENT</span>`;
    api.verifyPackage(name).catch((err) => {
      renderVerify({ name, ok: false, error: String(err?.message || err) });
    });
  }

  function renderVerify(d) {
    if (openName !== d.name) return;
    const out = drawerBodyEl.querySelector('#lib-verify-out');
    if (!out) return;
    drawerBodyEl.querySelector('#lib-verify-btn')?.setAttribute('aria-disabled', 'false');

    if (d.error === 'busy') {
      out.innerHTML = `<span class="chip warn"><span class="dot" aria-hidden="true"></span>VERIFY BUSY — ANOTHER DECODE IS IN FLIGHT</span>`;
      return;
    }
    if (d.ok) {
      const dur = d.duration_s ?? (performance.now() - verifyT0) / 1000;
      const checks = (d.checks || []).map((c) => laneRow({
        label: c.label, status: c.ok ? 'ok' : 'err', detail: c.detail ?? '',
      })).join('');
      out.innerHTML = `
        <span class="chip ok lg"><span class="dot" aria-hidden="true"></span>VERIFIED — DECODES CLEAN · ${dur.toFixed ? dur.toFixed(1) : dur}S</span>
        ${checks ? `<div class="lane-list">${checks}</div>` : ''}`;
    } else {
      out.innerHTML = `
        <span class="chip err lg"><span class="dot" aria-hidden="true"></span>DECODE FAILED — EXIT ${d.exit_code ?? '?'}</span>
        ${d.stderr_tail ? `<pre class="lib-tail">${esc(d.stderr_tail)}</pre>` : ''}
        ${d.error ? `<span class="micro">${esc(String(d.error).toUpperCase())}</span>` : ''}`;
    }
  }

  // -- events ---------------------------------------------------------------------

  bodyEl.addEventListener('click', (e) => {
    const reveal = e.target.closest('[data-reveal]');
    if (reveal) { api.revealFile(reveal.dataset.reveal).catch(() => {}); return; }
    const goto = e.target.closest('[data-goto]');
    if (goto) { location.hash = `#/${goto.dataset.goto}`; return; }
    const card = e.target.closest('.lib-pkg');
    if (card) openDrawer(card.dataset.name, card);
  });
  bodyEl.addEventListener('keydown', (e) => {
    const card = e.target.closest('.lib-pkg');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDrawer(card.dataset.name, card); }
  });

  root.querySelector('#lib-tab-published').addEventListener('click', () => setTab('published'));
  root.querySelector('#lib-tab-archive').addEventListener('click', () => setTab('archive'));
  function setTab(t) {
    tab = t;
    root.querySelector('#lib-tab-published').setAttribute('aria-selected', t === 'published');
    root.querySelector('#lib-tab-archive').setAttribute('aria-selected', t === 'archive');
    renderBody();
  }

  root.querySelector('#lib-drawer-close').addEventListener('click', closeDrawer);
  scrimEl.addEventListener('click', closeDrawer);
  subs.push(bus.on('escape', closeDrawer));
  subs.push(bus.on('report:verify', renderVerify));

  // -- boot -----------------------------------------------------------------------

  try { packages = (await api.libraryList()) ?? []; } catch { packages = []; }
  try { archive = (await api.archiveList()) ?? []; } catch { archive = []; }
  renderBody();

  return () => subs.forEach((off) => off());
}
