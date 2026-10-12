"""Headless click-through of the Convert wizard.

Same offscreen Qt WebEngine the screenshot smoke test uses. The page
runs with ?mock=1, so the walk does not encode and does not touch a
real engine. A child process owns the QApplication.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parents[1]
FRONTEND = APP_DIR / "frontend" / "index.html"
STEP_LABELS = [
    "1 Source",
    "2 Choose",
    "3 Resolutions",
    "4 Output",
    "5 Hardware",
    "6 Delivery",
    "7 Convert",
]


def _webengine_unavailable_reason() -> str | None:
    try:
        import PySide6.QtWebEngineWidgets  # noqa: F401
    except Exception as exc:
        return f"QtWebEngine cannot be imported: {exc!r}"
    return None


pytestmark = pytest.mark.skipif(
    _webengine_unavailable_reason() is not None,
    reason=_webengine_unavailable_reason() or "unreachable",
)


def test_convert_wizard_headless(tmp_path):
    env = dict(
        os.environ,
        QT_QPA_PLATFORM="offscreen",
        QTWEBENGINE_DISABLE_SANDBOX="1",
        QTWEBENGINE_CHROMIUM_FLAGS="--no-sandbox --disable-gpu "
                                   "--disable-dev-shm-usage",
        XDG_RUNTIME_DIR=str(tmp_path),
    )
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--wizard-ui"],
        cwd=str(APP_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, (
        proc.stdout[-4000:] + "\n" + proc.stderr[-4000:]
    )
    report = json.loads(proc.stdout.strip().splitlines()[-1])
    assert report["steps"] == STEP_LABELS
    assert report["output_rows"] == 2
    assert report["encoder"] == "CPU"
    assert report["upload"] == "Output folder only"
    assert report["cpu_only"].startswith("No GPU encoder")
    assert report["queued"] is True


class _Check:
    def __init__(self, page):
        self.page = page
        self.notes = []

    def js(self, source, ms=8000):
        from PySide6.QtCore import QEventLoop, QTimer

        box = {}
        loop = QEventLoop()

        def got(value):
            box["v"] = value
            loop.quit()

        self.page.runJavaScript(source, got)
        QTimer.singleShot(ms, loop.quit)
        loop.exec()
        if "v" not in box:
            raise AssertionError(f"no JavaScript result for {source[:180]}")
        return box["v"]

    def wait(self, expression, timeout=20):
        import time
        from PySide6.QtCore import QEventLoop, QTimer

        end = time.monotonic() + timeout
        last = None
        while time.monotonic() < end:
            last = self.js(
                "(function(){ try { return !!(" + expression + "); }"
                " catch (err) { return 'ERR ' + err; } })()",
                ms=2500,
            )
            if last is True:
                return
            loop = QEventLoop()
            QTimer.singleShot(150, loop.quit)
            loop.exec()
        raise AssertionError(f"timed out waiting for {expression}; last={last!r}")

    def click(self, selector):
        result = self.js(
            "(function(){\n"
            f"  const el = document.querySelector({json.dumps(selector)});\n"
            "  if (!el) return 'missing';\n"
            "  if (el.disabled) return 'disabled';\n"
            "  el.click();\n"
            "  return 'ok';\n"
            "})()"
        )
        if result != "ok":
            text = self.js("(document.querySelector('#view')||document.body).textContent.slice(0,500)")
            raise AssertionError(f"click {selector}: {result}\n{text}")

    def view_text(self):
        return self.js("(document.querySelector('#view')||document.body).textContent")


def _load(view, page, query):
    from PySide6.QtCore import QEventLoop, QTimer, QUrl

    url = QUrl.fromLocalFile(str(FRONTEND.resolve()))
    url.setQuery(query)
    url.setFragment("/routes")
    loop = QEventLoop()
    view.loadFinished.connect(lambda _ok: loop.quit())
    view.load(url)
    QTimer.singleShot(20000, loop.quit)
    loop.exec()
    ui = _Check(page)
    ui.wait("document.querySelector('#wz-rail button')")
    return ui


def _walk_to_output(ui):
    labels = ui.js(
        "JSON.stringify([...document.querySelectorAll('#wz-rail button')]"
        ".map((b) => b.textContent.trim()))"
    )
    assert json.loads(labels) == STEP_LABELS
    assert ui.js("document.querySelector('#wz-rail button[aria-selected=true]').textContent.trim()") == "1 Source"
    ui.click('[data-act="pick-dir"]')
    ui.wait("document.querySelector('#wz-body .wz-path')")
    picked = ui.js("document.querySelector('#wz-body .wz-path').textContent")
    assert picked == "/opt/video-hls/hls", picked
    ui.click("#wz-next")
    ui.wait("document.querySelector('[data-pick]')")
    choose = ui.view_text()
    assert "2 selected" in choose
    assert "Could not use" in choose
    assert "Audio only, no video stream." in choose
    assert "Could not read the file." in choose
    assert ui.js("document.querySelectorAll('[data-pick]:checked').length") == 2
    ui.click("#wz-next")
    ui.wait("document.querySelector('[data-tier]')")
    pressed = json.loads(ui.js(
        "JSON.stringify([...document.querySelectorAll('[data-tier]')].map("
        "(b) => [b.dataset.tier, b.getAttribute('aria-pressed')]))"
    ))
    assert pressed == [
        ["240p", "false"], ["360p", "true"], ["480p", "true"],
        ["720p", "true"], ["1080p", "true"], ["1440p", "false"],
        ["2160p", "false"],
    ]
    stranded = ui.js(
        "(function(){\n"
        "  const clickTier = (label) => document.querySelector('[data-tier=\"' + label + '\"]').click();\n"
        "  for (const label of ['360p', '480p', '720p', '1080p']) clickTier(label);\n"
        "  clickTier('2160p');\n"
        "  return JSON.stringify({\n"
        "    disabled: document.querySelector('#wz-next').disabled,\n"
        "    text: document.querySelector('#view').textContent\n"
        "  });\n"
        "})()"
    )
    stranded = json.loads(stranded)
    assert stranded["disabled"] is True
    assert "shorter than every checked size" in stranded["text"]
    restored = ui.js(
        "(function(){\n"
        "  for (const label of ['2160p', '360p', '480p', '720p', '1080p']) {\n"
        "    document.querySelector('[data-tier=\"' + label + '\"]').click();\n"
        "  }\n"
        "  return document.querySelector('#wz-next').disabled;\n"
        "})()"
    )
    assert restored is False
    ui.click("#wz-next")
    ui.wait("document.querySelector('.wz-name input')")


def _assert_output_layout(ui):
    rows = json.loads(ui.js(
        """JSON.stringify((() => {
          const out = document.querySelector('#wz-out');
          const rows = [...document.querySelectorAll('.wz-name')].map((row) => {
            const input = row.querySelector('input');
            const path = input.nextElementSibling;
            const name = input.value;
            const hits = row.textContent.split(name).length - 1;
            return {
              tag: input.tagName,
              name,
              nextClass: path && path.className,
              path: path && path.textContent,
              flex: getComputedStyle(row).flexDirection,
              inputs: row.querySelectorAll('input').length,
              nameHits: hits,
              loneName: [...row.querySelectorAll('p,span,label,h2,h3,div')]
                .some((el) => el.textContent.trim() === name),
            };
          });
          return {
            outCount: document.querySelectorAll('#wz-out').length,
            outReadonly: out.readOnly,
            outValue: out.value,
            rows,
          };
        })())"""
    ))
    assert rows["outCount"] == 1
    assert rows["outReadonly"] is True
    assert rows["outValue"] == "/opt/video-hls/hls"
    assert len(rows["rows"]) == 2
    for row in rows["rows"]:
        assert row["tag"] == "INPUT"
        assert row["inputs"] == 1
        assert row["nextClass"] == "wz-path"
        assert row["flex"] == "column"
        assert row["nameHits"] == 1
        assert row["loneName"] is False
        assert row["path"] == f"/opt/video-hls/hls/{row['name']}/master.m3u8"
    return [row["name"] for row in rows["rows"]]


def _reject_a_bad_folder_name(ui, names):
    bad = json.loads(ui.js(
        """JSON.stringify((() => {
          const input = document.querySelector('[data-name]');
          input.value = 'a/b';
          input.dispatchEvent(new Event('input', {bubbles: true}));
          return {
            err: document.querySelector('[data-name-err]').textContent,
            disabled: document.querySelector('#wz-next').disabled,
          };
        })())"""
    ))
    assert "slashes" in bad["err"]
    assert bad["disabled"] is True
    ui.js(
        "(function(){\n"
        "  const input = document.querySelector('[data-name]');\n"
        f"  input.value = {json.dumps(names[0])};\n"
        "  input.dispatchEvent(new Event('input', {bubbles: true}));\n"
        "})()"
    )
    ui.wait("document.querySelector('#wz-next') && !document.querySelector('#wz-next').disabled")


def _warn_when_the_folder_already_exists(ui, names):
    ui.js(
        "(function(){\n"
        "  const input = document.querySelector('[data-name]');\n"
        "  input.value = 'PressedMail Demo';\n"
        "  input.dispatchEvent(new Event('input', {bubbles: true}));\n"
        "})()"
    )
    ui.wait("document.querySelector('#view').textContent.includes('already in the output directory')")
    ui.js(
        "(function(){\n"
        "  const input = document.querySelector('[data-name]');\n"
        f"  input.value = {json.dumps(names[0])};\n"
        "  input.dispatchEvent(new Event('input', {bubbles: true}));\n"
        "})()"
    )
    ui.wait("!document.querySelector('#view').textContent.includes('already in the output directory')")
    ui.wait("document.querySelector('#wz-next') && !document.querySelector('#wz-next').disabled")


def _hardware_choose_cpu(ui):
    ui.click("#wz-next")
    ui.wait(
        "document.querySelector('[data-hw]') && "
        "!document.querySelector('#view').textContent.includes('Checking this machine')"
    )
    text = ui.view_text()
    assert "A GPU encoder is available (NVIDIA, VAAPI)" in text
    ui.click('[data-hw="cpu"]')
    pressed = ui.js("document.querySelector('[data-hw=cpu]').getAttribute('aria-pressed')")
    assert pressed == "true"


def _delivery_then_leave_it_off(ui):
    ui.click("#wz-next")
    ui.wait("document.querySelector('[data-act=delivery-toggle]')")
    text = ui.view_text()
    assert "keep the files in the output folder" in text
    assert ui.js("document.querySelector('#wz-next').disabled") is False
    ui.js(
        "(function(){\n"
        "  const box = document.querySelector('[data-act=delivery-toggle]');\n"
        "  box.checked = true;\n"
        "  box.dispatchEvent(new Event('change', {bubbles: true}));\n"
        "})()"
    )
    ui.wait("document.querySelector('[data-act=test-s3]')")
    assert ui.js("document.querySelector('#wz-next').disabled") is True
    assert "AllowedMethods" in ui.view_text()
    filled = ui.js(
        """(() => {
          const set = (key, value) => {
            const el = document.querySelector('[data-field="' + key + '"]');
            if (!el) return 'missing ' + key;
            el.value = value;
            el.dispatchEvent(new Event('input', {bubbles: true}));
            return 'ok';
          };
          const keys = ['access_key_id', 'secret', 'bucket'];
          const results = keys.map((key) => set(key, key === 'secret' ? 's3cret' : 'streams'));
          return results.join(',');
        })()"""
    )
    assert filled == "ok,ok,ok", filled
    assert ui.js("document.querySelector('#wz-next').disabled") is True
    ui.click('[data-act="test-s3"]')
    ui.wait("document.querySelector('#view').textContent.includes('Connection works.')")
    assert ui.js("document.querySelector('#wz-next').disabled") is False
    ui.click('[data-provider="r2"]')
    ui.wait("document.querySelector('[data-field=account_id]')")
    assert ui.js("document.querySelector('#wz-next').disabled") is True
    ui.js(
        "(function(){\n"
        "  const el = document.querySelector('[data-field=account_id]');\n"
        "  el.value = 'abc123';\n"
        "  el.dispatchEvent(new Event('input', {bubbles: true}));\n"
        "})()"
    )
    ui.click('[data-act="test-s3"]')
    ui.wait("document.querySelector('#view').textContent.includes('Connection works.')")
    ui.js(
        "(function(){\n"
        "  const box = document.querySelector('[data-act=delivery-toggle]');\n"
        "  box.checked = false;\n"
        "  box.dispatchEvent(new Event('change', {bubbles: true}));\n"
        "})()"
    )
    ui.wait("!document.querySelector('[data-act=test-s3]')")
    assert ui.js("document.querySelector('#wz-next').disabled") is False


def _summary_and_start(ui):
    ui.click("#wz-next")
    ui.wait("document.querySelector('.kv')")
    pairs = json.loads(ui.js(
        "JSON.stringify([...document.querySelectorAll('.kv dt')].map("
        "(dt, i) => [dt.textContent, document.querySelectorAll('.kv dd')[i].textContent]))"
    ))
    got = dict(pairs)
    assert got["Videos"] == "2"
    assert got["Sizes"] == "360p, 480p, 720p, 1080p"
    assert got["Output"] == "/opt/video-hls/hls"
    assert got["Encoder"] == "CPU"
    assert got["Upload"] == "Output folder only"
    masters = ui.js("document.querySelector('.wz-list').textContent")
    assert "/opt/video-hls/hls/Route 66 Demo/master.m3u8" in masters
    assert "/opt/video-hls/hls/Second Clip/master.m3u8" in masters
    ui.click("#wz-start")
    ui.wait(
        "document.querySelector('#view').textContent.includes('QUEUED') || "
        "document.querySelector('#view').textContent.includes('ENCODING')"
    )
    live = ui.view_text()
    assert "Route 66 Demo" in live
    assert "Second Clip" in live
    return got


def _cpu_only_page(view, page):
    ui = _load(view, page, "mock=1&nogpu=1")
    ui.click('[data-act="pick-dir"]')
    ui.wait("document.querySelector('#wz-body .wz-path')")
    ui.click("#wz-next")
    ui.wait("document.querySelector('[data-pick]')")
    ui.click("#wz-next")
    ui.wait("document.querySelector('[data-tier]')")
    ui.click("#wz-next")
    ui.wait("document.querySelector('.wz-name')")
    ui.click("#wz-next")
    ui.wait(
        "!document.querySelector('#view').textContent.includes('Checking this machine') && "
        "document.querySelector('#wz-next') && !document.querySelector('#wz-next').disabled"
    )
    text = ui.view_text()
    assert "No GPU encoder is available on this machine. This run uses the CPU." in text
    assert ui.js("document.querySelector('[data-hw]')") in (None, "")
    return "No GPU encoder is available on this machine. This run uses the CPU."


def _wizard_ui_main() -> int:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from PySide6.QtCore import Qt
    from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings
    from PySide6.QtWebEngineWidgets import QWebEngineView
    from PySide6.QtWidgets import QApplication

    class Page(QWebEnginePage):
        def __init__(self, parent=None):
            super().__init__(parent)
            self.msgs = []

        def javaScriptConsoleMessage(self, level, message, line, source):
            self.msgs.append(message)

    QApplication.setAttribute(Qt.AA_ShareOpenGLContexts, True)
    app = QApplication([])
    view = QWebEngineView()
    page = Page(view)
    view.setPage(page)
    page.settings().setAttribute(QWebEngineSettings.LocalContentCanAccessFileUrls, True)
    view.resize(1600, 1000)
    view.show()
    app.processEvents()
    ui = _load(view, page, "mock=1")
    _walk_to_output(ui)
    names = _assert_output_layout(ui)
    _reject_a_bad_folder_name(ui, names)
    _warn_when_the_folder_already_exists(ui, names)
    _hardware_choose_cpu(ui)
    _delivery_then_leave_it_off(ui)
    summary = _summary_and_start(ui)
    cpu_only = _cpu_only_page(view, page)
    unexpected = [msg for msg in page.msgs if "Uncaught" in msg]
    if unexpected:
        raise AssertionError("page errors: " + " | ".join(unexpected[:8]))
    print(json.dumps({
        "steps": STEP_LABELS,
        "output_rows": 2,
        "encoder": summary["Encoder"],
        "upload": summary["Upload"],
        "cpu_only": cpu_only,
        "queued": True,
    }))
    return 0


if __name__ == "__main__":
    if "--wizard-ui" in sys.argv:
        try:
            raise SystemExit(_wizard_ui_main())
        except Exception:
            import traceback
            traceback.print_exc()
            raise SystemExit(1)
