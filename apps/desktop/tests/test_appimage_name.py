"""The Linux package file name carries the desktop app version."""

from __future__ import annotations

import re
import subprocess

from controlroom import __version__

EXPECTED = "CurbStream-0.1.0-x86_64.AppImage"


def _pyproject_version(repo_root) -> str:
    text = (repo_root / "apps" / "desktop" / "pyproject.toml").read_text()
    match = re.search(r'^version = "([^"]+)"', text, re.M)
    assert match, "apps/desktop/pyproject.toml has no version"
    return match.group(1)


def test_pyproject_and_package_version_are_0_1_0(repo_root):
    assert _pyproject_version(repo_root) == "0.1.0"
    assert __version__ == "0.1.0"


def test_appimage_script_writes_the_versioned_name(repo_root):
    script = (repo_root / "packaging" / "appimage.sh").read_text()
    assert 'APPIMAGE_PATH="$PKG_DIR/CurbStream-${APP_VERSION}-x86_64.AppImage"' in script
    assert 'mv "$produced" "$APPIMAGE_PATH"' in script
    version_line = [
        line for line in script.splitlines()
        if line.startswith("APP_VERSION=")
    ]
    assert version_line == [
        'APP_VERSION="$(sed -n \'s/^version = "\\([^"]*\\)"/\\1/p\' '
        '"$DESKTOP_APP/pyproject.toml" | head -n1)"'
    ]
    assert 'APPIMAGE_PATH="$PKG_DIR/CurbStream-x86_64.AppImage"' not in script


def test_same_sed_the_script_uses_prints_the_versioned_file(repo_root):
    desktop = repo_root / "apps" / "desktop"
    proc = subprocess.run(
        [
            "bash", "-c",
            'APP_VERSION="$(sed -n \'s/^version = "\\([^"]*\\)"/\\1/p\' '
            '"$1/pyproject.toml" | head -n1)"\n'
            'printf \'CurbStream-%s-x86_64.AppImage\\n\' "$APP_VERSION"\n',
            "bash",
            str(desktop),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == EXPECTED


def test_release_workflow_uploads_the_versioned_file(repo_root):
    workflow = (repo_root / ".github" / "workflows" / "release.yml").read_text()
    assert "path: packaging/CurbStream-*-x86_64.AppImage" in workflow
    assert "packaging/CurbStream-*-x86_64.AppImage --clobber" in workflow
    import fnmatch
    assert fnmatch.fnmatch(EXPECTED, "CurbStream-*-x86_64.AppImage")
