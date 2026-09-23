"""Syllable timing for karaoke.

Word timings say when each word starts and ends. Karaoke needs more: *where
inside* a word the voice moves on — the long held "lo-o-ove", the quick
"ev-ery". This module gets there the way WhisperX does, with a character-level
acoustic model:

1. Each word is split into syllable units — hyphenation rules for Latin
   scripts, grapheme groups (aksharas, kana) for Devanagari, Japanese and the
   rest.
2. Each unit is romanised to the 26 letters Meta's MMS aligner knows (1,130
   languages; uroman handles the romanising), so a Hindi syllable and an
   English one go through the same model.
3. The model scores every 20 ms of the line's audio against those letters, and
   a CTC Viterbi pass finds the single best path — which letter is being sung
   at every moment. A syllable's time is the span of its letters.

Where the acoustic answer disagrees badly with the word's own timing, the word
falls back to splitting its time across its syllables by length, so a bad frame
can make a syllable a little early, never a word land in the wrong bar.
"""
from __future__ import annotations

import re
import unicodedata

import numpy as np

MMS_ALIGNER = "MahmoudAshraf/mms-300m-1130-forced-aligner"
SAMPLE_RATE = 16000

# ---------------------------------------------------------------------------
# Splitting words into syllable units
# ---------------------------------------------------------------------------

_LATIN = re.compile(r"[A-Za-zÀ-ÖØ-öø-ɏ]")
_SMALL_KANA = set("ぁぃぅぇぉゃゅょゎっァィゥェォャュョヮッー")
_VIRAMA = {"्", "্", "੍", "્", "୍", "்", "్", "್", "്"}

_VOWELS = set("aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ")
# Letter pairs that make one sound, so a syllable boundary never splits them.
_DIGRAPHS = {"ch", "sh", "th", "ph", "wh", "ck", "gh", "qu"}
# Consonant clusters a syllable can start with ("tr" in as-tral, "bl" in ta-ble).
_ONSETS = {"bl", "br", "cl", "cr", "dr", "fl", "fr", "gl", "gr", "pl", "pr", "sc", "sk", "sl", "sm", "sn", "sp", "st",
           "sw", "tr", "tw", "wr", "thr", "shr", "str", "spr", "spl", "scr", "squ"} | _DIGRAPHS


def _syllabify_core(core: str, english: bool) -> list[str]:
    """Split one run of letters into spoken syllables.

    Hyphenation dictionaries are the obvious tool and the wrong one: they choose
    breaks that are safe on a printed page, so "river" never splits and "eyed"
    comes out "eye-d". Karaoke wants the sounds. So: find the vowel nuclei, drop
    the ones English does not pronounce (the silent final e, -ed after most
    consonants, -es after most), then share each consonant cluster between its
    neighbours the way speech does — one consonant goes forward (ri-ver), a
    pair splits (lit-tle) unless it can open a syllable together (as-tral).
    """
    lower = core.lower()
    n = len(lower)
    vowel = []
    for i, ch in enumerate(lower):
        if ch == "y":
            # y is a vowel inside a word unless a vowel follows it ("be-yond").
            vowel.append(i > 0 and not (i + 1 < n and lower[i + 1] in _VOWELS - {"y"}))
        else:
            vowel.append(ch in _VOWELS)
    for i in range(1, n):
        if lower[i] == "u" and lower[i - 1] == "q":
            vowel[i] = False
    nuclei: list[tuple[int, int]] = []
    i = 0
    while i < n:
        if vowel[i]:
            j = i
            while j < n and vowel[j]:
                j += 1
            nuclei.append((i, j))
            i = j
        else:
            i += 1
    consonant_le = english and n >= 3 and lower.endswith("le") and not vowel[n - 3]
    if english and len(nuclei) > 1:
        start, end = nuclei[-1]
        tail, before = lower[start:], lower[start - 1] if start else ""
        silent = False
        if lower[start:end] == "e" and before and not vowel[start - 1]:
            if end == n and not consonant_le:
                silent = True                                   # time, there, were
            elif tail == "ed" and before not in "td":
                silent = True                                   # jumped, eyed (not wanted)
            elif tail == "es" and before not in "sxzgc" and lower[start - 2:start] not in ("ch", "sh"):
                silent = True                                   # futures, times (not boxes)
        if silent:
            nuclei.pop()
    if len(nuclei) < 2:
        return [core]
    cuts: list[int] = []
    for k in range(len(nuclei) - 1):
        left_end, right_start = nuclei[k][1], nuclei[k + 1][0]
        cluster = lower[left_end:right_start]
        if consonant_le and k == len(nuclei) - 2 and right_start == n - 1:
            cuts.append(n - 3)                                  # lit-tle, ta-ble
            continue
        if len(cluster) <= 1 or cluster in _DIGRAPHS:
            cuts.append(left_end)                               # ri-ver, no-thing
            continue
        onset = 1
        for size in (3, 2):
            if size < len(cluster) and cluster[-size:] in _ONSETS:
                onset = size
                break
        cut = right_start - onset
        if lower[cut - 1:cut + 1] in _DIGRAPHS:                 # never split "th", "ch"…
            cut += 1
        cuts.append(cut)
    parts, previous = [], 0
    for cut in cuts:
        if previous < cut < n:
            parts.append(core[previous:cut])
            previous = cut
    parts.append(core[previous:])
    return [part for part in parts if part]


