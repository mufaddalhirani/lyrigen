"""Writing timed lyrics as TTML and LRC.

TTML follows Apple Music's own layout — the format Lyrigen, Better Lyrics and
AMLL all read. Word timing is one `<span>` per word with spaces between; for
syllable timing a word's syllables are spans placed side by side with *no*
space between them, which is exactly how Apple marks a syllable-synced song.

LRC is the standard word-timed "A2" dialect: a `<mm:ss.xxx>` stamp before
every word (or syllable) and one after the last, which most players that
understand word timing can read.
"""
from __future__ import annotations

from xml.sax.saxutils import escape


def _ttml_time(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    minutes, rest = divmod(seconds, 60)
    if minutes >= 60:
        hours, minutes = divmod(minutes, 60)
        return f"{int(hours)}:{int(minutes):02d}:{rest:06.3f}"
    return f"{int(minutes)}:{rest:06.3f}" if minutes else f"{rest:.3f}"


def _lrc_time(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    minutes, rest = divmod(seconds, 60)
    return f"{int(minutes):02d}:{rest:06.3f}"


def _pieces(word: dict, level: str) -> list[dict]:
    """The timed pieces of one word: its syllables, or the word itself."""
    if level == "syllable" and word.get("syllables"):
        return word["syllables"]
    return [{"text": word["word"], "start": word["start"], "end": word["end"]}]


def to_ttml(segments: list[dict], level: str = "word", language: str | None = None, duration: float | None = None) -> str:
    timing = "Syllable" if level == "syllable" else "Word"
    end = duration or (segments[-1]["end"] if segments else 0)
    start = segments[0]["start"] if segments else 0
    out = [
        '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" '
        f'xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="{timing}" xml:lang="{escape(language or "en")}">',
        '<head><metadata><ttm:agent type="person" xml:id="v1"/>'
        '<meta key="lyrigen:alignment" value="machine-aligned; review recommended"/></metadata></head>',
        f'<body dur="{_ttml_time(end)}"><div begin="{_ttml_time(start)}" end="{_ttml_time(end)}">',
    ]
    for index, segment in enumerate(segments, start=1):
        spans = []
        for position, word in enumerate(segment["words"]):
            for piece_index, piece in enumerate(_pieces(word, level)):
                text = piece["text"]
                # The space before a word sits between spans, never inside one;
                # syllables of the same word touch.
                gap = " " if position and piece_index == 0 else ""
                spans.append(f'{gap}<span begin="{_ttml_time(piece["start"])}" end="{_ttml_time(piece["end"])}">{escape(text.strip())}</span>')
        out.append(f'<p begin="{_ttml_time(segment["start"])}" end="{_ttml_time(segment["end"])}" itunes:key="L{index}" ttm:agent="v1">{"".join(spans)}</p>')
    out.append("</div></body></tt>")
    return "".join(out)


def to_lrc(segments: list[dict], level: str = "word", title: str | None = None, artist: str | None = None) -> str:
    lines = []
    if title:
        lines.append(f"[ti:{title}]")
    if artist:
        lines.append(f"[ar:{artist}]")
    lines.append("[re:Lyric Studio (stable-ts + faster-whisper)]")
    for segment in segments:
        parts = []
        last_end = segment["end"]
        for position, word in enumerate(segment["words"]):
            for piece_index, piece in enumerate(_pieces(word, level)):
                text = piece["text"].strip()
                if position and piece_index == 0:
                    text = " " + text
                parts.append(f"<{_lrc_time(piece['start'])}>{text}")
                last_end = piece["end"]
        lines.append(f"[{_lrc_time(segment['start'])}]{''.join(parts)}<{_lrc_time(last_end)}>")
    return "\n".join(lines) + "\n"


def plain_text(segments: list[dict]) -> str:
    return "\n".join(segment["text"] for segment in segments)
