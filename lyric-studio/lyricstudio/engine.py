"""The sync engine: word- and syllable-level lyric timing, on this computer.

Shared by Lyric Studio (the standalone app) and Lyrigen (which runs it as a
worker). stable-ts drives faster-whisper for word timing; the syllable stage
adds Meta's MMS character aligner on top (see syllables.py).

Modes, chosen from what the caller has:

  align-lines  Lyrics with line timings (an LRC, a TTML). Each line is aligned
               only within its own moment — fast and reliable on any model.
  align        Lyrics as plain text. Aligned across the whole song; wants the
               "small" model or larger.
  transcribe   No lyrics. Whisper writes and times the words itself.

Whatever the mode, the model decides timing, never spelling: its output is
projected back onto the source words, so lyrics come out exactly as they went
in.
"""
from __future__ import annotations

import difflib
import glob
import os
import re
import site
import time
from typing import Callable

Event = Callable[[dict], None]


def _quiet(_event: dict) -> None:
    pass


def add_cuda_runtime_dirs():
    """Make NVIDIA's pip-packaged CUDA 12 libraries loadable.

    faster-whisper's engine (ctranslate2) is built against CUDA 12 and looks for
    cublas64_12.dll and cuDNN 9. A system CUDA toolkit of another major version
    does not provide them, but `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12`
    does — inside site-packages, where Windows will not look unless told to.
    """
    roots = []
    try:
        roots.extend(site.getsitepackages())
    except Exception:
        pass
    try:
        roots.append(site.getusersitepackages())
    except Exception:
        pass
    added = []
    for root in roots:
        for folder in glob.glob(os.path.join(root, "nvidia", "*", "bin")):
            try:
                os.add_dll_directory(folder)
            except (AttributeError, OSError):
                pass
            os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")
            added.append(folder)
    return added


def is_cuda_library_error(error):
    text = f"{type(error).__name__}: {error}".lower()
    return any(marker in text for marker in ("cublas", "cudnn", "cuda", "cudart", "nvrtc", "gpu"))


SAMPLE_RATE = 16000


def repair_words(words):
    """Give every word a real, forward-moving span — and never drop one.

    stable-ts marks a word it cannot place confidently with zero duration. The
    first version of this worker discarded those, and lyrics came back with
    words and whole lines missing. The text is the one thing that must survive
    intact, so an unsure word keeps its place and borrows a short span instead.
    """
    repaired = []
    for index, (text, start, end) in enumerate(words):
        if repaired and start < repaired[-1][2]:
            start = repaired[-1][2]
        if end <= start:
            following = next((later[1] for later in words[index + 1:] if later[1] > start), start + 0.35)
            end = max(start + 0.05, min(following, start + 0.6))
        repaired.append((text, round(start, 3), round(end, 3)))
    return repaired


def _token_key(token):
    return re.sub(r"[^\w']", "", token.lower())


def project_onto_text(text, aligned, start, end):
    """Put the model's timings onto *your* words, exactly as written.

    The model's job is timing, not spelling. Left to itself it occasionally
    doubles a word ("little row row boat") or drops one, and lyrics must come
    out exactly as they went in. So the source words are matched against what
    the model returned: matched words take its times, words it skipped are
    placed between their timed neighbours, and anything it invented is
    ignored. The output always has precisely the source's words.
    """
    tokens = text.split()
    if not tokens:
        return []
    got = [(word.strip(), s, e) for word, s, e in aligned if word.strip()]
    times = [None] * len(tokens)
    if got:
        matcher = difflib.SequenceMatcher(a=[_token_key(t) for t in tokens], b=[_token_key(w) for w, _, _ in got], autojunk=False)
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == "equal":
                for offset in range(i2 - i1):
                    times[i1 + offset] = (got[j1 + offset][1], got[j1 + offset][2])
            elif tag == "replace":
                # Same stretch of audio, different spelling: share it out.
                span_start, span_end = got[j1][1], got[j2 - 1][2]
                count = i2 - i1
                for offset in range(count):
                    times[i1 + offset] = (span_start + (span_end - span_start) * offset / count,
                                          span_start + (span_end - span_start) * (offset + 1) / count)
    # Fill anything unmatched evenly between the nearest timed neighbours.
    index = 0
    while index < len(tokens):
        if times[index] is not None:
            index += 1
            continue
        run_end = index
        while run_end < len(tokens) and times[run_end] is None:
            run_end += 1
        left = times[index - 1][1] if index > 0 else start
        right = times[run_end][0] if run_end < len(tokens) else end
        right = max(right, left + 0.05 * (run_end - index))
        step = (right - left) / (run_end - index)
        for offset in range(run_end - index):
            times[index + offset] = (left + step * offset, left + step * (offset + 1))
        index = run_end
    return [((" " if i else "") + token, times[i][0], times[i][1]) for i, token in enumerate(tokens)]


