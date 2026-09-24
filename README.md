<img src="docs/banner.png" alt="Lyrigen — a music player for Windows" width="100%" />

**Lyrigen** is a free music player for the songs already on your computer. Lyrics follow the voice word by word — syllable by syllable when you want karaoke — a DJ mode mixes two songs on the beat, and nothing you play ever leaves the machine. No account, no subscription, no telemetry.

**[Download for Windows →](https://github.com/mufaddalhirani/lyrigen/releases/latest)** &nbsp;·&nbsp; version 2.5.0 &nbsp;·&nbsp; Windows 10 and 11 &nbsp;·&nbsp; companion app: [Lyric Studio](https://github.com/mufaddalhirani/lyrics-studio)

<img src="docs/screenshots/player.jpg" alt="Now playing: word-by-word lyrics beside the album art, over a slowly moving background made from the cover" width="100%" />

---

### 01 &nbsp;The player

<table>
<tr>
<td width="62%" rowspan="2"><img src="docs/screenshots/home.jpg" alt="Home: the song you were last playing, set large" /></td>
<td><img src="docs/screenshots/brat.jpg" alt="brat mode: lime green, words fly in as they are sung" /></td>
</tr>
<tr>
<td><img src="docs/screenshots/player-interlude.jpg" alt="An instrumental break: a small live visualizer between the lines" /></td>
</tr>
</table>

Home opens on what you were last playing. The player puts the lyrics beside the cover, over a background made from the cover itself — blurred, slowly moving, pulsing with the beat ([Kawarp](https://github.com/better-lyrics/kawarp)). Choose the view from the player's top bar: Balanced, Lyrics only, Cover only, Spinning vinyl, Visualizer, or **brat**, where each word flies in from alternate sides as it is sung.

Also on board: a six-band EQ with presets and genre modes, dynamic leveling, pitch shift, pitch-preserving speed, centre-vocal reduction, A–B loops, gapless preloading, resume-where-you-paused, a mini player, and global media keys. The library opens instantly, even with thousands of songs.

### 02 &nbsp;The DJ

<img src="docs/screenshots/dj.jpg" alt="The DJ screen: two decks with waveforms, a mixer, the library and a sampler" width="100%" />

Two decks that find each song's **tempo and beat grid** on their own, then **sync** them — tempo and phase, half- and double-time aware — and keep them locked. Scrolling waveforms, cue and four hot cues per song, loops from ½ to 16 beats, beat roll, vinyl brake, three-band EQ with kills, a filter sweep, echo, reverb, flanger, bitcrush, and an eight-pad sampler. **Automix** blends a queue of songs on the beat; **record** your mix to an Opus file; map any USB controller with **MIDI learn**; go full-screen with party mode.

### 03 &nbsp;Lyrics, found and timed

<table>
<tr>
<td width="36%"><img src="docs/screenshots/library.jpg" alt="The library, by album" /></td>
<td><img src="docs/screenshots/lyrics.jpg" alt="AI lyric sync: word or syllable timing, made on your computer" /></td>
</tr>
</table>

Lyrigen reads `.ttml`, `.lrc`, `.yrc` and `.txt` beside each song, and finds the rest from free sources — Better Lyrics, BiniLyrics, Unison, AMLL TTML DB and LRCLIB — keeping the **best-timed** match. Click any word to jump to it. With **[Lyric Studio](https://github.com/mufaddalhirani/lyrics-studio)** installed, *AI sync* times any song on your own computer, word by word or syllable by syllable, keeping any timing a person already made. Lyrics are saved beside the song and inside its tags, so other players see them too.

---

## Install

1. Download **`Lyrigen.Setup.2.5.0.exe`** from [Releases](https://github.com/mufaddalhirani/lyrigen/releases/latest) — or `Lyrigen-Portable-2.5.0.exe`, a single file that runs without installing.
2. Run it. Windows may say *"Windows protected your PC"*, because the app isn't code-signed yet: choose **More info → Run anyway**.
3. Choose your music folder. Lyrigen scans everything beneath it and remembers it.

**Optional.** For AI lyric sync, install [Python 3.10+](https://www.python.org/downloads/) and [Lyric Studio](https://github.com/mufaddalhirani/lyrics-studio). For the Downloads screen, install yt-dlp and ffmpeg: `winget install yt-dlp.yt-dlp` and `winget install Gyan.FFmpeg`.

<details>
<summary><b>Keyboard</b></summary>

| Key | Action |
|---|---|
| `Space` | Play / pause (in DJ: the louder deck) |
| `←` / `→` | Back / forward 10 seconds |
| `M` · `S` · `R` | Mute · shuffle · repeat mode |
| `Ctrl` + `K` | Search your library (`Esc` clears it) |
| Media keys | Play, previous, next — even in the background |
</details>

<details>
<summary><b>Library tools</b></summary>

- **Metadata Studio** — fix tags and artwork, with undo.
- **Organizer** — plans moves into `Artist\Album\` folders; nothing moves until you approve, and Undo puts it all back.
- **Lyrics Finder** — fills in missing lyrics in bulk, or lets you pick the match.
- **Downloads** (optional, uses your own yt-dlp) — checks a link, lets you correct artist, title and album, then tags it, adds lyrics and files it.
- **Listening** — recaps for the week, month, year or all time, kept on your computer.
</details>

## Privacy

There is no account and no telemetry. Your library, history and settings stay in your Windows user folder. The only network requests are lyric look-ups (which you can switch off) and, if you use them, the optional download and catalogue screens.

## Build from source

```bash
git clone https://github.com/mufaddalhirani/lyrigen.git
cd lyrigen
npm install
npm run dev        # run it while you work on the code
npm run build      # installer + portable exe in release\
```

How it fits together is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the end-to-end checks live in [`scripts/`](scripts/).

## Use it responsibly

The optional Downloads screen drives [yt-dlp](https://github.com/yt-dlp/yt-dlp), which you install yourself. Only download what you have the right to — your own uploads, public-domain or Creative Commons music, or content the service's terms allow.

## Credits

Lyric rendering by [Apple Music-like Lyrics](https://github.com/Steve-xmh/applemusic-like-lyrics); fluid background by [Kawarp](https://github.com/better-lyrics/kawarp); lyrics from [Better Lyrics](https://better-lyrics.boidu.dev), [BiniLyrics](https://lyrics.binimum.org), [Unison](https://unison.boidu.dev), [AMLL TTML DB](https://github.com/Steve-xmh/amll-ttml-db) and [LRCLIB](https://lrclib.net). Type: [Instrument Serif](https://fonts.google.com/specimen/Instrument+Serif) and [Geist](https://vercel.com/font), both OFL. Icons: [Material Symbols](https://fonts.google.com/icons). Built with [Electron](https://www.electronjs.org), [React](https://react.dev) and [Vite](https://vite.dev).

The songs in the screenshots are made up; their covers are public-domain paintings and prints from [The Met's Open Access collection](https://www.metmuseum.org/about-the-met/policies-and-documents/open-access) — van Gogh, Hokusai and Seurat.
