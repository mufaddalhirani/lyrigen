#!/usr/bin/env python3
"""Lyrigen's local lyric-sync worker: word-level timing with stable-ts + faster-whisper.

Lyrigen runs this as a child process and reads one JSON object per line from
stdout. Nothing here talks to the network except faster-whisper's one-time
model download from Hugging Face.

Three modes:

  align-lines The lyrics are known *and* line-synced (an LRC, say). Each line is
              aligned only within its own moment, which keeps a long intro or a
              repeated chorus from dragging words into the wrong place. Fast
              and reliable even with the small models.
  align       The lyrics are known. stable-ts forces them onto the audio, word
              by word. Far more accurate for sung vocals than transcription,
              because the model only has to find *when* each word is sung,
              never guess *what* it was. Line breaks are kept as written.
  transcribe  No lyrics. Whisper transcribes and times the words itself.

Events written to stdout:
  {"event": "status",   "stage": "...", "message": "..."}
  {"event": "device",   "device": "cuda"|"cpu", "compute": "...", "note": "..."}
  {"event": "progress", "percent": 0..100}
  {"event": "result",   "mode": "...", "language": "..", "device": "..", "segments": [...]}
  {"event": "error",    "message": "..."}

`segments` is the shape Lyrigen's fromAlignmentJson() reads:
  [{"text": "...", "start": s, "end": s, "words": [{"word": "..", "start": s, "end": s}]}]

Usage (normally only Lyrigen calls this):
  python lyric_sync.py --audio song.opus --model base [--lyrics-file lyrics.txt | --lines-file lines.json]
                       [--language en] [--device auto|cuda|cpu] [--ffmpeg-dir C:\\seng]
"""
import argparse
import difflib
import glob
import json
import os
import re
import site
import sys
import time


def emit(event, **data):
    print(json.dumps({"event": event, **data}, ensure_ascii=False), flush=True)


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


def load_model(stable_whisper, model_size, device, compute):
    return stable_whisper.load_faster_whisper(model_size, device=device, compute_type=compute)


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


def align_by_lines(model, audio, lines, language, duration):
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
        emit("progress", percent=round((index + 1) / len(lines) * 100, 1))
    return enforce_order(segments)