def enforce_order(segments):
    """One pass over the whole song so time only moves forward.

    Each line is aligned in a window a little wider than the line, so the end of
    one can overlap the start of the next. Nudging each word to start no
    earlier than the previous one ended keeps the highlight from ever stepping
    backwards across a line break.
    """
    previous_end = 0.0
    for segment in segments:
        for word in segment["words"]:
            if word["start"] < previous_end:
                word["start"] = round(previous_end, 3)
            if word["end"] <= word["start"]:
                word["end"] = round(word["start"] + 0.05, 3)
            previous_end = word["end"]
        segment["start"], segment["end"] = segment["words"][0]["start"], segment["words"][-1]["end"]
    return segments


def spread_words(text, start, end):
    """Last resort for a line the model could not align: spread its words evenly
    over the line's known window. Still word-level, just not listened for."""
    tokens = text.split()
    if not tokens:
        return []
    span = max(end - start, 0.2) / len(tokens)
    return [((" " if i else "") + token, start + i * span, start + (i + 1) * span) for i, token in enumerate(tokens)]


def align_by_lines(model, audio, lines, language, duration, on_progress=None):
    """Align each lyric line inside its own known time window.

    When the lyrics are already line-synced (an LRC from LRCLIB, say), we know
    roughly when every line is sung. Handing the model the whole song and all
    the words at once throws that away — a long intro or a repeated chorus then
    drags words into the wrong place. Clipping the audio to each line and
    aligning only that line's words keeps every error local to one line.
    """
    segments = []
    for index, line in enumerate(lines):
        start = float(line["start"])
        end = line.get("end")
        if end is None:
            end = lines[index + 1]["start"] if index + 1 < len(lines) else duration
        end = float(min(max(end, start + 0.3), duration))
        window_start = max(0.0, start - 0.3)
        window_end = min(duration, end + 0.3)
        clip = audio[int(window_start * SAMPLE_RATE):int(window_end * SAMPLE_RATE)]
        words = []
        if len(clip) > SAMPLE_RATE * 0.3:
            try:
                result = model.align(clip, line["text"], language=language, original_split=True)
                words = [(word.word, float(word.start) + window_start, float(word.end) + window_start)
                         for segment in result.segments for word in (segment.words or []) if word.word.strip()]
            except Exception:
                words = []
        # An alignment that lost most of the line's words is worse than an even spread.
        if len(words) < max(1, int(len(line["text"].split()) * 0.6)):
            words = spread_words(line["text"], start, end)
        else:
            words = project_onto_text(line["text"], words, start, end)
        words = repair_words(words)
        if words:
            segments.append({"text": line["text"], "start": words[0][1], "end": words[-1][2],
                             "words": [{"word": text, "start": s, "end": e} for text, s, e in words]})
        if on_progress:
            on_progress((index + 1) / len(lines) * 100)
    return enforce_order(segments)




# ---------------------------------------------------------------------------
# The engine
# ---------------------------------------------------------------------------

_models: dict = {}
_aligner = None


def _models_folder() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "LyricStudio", "models")