def _split_latin(word: str, language: str | None) -> list[str]:
    # Punctuation rides on the first/last syllable so the units rejoin exactly.
    match = re.match(r"^(\W*)(.*?)(\W*)$", word, flags=re.S)
    lead, core, trail = match.groups() if match else ("", word, "")
    if not core:
        return [word]
    english = (language or "en").startswith("en")
    parts: list[str] = []
    for piece in re.split(r"(-)", core):
        if not piece:
            continue
        if piece == "-":
            if parts:
                parts[-1] += "-"
            continue
        parts.extend(_syllabify_core(piece, english))
    if not parts:
        return [word]
    parts[0] = lead + parts[0]
    parts[-1] = parts[-1] + trail
    return parts


def _split_graphemes(word: str) -> list[str]:
    import regex
    clusters = regex.findall(r"\X", word)
    units: list[str] = []
    for cluster in clusters:
        joined = False
        if units:
            # A conjunct (consonant + virama + consonant) is one akshara; a small
            # kana belongs to the mora before it; punctuation rides along.
            if units[-1][-1] in _VIRAMA or cluster[0] in _SMALL_KANA or not any(ch.isalnum() for ch in cluster):
                units[-1] += cluster
                joined = True
        if not joined:
            units.append(cluster)
    return units or [word]


def syllable_units(word: str, language: str | None = None) -> list[str]:
    """Split a word into units that concatenate back to exactly the word."""
    word = word.strip()
    if not word:
        return []
    if _LATIN.search(word) and not re.search(r"[^\x00-ɏ\s\W]", word):
        return _split_latin(word, language)
    return _split_graphemes(word)


# ---------------------------------------------------------------------------
# Romanising units into the aligner's alphabet
# ---------------------------------------------------------------------------

_uroman = None


def romanize(unit: str, language: str | None = None) -> str:
    """The unit as lowercase a–z and apostrophes — all the MMS aligner reads."""
    global _uroman
    text = unit
    if not _LATIN.search(unit) or re.search(r"[^\x00-ɏ]", unit):
        try:
            if _uroman is None:
                import uroman as ur
                _uroman = ur.Uroman()
            text = _uroman.romanize_string(unit)
        except Exception:
            text = unit
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    return re.sub(r"[^a-z']", "", text)


# ---------------------------------------------------------------------------
# The acoustic model and the CTC alignment
# ---------------------------------------------------------------------------


def ctc_forced_align(log_probs: np.ndarray, targets: list[int], blank: int = 0) -> list[tuple[int, int] | None]:
    """Best CTC path of `targets` through `log_probs` [frames x vocab].

    Returns, per target token, the (first, last+1) frames it occupies. This is
    the textbook Viterbi over the blank-interleaved label sequence, written out
    here rather than borrowed from torchaudio, whose compiled version is tied to
    one torch build and breaks the moment the two drift apart.
    """
    frames = log_probs.shape[0]
    count = len(targets)
    if count == 0 or frames < count:
        return [None] * count
    states = 2 * count + 1
    labels = np.full(states, blank, dtype=np.int64)
    labels[1::2] = targets
    neg = np.float32(-1e30)
    emit = log_probs[:, labels]
    score = np.full(states, neg, dtype=np.float32)
    score[0] = emit[0, 0]
    score[1] = emit[0, 1]
    can_skip = np.zeros(states, dtype=bool)
    can_skip[2:] = (labels[2:] != blank) & (labels[2:] != labels[:-2])
    back = np.zeros((frames, states), dtype=np.int8)
    for frame in range(1, frames):
        stay = score
        step = np.concatenate(([neg], score[:-1]))
        skip = np.where(can_skip, np.concatenate(([neg, neg], score[:-2])), neg)
        best = np.maximum(np.maximum(stay, step), skip)
        back[frame] = np.where(best == stay, 0, np.where(best == step, 1, 2))
        score = best + emit[frame]
    state = states - 1 if score[states - 1] >= score[states - 2] else states - 2
    path = np.empty(frames, dtype=np.int64)
    for frame in range(frames - 1, -1, -1):
        path[frame] = state
        if frame:
            state -= back[frame, state]
    spans: list[tuple[int, int] | None] = []
    for index in range(count):
        hits = np.nonzero(path == 2 * index + 1)[0]
        spans.append((int(hits[0]), int(hits[-1]) + 1) if len(hits) else None)
    return spans


