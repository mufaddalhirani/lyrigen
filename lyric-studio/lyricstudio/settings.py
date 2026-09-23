"""Remembered choices: the last folder, model, level and format.

Opening the file picker in Downloads every single time was one of the first
things wrong with the in-app version; this is where the last folder lives.
"""
from __future__ import annotations

import json
import os

DEFAULTS = {
    "last_folder": None,
    "model": "base",
    "level": "syllable",
    "format": "ttml",
    "language": "",
    "embed": False,
}


def _path() -> str:
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    folder = os.path.join(base, "LyricStudio")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, "settings.json")


def load() -> dict:
    try:
        with open(_path(), encoding="utf-8") as handle:
            return {**DEFAULTS, **json.load(handle)}
    except Exception:
        return dict(DEFAULTS)


def save(values: dict) -> None:
    # Read before opening for writing: "w" empties the file first, and merging
    # into a load() taken after that silently dropped every other setting —
    # the remembered folder included.
    merged = {**load(), **values}
    try:
        path = _path()
        with open(path + ".tmp", "w", encoding="utf-8") as handle:
            json.dump(merged, handle, indent=2)
        os.replace(path + ".tmp", path)
    except Exception:
        pass