def fetch_model(model_size: str, on_status=None, on_progress=None) -> str:
    """The model's folder on disk, downloading it first if needed.

    faster-whisper's own download is silent and starts from zero every time it
    is interrupted, so Medium (1.5 GB) and Large (3 GB) looked like they never
    loaded — and each cancel threw away what had arrived. Here every file is
    fetched with HTTP ranges into a `.part` that the next attempt continues,
    and progress is reported as it goes.
    """
    from faster_whisper.utils import _MODELS, download_model
    if os.path.isdir(model_size):
        return model_size
    try:  # already complete in the Hugging Face cache (older installs)
        return download_model(model_size, local_files_only=True)
    except Exception:
        pass
    repo = _MODELS.get(model_size, model_size)
    folder = os.path.join(_models_folder(), repo.replace("/", "--"))
    done_marker = os.path.join(folder, ".complete")
    if os.path.exists(done_marker):
        return folder
    import requests
    from huggingface_hub import HfApi, hf_hub_url
    os.makedirs(folder, exist_ok=True)
    wanted = ("config.json", "preprocessor_config.json", "model.bin", "tokenizer.json")
    info = HfApi().model_info(repo, files_metadata=True)
    files = [(s.rfilename, s.size or 0) for s in info.siblings
             if s.rfilename in wanted or s.rfilename.startswith("vocabulary.")]
    total = sum(size for _, size in files) or 1
    have = sum(os.path.getsize(os.path.join(folder, name)) for name, _ in files if os.path.exists(os.path.join(folder, name)))
    for name, size in files:
        target = os.path.join(folder, name)
        if os.path.exists(target) and (not size or os.path.getsize(target) == size):
            continue
        part = target + ".part"
        start = os.path.getsize(part) if os.path.exists(part) else 0
        headers = {"Range": f"bytes={start}-"} if start else {}
        with requests.get(hf_hub_url(repo, name), headers=headers, stream=True, timeout=60) as response:
            if response.status_code == 416:  # the part is already whole
                response.close()
            else:
                response.raise_for_status()
                if start and response.status_code != 206:
                    start = 0  # the server ignored the range; begin again
                with open(part, "ab" if start else "wb") as handle:
                    received = start
                    last = -1
                    for chunk in response.iter_content(1 << 20):
                        handle.write(chunk)
                        received += len(chunk)
                        percent = int((have + received) * 100 / total)
                        if percent != last:
                            last = percent
                            if on_status:
                                on_status(f"Downloading the {model_size} model (once): {(have + received) / 1e9:.2f} of {total / 1e9:.2f} GB — "
                                          "you can cancel and it continues where it stopped.")
                            if on_progress:
                                on_progress(percent)
        os.replace(part, target)
        have += size
    open(done_marker, "w").close()
    return folder


def _load_whisper(model_size: str, device: str, compute: str, on_status=None, on_progress=None):
    import stable_whisper
    key = (model_size, device, compute)
    if key not in _models:
        _models.clear()  # one model in memory at a time; they are large
        path = fetch_model(model_size, on_status, on_progress)
        if on_status:
            on_status(f"Loading the {model_size} model on the {'GPU' if device == 'cuda' else 'CPU'}…")
        _models[key] = stable_whisper.load_faster_whisper(path, device=device, compute_type=compute)
    return _models[key]


def _load_aligner(on_status):
    global _aligner
    if _aligner is None:
        from .syllables import CharAligner
        _aligner = CharAligner(on_status=on_status)
    return _aligner


def prepare(ffmpeg_dir: str | None = None) -> list[str]:
    """PATH for ffmpeg (stable-ts calls the binary) and the CUDA 12 libraries."""
    if ffmpeg_dir:
        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
    return add_cuda_runtime_dirs()


def gpu_count() -> int:
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count()
    except Exception:
        return 0


def shift_lines(lines: list[dict], offset: float) -> list[dict]:
    shifted = []
    for line in lines:
        moved = {**line, "start": float(line["start"]) + offset}
        if line.get("end") is not None:
            moved["end"] = float(line["end"]) + offset
        if line.get("words"):
            moved["words"] = [{**w, "start": float(w["start"]) + offset, "end": float(w["end"]) + offset} for w in line["words"]]
        shifted.append(moved)
    return shifted


