r"""Read and write the engines' .env files.

run.sh sources .env as bash, so anything this module writes must be valid
shell. Every managed value is emitted as ``VAR="${VAR:-value}"`` which keeps
the engines' precedence intact: an exported variable still wins over the
file, and the file still wins over the built-in default.

Escaping follows bash double-quote rules exactly: backslash only escapes
``$``, `` ` ``, ``"`` and ``\``; any other backslash sequence is literal.
"""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

_ASSIGN_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=")
# A complete double-quoted value, escape-aware, with an optional trailing
# comment the way .env.example writes them: VAR="value"  # note.
_QUOTED_RE = re.compile(r'^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$')
# The inner part of ${NAME:-value}, value captured greedily up to the final }.
_PARAM_RE = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*:-(.*)\}$", re.S)
_TRAILING_COMMENT_RE = re.compile(r"\s#")


def read_env(path) -> dict[str, str]:
    """Parse a .env into a plain str dict.

    Handles both ``VAR=value`` and ``VAR="${VAR:-value}"`` forms; the
    ``${NAME:-...}`` wrapper is unwrapped and double-quote escapes are
    decoded. Comments, blank and unparseable lines are skipped silently
    (write_env preserves the latter from the existing file). A missing file
    yields {}.
    """
    try:
        text = Path(path).read_text()
    except OSError:
        return {}
    values: dict[str, str] = {}
    for line in text.splitlines():
        m = _ASSIGN_RE.match(line)
        if not m:
            continue
        rhs = line[m.end():].strip()
        qm = _QUOTED_RE.match(rhs)
        if qm:
            inner = qm.group(1)
            pm = _PARAM_RE.match(inner)
            values[m.group(1)] = _unescape_dq(pm.group(1) if pm else inner)
        else:
            cm = _TRAILING_COMMENT_RE.search(rhs)
            values[m.group(1)] = rhs[:cm.start()] if cm else rhs
    return values


def write_env(path, values: dict[str, str], specs: dict, engine_root: Path,
              header: str) -> None:
    """Write a minimal-diff .env atomically (tmp file + os.replace).

    Only settings whose value differs from the spec default get a line, so
    returning a value to its default removes the override. Unknown variables
    and mid-file comments from the existing file are preserved verbatim; the
    leading comment block is replaced by ``header``.

    ``engine_root`` is accepted for call-site symmetry with env_preview but
    does not affect the content - the target path is decided by the caller
    (see env_file_path).
    """
    path = Path(path)
    existing = path.read_text() if path.exists() else ""
    text = _render(values, specs, header, existing)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def env_preview(values: dict[str, str], specs: dict, engine_root: Path,
                header: str) -> str:
    """Render exactly what write_env would produce for a fresh file."""
    return _render(values, specs, header, "")


def env_file_path(engine_root: Path) -> Path:
    """Where a managed .env lives: engine_root/.env when writable, else the
    user config dir (for read-only engine checkouts)."""
    engine_root = Path(engine_root)
    if engine_root.is_dir() and os.access(engine_root, os.W_OK):
        return engine_root / ".env"
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base) if base else Path.home() / ".config"
    return root / "videohls-controlroom" / "engine.env"


def _render(values: dict[str, str], specs: dict, header: str,
            existing_text: str) -> str:
    out = [header.rstrip("\n"), ""]
    for name, spec in specs.items():
        v = values.get(name, spec.default)
        if v == spec.default:
            continue
        if "\n" in v or "\r" in v:
            raise ValueError(f"{name}: value must not contain newlines: {v!r}")
        out.append(f'{name}="${{{name}:-{_escape_dq(v)}}}"')

    # Preserve everything except the old header block and the managed keys.
    old = existing_text.splitlines() if existing_text else []
    i = 0
    while i < len(old) and (not old[i].strip() or old[i].lstrip().startswith("#")):
        i += 1
    tail = [line for line in old[i:] if _ASSIGN_RE.match(line) is None
            or _ASSIGN_RE.match(line).group(1) not in specs]
    if tail:
        out.append("")
        out.extend(tail)
    return "\n".join(out) + "\n"


def _escape_dq(v: str) -> str:
    """Escape a value for a double-quoted bash context."""
    return (v.replace("\\", "\\\\").replace('"', '\\"')
             .replace("`", "\\`").replace("$", "\\$"))


def _unescape_dq(v: str) -> str:
    """Undo _escape_dq; any other backslash sequence stays literal, as in
    bash double quotes (the engines' regex defaults rely on this)."""
    out: list[str] = []
    i = 0
    while i < len(v):
        if v[i] == "\\" and i + 1 < len(v) and v[i + 1] in '\\"`$':
            out.append(v[i + 1])
            i += 2
        else:
            out.append(v[i])
            i += 1
    return "".join(out)