def run(args):
    if args.ffmpeg_dir:
        # stable-ts decodes audio by calling the ffmpeg binary; Lyrigen's may not be on PATH.
        os.environ["PATH"] = args.ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
    cuda_dirs = add_cuda_runtime_dirs()

    emit("status", stage="starting", message="Starting the AI engine…")
    try:
        import ctranslate2
        import faster_whisper
        import stable_whisper
    except ImportError as error:
        emit("error", message=f"A Python package is missing ({error.name}). Install with: pip install stable-ts faster-whisper")
        return 2

    lyrics = None
    if args.lyrics_file:
        with open(args.lyrics_file, encoding="utf-8") as handle:
            lyrics = "\n".join(line.strip() for line in handle.read().splitlines() if line.strip())
        if not lyrics:
            lyrics = None
    timed_lines = None
    if args.lines_file:
        with open(args.lines_file, encoding="utf-8") as handle:
            timed_lines = [line for line in json.load(handle) if str(line.get("text", "")).strip() and line.get("start") is not None]
        timed_lines = sorted(timed_lines, key=lambda line: float(line["start"])) or None
    mode = "align-lines" if timed_lines else "align" if lyrics else "transcribe"

    # GPU first when there is one, CPU as the fallback that always works.
    has_gpu = False
    try:
        has_gpu = ctranslate2.get_cuda_device_count() > 0
    except Exception:
        has_gpu = False
    if args.device == "cpu" or not has_gpu:
        attempts = [("cpu", "int8")]
    elif args.device == "cuda":
        attempts = [("cuda", "float16")]
    else:
        attempts = [("cuda", "float16"), ("cpu", "int8")]

    last_error = None
    for index, (device, compute) in enumerate(attempts):
        started = time.time()
        try:
            emit("status", stage="loading-model",
                 message=f"Loading the {args.model} model on the {'GPU' if device == 'cuda' else 'CPU'}… (the first use downloads it)")
            model = load_model(stable_whisper, args.model, device, compute)
            emit("device", device=device, compute=compute,
                 note=("CUDA 12 libraries loaded from pip packages." if device == "cuda" and cuda_dirs else ""))

            audio = faster_whisper.decode_audio(args.audio)
            language = args.language or None
            if not language:
                emit("status", stage="detecting", message="Working out the language…")
                detected = model.detect_language(audio)
                language = detected[0]
                emit("status", stage="detected", message=f"Language: {language} ({round(detected[1] * 100)}% sure)")

            duration = max(len(audio) / float(SAMPLE_RATE), 0.001)
            if mode == "align-lines":
                emit("status", stage="aligning", message=f"Timing the words of {len(timed_lines)} lines, each within its own line's moment…")
                segments = align_by_lines(model, audio, timed_lines, language, duration)
                if not segments:
                    emit("error", message="None of the lines could be timed.")
                    return 3
                emit("progress", percent=100)
                emit("result", mode=mode, language=language, device=device, seconds=round(time.time() - started, 1), segments=segments)
                return 0
            if mode == "align":
                emit("status", stage="aligning", message="Placing each word of your lyrics against the audio…")
                result = model.align(audio, lyrics, language=language, original_split=True)
            else:
                emit("status", stage="transcribing", message="Transcribing & syncing every word…")

                def on_progress(seek, total=None):
                    total = total or duration
                    emit("progress", percent=round(min(100.0, max(0.0, seek / total * 100.0)), 1))

                result = model.transcribe(audio, word_timestamps=True, language=language, verbose=None,
                                          regroup=True, progress_callback=on_progress)

            segments = []
            aligned = [(word.word, float(word.start), float(word.end)) for segment in result.segments for word in (segment.words or []) if word.word.strip()]
            if mode == "align":
                # Your lines, your words: project the timings onto the text as
                # written, then cut it back into the lines you wrote.
                source_lines = [line for line in lyrics.splitlines() if line.strip()]
                projected = project_onto_text(" ".join(source_lines), aligned, 0.0, duration)
                cursor = 0
                for line in source_lines:
                    count = len(line.split())
                    words = repair_words([(text.strip() if i == 0 else text, s, e) for i, (text, s, e) in enumerate(projected[cursor:cursor + count])])
                    cursor += count
                    if words:
                        segments.append({"text": line.strip(), "start": words[0][1], "end": words[-1][2],
                                         "words": [{"word": text, "start": s, "end": e} for text, s, e in words]})
            else:
                for segment in result.segments:
                    words = repair_words([(word.word, float(word.start), float(word.end)) for word in (segment.words or []) if word.word.strip()])
                    if words:
                        segments.append({"text": segment.text.strip(), "start": words[0][1], "end": words[-1][2],
                                         "words": [{"word": text, "start": s, "end": e} for text, s, e in words]})
            segments = enforce_order(segments)
            if not segments:
                emit("error", message="The model found no words to time. If this is an instrumental, there is nothing to sync.")
                return 3
            emit("progress", percent=100)
            emit("result", mode=mode, language=language, device=device, seconds=round(time.time() - started, 1), segments=segments)
            return 0
        except Exception as error:  # noqa: BLE001 — everything becomes a readable event
            last_error = error
            if device == "cuda" and is_cuda_library_error(error) and index + 1 < len(attempts):
                emit("device", device="cpu", compute="int8",
                     note=f"The GPU could not be used ({str(error)[:140]}). Running on the CPU instead — slower, same result.")
                continue
            break
    emit("error", message=f"{type(last_error).__name__}: {last_error}")
    return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--lyrics-file")
    parser.add_argument("--lines-file", help="JSON list of {text, start, end} lines (seconds) from line-synced lyrics")
    parser.add_argument("--language")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--ffmpeg-dir")
    args = parser.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    try:
        sys.exit(run(args))
    except KeyboardInterrupt:
        emit("error", message="Cancelled.")
        sys.exit(130)


if __name__ == "__main__":
    main()