def estimate_offset(whisper, audio, lines: list[dict], language: str | None, duration: float) -> tuple[float, bool]:
    """How far the lyrics' timing is from *this* recording, checked by ear.

    Timed lyrics online are made against one release of a song, and the file
    you have may be another: a YouTube upload with a longer intro, a radio edit.
    BiniLyrics' Pyramid Song, timed on the Apple Music master, sits about seven
    seconds early against the YouTube upload — and syllables built on it would
    all be seven seconds early too. So a few lines are aligned by ear in a wide
    window at the start and in the middle of the song, and their start times
    compared. Returns (offset seconds, inconsistent). Two probes that disagree
    mean a different edit, not a different intro, and the timings are useless.
    """
    probes = []
    for anchor in (0, len(lines) // 2):
        group = lines[anchor:anchor + 3]
        if not group:
            continue
        start = float(group[0]["start"])
        end = float(group[-1].get("end") or group[-1]["start"] + 5)
        window_start, window_end = max(0.0, start - 15.0), min(duration, end + 15.0)
        clip = audio[int(window_start * SAMPLE_RATE):int(window_end * SAMPLE_RATE)]
        if len(clip) < SAMPLE_RATE:
            continue
        try:
            result = whisper.align(clip, "\n".join(line["text"] for line in group), language=language, original_split=True)
        except Exception:
            continue
        deltas = []
        for segment, line in zip(result.segments, group):
            spoken = [w for w in (segment.words or []) if w.word.strip() and w.end > w.start]
            if spoken:
                deltas.append(float(spoken[0].start) + window_start - float(line["start"]))
        if deltas:
            deltas.sort()
            probes.append(deltas[len(deltas) // 2])
    if not probes:
        return 0.0, False
    if len(probes) == 2 and abs(probes[0] - probes[1]) > 1.5:
        return 0.0, True
    return sum(probes) / len(probes), False


def sync(audio_path: str, *, model: str = "base", level: str = "word", lyrics_text: str | None = None,
         lines: list[dict] | None = None, language: str | None = None, device: str = "auto",
         ffmpeg_dir: str | None = None, on_event: Event = _quiet) -> dict:
    """Time the lyrics of one song. Returns segments; raises on failure.

    `level` is "word" or "syllable". `lines` (dicts with text/start/end in
    seconds, optionally with timed `words`) switches to line-windowed
    alignment — or, when every line carries a person's word timing, keeps that
    and only adds syllables. `lyrics_text` aligns plain text across the whole
    song; neither transcribes.
    """
    import faster_whisper

    def status(stage, message):
        on_event({"event": "status", "stage": stage, "message": message})

    def progress(percent):
        on_event({"event": "progress", "percent": round(min(100.0, max(0.0, percent)), 1)})

    cuda_dirs = prepare(ffmpeg_dir)
    given_lines = sorted([line for line in (lines or []) if str(line.get("text", "")).strip() and line.get("start") is not None],
                         key=lambda line: float(line["start"])) or None
    given_text = "\n".join(line.strip() for line in (lyrics_text or "").splitlines() if line.strip()) or None
    word_share = 60.0 if level == "syllable" else 100.0

    has_gpu = gpu_count() > 0
    if device == "cpu" or not has_gpu:
        attempts = [("cpu", "int8")]
    elif device == "cuda":
        attempts = [("cuda", "float16")]
    else:
        attempts = [("cuda", "float16"), ("cpu", "int8")]

    last_error: Exception | None = None
    for index, (dev, compute) in enumerate(attempts):
        started = time.time()
        timed_lines, lyrics, note = given_lines, given_text, None
        try:
            status("loading-model", f"Loading the {model} model on the {'GPU' if dev == 'cuda' else 'CPU'}… (the first use downloads it)")
            whisper = _load_whisper(model, dev, compute, lambda message: status("downloading-model", message), progress)
            on_event({"event": "device", "device": dev, "compute": compute,
                      "note": "CUDA 12 libraries loaded from pip packages." if dev == "cuda" and cuda_dirs else ""})
            audio = faster_whisper.decode_audio(audio_path)
            duration = max(len(audio) / float(SAMPLE_RATE), 0.001)
            lang = language or None
            if not lang:
                status("detecting", "Working out the language…")
                detected = whisper.detect_language(audio)
                lang = detected[0]
                status("detected", f"Language: {lang} ({round(detected[1] * 100)}% sure)")

            # Timings from elsewhere are checked against this recording first.
            if timed_lines:
                status("checking", "Checking the lyrics' timing against this recording…")
                offset, inconsistent = estimate_offset(whisper, audio, timed_lines, lang, duration)
                if inconsistent:
                    note = "These lyrics were timed for a different edit of the song, so they were re-aligned from scratch."
                    status("retiming", note)
                    lyrics, timed_lines = "\n".join(line["text"] for line in timed_lines), None
                elif abs(offset) > 0.35:
                    note = f"These lyrics were timed for a version with a different intro; shifted {offset:+.1f}s to match this file."
                    status("shifted", note)
                    timed_lines = shift_lines(timed_lines, offset)
            human_words = bool(timed_lines) and all(line.get("words") for line in timed_lines)
            mode = "from-words" if human_words else "align-lines" if timed_lines else "align" if lyrics else "transcribe"

            if mode == "from-words":
                # A person's word timing beats anything the model would redo.
                segments = []
                for line in timed_lines:
                    words = repair_words([(("" if i == 0 else " ") + str(w["word"]).strip(), float(w["start"]), float(w["end"]))
                                          for i, w in enumerate(line["words"]) if str(w.get("word", "")).strip()])
                    if words:
                        segments.append({"text": line["text"].strip(), "start": words[0][1], "end": words[-1][2],
                                         "words": [{"word": t, "start": s, "end": e} for t, s, e in words]})
                segments = enforce_order(segments)
            elif mode == "align-lines":
                status("aligning", f"Timing the words of {len(timed_lines)} lines, each within its own line's moment…")
                segments = align_by_lines(whisper, audio, timed_lines, lang, duration, on_progress=lambda p: progress(p * word_share / 100))
            else:
                if mode == "align":
                    status("aligning", "Placing each word of your lyrics against the audio…")
                    result = whisper.align(audio, lyrics, language=lang, original_split=True)
                else:
                    status("transcribing", "Transcribing & syncing every word…")
                    result = whisper.transcribe(audio, word_timestamps=True, language=lang, verbose=None, regroup=True,
                                                progress_callback=lambda seek, total=None: progress(seek / (total or duration) * word_share))
                aligned = [(w.word, float(w.start), float(w.end)) for s in result.segments for w in (s.words or []) if w.word.strip()]
                segments = []
                if mode == "align":
                    source_lines = [line for line in lyrics.splitlines() if line.strip()]
                    projected = project_onto_text(" ".join(source_lines), aligned, 0.0, duration)
                    cursor = 0
                    for line in source_lines:
                        count = len(line.split())
                        words = repair_words([(text.strip() if i == 0 else text, s, e) for i, (text, s, e) in enumerate(projected[cursor:cursor + count])])
                        cursor += count
                        if words:
                            segments.append({"text": line.strip(), "start": words[0][1], "end": words[-1][2],
                                             "words": [{"word": t, "start": s, "end": e} for t, s, e in words]})
                else:
                    for s in result.segments:
                        words = repair_words([(w.word, float(w.start), float(w.end)) for w in (s.words or []) if w.word.strip()])
                        if words:
                            segments.append({"text": s.text.strip(), "start": words[0][1], "end": words[-1][2],
                                             "words": [{"word": t, "start": st, "end": e} for t, st, e in words]})
                segments = enforce_order(segments)
            if not segments:
                raise RuntimeError("The model found no words to time. If this is an instrumental, there is nothing to sync.")
            progress(word_share)

            stats = None
            if level == "syllable":
                from .syllables import add_syllables
                status("syllables", "Finding where every syllable sits…")
                aligner = _load_aligner(lambda message: status("loading-syllables", message))
                stats = add_syllables(audio, segments, lang, aligner, on_progress=lambda p: progress(word_share + p * (100 - word_share) / 100))
            progress(100)
            return {"mode": mode, "level": level, "language": lang, "device": dev, "seconds": round(time.time() - started, 1),
                    "duration": round(duration, 3), "segments": segments, "syllableStats": stats, "note": note}
        except Exception as error:  # noqa: BLE001 — every failure becomes a readable message
            last_error = error
            if dev == "cuda" and is_cuda_library_error(error) and index + 1 < len(attempts):
                _models.clear()
                on_event({"event": "device", "device": "cpu", "compute": "int8",
                          "note": f"The GPU could not be used ({str(error)[:140]}). Running on the CPU instead — slower, same result."})
                continue
            raise
    raise last_error or RuntimeError("The sync failed.")
