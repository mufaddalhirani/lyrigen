#!/usr/bin/env python3
"""Generate word-level lyric timing for Lyrigen's "Import alignment JSON" tool.

Two free, local engines are supported (research notes: docs/ARCHITECTURE.md):

  mms      Forced alignment with Meta's MMS acoustic model, via the
           ctc-forced-aligner project. Use this when you already have the
           correct lyrics text -- it times YOUR words against the audio
           instead of guessing what was sung, so it is the more accurate
           choice for music.
             pip install git+https://github.com/MahmoudAshraf97/ctc-forced-aligner.git

  whisper  ASR + word timestamps via stable-ts driving faster-whisper. Use
           this when you do not have a lyrics file and want the model to
           transcribe the words too. Less reliable on sung vocals/melisma
           than forced alignment, but needs nothing but the audio.
             pip install -U stable-ts[fw]

Both paths write the same JSON shape Lyrigen's fromAlignmentJson() expects:
  {"segments": [{"words": [{"word": "hello", "start": 0.42, "end": 0.61}, ...]}, ...]}
Timestamps are seconds (Lyrigen converts to milliseconds itself).

Everything here runs on CPU (slower) or GPU (faster) with no paid API calls.

Usage:
  python scripts/align_lyrics.py song.mp3 --lyrics lyrics.txt --engine mms --language eng -o song.alignment.json
  python scripts/align_lyrics.py song.mp3 --engine whisper -o song.alignment.json
"""
import argparse
import json
import sys
from pathlib import Path


def align_with_mms(audio_path: Path, lyrics_path: Path, language: str) -> dict:
    """Forced-align known lyrics against the audio using ctc-forced-aligner's
    documented Python API (not its CLI -- the CLI's exact flags for word-vs-
    line output and where it writes results are not consistently documented
    across versions, so calling the library functions directly is the more
    reliable path). Regroups the flat per-word result back into the
    original lyric lines so the JSON reads naturally in Lyrigen.

    If a newer/older ctc-forced-aligner release renames the dict keys on
    each aligned word, adjust WORD_TEXT_KEYS below to match -- this script
    tries a short list of likely key names rather than hard failing.
    """
    import torch
    from ctc_forced_aligner import (
        load_audio,
        load_alignment_model,
        generate_emissions,
        preprocess_text,
        get_alignments,
        get_spans,
        postprocess_results,
    )

    lines = [line for line in lyrics_path.read_text(encoding='utf-8').splitlines() if line.strip()]
    words_per_line = [len(line.split()) for line in lines]
    text = ' '.join(lines)

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    alignment_model, alignment_tokenizer = load_alignment_model(device, dtype=torch.float16 if device == 'cuda' else torch.float32)
    audio_waveform = load_audio(str(audio_path), alignment_model.dtype, alignment_model.device)
    emissions, stride = generate_emissions(alignment_model, audio_waveform, batch_size=16)
    tokens_starred, text_starred = preprocess_text(text, romanize=True, language=language)
    segments, scores, blank_token = get_alignments(emissions, tokens_starred, alignment_tokenizer)
    spans = get_spans(tokens_starred, segments, blank_token)
    word_timestamps = postprocess_results(text_starred, spans, stride, scores)

    WORD_TEXT_KEYS = ('text', 'word', 'label')

    def word_text(item: dict) -> str:
        for key in WORD_TEXT_KEYS:
            if key in item:
                return item[key]
        raise KeyError(f'Could not find a text field on an aligned word; saw keys {list(item.keys())}. '
                        f'Update WORD_TEXT_KEYS in this script to match your ctc-forced-aligner version.')

    if len(word_timestamps) != sum(words_per_line):
        print(f'warning: aligner produced {len(word_timestamps)} words but the lyrics file has {sum(words_per_line)}; '
              'lines below may drift out of sync near the mismatch.', file=sys.stderr)

    result_segments = []
    cursor = 0
    for count in words_per_line:
        chunk = word_timestamps[cursor:cursor + count]
        cursor += count
        if not chunk:
            continue
        result_segments.append({'words': [{'word': word_text(item), 'start': item['start'], 'end': item['end']} for item in chunk]})
    return {'segments': result_segments}


def align_with_whisper(audio_path: Path, model_size: str) -> dict:
    """Transcribe + word-align with stable-ts on top of faster-whisper. Its
    own JSON export already matches Lyrigen's schema almost exactly."""
    import stable_whisper  # imported lazily so --engine mms doesn't need it installed

    model = stable_whisper.load_faster_whisper(model_size)
    result = model.transcribe(str(audio_path), word_timestamps=True)
    data = result.to_dict()
    segments = [
        {'words': [{'word': word['word'].strip(), 'start': word['start'], 'end': word['end']} for word in segment.get('words', [])]}
        for segment in data.get('segments', [])
    ]
    return {'segments': [segment for segment in segments if segment['words']]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('audio', type=Path, help='Path to the song (mp3/flac/wav/...)')
    parser.add_argument('--lyrics', type=Path, help='Plain-text lyrics, one line per sung line (required for --engine mms)')
    parser.add_argument('--engine', choices=['mms', 'whisper'], default='mms')
    parser.add_argument('--language', default='eng', help='ISO 639-3 code for --engine mms (default: eng)')
    parser.add_argument('--model', default='base', help='faster-whisper model size for --engine whisper (default: base)')
    parser.add_argument('-o', '--output', type=Path, help='Where to write the alignment JSON (default: <audio>.alignment.json)')
    args = parser.parse_args()

    if args.engine == 'mms' and not args.lyrics:
        parser.error('--lyrics is required for --engine mms (forced alignment needs the words to align against)')

    result = align_with_mms(args.audio, args.lyrics, args.language) if args.engine == 'mms' else align_with_whisper(args.audio, args.model)
    output_path = args.output or args.audio.with_suffix('.alignment.json')
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    word_count = sum(len(segment['words']) for segment in result['segments'])
    print(f'Wrote {word_count} timed words across {len(result["segments"])} line(s) to {output_path}')
    print('Open Lyrigen -> Sound Lab -> Import alignment JSON to load it, then Create TTML to save it beside the song.')


if __name__ == '__main__':
    main()
