# Lyrigen — architecture & feature guide

Lyrigen is a free, local-first Windows music player: Electron + React (Vite) on
the front end, a Node/Electron main process for the file system and network
side, and no account or server of its own. This document is the map: what the
app is made of, how each feature actually works, what was fixed in this pass,
and what a future contributor (human or AI) should know before touching it.

## 1. Stack and layout

- **Renderer**: React 18 + TypeScript, plain CSS (`src/App.css`, intentionally
  hand-written and mostly minified rather than a framework) built with Vite.
- **Main process**: Electron 28, TypeScript, built with the same Vite pipeline
  via `vite-plugin-electron` (see `vite.config.ts`).
- **Lyrics**: [`@applemusic-like-lyrics`](https://github.com/Steve-xmh/applemusic-like-lyrics)
  (`core` + `lyric` + `react` packages) — the same renderer the AMLL desktop
  app and several other Apple-Music-style players use for smooth, word-level
  synced lyrics.
- **Tags**: `music-metadata` (read) and `node-id3` (write, MP3 only).
- **Packaging**: `electron-builder` → NSIS installer + a portable `.exe`.

```
src/
  App.tsx / App.css       Shell: sidebar, library views, playlists, home
  components/
    Player.tsx             Now-playing screen: visual modes, EQ, lyrics UI
    SyncedLyrics.tsx        Thin wrapper around AMLL's <LyricPlayer>
    MetadataStudio.tsx      Bulk "research + apply" metadata tool
    LrcConverter.tsx        Drag-and-drop LRC → TTML converter
  hooks/useAudioPlayer.ts   Web Audio graph: EQ, karaoke, leveling, waveshaper
  lib/lyrics.ts             Parse/normalize LRC/TTML/YRC/alignment-JSON
  lib/lrcToTtml.ts          Standalone LRC → TTML converter (own weighting)
  views/
    Downloads.tsx           Download queue GUI: paste a link, review, watch it run
    Organizer.tsx           Preview-then-apply file sorter for existing folders
    LyricsHub.tsx           Bulk lyric fetch for songs that have none
electron/
  main.ts                   Library scanning, IPC handlers, window/tray/mini-mode
  metadata-files.ts         Tag writer (MP3 embed / sidecar) + undo journal
  downloader.ts             Download queue + file organiser (the pipeline in §12)
  media-tools.ts            yt-dlp / ffmpeg / ffprobe discovery and invocation
  lyrics-sources.ts         Unison + AMLL + LRCLIB lookup, re-timing, conversion
  song-naming.ts            "Artist - Title (Sped Up) [videoId]" → structured fields
  artwork-cache.ts          Extracted cover art, cached on disk
  catalog.ts                Rate limiting, match scoring, bounded concurrency
  state-store.ts            JSON persisted state (library roots, playlists, …)
  preload.ts                contextBridge surface exposed as window.electronAPI
scripts/
  smoke-visual-modes.mjs    Headless Playwright+Electron check for the 5 visual modes
  align_lyrics.py           Optional local forced-alignment helper (see §6)
docs/ARCHITECTURE.md        This file
```

Everything talks to the outside world only for things that are explicitly
optional and clearly labeled in the UI: LRCLIB (lyrics), MusicBrainz + Cover
Art Archive (metadata/artwork), Internet Archive / Free Music Archive
(Discover tab links). Your audio files are never uploaded anywhere.

## 2. What this pass fixed

The previous session had built almost everything described below, but left a
few things broken or unfinished. In order of how much they mattered:

1. **`src/App.tsx` didn't compile.** A JSX prop (`onPlaybackModes={...}`) was
   missing its closing `}`, so `tsc`/`vite build` failed outright. This is
   almost certainly what "test the main program" would have hit immediately.
   Fixed — the project now type-checks and builds cleanly end to end
   (renderer, Electron main, preload).
2. **The visual modes had no CSS.** `Player.tsx` already had full state for
   `balanced / lyrics / cover / vinyl / visualizer`, but not one of the
   classes it sets (`.visual-mode-*`, `.vinyl-rim`, `.visualizer-stage`, the
   `--bar-phase`/`--bar-height`/`--audio-energy`/`--bass-energy` custom
   properties) had a matching CSS rule anywhere. Selecting "Spinning vinyl"
   did nothing visually. See §4 for what was built.
3. **The "Reduced motion" toggle did nothing.** It flipped a `.reduce-motion`
   class that no rule ever targeted (only the OS-level
   `prefers-reduced-motion` media query worked). Now the manual toggle
   actually disables the new ambient/vinyl/visualizer animations too.
4. **`fromAlignmentJson()` was dead code.** `lib/lyrics.ts` already had a
   function to import Whisper/stable-ts-style word-timestamp JSON, but
   nothing in the UI ever called it. Wired up as an "Import alignment JSON"
   button in Sound Lab → Lyric tools, backed by a new
   `choose-alignment-json` IPC handler. See §6.
5. **`resumePositions` was written by nothing and read by nothing.** The
   persisted-state schema had a slot for "resume where you left off," but no
   code ever populated or consulted it. It's now wired end to end (§5).
6. Minor cleanup: duplicate `saveLyrics`/`saveTtml` entries in
   `electron.d.ts`, `@applemusic-like-lyrics/*` pinned to the versions
   actually resolved in the lockfile instead of `"latest"` (so a fresh
   `npm install` a year from now can't silently pull a breaking major),
   MusicBrainz calls now share one retrying helper.

Everything above was verified with `tsc --noEmit`, a full `vite build`, and a
Playwright-driven Electron run that clicks through all five visual modes and
asserts the DOM actually changed shape (see §7).

## 3. Feature tour

Most of this already existed; it's listed here so the whole app is
documented in one place, not just what changed.

- **Local-first library**: pick one or more root folders; Lyrigen recursively
  scans, watches them for changes (`fs.watch` + debounce), and indexes
  title/artist/album/genre/duration/lossless-ness via `music-metadata`, with a
  small on-disk cache keyed by file size + mtime so re-scans are cheap.
- **Lyrics, in order of preference**: a same-name `.ttml`/`.lrc`/`.yrc`/`.txt`
  file beside the song → a free lookup against the **AMLL TTML DB**
  (`api.amll.dev`, see §6 below) for a *real* word-synced Apple Music TTML →
  a free LRCLIB lookup for a line-synced match. TTML (local or fetched) gives
  true word-level timing; plain LRC is upgraded to *estimated* word timing
  (weighted by character count) so AMLL's word-highlight still looks
  reasonable without real per-word data.
- **Sound Lab**: 6-band EQ with presets (see §5 for the two new ones),
  pitch-preserving variable speed, a center-vocal-cancellation "karaoke" path,
  dynamic-range leveling, and A–B looping — all built on a fairly small Web
  Audio graph (`hooks/useAudioPlayer.ts`): one `AnalyserNode` feeds both the
  EQ chain and a parallel stereo-cancel chain, mixed by two `GainNode`s so
  toggling karaoke mode is just a gain flip, not a graph rebuild.
- **Metadata Studio**: add files/a folder/your whole library, "Research all"
  queries MusicBrainz (rate-limited to ~1 request/sec, the documented free
  tier), scores candidates against your existing tags + duration, and only
  auto-selects high-confidence matches for you to review before writing.
  Writes go through `metadata-files.ts`, which always makes a timestamped
  backup first and keeps a JSON undo journal — "Undo last edit" is a real,
  file-level undo, not just an in-memory one.
- **LRC → TTML converter**: a standalone drag-and-drop tool
  (`components/LrcConverter.tsx` + `lib/lrcToTtml.ts`) for turning a plain
  LRC into an Apple-style TTML with estimated word spans, independent of the
  AMLL library's own parser (used for the *in-player* lyric pipeline instead).
- **Playback niceties**: gapless-feeling next-track preloading, Media Session
  integration (OS media keys + lock-screen metadata), a tray icon with
  play/pause/skip, a floating always-on-top mini player, and global media-key
  shortcuts.

## 4. Visual modes (this pass's main addition)

`Player.tsx` exposes five modes via the Sound Lab settings drawer, kept in
the DOM as a single `visual-mode-${mode}` class on the player shell so the
layout differences are pure CSS — no extra re-renders when you switch modes.

| Mode | What changes |
|---|---|
| Balanced | default: cover + details on the left, lyrics panel on the right |
| Lyrics only | artwork column hidden, lyrics panel expands to a centered ~760px column |
| Cover only | lyrics panel hidden, artwork grows to ~40% of viewport width |
| Spinning vinyl | same as Cover only, plus the artwork becomes a circle with a grooved rim (`repeating-radial-gradient`, no images) and spins via a CSS `@keyframes` rotation that's paused/resumed by toggling `.is-playing` — no JavaScript animation loop |
| Reactive visualizer | artwork dims to a faint backdrop; 18 bars fade in, each bar's resting height is set once inline (`--bar-height`), and its *live* height comes from `scaleY(calc(.55 + var(--audio-energy) * .85))`, where `--audio-energy` is a CSS custom property the player already updates from the Web Audio analyser (~6 fps, see §5) |

Everything here is `transform`/`opacity` only (rotation, scale, translate) —
nothing triggers layout or paint on every frame, which matters for the
performance target below. The ambient background (`.wave-a`/`.wave-b`) uses
soft `radial-gradient` blobs instead of `filter: blur()` on an animated
element, since an animated blur is one of the more expensive things you can
ask a GPU to recomposite every frame; a gradient already has a soft edge for
free. The one `filter: blur(55px)` in the app (`.cover-bloom`, the ambient
glow behind the whole background) is **static** — it only repaints when the
track's cover art changes, not per frame.

## 5. Performance notes (target: GTX 1650 + Ryzen 5 5600, 16 GB RAM)

This is a mid/entry tier discrete GPU, so the guiding rule for every visual
addition in this pass was: *animate `transform`/`opacity` only, never
`width`/`height`/`filter`/`box-shadow` on anything that moves continuously.*
Concretely:

- The audio analyser (`useAudioPlayer.ts`) samples at 256 FFT bins and only
  pushes new `audioEnergy`/`bassEnergy` React state ~6 times a second
  (`clock - lastVisualRenderRef.current >= 150`), not every animation frame —
  that's plenty for a "breathing" visual and an order of magnitude cheaper
  than driving it from `requestAnimationFrame`.
- Playback time (`currentTimeMs`) is similarly throttled to ~5 fps
  (`>= 200` ms) for React state, while the actual lyric sync
  (`SyncedLyrics.tsx`) drives AMLL's own internal clock directly via
  `player.setCurrentTime()`/`.update()` on a separate ~30fps timer that is
  paused whenever the tab/window is hidden (`document.hidden`) — the two
  clocks are deliberately decoupled so lyric smoothness never depends on a
  full React re-render.
- `SyncedLyrics.tsx` already turns off AMLL's own scale animation when
  Reduced Motion is on (`enableScale={!reducedMotion}`); this pass makes sure
  the *new* ambient/vinyl/visualizer effects respect the same toggle
  (`.reduce-motion` — see §2, item 3).
- Video backdrops (`videoPath`) default to **off** even when a matching video
  file exists, specifically because decoding video is expensive on
  integrated/low-tier GPUs; the user opts in per track.
- The renderer bundle is a single ~670 KB (⇒ ~200 KB gzipped) chunk. It's
  not code-split, which Vite flags as a build warning; on a fast local load
  (Electron, not a cold internet fetch) this is a non-issue for parse time,
  so it wasn't worth the complexity of manual chunking for this pass — noted
  here in case a future change makes bundle size matter more (e.g. shipping
  the renderer over a slow channel).

## 6. Lyrics timing: TTML, AMLL, and free forced alignment

**How AMLL fits in.** `SyncedLyrics.tsx` is a thin wrapper around
`@applemusic-like-lyrics/react`'s `<LyricPlayer>`. Lyrigen's job is just to
keep AMLL's internal clock in sync with the `<audio>` element
(`player.setCurrentTime(audio.currentTime * 1000 + offsetMs)`) and hand it
already-parsed `LyricLine[]` data; AMLL owns all the actual scroll physics,
word-highlight animation, and blur/scale effects.

**Where the lines come from.** `lib/lyrics.ts` normalizes four input shapes
into that same `LyricLine[]` before handing them to AMLL:

- `.ttml` — real word-level timing, parsed by AMLL's own `parseTTML`.
- `.lrc` (plain) — line-level timing only; `estimateWordTiming()` fakes word
  spans by splitting each line's text and weighting each word's share of the
  line's duration by its character count. It looks convincing but it is a
  guess, and it's labeled as `estimated` in the UI (vs `word` for real
  per-word data) so you always know which you're looking at.
- Enhanced/"ESLRC" (`<mm:ss.xx>` word tags inline) and `.yrc` — real
  per-word timing, same as TTML.
- Whisper/stable-ts-style alignment JSON — see below.

**Fetching real word timing for free — the AMLL TTML DB.** Before falling
back to LRCLIB or a local alignment run, Lyrigen now queries
[`api.amll.dev`](https://amll.dev/reference/http-api/overview) — a free,
no-auth REST API (Rust/Wasm, Cloudflare Workers, 50 req/s per IP, no key
needed) in front of the community-run
[`amll-ttml-db`](https://github.com/amll-dev/amll-ttml-db) mirror of real
Apple Music word-synced TTML, cross-referenced by Apple Music/Spotify/
NetEase/QQ Music id and ISRC. The lookup (`fetchAmllTtmlLyrics` in
`electron/main.ts`) is two calls: `GET /v1/lyrics/search?musicName=...&artistName=...`
to find a matching entry's numeric id, then `GET /v1/lyrics/get?id=...`,
whose `data.lyrics` field is the raw TTML string — the exact same
`itunes:timing="Word"` dialect AMLL's own parser already expects, so it
needs zero new parsing code on Lyrigen's side. The API also exposes an
LRCLIB-compatible shim (`/v1/lrclib/get`, `/v1/lrclib/search`) for apps that
only want a drop-in LRCLIB replacement, but Lyrigen calls the native
endpoint so it gets the real word-level TTML rather than a downgraded
line-synced copy. This is the same underlying database the AMLL TTML Tool
and community editor (linked from Discover) read from and write to, so a
song that's missing here can often be contributed there.

**Getting real word timing for songs that aren't in any database.** Two
free, local options were researched for turning "I have a song and its
lyrics, but no synced file exists anywhere" into real per-word timestamps:

1. **Meta's MMS acoustic model via forced alignment** — the
   [`ctc-forced-aligner`](https://github.com/MahmoudAshraf97/ctc-forced-aligner)
   project (`pip install git+https://github.com/MahmoudAshraf97/ctc-forced-aligner.git`)
   times *your own* correct lyrics text against the audio using a
   wav2vec2/MMS acoustic model, rather than transcribing from scratch. This
   is the more accurate choice for music specifically, because it never has
   to *guess* a word — it only has to find where each already-known word
   falls in time, which is far more forgiving of singing, melisma, and
   non-standard pronunciation than ASR.
2. **faster-whisper + stable-ts** — `pip install -U stable-ts[fw]`, then
   `stable_whisper.load_faster_whisper('base').transcribe(...)`. This is
   ASR (it transcribes the words itself) with word-level timestamps bolted
   on via cross-attention. Use it when you *don't* have a lyrics file at
   all; it's noticeably less reliable on sung vocals than forced alignment
   because it also has to get the words right, not just their timing.

Both run entirely on your own machine (CPU works, GPU is faster) with no paid
API and no per-request cost. `scripts/align_lyrics.py` wraps both behind one
CLI and writes out exactly the JSON shape Lyrigen's `fromAlignmentJson()`
expects:

```jsonc
{ "segments": [ { "words": [ { "word": "hello", "start": 0.42, "end": 0.61 }, ... ] } ] }
```

(Timestamps in **seconds**; Lyrigen converts to integer milliseconds itself.)

```bash
pip install git+https://github.com/MahmoudAshraf97/ctc-forced-aligner.git   # for --engine mms
pip install -U "stable-ts[fw]"                                              # for --engine whisper

python scripts/align_lyrics.py "song.mp3" --lyrics "song.txt" --engine mms --language eng
python scripts/align_lyrics.py "song.mp3" --engine whisper
```

Then in Lyrigen: open the track, Sound Lab → Lyric tools → **Import
alignment JSON**, pick the `.json` the script wrote, review the timing, and
**Create TTML** to save it beside the song as a normal `.ttml` file (from
then on it's a regular local lyric file — the alignment step never has to be
repeated). The `ctc-forced-aligner` Python-API call sequence in the script
was copied from that project's own README verbatim; if a future release of
that package renames a field on each aligned word, `WORD_TEXT_KEYS` at the
top of `align_with_mms()` is the one place to adjust.

**Not implemented, on purpose:** turning an arbitrary song into a *different
genre* (e.g. "make this sound like hyperpop") is a real AI style-transfer /
music-generation research problem, not a forced-alignment problem, and
nothing free does it robustly or in real time today. What Lyrigen ships
instead (§ below) is honest, instant, zero-latency DSP tone-shaping — real
EQ curves and a light waveshaper, not a claim of AI remixing.

## 7. DSP "genre" presets

`hooks/useAudioPlayer.ts` exposes EQ presets through a small, fixed Web
Audio graph (six `BiquadFilterNode`s + one shared `WaveShaperNode` for a
touch of harmonic drive on a couple of presets). This pass added two:

- **Vinyl warmth** — rolled-off highs, a small bass/low-mid lift, and a
  gentle `tanh` waveshaper drive (amount 4, vs. Hyperpop's 12) for a warm,
  slightly saturated analog feel.
- **Arena** — a scooped-mid, boosted-low/high curve, the classic "make it
  sound big in a room" EQ shape.

These sit alongside the existing Hyperpop, Lo-fi, Dream pop, and Night drive
presets. All of it is instant (no processing delay, no offline render step)
because it's just live filter coefficients — the tradeoff for that is that
it's tone-shaping, not genre transformation.

## 8. Session restoration ("resume where you left off")

New in this pass. `state-store.ts` already had a `resumePositions` map in
its schema, but nothing wrote to it with real data and nothing read it back.
Now:

- Every ~15 seconds during playback, and immediately on pause, the current
  position is saved via a dedicated `save-resume-position` IPC call — kept
  deliberately separate from `record-play` (which still fires once per
  play-start, unchanged) so this doesn't inflate "recently played"/"most
  played" stats.
- When a track loads, Lyrigen looks up its saved position and seeks there
  automatically, but only if it's meaningfully into the song (> 4 seconds)
  and not essentially finished (< 97% of duration) — so replaying a track
  you already finished doesn't awkwardly restart 3 seconds from the end.

## 9. What other music players do well (research notes)

A quick survey of other free/open players' standout ideas, for context on
what Lyrigen already covers and what could be worth borrowing later:

- **Feishin** — a command-palette-style keyboard launcher for navigation, and
  listening statistics.
- **Euphonica** — synced lyrics + a waveform-shaped scrubber + a background
  visualizer, i.e. roughly the combination Lyrigen's "Reactive visualizer"
  mode is going for.
- **Amberol** — a genuinely minimal UI and session restoration (now also true
  of Lyrigen — see §8).
- **Tauon** — network source support (Plex/Subsonic/Jellyfin/Spotify), an
  in-app lyrics editor, and Discord Rich Presence.
- **Lollypop** — a daily "album of the day" curation surfaced on the home
  screen.
- Several players (Recordbox, Plattenalbum) lean on a strong album-first
  browsing view, which Lyrigen's "Albums" collection view already covers via
  the shared entity-grid.

Ideas not implemented in this pass, worth a future look: a literal
waveform-shaped progress scrubber (visually distinct from today's plain
range slider — would need pre-computed peak data, ideally cached alongside
the existing per-file metadata cache); Discord Rich Presence (low effort, a
few IPC calls to `discord-rpc`); and a keyboard command palette (medium
effort — Lyrigen already has global shortcuts and a search field, a palette
would unify them).

## 10. Testing

- `npx tsc --noEmit` — the whole project (renderer + Electron main) is one
  TypeScript program (see `tsconfig.json`'s `include`); this alone would have
  caught the broken build in §2.
- `npm run build:dir` — full Vite + electron-builder build without packaging
  installers, fastest way to confirm everything actually compiles.
- `npm run smoke:visual-modes` — headless (Playwright's Electron driver)
  regression test: synthesizes an 8-second test tone with `ffmpeg`, boots the
  real app against a throwaway library, opens a track, and cycles all five
  visual modes, asserting the DOM actually reflects each one (lyrics column
  shown/hidden, artwork column shown/hidden, vinyl rim present, visualizer
  bars visible) and saving a screenshot of each to `.smoke-shots/` for a
  human to eyeball. Needs `ffmpeg` on `PATH`; on Linux CI, run it under
  `xvfb-run` since Electron needs a display.
- `electron/main.ts` also has its own long-standing `--smoke-test=<png>` +
  `--library-root=` + `--smoke-open-first` etc. flags (used to generate the
  `smoke-*.png` screenshots that were floating around the repo root before
  this cleanup) for a lower-level, no-Playwright-needed sanity check that the
  renderer boots and paints something.

## 11. Running it

```bash
npm install
npm run dev              # Vite dev server + Electron, hot reload
npm run build:dir        # full build, unpacked app in release/ (no installer)
npm run build            # full build + NSIS installer + portable .exe
npm run smoke:visual-modes  # headless regression check (needs ffmpeg)
npm run smoke:downloads     # download/organise/lyrics backend (add --download
                            # for a real yt-dlp fetch; needs yt-dlp + ffmpeg)
npm run shot:ui "C:\path\to\music"   # boots the app on a throwaway profile,
                            # plays a track and asserts nothing overlaps the dock
npm run shot:themes .       # screenshots every theme and checks each one applies
```

## 12. Downloading, sorting and embedded lyrics

Lyrigen drives two external binaries it never bundles: **yt-dlp** (fetching)
and **ffmpeg / ffprobe** (tagging, converting, inspecting). `media-tools.ts`
finds them by looking, in order, at the folder set in Settings, a `bin/` folder
next to the app, then `C:\seng`, `C:\ffmpeg\bin`, `C:\tools`, scoop shims,
WinGet links, and finally `PATH`. Nothing is downloaded on your behalf and the
Downloads screen shows which binaries it resolved, with versions.

A download job runs one stage at a time, each pushed to the GUI as it happens:

```
inspect → download (yt-dlp) → tag (ffmpeg) → lyrics → file into place
```

**Naming.** `song-naming.ts` turns `Artist - Title (Sped Up) [dQw4w9WgXcQ]`
into structured fields: it strips the ~60 kinds of YouTube title noise
("Official Music Video", "HQ", "Lyrics", "prod. by …"), pulls out `feat.`
credits, detects speed/mood variants (Nightcore, Slowed + Reverb, Daycore, …)
and recognises the trailing 11-character video id. Which half of `A - B` is the
artist is decided partly by what is already in your library.

**Filing.** The organiser builds `{albumArtist}/{album}/{track} {title}` (or
whichever preset/template you choose) and never overwrites: a clashing name
gets a numeric suffix. Running it over existing folders always produces a
*plan* you review and edit first, and every applied batch is journalled so
**Undo** puts the files back. Lyric, cover and metadata sidecars move with the
song and are renamed to match.

**Lyrics.** `lyrics-sources.ts` queries four sources in parallel:

1. **Better Lyrics** (`lyrics-api.boidu.dev/getLyrics?s=&a=`) — the API the
   browser extension uses. One endpoint that *aggregates* its own TTML corpus
   plus Musixmatch, BiniLyrics and Kugou, returning a single Apple-style TTML
   document, frequently syllable-level. Cached songs answer without a key;
   uncached ones return 401, which is treated as a miss rather than an error
   so the next source answers. Keys are not currently issued (a cache miss
   costs them a paid upstream lookup), and `betterLyricsApiKey` exists only
   for anyone who has one. Playing a song in the Better Lyrics extension
   primes their cache and makes it publicly readable. Rate limit 60/min.
2. **Unison** (`unison.boidu.dev`) — crowdsourced, keyed by YouTube video id,
   so a yt-dlp download is an *exact* match rather than a fuzzy title search.
3. **AMLL TTML DB** — community mirror of word-synced Apple Music TTML. Note
   its search returns *alias arrays* (`musicNames`, `artistNames`), not single
   names, and reports no duration.
4. **LRCLIB** — line-synced LRC and plain text. A fallback, never the default.

**Choosing.** Two different orderings, deliberately:

- The Lyrics Finder *list* sorts by `rankCandidate` — match quality, then
  sync richness, then community confidence — because a human is scanning it.
- The *automatic* pick (`findBestLyrics`) sorts by `SYNC_TIER` first: syllable
  → word → line → plain, then match, then source. It fetches down the list
  only while something unfetched could still beat what it holds, and it
  re-derives granularity from the fetched document (`ttmlGranularity`) instead
  of trusting the search result's claim. That stops an entry advertised as
  word-synced but actually line-synced from winning.

For a speed edit, timestamps are *stretched* to the file's real duration
(`retimeLyrics`), which is why a Nightcore rip still lines up.

**Where the words end up.** Both places, because neither alone is enough:

- A **sidecar** (`.ttml` / `.lrc`) next to the song. This keeps word-level
  timing, and it is what Lyrigen itself reads.
- **Inside the audio file**, so every other player sees them. MP3 goes through
  `node-id3` — `USLT` for the text and `SYLT` for line timing, editing the tag
  in place and leaving other frames alone. M4A, FLAC and Opus get a `lyrics`
  tag written by an ffmpeg stream copy: no re-encode, no quality loss. WAV and
  raw AAC have nowhere to put lyrics and are reported as unsupported rather
  than failing the job.

Tag frames cannot hold word-level timing — `SYLT` is one timestamp per entry
and a `lyrics` tag is plain text — so embedding flattens TTML into lines. The
sidecar stays authoritative for Lyrigen's word-by-word view.

**Inbox.** Point Settings at a folder (say your browser's download folder) and
anything audio that lands there is tagged, given lyrics and filed
automatically, once it has stopped growing.


## 13. Appearance: themes, icons and lyric interaction

**Themes** (`src/lib/themes.ts` + `src/styles/themes.css`) are purely
presentational. A choice writes `data-theme`, `data-font` and
`data-lyric-motion` onto `<html>`, and CSS redefines custom properties from
there — no component reads the theme, so a theme can never break playback, and
an unrecognised id just leaves the defaults. `main.tsx` applies the saved
choice before first paint so the window never flashes the wrong palette.

Six palettes ship (Nocturne Bloom, Spotlight, Lucid, Ember, Paper, Monochrome),
five typefaces, and four lyric motions (Glow, Scale, Focus, Still — "Still"
removes per-line transitions entirely, which is the cheapest on a weak GPU).
The picker lives in Sound Lab.

One wrinkle worth knowing: `index.html` sets `font-family`, `color` and
`background` directly on `body`, and a declaration on the element beats one
inherited from `html`. Theme rules therefore use `html body` to out-specify it.
The light theme (Paper) additionally has to override the places App.css
hard-codes dark values — the title bar, sidebar gradient and hero cards are
driven by `--chrome`, `--sidebar` and `--hero` so a light theme can swap them
in one place.

**Icons** are Google Material Symbols (Rounded), Apache 2.0. The path data is
generated into `src/components/common/material-icons.ts` and bundled rather
than loaded from fonts.googleapis.com, so the app renders identically offline.
`Icon` keeps its original `name` API — call sites did not change — and
`MaterialIcon` exposes the full set for new code. These are filled shapes on a
960-unit grid, so they take `fill` and have no stroke width.

**Clicking a word seeks to that word.** AMLL's `onLyricLineClick` only reports
a line index, so `SyncedLyrics` hit-tests the word element under the pointer
and maps its position to that line's word list, falling back to the line start
if the DOM is not what it expects. AMLL's class names are content-hashed, hence
the `[class*="wordBody"]` substring selectors.

## 14. Listening history and recaps

Every load of a track records one play (`record-play`), not one per second, so
"hours listened" sums each play's track length rather than measured playtime.
That is an approximation, and an honest one — it over-counts a song you skip
thirty seconds into. History is capped at 20,000 entries, enough for a year's
recap at a couple of megabytes on disk.

`get-listening-recap` joins the history against the current library, so a
deleted file stops skewing the totals, and credits plays to the **lead** artist
(`primaryArtist`) — otherwise "Solya" and "Solya, Solya" rank separately.

The chart buckets by day up to a month, by week up to a year, and by month
beyond, never exceeding 52 bars. A year drawn as 365 bars is sub-pixel and
reads as an empty axis; the label follows the bucket ("Plays per week") so the
chart never implies a resolution it does not have.

Artist grouping in the library uses the same lead-name rule
(`primaryArtistName` in `src/lib/format.ts`). The word boundaries in that
regex are load-bearing: without them "and" matches inside Alexander.
