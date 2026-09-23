"""Finding a song's lyrics online, so nobody has to copy and paste them.

Two free, public, keyless sources, best timing first:

  BiniLyrics   Community-built Apple-format TTML, word- or syllable-timed.
               Human word timing beats anything a model would redo, so when
               this answers, only the syllable stage is left to do.
  LRCLIB       The largest open lyrics database; line-synced LRC or plain text.
               Line timings are what make alignment fast and reliable.

Whatever is found comes back as lines — with start/end seconds when the source
has them, and each line's words when it has those too.
"""
from __future__ import annotations

import json
import os
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

USER_AGENT = "LyricStudio/1.0 (local lyric timing; https://github.com/mufaddalhirani/lyrigen)"


def _get(url: str, timeout: float = 15.0):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


# ---------------------------------------------------------------------------
# What song is this?
# ---------------------------------------------------------------------------


def read_tags(audio_path: str) -> dict:
    """Title, artist, album and length from the file's tags, or its name."""
    info = {"title": None, "artist": None, "album": None, "duration": None}
    try:
        import av
        with av.open(audio_path) as container:
            tags = {k.lower(): v for k, v in (container.metadata or {}).items()}
            if container.streams.audio:
                tags.update({k.lower(): v for k, v in (container.streams.audio[0].metadata or {}).items()})
            info["title"] = tags.get("title")
            info["artist"] = tags.get("artist") or tags.get("album_artist") or tags.get("albumartist")
            info["album"] = tags.get("album")
            if container.duration:
                info["duration"] = container.duration / 1_000_000
    except Exception:
        pass
    if not info["title"]:
        stem = os.path.splitext(os.path.basename(audio_path))[0]
        stem = re.sub(r"\s*\[[A-Za-z0-9_-]{11}\]$", "", stem)  # a yt-dlp [videoId]
        if " - " in stem:
            artist, title = stem.split(" - ", 1)
            info["artist"] = info["artist"] or artist.strip()
            info["title"] = title.strip()
        else:
            info["title"] = stem.strip()
    return info


def _primary_artist(artist: str | None) -> str | None:
    if not artist:
        return artist
    return re.split(r"\s*(?:,|&|;|/|\bfeat\.?\b|\bft\.?\b|\bx\b)\s*", artist, flags=re.I)[0].strip() or artist


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------


def parse_time(value: str | None) -> float | None:
    if not value:
        return None
    value = value.strip().rstrip("s")
    parts = value.split(":")
    try:
        seconds = 0.0
        for part in parts:
            seconds = seconds * 60 + float(part)
        return seconds
    except ValueError:
        return None


def parse_ttml(ttml: str) -> tuple[list[dict], str | None]:
    """Lines (with words when timed per word) out of an Apple-style TTML."""
    ttml = re.sub(r"\sxmlns(:\w+)?=\"[^\"]*\"", "", ttml, count=0)  # namespaces only get in the way here
    ttml = re.sub(r"<(/?)\w+:", r"<\1", ttml)
    ttml = re.sub(r"\s\w+:(\w+)=", r" \1=", ttml)
    root = ET.fromstring(ttml)
    language = root.attrib.get("lang")
    lines = []
    for p in root.iter("p"):
        words = []
        pending_space = False
        # Direct children only: background vocals sit in a wrapper span of
        # their own, and folding them in would put extra words in the line.
        for span in [child for child in p if child.tag == "span"]:
            if span.attrib.get("role") in ("x-bg", "x-translation", "x-roman"):
                continue
            text = "".join(span.itertext()).strip()
            start, end = parse_time(span.attrib.get("begin")), parse_time(span.attrib.get("end"))
            if text and start is not None and end is not None:
                # Syllables of one word touch; a gap before a span means a new word.
                if words and not pending_space:
                    words[-1]["word"] += text
                    words[-1]["end"] = end
                else:
                    words.append({"word": text, "start": start, "end": end})
            pending_space = bool(span.tail and span.tail.strip() == "" and " " in span.tail)
        text = " ".join(word["word"] for word in words) or "".join(p.itertext()).strip()
        start = parse_time(p.attrib.get("begin"))
        end = parse_time(p.attrib.get("end"))
        if text:
            lines.append({"text": text, "start": start, "end": end, "words": words or None})
    return lines, language


def parse_lrc(lrc: str) -> list[dict]:
    rows = []
    for raw in lrc.splitlines():
        stamps = re.findall(r"\[(\d+):(\d+(?:\.\d+)?)\]", raw)
        text = re.sub(r"\[[^\]]*\]|<[^>]*>", "", raw).strip()
        for minutes, seconds in stamps:
            rows.append({"text": text, "start": int(minutes) * 60 + float(seconds)})
    rows = [row for row in sorted(rows, key=lambda row: row["start"]) if row["text"]]
    for index, row in enumerate(rows):
        row["end"] = rows[index + 1]["start"] if index + 1 < len(rows) else None
    return rows


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


