"""Convert-wizard rules that live in the page, evaluated without a browser.

PySide6's QJSEngine runs the pure helpers in routes.js. The output-step
markup and the column layout are checked against the source the page
actually ships. The headless click-through is test_wizard_ui.py.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"
ROUTES = FRONTEND / "js" / "views" / "routes.js"
VIEWS_CSS = FRONTEND / "css" / "views.css"

STEPS = [
    ("source", "Source"),
    ("choose", "Choose"),
    ("sizes", "Resolutions"),
    ("output", "Output"),
    ("hardware", "Hardware"),
    ("delivery", "Delivery"),
    ("convert", "Convert"),
]


def _pyside_unavailable_reason() -> str | None:
    try:
        import PySide6.QtCore  # noqa: F401
    except Exception as exc:
        return f"PySide6 cannot be imported: {exc!r}"
    return None


pytestmark = pytest.mark.skipif(
    _pyside_unavailable_reason() is not None,
    reason=_pyside_unavailable_reason() or "unreachable",
)


def _extract_function(src: str, name: str) -> str:
    token = f"function {name}("
    start = src.index(token)
    brace = src.index("{", start)
    depth = 0
    for index, char in enumerate(src[brace:], brace):
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return src[start:index + 1]
    raise AssertionError(f"unclosed function {name}")


def _css_block(css: str, selector: str) -> str:
    token = selector + " {"
    start = css.index(token)
    end = css.index("}", start)
    return css[start:end]


@pytest.fixture(scope="module")
def wizard():
    from PySide6.QtCore import QCoreApplication
    from PySide6.QtQml import QJSEngine

    if QCoreApplication.instance() is None:
        QCoreApplication([])
    src = ROUTES.read_text()
    chunk = src[src.index("const STEPS"):src.index("export async function render")]
    chunk += """
    ({
      ids: STEPS.map((s) => s.id),
      labels: STEPS.map((s) => s.label),
      lines: STEPS.map((s) => s.line),
      fallback: FALLBACK_LADDER.map((r) => r.label),
      space: nameProblem('  clip', ['  clip']),
      empty: nameProblem('', ['']),
      dot: nameProblem('.', ['.']),
      dots: nameProblem('..', ['..']),
      slash: nameProblem('a/b', ['a/b']),
      back: nameProblem('a\\\\b', ['a\\\\b']),
      dup: nameProblem('Beach', ['Beach', 'Beach']),
      ok: nameProblem('Beach Day', ['Beach Day']),
      joined: joinPath('/srv/hls/', 'Beach Day'),
      bare: joinPath('', 'Beach'),
      stem: stemOf('folder/Beach Day.mp4'),
      gpu: usableGpu({video_encoders: [
        {encoder: 'h264_nvenc', status: 'USABLE'},
        {encoder: 'h264_vaapi', status: 'USABLE'},
        {encoder: 'libx264', status: 'USABLE'},
        {encoder: 'h264_qsv', status: 'built, not usable here'},
      ]}),
      cpu: usableGpu({video_encoders: [{encoder: 'libx264', status: 'USABLE'}]}),
      none: usableGpu(null),
      mb: fmtSize(155317760),
      gb: fmtSize(2 * 1024 * 1048576),
      dur: fmtDur(164.4),
    })
    """
    engine = QJSEngine()
    value = engine.evaluate(chunk, str(ROUTES))
    assert not value.isError(), value.toString()
    return value.toVariant()


def test_steps_are_source_choose_resolutions_output_hardware_delivery_convert(wizard):
    assert list(zip(wizard["ids"], wizard["labels"])) == STEPS
    assert all(line.strip() for line in wizard["lines"])
    assert "Original files stay where they are." in wizard["lines"][-1]


def test_fallback_ladder_matches_the_engine_builtin(wizard):
    from controlroom import convert

    assert wizard["fallback"] == [row["label"] for row in convert.builtin_ladder()]


def test_folder_name_rules(wizard):
    assert "space" in wizard["space"]
    assert wizard["empty"] == "Use a folder name."
    assert wizard["dot"] == "Use a folder name."
    assert wizard["dots"] == "Use a folder name."
    assert "slashes" in wizard["slash"]
    assert "slashes" in wizard["back"]
    assert wizard["dup"] == "Two videos would share this folder."
    assert wizard["ok"] == ""


def test_path_and_size_helpers(wizard):
    assert wizard["joined"] == "/srv/hls/Beach Day"
    assert wizard["bare"] == "/Beach"
    assert wizard["stem"] == "Beach Day"
    assert wizard["gpu"] == ["nvenc", "vaapi"]
    assert wizard["cpu"] == []
    assert wizard["none"] == []
    assert wizard["mb"].endswith("MB")
    assert wizard["gb"].endswith("GB")
    assert wizard["dur"] == "2:44"


def test_output_row_shows_the_folder_name_once_and_the_path_on_the_next_row():
    body = _extract_function(ROUTES.read_text(), "outputHtml")
    row_at = body.index('<div class="wz-name"')
    row = body[row_at:body.index("</div>`;", row_at)]
    input_at = row.index("<input")
    path_at = row.index('<p class="wz-path"')
    assert input_at < path_at
    between = row[input_at:path_at]
    assert "<p" not in between
    assert "<span" not in between
    assert "<h2" not in row and "<h3" not in row and "<label" not in row
    assert row.count("<input") == 1
    assert row.count('class="wz-path"') == 1
    assert 'value="${esc(name)}"' in row
    assert ">${esc(name)}<" not in row
    assert "/master.m3u8" in row
    assert "joinPath(outputDir || 'output', name || '…')" in row
    assert 'id="wz-out"' in body
    assert "readonly" in body


def test_output_rows_stack_the_path_under_the_name():
    css = VIEWS_CSS.read_text()
    name = _css_block(css, ".wz-name")
    assert "display: flex" in name
    assert "flex-direction: column" in name
    path = _css_block(css, ".wz-path")
    assert "overflow-wrap: anywhere" in path


def test_run_overrides_keep_originals_and_force_browser_codecs():
    src = ROUTES.read_text()
    body = _extract_function(src, "runOverrides")
    assert "ARCHIVE_SOURCE: 'false'" in body
    assert "VIDEO_CODEC: 'h264'" in body
    assert "AUDIO_CODEC: 'aac'" in body
    assert "HWACCEL: hw === 'gpu' ? 'auto' : 'none'" in body
    assert "INPUT_ROOT: inputRoot" in body
    assert "HLS_ROOT: outputDir" in body
    assert "MIN_RESOLUTION_HEIGHT" in body
    assert "MAX_RESOLUTION_HEIGHT" in body


def test_delivery_step_offers_s3_and_the_cors_policy():
    src = ROUTES.read_text()
    assert "Upload finished packages" in src
    assert "Amazon S3" in src
    assert "Cloudflare R2" in src
    assert "Other S3" in src
    assert '"AllowedMethods": ["GET", "HEAD"]' in src
    assert "Test connection" in src
    assert "Apply to this bucket" in src
