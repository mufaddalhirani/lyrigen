# Lyrigen 2.0

A free, local-first Windows music player with liquid visuals and synced lyrics.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the app is built, how the visual modes and DSP genre presets work, and how to get real word-level lyric timing for free with Meta's MMS forced aligner or faster-whisper + stable-ts.

## Start listening

1. Build it: `npm install`, then `npm run build`. That produces an installer (Start Menu shortcut and uninstaller) and a portable `.exe` in `release\`, both named with the current version. Use `npm run build:dir` for just an unpacked `release\win-unpacked\Lyrigen.exe`, or `npm run dev` while working on the code.

   To cut a new version, use `npm run release:patch` (fixes), `release:minor` (features) or `release:major`. Each bumps the version, deletes the previous artifacts and rebuilds, so `release\` only ever holds one installer and one portable — which is what makes two builds tellable apart.
2. Choose the one main folder that contains your music.
3. Lyrigen remembers it and scans every folder beneath it whenever the app opens.

The Home screen stays lightweight and does not open the full track list automatically. Open Library when you want the sorted album/folder view; use Smart Library for Needs lyrics, Lossless, Videos, Duplicates, and My playlist.

New albums appear automatically while the app is open. Nothing is uploaded, and local playback does not need an account.

## Lyrics

- Put an `.lrc`, `.ttml`, `.yrc`, or `.txt` file beside its song with the same filename.
- If no local file exists, playing the song automatically checks the free AMLL TTML DB first — a community mirror of real, word-by-word Apple Music lyrics, searchable by title/artist, no login or subscription needed — then falls back to LRCLIB for a line-synced match.
- Open Sound Lab to save a matched LRC, or use **Create TTML** to save a fetched/estimated document as an Apple-style word-timed TTML file beside the song (this also re-saves a freshly-fetched AMLL TTML match locally).
- LRC lines are enhanced into estimated word flow. Real word-timed TTML/YRC (from the AMLL DB, a downloaded file, or forced alignment) remains more precise.
- Use the ±50 ms controls when a lyric file needs a small timing correction.
- Click any lyric line to seek it; the selected line is re-centered even after manual scrolling.
- Discover links to the free AMLL TTML editor and community TTML database for true word timing.
- No lyrics file at all, or want real word timing for a song you already have plain lyrics for? Sound Lab → Lyric tools → **Import alignment JSON** accepts free, local output from Meta's MMS forced aligner or faster-whisper + stable-ts — see `scripts/align_lyrics.py` and `docs/ARCHITECTURE.md`.

## Downloading, sorting and lyrics

These three screens live under **Tools** in the sidebar. They need `yt-dlp.exe` and `ffmpeg.exe` / `ffprobe.exe` on your machine — Lyrigen does not bundle or download them. It looks in the folder you set in Settings, then `C:\seng`, `C:\ffmpeg\bin`, `C:\tools`, scoop, WinGet and `PATH`, and the Downloads screen tells you which ones it found.

- **Downloads** — paste a YouTube link (or a playlist) and Lyrigen inspects it, shows you the artist/title/album it worked out from the video title, and lets you correct anything before it starts. Then it downloads, writes clean tags, finds lyrics, and files the song away — one pass, with live progress.
- **Organizer** — point it at a folder of loose downloads and it builds a **plan**: what each file actually is, and where it would go. Nothing moves until you approve it, you can edit any row, and **Undo** puts the whole batch back. Songs are sorted into `Artist\Album\` folders that it creates as needed (several layouts to choose from, or write your own template). Lyric and cover files travel with the song.
- **Lyrics Finder** — fetches lyrics for songs in your library that have none, in bulk, or lets you pick the match yourself per song.

Lyrics come from four free sources, and Lyrigen always keeps the **best-timed** one rather than the first that answers:

| Source | Timing | Notes |
|---|---|---|
| **Better Lyrics** | syllable / word | Same API the Better Lyrics extension uses, which itself aggregates Musixmatch, BiniLyrics, Kugou and its own corpus |
| **Unison** | word / line | Crowdsourced; matched by YouTube video id, so Lyrigen's own downloads hit exactly |
| **AMLL TTML DB** | word | Community mirror of Apple Music word-synced TTML |
| **LRCLIB** | line | Broadest coverage, line-synced only — the last resort, not the default |

Selection is by timing granularity first (syllable → word → line → plain), then match quality, then source. A line-synced LRCLIB hit can no longer beat word-synced TTML for the same song. The granularity is verified by reading the fetched document, not trusted from the search result.

**About the Better Lyrics cache.** Its API serves anything already cached with no key, and Lyrigen falls straight through to Unison → AMLL → LRCLIB when a song isn't. Keys are not currently being issued (each cache miss costs them a paid upstream lookup), so leave that setting empty. Their docs suggest playing a song in the Better Lyrics extension primes the cache; in testing that did not hold — songs played in the extension still came back as cache misses — so treat it as unreliable. For songs no source covers word-synced, run local forced alignment (see `scripts/align_lyrics.py`) to generate real word timing from line-synced lyrics.

Lyrics are saved **twice, on purpose**: as a `.ttml`/`.lrc` file beside the song, which keeps word-by-word timing and is what Lyrigen reads, and **inside the audio file's own tags** so any other player shows them too (ID3 `USLT` + `SYLT` for MP3; a `lyrics` tag for M4A, FLAC and Opus, written by an ffmpeg stream copy — no re-encode, no quality loss). They are fetched once and kept, so playing a song again never re-downloads them. Both can be switched off per screen.

Sped-up and slowed edits are handled: Lyrigen recognises Nightcore / Slowed + Reverb / Daycore and similar in a title, and stretches the lyric timestamps to the file's real length so they still line up.

Set an **inbox folder** in Downloads settings (your browser's download folder, say) and anything audio that lands there is tagged, given lyrics and filed automatically.

## Listening and recaps

The **Listening** screen keeps a recap for the last week, month, year, or all time: plays, hours listened, how many different songs and artists, your top artists, songs and genres, and a chart of when you listened. Everything stays on this computer — no account, nothing uploaded.

Plays are counted once per track per play, so hours listened treats each play as a full listen.

## Settings

**Settings** in the sidebar covers how the app behaves:

- **When Lyrigen opens** — start playing automatically (off by default), resume where you left off, rescan folders on launch.
- **Lyrics** — look up lyrics automatically for songs that have none.
- **Window** — keep running in the tray when closed, and reduced motion.
- **Safety** — confirm before the Organizer moves anything.
- **Library folders** — add or remove the folders Lyrigen scans. Removing one only stops it being scanned; no files are deleted.
- **Data** — clear play history or resume positions, reset the window size, open the data folder.

Settings that belong to one feature stay with it — download options in Downloads, themes in Sound Lab, EQ on the player — and are linked from Settings rather than duplicated, so there is only ever one of each.

## Suggestions

Home builds four shelves from your own library and play counts — no service, no account, nothing leaves the machine:

- **Speed dial** — what you reach for most.
- **Quick picks** — more from the artists you have been playing, weighted toward tracks you have *not* worn out.
- **On repeat lately** — what you have played recently.
- **Never played** — in your library, never opened.

**Shuffle everything** starts a random run through the whole library.

## Sound Lab

Four sections: **Appearance** (themes, type, lyric motion), **Sound** (what each playback control does), **Lyric tools** (the LRC → TTML converter), and **Mixer**.

The player's sound controls include **bass and treble** shortcuts over the six-band EQ, and **pitch** — shift the key by up to a tone either way without changing speed. Centred, the pitch shifter is bypassed entirely.

The **mixer** is two decks with independent speed, trim and an equal-power crossfader, running on its own audio graph so it never disturbs playback or your queue. There is no tempo detection — match tracks by ear with the speed sliders, the way you would on real decks.

## Themes and appearance

Sound Lab → **Themes** changes how the whole app looks, straight away, and remembers it:

- **Theme** — Nocturne Bloom (default), Spotlight (high contrast), Lucid (cool frosted glass), Ember (warm, low glare), Paper (light), Monochrome (greyscale, minimal motion).
- **Typeface** — System, Serif, Rounded, Mono or Condensed, applied to both the interface and the lyrics.
- **Lyric motion** — Glow, Scale, Focus (blurs inactive lines) or Still. Pick **Still** on a weaker GPU; it removes per-line animation entirely.

Icons throughout are [Google Material Symbols](https://fonts.google.com/icons) (Apache 2.0), bundled into the app rather than fetched, so nothing depends on a network connection.

## Lyrics you can click

With word-synced lyrics, **clicking any word jumps to that exact word** — not just the start of the line. Words highlight as you hover so you can see the target. Clicking the gap between words still seeks to the line start.

## Visual modes

Open Sound Lab while a track is playing to switch the now-playing screen between five views: **Balanced** (cover + lyrics together), **Lyrics only**, **Cover only**, **Spinning vinyl** (the album art becomes a slowly turning record), and **Reactive visualizer** (lightweight bars that follow the music). The "Reduced motion" toggle right below it turns off all of the ambient/spinning/bar animation for slower machines while keeping word-by-word lyric highlighting.

## Controls

- `Space`: play or pause
- `Left` / `Right`: move 10 seconds
- `M`: mute
- `S`: shuffle
- `R`: repeat mode
- Media play, previous, and next keys work globally while Lyrigen is running.

Sound Lab includes a six-band equalizer with tone presets (Flat, Warm, Bass lift, Vocal focus, Late night, Bright, Hyperpop, Lo-fi, Dream pop, Night drive, Vinyl warmth, Arena), dynamic leveling, pitch-preserving speed, center-vocal reduction, and A–B looping. These are local tone-shaping presets — a light EQ curve and, on a couple of them, a touch of waveshaper drive — not AI genre conversion. The mini-player stays above other windows. Same-name local video files can become synchronized backdrops. Lyrigen also remembers where you paused a track and picks up from there next time.

Use the Speed dial for precise 0.05× steps. Right-click a track to add/remove it from the local My playlist. The in-app mini-player keeps audio playing while you browse Home, Library, and Smart Library; the optional always-on-top mini window remains available too. Next-track audio is preloaded for a fast, gapless-style handoff without a continuous visualizer loop.

## Free catalogs

The Discover screen links to LRCLIB, MusicBrainz, Internet Archive Audio, and Free Music Archive. Licenses vary on public music sites; check each item before downloading or sharing it.