class CharAligner:
    """Meta's MMS forced-alignment model, loaded once and reused."""

    def __init__(self, on_status=None):
        import torch
        from transformers import AutoFeatureExtractor, Wav2Vec2ForCTC
        if on_status:
            on_status("Loading the syllable model… (the first use downloads 1.2 GB)")
        self.torch = torch
        self.extractor = AutoFeatureExtractor.from_pretrained(MMS_ALIGNER)
        self.model = Wav2Vec2ForCTC.from_pretrained(MMS_ALIGNER)
        self.model.eval()
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model.to(self.device)
        vocab = self.model.config.vocab_size
        import json
        from huggingface_hub import hf_hub_download
        with open(hf_hub_download(MMS_ALIGNER, "vocab.json"), encoding="utf-8") as handle:
            self.vocab: dict[str, int] = json.load(handle)
        self.blank = self.vocab.get("<blank>", 0)
        self.vocab_size = vocab

    def log_probs(self, clip: np.ndarray) -> tuple[np.ndarray, float]:
        inputs = self.extractor(clip, sampling_rate=SAMPLE_RATE, return_tensors="pt")
        with self.torch.inference_mode():
            logits = self.model(inputs.input_values.to(self.device)).logits[0]
            log_probs = self.torch.log_softmax(logits.float(), dim=-1).cpu().numpy()
        seconds_per_frame = (len(clip) / SAMPLE_RATE) / max(log_probs.shape[0], 1)
        return log_probs, seconds_per_frame


# ---------------------------------------------------------------------------
# Putting syllables on already-timed words
# ---------------------------------------------------------------------------


def _proportional(units: list[str], start: float, end: float) -> list[dict]:
    """Split a word's time across its syllables by how many letters each has."""
    weights = [max(len(re.sub(r"\W", "", unit)), 1) for unit in units]
    total = sum(weights)
    out, cursor = [], start
    for unit, weight in zip(units, weights):
        span = (end - start) * weight / total
        out.append({"text": unit, "start": round(cursor, 3), "end": round(cursor + span, 3)})
        cursor += span
    return out


