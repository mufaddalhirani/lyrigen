"""Command-line worker: the interface Lyrigen (or anything else) drives.

Writes one JSON object per line to stdout:

  {"event": "status",   "stage": "...", "message": "..."}
  {"event": "device",   "device": "cuda"|"cpu", "compute": "...", "note": "..."}
  {"event": "progress", "percent": 0..100}
  {"event": "result",   "mode": "...", "level": "...", "segments": [...], "ttml": "...", "lrc": "..."}
  {"event": "error",    "message": "..."}

The result carries finished TTML and LRC as well as the raw segments, so every
front end saves exactly the same files.

  python -m lyricstudio.cli --audio song.opus [--level syllable] [--model base]
         [--lines-file lines.json | --lyrics-file lyrics.txt] [--language hi]
         [--device auto|cuda|cpu] [--ffmpeg-dir C:\\ffmpeg\\bin]
         [--find-lyrics]      look the lyrics up online first (BiniLyrics, LRCLIB)
"""
from __future__ import annotations

import argparse
import json
import sys


def emit(event: dict) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(prog="lyricstudio.cli", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--level", default="word", choices=["word", "syllable"])
    parser.add_argument("--lyrics-file")
    parser.add_argument("--lines-file", help="JSON list of {text, start, end[, words]} in seconds")
    parser.add_argument("--language")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--ffmpeg-dir")
    parser.add_argument("--find-lyrics", action="store_true", help="look the lyrics up online when none are given")
    args = parser.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    try:
        from . import engine, formats
    except ImportError as error:
        emit({"event": "error", "message": f"A Python package is missing ({getattr(error, 'name', error)}). Run the Lyric Studio installer, or: pip install stable-ts faster-whisper"})
        return 2

    lines = None
    lyrics_text = None
    language = args.language
    if args.lines_file:
        with open(args.lines_file, encoding="utf-8") as handle:
            lines = json.load(handle)
    elif args.lyrics_file:
        with open(args.lyrics_file, encoding="utf-8") as handle:
            lyrics_text = handle.read()
    elif args.find_lyrics:
        from .lyrics_online import find_lyrics
        emit({"event": "status", "stage": "finding-lyrics", "message": "Looking the lyrics up online…"})
        found = find_lyrics(args.audio)
        if found:
            lines = found["lines"] if found["kind"] != "plain" else None
            lyrics_text = "\n".join(line["text"] for line in found["lines"]) if found["kind"] == "plain" else None
            language = language or found.get("language")
            emit({"event": "status", "stage": "found-lyrics", "message": f"Lyrics from {found['source']} ({found['kind']}-timed, {len(found['lines'])} lines)."})
        else:
            emit({"event": "status", "stage": "no-lyrics", "message": "No lyrics online; transcribing instead."})

    try:
        result = engine.sync(args.audio, model=args.model, level=args.level, lyrics_text=lyrics_text, lines=lines,
                             language=language, device=args.device, ffmpeg_dir=args.ffmpeg_dir, on_event=emit)
    except KeyboardInterrupt:
        emit({"event": "error", "message": "Cancelled."})
        return 130
    except Exception as error:  # noqa: BLE001
        emit({"event": "error", "message": f"{type(error).__name__}: {error}"})
        return 1
    result["ttml"] = formats.to_ttml(result["segments"], result["level"], result["language"], result.get("duration"))
    result["lrc"] = formats.to_lrc(result["segments"], result["level"])
    emit({"event": "result", **result})
    return 0


if __name__ == "__main__":
    sys.exit(main())
