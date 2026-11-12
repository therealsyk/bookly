"""Central configuration for Bookly.

No absolute paths and no API keys are hardcoded: everything comes from
config.json (project root) or environment variables. Paths are resolved
relative to the project root so the app works wherever it is installed.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

# Project root = the folder that contains backend/ and frontend/.
ROOT_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT_DIR / "config.json"


def _load_config() -> Dict[str, Any]:
    """Read config.json if present; a missing file is allowed (defaults used)."""
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            return {}
        return data
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        # A broken config file should not crash the app.
        return {}


_CONFIG: Dict[str, Any] = _load_config()


def cfg(key: str, default: Any = None) -> Any:
    """Return a config value; environment variable overrides config.json."""
    env_key = key.upper().replace(".", "_")
    env_value = os.environ.get(env_key)
    if env_value is not None:
        return env_value
    return _CONFIG.get(key, default)


# --- Server ---
HOST: str = str(cfg("host", "127.0.0.1"))
PORT: int = int(cfg("port", 8000))

# --- Paths (relative to ROOT_DIR, never absolute in code) ---
DATA_DIR = ROOT_DIR / str(cfg("data_dir", "data"))
BOOKS_DIR = DATA_DIR / "books"
COVERS_DIR = DATA_DIR / "covers"
AUDIO_DIR = DATA_DIR / "audio"
FRONTEND_DIR = ROOT_DIR / str(cfg("frontend_dir", "frontend"))

DB_FILENAME = str(cfg("db_file", "bookly.db"))
DB_PATH = DATA_DIR / DB_FILENAME

# --- External sources (public, legal endpoints; no keys needed) ---
LIBRIVOX_BASE: str = str(cfg("librivox_base", "https://librivox.org"))
GUTENDEX_BASE: str = str(cfg("gutendex_base", "https://gutendex.com"))
ARCHIVE_BASE: str = str(cfg("archive_base", "https://archive.org"))

# --- Misc ---
DEFAULT_LANGUAGE: str = str(cfg("default_language", "pt-PT"))
HTTP_TIMEOUT_SEC: int = int(cfg("http_timeout_sec", 20))


def ensure_dirs() -> None:
    """Create the data folders if they do not exist yet."""
    for d in (DATA_DIR, BOOKS_DIR, COVERS_DIR, AUDIO_DIR):
        d.mkdir(parents=True, exist_ok=True)

