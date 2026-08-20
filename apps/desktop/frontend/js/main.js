// Control Room — main.js
// Hash router + keyboard layer + view lifecycle.
//
// View module contract (all views, present and future):
//   export async function render(root) -> cleanup?  (root = #view element)
//   cleanup() runs before the next view renders — use it to unsubscribe from
//   the bus and stop tails.
// Views are lazy-imported; a missing module renders the under-construction
// panel with its exit number, so other agents' views can land independently.
//
// Keyboard: 1–6 jump exits, Esc broadcasts bus 'escape', arrows roam the nav.

import { api } from './api.js';
import { bus, initShell } from './shell.js';

const ROUTES = [
  { id: 'dashboard', exit: '01', label: 'SYSTEMS',     load: () => import('./views/dashboard.js') },
  { id: 'routes',    exit: '02', label: 'ROUTES',      load: () => import('./views/routes.js') },
  { id: 'library',   exit: '03', label: 'LIBRARY',     load: () => import('./views/library.js') },
  { id: 'batch',     exit: '04', label: 'RE-ENCODER',  load: () => import('./views/batch.js') },
  { id: 'settings',  exit: '05', label: 'SETTINGS',    load: () => import('./views/settings.js') },
  { id: 'dispatch',  exit: '06', label: 'DISPATCH',    load: () => import('./views/dispatch.js') },
];

const view = document.getElementById('view');
const nav = document.getElementById('nav');

let cleanup = null;
let currentId = null;
let renderSeq = 0;

function routeFromHash() {
  const id = (location.hash.match(/^#\/([a-z0-9-]+)/) || [])[1];
  return ROUTES.find((r) => r.id === id) || ROUTES[0];
}

function buildNav() {
  nav.innerHTML = '';
  for (const r of ROUTES) {
    const a = document.createElement('a');
    a.href = `#/${r.id}`;
    a.dataset.view = r.id;
    a.innerHTML =
      `<span class="exit">EXIT ${r.exit}</span>` +
      `<span class="label">${r.label}</span>` +
      `<span class="key-hint" aria-hidden="true">${ROUTES.indexOf(r) + 1}</span>`;
    nav.appendChild(a);
  }
}

function setActiveNav(id) {
  for (const a of nav.querySelectorAll('a')) {
    a.classList.toggle('active', a.dataset.view === id);
    a.setAttribute('aria-current', a.dataset.view === id ? 'page' : 'false');
  }
}

function constructionPanel(route) {
  view.innerHTML =
    `<div class="construction grid-wash">` +
    `<span class="empty-code" aria-hidden="true">${route.exit}</span>` +
    `<h2>${route.label} — under construction</h2>` +
    `<p class="micro">EXIT ${route.exit} IS BEING BUILT · THE ROADWAY IS OPEN ELSEWHERE<br>` +
    `PRESS 1–6 TO REACH ANOTHER EXIT</p>` +
    `</div>`;
}

async function render() {
  const route = routeFromHash();
  const seq = ++renderSeq;
  currentId = route.id;
  setActiveNav(route.id);

  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }

  let mod;
  try {
    mod = await route.load();
  } catch {
    mod = null;
  }
  if (seq !== renderSeq || currentId !== route.id) return; // stale navigation

  if (mod && typeof mod.render === 'function') {
    try {
      cleanup = (await mod.render(view)) || null;
    } catch (err) {
      console.error(`view ${route.id} failed`, err);
      view.innerHTML =
        `<div class="construction grid-wash">` +
        `<span class="empty-code" aria-hidden="true">${route.exit}</span>` +
        `<h2>${route.label} — derailed</h2>` +
        `<p class="micro">${String(err?.message || err)}</p></div>`;
      cleanup = null;
    }
  } else {
    constructionPanel(route);
    cleanup = null;
  }

  view.classList.remove('view-in');
  void view.offsetWidth; // restart the reveal
  view.classList.add('view-in');
  view.scrollTop = 0;

  // viewReady fires once fonts are in and a frame has painted — the
  // screenshot harness waits on it.
  try { await document.fonts.ready; } catch {}
  requestAnimationFrame(() => {
    if (seq === renderSeq) api.viewReady(route.id).catch(() => {});
  });
}

function isTyping(t) {
  return !!(t.closest && t.closest('input, textarea, select, [contenteditable="true"]'));
}

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Escape') { bus.emit('escape'); return; }

    if (e.key >= '1' && e.key <= '6' && !isTyping(e.target)) {
      const r = ROUTES[Number(e.key) - 1];
      if (r && location.hash !== `#/${r.id}`) location.hash = `#/${r.id}`;
      return;
    }

    // roving focus through the sidebar exits
    if (e.target.closest && e.target.closest('#nav')) {
      const links = [...nav.querySelectorAll('a')];
      const i = links.indexOf(document.activeElement);
      let next = -1;
      if (e.key === 'ArrowDown') next = Math.min(links.length - 1, i + 1);
      else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = links.length - 1;
      if (next >= 0) { e.preventDefault(); links[next].focus(); }
    }
  });
}

buildNav();
wireKeyboard();
window.addEventListener('hashchange', render);

// Boot: shell first (status bar, state), then the first view.
initShell(api).finally(render);