def add_syllables(audio: np.ndarray, segments: list[dict], language: str | None, aligner: CharAligner, on_progress=None) -> dict:
    """Attach `syllables` to every word, timed acoustically where it holds up.

    Returns counts of how many words were timed by the model and how many fell
    back to the proportional split, so callers can say so honestly.
    """
    duration = len(audio) / SAMPLE_RATE
    acoustic = fallback = 0
    for line_index, segment in enumerate(segments):
        words = segment["words"]
        word_ends = [word["end"] for word in words]
        window_start = max(0.0, words[0]["start"] - 0.25)
        window_end = min(duration, words[-1]["end"] + 0.25)
        word_units = [syllable_units(word["word"], language) for word in words]
        targets: list[int] = []
        owner: list[tuple[int, int]] = []
        for w, units in enumerate(word_units):
            for u, unit in enumerate(units):
                for letter in romanize(unit, language):
                    token = aligner.vocab.get(letter)
                    if token is not None:
                        targets.append(token)
                        owner.append((w, u))
        spans: list = []
        seconds_per_frame = 0.02
        clip = audio[int(window_start * SAMPLE_RATE):int(window_end * SAMPLE_RATE)]
        if targets and len(clip) > SAMPLE_RATE * 0.2:
            try:
                log_probs, seconds_per_frame = aligner.log_probs(clip)
                spans = ctc_forced_align(log_probs, targets, aligner.blank)
            except Exception:
                spans = []
        # Unit spans from their letters' frames.
        unit_times: dict[tuple[int, int], list[float]] = {}
        for (key, span) in zip(owner, spans):
            if span is None:
                continue
            begin = window_start + span[0] * seconds_per_frame
            finish = window_start + span[1] * seconds_per_frame
            if key in unit_times:
                unit_times[key][0] = min(unit_times[key][0], begin)
                unit_times[key][1] = max(unit_times[key][1], finish)
            else:
                unit_times[key] = [begin, finish]
        for w, (word, units) in enumerate(zip(words, word_units)):
            if not units:
                continue
            timed = [unit_times.get((w, u)) for u in range(len(units))]
            known = [t for t in timed if t]
            word_start, word_end = word["start"], word["end"]
            word_length = max(word_end - word_start, 0.05)
            trusted = False
            if known:
                acoustic_start, acoustic_end = known[0][0], known[-1][1]
                # Trust the model when it puts the word roughly where the word
                # timing does; otherwise a stray frame could move a whole word.
                slack = max(0.6, word_length)
                trusted = abs(acoustic_start - word_start) < slack and abs(acoustic_end - word_end) < slack
            if trusted:
                syllables = []
                for u, unit in enumerate(units):
                    if timed[u]:
                        syllables.append({"text": unit, "start": timed[u][0], "end": timed[u][1]})
                    else:
                        syllables.append({"text": unit, "start": None, "end": None})
                # Units the model skipped (no letters it knows) sit between neighbours.
                for u, syllable in enumerate(syllables):
                    if syllable["start"] is None:
                        before = next((s["end"] for s in reversed(syllables[:u]) if s["start"] is not None), known[0][0])
                        after = next((s["start"] for s in syllables[u + 1:] if s["start"] is not None), known[-1][1])
                        syllable["start"], syllable["end"] = before, max(after, before + 0.03)
                # Inside a word the sweep never pauses: each syllable runs until the next begins.
                for u in range(len(syllables) - 1):
                    syllables[u]["end"] = max(syllables[u]["start"] + 0.02, syllables[u + 1]["start"])
                for syllable in syllables:
                    syllable["start"], syllable["end"] = round(syllable["start"], 3), round(max(syllable["end"], syllable["start"] + 0.02), 3)
                acoustic += 1
            else:
                syllables = _proportional(units, word_start, word_end)
                fallback += 1
            # Keep the leading space convention: it belongs to the first syllable.
            if word["word"].startswith(" ") and not syllables[0]["text"].startswith(" "):
                syllables[0]["text"] = " " + syllables[0]["text"]
            word["syllables"] = syllables
            word["start"], word["end"] = syllables[0]["start"], syllables[-1]["end"]
        next_line = segments[line_index + 1]["words"][0]["start"] if line_index + 1 < len(segments) and segments[line_index + 1]["words"] else None
        _hold_last_syllables(words, word_ends, next_line)
        if on_progress:
            on_progress((line_index + 1) / len(segments) * 100)
    _enforce_syllable_order(segments)
    return {"acoustic": acoustic, "fallback": fallback}


def _hold_last_syllables(words: list[dict], word_ends: list[float], next_line: float | None) -> None:
    """Let each word's last syllable last as long as the word is sung.

    CTC marks a letter by a spike at its onset, so an acoustic span ends where
    the letter *starts* — a held "I" came out 20 ms long and flashed past in
    karaoke. The word timing knew better: the last syllable runs to the word's
    own end (at least a beat), never into the next word.
    """
    for index, word in enumerate(words):
        syllables = word.get("syllables")
        if not syllables:
            continue
        last = syllables[-1]
        following = next((later["syllables"][0]["start"] for later in words[index + 1:] if later.get("syllables")), next_line)
        end = max(last["end"], word_ends[index], last["start"] + 0.12)
        if following is not None:
            end = min(end, following)
        if end > last["end"]:
            last["end"] = round(end, 3)
            word["end"] = last["end"]


def _enforce_syllable_order(segments: list[dict]) -> None:
    previous = 0.0
    for segment in segments:
        for word in segment["words"]:
            for syllable in word.get("syllables", []):
                if syllable["start"] < previous:
                    syllable["start"] = round(previous, 3)
                if syllable["end"] <= syllable["start"]:
                    syllable["end"] = round(syllable["start"] + 0.02, 3)
                previous = syllable["end"]
            if word.get("syllables"):
                word["start"], word["end"] = word["syllables"][0]["start"], word["syllables"][-1]["end"]
        if segment["words"]:
            segment["start"], segment["end"] = segment["words"][0]["start"], segment["words"][-1]["end"]
