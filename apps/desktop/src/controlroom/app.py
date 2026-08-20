"""app.py — QApplication + QWebEngineView window hosting the frontend.

The Api object is registered as "api" on the page's QWebChannel; the frozen
contract is BRIDGE.md.
"""

from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QIcon
from PySide6.QtWebEngineCore import QWebEngineSettings, QWebEnginePage
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWidgets import QApplication

from .api import Api

APP_NAME = "videohls-controlroom"
WINDOW_TITLE = "Control Room — video-hls"
MIN_SIZE = (1440, 900)


def resolve_frontend() -> Path | None:
    """$CONTROLROOM_FRONTEND → dev checkout → frozen share dir."""
    env = os.environ.get("CONTROLROOM_FRONTEND")
    if env:
        p = Path(env).expanduser()
        if p.is_file():
            return p
        print(f"[controlroom] CONTROLROOM_FRONTEND={env} is not a file",
              file=sys.stderr)
    here = Path(__file__).resolve()
    for anc in here.parents:  # dev: .../apps/desktop/src/controlroom → up
        cand = anc / "frontend" / "index.html"
        if cand.is_file():
            return cand
    if getattr(sys, "frozen", False):
        cand = (Path(sys.prefix).parent / "share" / APP_NAME
                / "frontend" / "index.html")
        if cand.is_file():
            return cand
    return None


class Window(QWebEngineView):
    def __init__(self, frontend: Path | None):
        super().__init__()
        self.setMinimumSize(*MIN_SIZE)
        self.setWindowTitle(WINDOW_TITLE)
        self.setContextMenuPolicy(Qt.NoContextMenu)
        page = self.page()
        page.settings().setAttribute(
            QWebEngineSettings.LocalContentCanAccessFileUrls, True)
        page.settings().setAttribute(
            QWebEngineSettings.LocalContentCanAccessRemoteUrls, True)
        if frontend is None:
            self._show_missing_frontend(page)
            return
        self.api = Api(self)
        self._channel = QWebChannel(self)
        self._channel.registerObject("api", self.api)
        page.setWebChannel(self._channel)
        icon = frontend.parent / "assets" / "icon.svg"
        if icon.is_file():
            qi = QIcon(str(icon))
            if not qi.isNull():
                self.setWindowIcon(qi)
        if os.environ.get("CONTROLROOM_DEV") == "1":
            page.settings().setAttribute(
                QWebEngineSettings.DeveloperExtrasEnabled, True)
            self.setContextMenuPolicy(Qt.DefaultContextMenu)
            print("[controlroom] dev mode: devtools enabled "
                  "(right-click → Inspect)", file=sys.stderr)
        self.load(QUrl.fromLocalFile(str(frontend)))

    def _show_missing_frontend(self, page: QWebEnginePage) -> None:
        self.api = Api(self)
        self._channel = QWebChannel(self)
        self._channel.registerObject("api", self.api)
        page.setWebChannel(self._channel)
        self.setHtml(
            "<html><body style='font-family:monospace;background:#111;"
            "color:#eee;padding:2em'>"
            "<h2>Control Room: frontend not found</h2>"
            "<p>Set <code>CONTROLROOM_FRONTEND</code> to index.html, or run "
            "from the repo (<code>apps/desktop/frontend/index.html</code>)."
            "</p></body></html>")


def create_app(argv: list[str]) -> tuple[QApplication, Window]:
    if os.environ.get("CONTROLROOM_DEV") == "1":
        os.environ.setdefault("QTWEBENGINE_REMOTE_DEBUGGING", "9222")
    QApplication.setAttribute(Qt.AA_ShareOpenGLContexts, True)
    QApplication.setApplicationName(APP_NAME)
    QApplication.setOrganizationName(APP_NAME)
    app = QApplication(argv)
    window = Window(resolve_frontend())
    return app, window


def run(argv: list[str]) -> int:
    app, window = create_app(argv)
    window.show()
    return app.exec()