def _bini(title: str, artist: str | None) -> dict | None:
    params = {"track": title}
    if artist:
        params["artist"] = artist
    body = _get("https://lyrics-api.binimum.org/?" + urllib.parse.urlencode(params))
    if not body:
        return None
    results = json.loads(body).get("results") or []
    result = next((r for r in results if r.get("lyricsUrl", "").startswith("https://lyrics-storage.binimum.org/")), None)
    if not result:
        return None
    ttml = _get(result["lyricsUrl"])
    if not ttml or "<tt" not in ttml:
        return None
    lines, language = parse_ttml(ttml)
    if not lines:
        return None
    kind = "word" if all(line.get("words") for line in lines) else "line"
    return {"source": "BiniLyrics", "kind": kind, "language": language, "lines": lines,
            "title": result.get("track_name"), "artist": result.get("artist_name")}


def _lrclib(title: str, artist: str | None, album: str | None, duration: float | None) -> dict | None:
    candidates = []
    if artist and duration:
        params = {"track_name": title, "artist_name": artist, "duration": round(duration)}
        if album:
            params["album_name"] = album
        body = _get("https://lrclib.net/api/get?" + urllib.parse.urlencode(params))
        if body:
            candidates.append(json.loads(body))
    if not candidates:
        params = {"track_name": title}
        if artist:
            params["artist_name"] = artist
        body = _get("https://lrclib.net/api/search?" + urllib.parse.urlencode(params))
        candidates = json.loads(body) if body else []
    if not candidates:
        return None

    def rank(entry):
        synced = 1 if entry.get("syncedLyrics") else 0
        closeness = -abs((entry.get("duration") or 0) - duration) if duration else 0
        return (synced, closeness)

    best = max(candidates, key=rank)
    if duration and best.get("duration") and abs(best["duration"] - duration) > 8 and best.get("syncedLyrics"):
        # Synced lyrics from a different edit would put every line at the wrong time.
        best = {**best, "syncedLyrics": None}
    if best.get("syncedLyrics"):
        lines = parse_lrc(best["syncedLyrics"])
        if lines:
            return {"source": "LRCLIB", "kind": "line", "language": None, "lines": lines,
                    "title": best.get("trackName"), "artist": best.get("artistName")}
    if best.get("plainLyrics"):
        lines = [{"text": line.strip(), "start": None, "end": None} for line in best["plainLyrics"].splitlines() if line.strip()]
        return {"source": "LRCLIB", "kind": "plain", "language": None, "lines": lines,
                "title": best.get("trackName"), "artist": best.get("artistName")}
    return None


_SCRIPTS = [
    (re.compile(r"[ऀ-ॿ]"), "hi"), (re.compile(r"[਀-੿]"), "pa"), (re.compile(r"[ঀ-৿]"), "bn"),
    (re.compile(r"[஀-௿]"), "ta"), (re.compile(r"[ఀ-౿]"), "te"), (re.compile(r"[぀-ヿ]"), "ja"),
    (re.compile(r"[가-힯]"), "ko"), (re.compile(r"[一-鿿]"), "zh"), (re.compile(r"[؀-ۿ]"), "ur"),
    (re.compile(r"[Ѐ-ӿ]"), "ru"),
]


def guess_language(text: str, declared: str | None = None) -> str | None:
    """The language the words are written in, judged by their script.

    Sources mislabel freely — a Hindi song's TTML declared itself English —
    and handing the model the wrong language wrecks the alignment. A script is
    much harder to get wrong than a label. Latin text keeps the declared code.
    """
    for pattern, code in _SCRIPTS:
        if len(pattern.findall(text)) > len(text) * 0.15:
            return code
    return declared


def find_lyrics(audio_path: str, title: str | None = None, artist: str | None = None) -> dict | None:
    """The best lyrics for a song, word-timed first, then line-timed, then plain."""
    tags = read_tags(audio_path)
    title = title or tags["title"]
    artist = artist or tags["artist"]
    if not title:
        return None
    attempts = [artist, _primary_artist(artist)] if artist else [None]
    for who in dict.fromkeys(attempts):
        for finder in (lambda: _bini(title, who), lambda: _lrclib(title, who, tags["album"], tags["duration"])):
            try:
                found = finder()
            except Exception:
                found = None
            if found:
                found["query"] = {"title": title, "artist": who}
                found["language"] = guess_language(" ".join(line["text"] for line in found["lines"]), found.get("language"))
                return found
    return None
