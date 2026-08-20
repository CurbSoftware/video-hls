// Control Room — shell.js
// The app chassis: a tiny pub-sub bus, shared engine state, and the status
// bar. Views never touch the bridge for state — they read `state` and
// subscribe to bus events:
//
//   bus.on('state',   fn)  engine state changed (mirrored in `state`)
//   bus.on('line',    fn)  {channel, text} — every lineReady, all channels
//   bus.on('report',  fn)  {channel, data} — every reportReady
//   bus.on('escape',  fn)  Esc pressed at shell level
//
// bus.on returns an unsubscribe; views call theirs from their cleanup.
// Payload shapes: BRIDGE.md.

const handlers = new Map();

export const bus = {
  on(evt, fn) {
    if (!handlers.has(evt)) handlers.set(evt, []);
    handlers.get(evt).push(fn);
    return () => {
      const arr = handlers.get(evt);
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  },
  emit(evt, payload) {
    for (const fn of [...(handlers.get(evt) || [])]) fn(payload);
  },
};

// Shared, read-mostly snapshot. Mutated only here; announced via bus 'state'.
export const state = {
  ready: false,        // bootstrap arrived
  engineReady: false,  // engine.root resolved
  engineVersion: null,
  busy: false,
  kind: null,          // 'runsh' | 'batch' | null
  started: null,
  lastCheck: null,     // parsed systems-check report (BRIDGE.md "check")
  hlsFreeGb: null,
  toolsMissing: [],
  bootstrap: null,
};

const $ = (id) => document.getElementById(id);

function renderSystemsChip() {
  const el = $('sb-systems');
  if (!el) return;
  if (!state.engineReady) {
    el.innerHTML = '<span class="chip err"><span class="dot"></span>SYSTEMS OFFLINE</span>';
  } else if (state.lastCheck) {
    el.innerHTML = state.lastCheck.ok
      ? '<span class="chip ok"><span class="dot"></span>SYSTEMS ONLINE</span>'
      : '<span class="chip err"><span class="dot"></span>PROBLEMS FOUND</span>';
  } else if (state.toolsMissing.length) {
    el.innerHTML = '<span class="chip err"><span class="dot"></span>TOOLS MISSING</span>';
  } else {
    el.innerHTML = '<span class="chip idle"><span class="dot"></span>SYSTEMS UNCHECKED</span>';
  }
}

function renderRunChip() {
  const el = $('sb-run');
  if (!el) return;
  el.hidden = !state.busy;
  if (state.busy) {
    const label = state.kind === 'batch' ? 'BATCH IN PROGRESS'
      : state.kind === 'runsh' ? 'ROUTE IN PROGRESS'
      : 'WORKING';
    el.innerHTML = `<span class="chip warn"><span class="dot"></span>${label}</span>`;
  }
}

function renderEngine() {
  const el = $('sb-engine');
  if (!el) return;
  const v = state.engineVersion;
  el.textContent = v && v !== 'unknown' ? `ENGINE v${v}` : 'ENGINE';
}

function renderDisk() {
  const el = $('sb-disk');
  if (!el) return;
  el.textContent = state.hlsFreeGb != null ? `HLS ROOT · ${state.hlsFreeGb.toFixed(0)} GB FREE` : '';
}

function startClock() {
  const el = $('sb-clock');
  if (!el) return;
  const tick = () => {
    const d = new Date();
    el.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, '0')).join(':');
  };
  tick();
  setInterval(tick, 1000);
}

function applyBootstrap(b) {
  state.bootstrap = b;
  state.ready = true;
  state.engineReady = !!(b.engine && b.engine.root);
  if (b.engine && b.engine.version) state.engineVersion = b.engine.version;
  state.busy = !!b.busy;
  const tools = b.tools || {};
  state.toolsMissing = Object.entries(tools)
    .filter(([, p]) => !p).map(([n]) => n);
  const hlsDisk = b.disk && b.disk.hls;
  if (hlsDisk && typeof hlsDisk.free_gb === 'number') state.hlsFreeGb = hlsDisk.free_gb;
}

function renderStatusbar() {
  renderSystemsChip();
  renderRunChip();
  renderEngine();
  renderDisk();
}

export async function initShell(api) {
  startClock();

  // Tooltips pick a side at show time so the bubble never grows past the
  // view's right edge (that would open a horizontal scrollbar). Pure-CSS
  // display; this only flips the anchor class.
  const flipTip = (el) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const viewR = document.getElementById('view').getBoundingClientRect();
    el.classList.toggle('tip-end', r.right - viewR.left + 284 > viewR.width);
  };
  document.addEventListener('pointerover', (e) => {
    flipTip(e.target.closest?.('[data-tip]'));
  });
  document.addEventListener('focusin', (e) => {
    flipTip(e.target.closest?.('[data-tip]'));
  });

  api.on('stateChanged', (s) => {
    state.busy = !!s.busy;
    state.kind = s.kind ?? null;
    state.started = s.started ?? null;
    if (s.engine_version && s.engine_version !== 'unknown') {
      state.engineVersion = s.engine_version;
    }
    renderRunChip();
    renderEngine();
    bus.emit('state', { ...state });
  });

  api.on('lineReady', (l) => bus.emit('line', l));

  api.on('reportReady', (r) => {
    if (r.channel === 'check' && r.data && !r.data.error) state.lastCheck = r.data;
    renderSystemsChip();
    bus.emit('report', r);
    bus.emit(`report:${r.channel}`, r.data);
  });

  try {
    const b = await api.getBootstrap();
    applyBootstrap(b || {});
  } catch (err) {
    console.error('bootstrap failed', err);
    state.engineReady = false;
  }
  renderStatusbar();
  bus.emit('state', { ...state });
}
