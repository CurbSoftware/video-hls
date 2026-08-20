import sys
from pathlib import Path

import pytest

# src-layout package; not installed into the venv during development.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from controlroom import envfile  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture()
def repo_root() -> Path:
    """Repository root (three levels up from this file)."""
    return REPO_ROOT


@pytest.fixture()
def env_example_path(repo_root) -> Path:
    return repo_root / ".env.example"


@pytest.fixture()
def env_example_values(env_example_path) -> dict:
    """The parsed .env.example: the engines' documented defaults."""
    return envfile.read_env(env_example_path)
