// Control Room — api.js
// Async facade over the engine bridge. Two backends, one surface:
//
//   Qt runtime (no ?mock): loads qrc:///qtwebchannel/qwebchannel.js, opens a
//   QWebChannel on qt.webChannelTransport, wraps the registered "api" object.
//   Slots return JSON strings (parsed here); signals are normalised to the
//   same shapes mock.js emits:
//     on('lineReady',    ({channel, text}) => …)
//     on('reportReady',  ({channel, data}) => …)
//     on('stateChanged', (state) => …)
//
//   Browser (?mock=1, or no qt object at all): dynamic-imports mock.js,
//   which exports the identical interface plus a scripted simulator.
//
// Payload shapes are documented in mock.js and mirrored by the Python host.

const MOCK = new URLSearchParams(location.search).has('mock') ||
             typeof window.qt === 'undefined';

export const isMock = MOCK;

// The frozen bridge contract — every slot the engine exposes.
const SLOTS = [
  'getBootstrap', 'runCheck', 'dryRun', 'launchRun', 'launchBatch',
  'cancelRun', 'listInputs', 'libraryList', 'packageDetail', 'archiveList',
  'verifyPackage', 'logsList', 'logRead', 'tailStart', 'tailStop',
  'settingsGet', 'settingsPreview', 'settingsSave', 'setEnginePath',
  'pickDirectory', 'openPath', 'revealFile', 'openInPlayer', 'viewReady',
];

const SIGNALS = ['lineReady', 'reportReady', 'stateChanged'];

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

let backendPromise = null;

function qtBackend() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'qrc:///qtwebchannel/qwebchannel.js';
    s.onload = () => {
      new QWebChannel(window.qt.webChannelTransport, (channel) => {
        const obj = channel.objects.api;
        if (!obj) { reject(new Error('bridge object "api" not registered')); return; }

        const subs = { lineReady: [], reportReady: [], stateChanged: [] };
        obj.lineReady.connect((channel_, text) => {
          for (const fn of subs.lineReady) fn({ channel: channel_, text });
        });
        obj.reportReady.connect((channel_, json) => {
          for (const fn of subs.reportReady) fn({ channel: channel_, data: parseMaybeJson(json) });
        });
        obj.stateChanged.connect((json) => {
          for (const fn of subs.stateChanged) fn(parseMaybeJson(json));
        });

        const api = {
          on(signal, fn) {
            if (!subs[signal]) return () => {};
            subs[signal].push(fn);
            return () => {
              const i = subs[signal].indexOf(fn);
              if (i >= 0) subs[signal].splice(i, 1);
            };
          },
        };
        for (const slot of SLOTS) {
          api[slot] = async (...args) => {
            // Qt slots take/return strings; object args (overrides, settings
            // values) are JSON-encoded so QWebChannel never sees a QJsonValue.
            const strArgs = args.map((a) =>
              a != null && typeof a === 'object' ? JSON.stringify(a) : a);
            // Slots with return values resolve Promises; payloads arrive as
            // JSON strings. A rejected slot resolves to {ok:false,error} so
            // views keep the simple await-and-use style.
            try {
              const raw = await obj[slot](...strArgs);
              return parseMaybeJson(raw);
            } catch (err) {
              return { ok: false, error: String(err?.message || err) };
            }
          };
        }
        resolve(api);
      });
    };
    s.onerror = () => reject(new Error('qwebchannel.js failed to load'));
    document.head.appendChild(s);
  });
}

function loadBackend() {
  if (!backendPromise) {
    backendPromise = MOCK ? import('./mock.js') : qtBackend().catch((err) => {
      backendPromise = null; // allow a retry
      throw err;
    });
  }
  return backendPromise;
}

// Public facade: named slot methods + on(signal, fn) -> unsubscribe.
export const api = {
  on(signal, fn) {
    let off = () => {};
    let alive = true;
    loadBackend().then((b) => {
      if (!alive) return;
      off = b.on(signal, fn);
    }).catch(console.error);
    return () => { alive = false; off(); };
  },
};

for (const slot of SLOTS) {
  api[slot] = (...args) => loadBackend().then((b) => b[slot](...args));
}
