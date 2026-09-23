# Lyric Studio

Word- and **syllable**-timed lyrics, made on your own computer — for karaoke,
for [Lyrigen](../README.md), or for any player that reads TTML or LRC.

Pick a song. Its lyrics are found online by themselves. Choose word or syllable
timing and press **Generate**. A `.ttml` (and/or `.lrc`) lands next to the song.
Nothing is uploaded; the AI runs locally, on your GPU if you have one.

## Install

1. Install [Python 3.10+](https://www.python.org/downloads/) (tick *Add python.exe to PATH*).
2. Double-click **`install.bat`**.

That's it — "Lyric Studio" appears in the Start menu and on the desktop. With an
NVIDIA GPU the installer also adds the CUDA 12 libraries faster-whisper needs,
whatever CUDA version your system has. The AI models download on first use
(Whisper *base* ≈ 145 MB; the syllable aligner ≈ 1.2 GB), then it works offline.

To run from this folder without installing: `run.bat`.

## How it times lyrics

| You have… | What happens | Speed |
|---|---|---|
| Lyrics word-timed by a person (BiniLyrics TTML) | Their word timing is kept; only syllables are added | fastest, most accurate |
| Line-timed lyrics (an LRC from LRCLIB) | Each line's words are aligned inside that line's moment | seconds per song |
| Plain lyrics | Aligned across the whole song | pick *Small* or larger; minutes on CPU |
| No lyrics | Whisper transcribes and times the words itself | depends on model |

**The model decides timing, never spelling.** Its output is mapped back onto
your exact words, so lyrics come out exactly as they went in.

**Syllables** come from Meta's MMS aligner (1,130 languages): every syllable is
romanised, and the model finds where each letter is sung, 20 ms at a time. That
is what makes a held note stretch in karaoke instead of splitting evenly.
English uses spoken-syllable rules (*ri·ver*, *lit·tle*, one-syllable *jumped*);
Hindi and other Indic scripts split by akshara (*आ·शि·क़ा·ना*); Japanese by mora.

## Lyrigen

Lyrigen's *Sync with AI* panel runs this same engine (`python -m lyricstudio.cli`),
so a file made in either plays word-by-word — or syllable-by-syllable — in the other.

## Command line

```
python -m lyricstudio.cli --audio song.opus --level syllable --find-lyrics
```

Prints JSON events, one per line; the final `result` includes the finished TTML
and LRC. See `lyricstudio/cli.py` for every option.

## Credits

[stable-ts](https://github.com/jianfch/stable-ts) ·
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) ·
[MMS forced aligner](https://huggingface.co/MahmoudAshraf/mms-300m-1130-forced-aligner) ·
[uroman](https://github.com/isi-nlp/uroman) ·
lyrics from [BiniLyrics](https://lyrics.binimum.org) and [LRCLIB](https://lrclib.net).
