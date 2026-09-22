import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { buildRelativePath, parseSongName, primaryArtist, stripYoutubeIdSuffix, uniquePath, PATH_PRESETS, type SongVariant } from './song-naming'
import { downloadAudio, embedLyrics, inspectUrl, isChromiumBrowser, isCookieDecryptError, isCookieLockedError, isOfflineError, isRetryableYtDlpError, needsCookies, probe, setCookieSource, writeTags, type AudioFormat, type AudioQuality, type CookieSource, type DownloadProgress, type LyricEmbedOutcome, type VideoInfo } from './media-tools'
import { findBestLyrics, lyricExtension, lyricLines, lyricsToPlainText, retimeLyrics, type LyricFormat, type LyricLookupResult } from './lyrics-sources'

/**
 * The download queue and the file organiser.
 *
 * A download job walks through: inspect → download (yt-dlp) → tag (ffmpeg) →
 * lyrics (Unison first) → organise (move into `{artist}/{album}/…`). Each
 * stage updates the job record and pushes it to the renderer, so the GUI is
 * just a view over `jobs`. Jobs persist in `downloads.json` under userData so
 * history survives restarts; anything that was mid-flight when the app
 * closed is marked failed with a retry available.
 *
 * The organiser is the same "work out what this file is, then move it"
 * logic applied to files that already exist — the `night core` folder of
 * yt-dlp downloads with `[videoId]` names, for example. It always previews
 * (a plan) before it touches anything, and keeps an undo journal of moves.
 */

/**
 * `waiting` means "will run again by itself" — a retryable failure or no
 * network — and is deliberately distinct from `error`, which needs a person.
 */
export type JobStatus = 'queued' | 'inspecting' | 'downloading' | 'converting' | 'tagging' | 'lyrics' | 'organizing' | 'done' | 'error' | 'cancelled' | 'paused' | 'waiting'

export interface SongMetadata {
  artist: string | null
  title: string
  album: string | null
  albumArtist: string | null
  featuring: string | null
  variant: SongVariant | null
  year: string | null
  genre: string | null
  confidence: 'high' | 'medium' | 'low'
  /** Where the fields came from, for the review UI. */
  origin: 'music-metadata' | 'title-parse' | 'tags' | 'manual' | 'musicbrainz'
}

export interface DownloadJob {
  id: string
  url: string
  videoId: string | null
  status: JobStatus
  stage: string
  progress: number
  speed: string | null
  eta: string | null
  totalSize: string | null
  error: string | null
  createdAt: string
  finishedAt: string | null
  info: { title: string; uploader: string | null; thumbnail: string | null; duration: number | null; extractor: string } | null
  metadata: SongMetadata | null
  /** Where the file ended up (after organising) and its lyric sidecar. */
  outputPath: string | null
  lyricPath: string | null
  lyricSource: string | null
  lyricRetimed: boolean
  /** Whether the lyrics were also written into the audio file's own tags. */
  lyricEmbedded: boolean
  /** How many times this job has been attempted, for backoff. */
  attempts: number
  /** When an automatic retry is due, while `status` is `waiting`. */
  retryAt: string | null
  options: DownloadOptions
}

export interface DownloadOptions {
  format: AudioFormat
  quality: AudioQuality
  destination: string
  pathTemplate: string
  organize: boolean
  fetchLyrics: boolean
  retimeLyrics: boolean
  /** Also write the lyrics into the audio file's tags, not just the sidecar. */
  embedLyrics: boolean
  embedThumbnail: boolean
  writeCoverFile: boolean
  useMusicBrainz: boolean
  /** Skip anything already downloaded instead of fetching it twice. */
  skipDuplicates: boolean
  /** Retry retryable failures automatically instead of stopping at the first. */
  autoRetry: boolean
  /**
   * Ask YouTube Music for its 256 kbps streams.
   *
   * Needs all three of: a Premium subscription, a signed-in cookies.txt, and a
   * proof-of-origin token provider installed. Missing any of them, the download
   * quietly falls back to the ordinary 130 kbps stream rather than failing.
   */
  premiumAudio: boolean
}

export interface DownloadSettings extends DownloadOptions {
  toolsFolder: string | null
  concurrency: number
  /** Optional Better Lyrics API key. Without one only their cached songs answer. */
  betterLyricsApiKey: string | null
  /** Browser to take YouTube cookies from, for sign-in walled videos. */
  cookieSource: CookieSource
  /** Profile directory for a browser yt-dlp cannot find on its own (Opera GX, portable installs). */
  cookieProfile: string
  /** A cookies.txt file. Takes priority, and is the only method Chromium 127+ cannot break. */
  cookieFile: string
  /** Where the proof-of-origin token provider was unpacked, when it is not somewhere obvious. */
  potProviderFolder: string | null
  /** Folder that is watched for new audio files to auto-organise (e.g. a browser download folder). */
  inboxFolder: string | null
  inboxEnabled: boolean
}

/** A song that was not queued, and what Lyrigen already has in its place. */
export interface SkippedDownload {
  title: string
  artist: string | null
  url: string
  videoId: string | null
  existingPath: string
  reason: string
}

export interface EnqueueResult {
  created: DownloadJob[]
  skipped: SkippedDownload[]
}

export interface InspectResult {
  ok: boolean
  error?: string
  items: Array<{ url: string; videoId: string; info: VideoInfo; metadata: SongMetadata; proposedPath: string; alreadyDownloaded: string | null }>
  playlistTitle?: string | null
}

export interface OrganizePlanItem {
  id: string
  sourcePath: string
  fileName: string
  videoId: string | null
  duration: number | null
  currentTags: { title: string | null; artist: string | null; album: string | null; genre: string | null }
  metadata: SongMetadata
  proposedPath: string
  sidecars: string[]
  hasLyrics: boolean
  selected: boolean
  reason: string
}

export interface OrganizeApplyOptions {
  destination: string
  pathTemplate: string
  rewriteTags: boolean
  fetchLyrics: boolean
  retimeLyrics: boolean
  embedLyrics: boolean
}

export type OrganizeProgress = { id: string; status: 'moving' | 'tagging' | 'lyrics' | 'done' | 'error' | 'skipped'; message: string; outputPath?: string | null }

type Listener = (event: 'job' | 'jobs' | 'organize' | 'inbox', payload: unknown) => void

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.webm', '.mka'])
/** Statuses that mean "this song is already being dealt with". */
/** How many jobs the queue file keeps. Well above any single paste. */
const MAX_PERSISTED_JOBS = 20_000
/** Statuses a job never leaves on its own. */
const SETTLED: ReadonlySet<JobStatus> = new Set<JobStatus>(['done', 'error', 'cancelled'])
const IN_FLIGHT: ReadonlySet<JobStatus> = new Set<JobStatus>(['queued', 'inspecting', 'downloading', 'converting', 'tagging', 'lyrics', 'organizing', 'waiting', 'paused'])
const SIDECAR_EXTENSIONS = ['.lrc', '.ttml', '.yrc', '.txt', '.jpg', '.jpeg', '.png', '.webp', '.lyrigen-metadata.json']

function defaultDestination() {
  return path.join(app.getPath('music'), 'Lyrigen Downloads')
}

export function defaultSettings(): DownloadSettings {
  return {
    format: 'm4a',
    quality: 'best',
    destination: defaultDestination(),
    pathTemplate: PATH_PRESETS[0].template,
    organize: true,
    fetchLyrics: true,
    retimeLyrics: true,
    embedLyrics: true,
    embedThumbnail: true,
    writeCoverFile: false,
    useMusicBrainz: false,
    toolsFolder: null,
    concurrency: 2,
    betterLyricsApiKey: null,
    cookieSource: 'none',
    cookieProfile: '',
    cookieFile: '',
    skipDuplicates: true,
    autoRetry: true,
    premiumAudio: false,
    potProviderFolder: null,
    inboxFolder: null,
    inboxEnabled: false,
  }
}

interface StoreShape { settings: DownloadSettings; jobs: DownloadJob[]; organizeJournal: Array<{ at: string; moves: Array<{ from: string; to: string }> }> }

// ---------------------------------------------------------------------------
// "Do I already have this?" — the library index
// ---------------------------------------------------------------------------

/**
 * One song Lyrigen already has, from wherever it was found.
 *
 * `duration` and a tag-derived `artist` are only present for files the library
 * scan has read; a plain folder walk fills in what the path says and leaves the
 * rest null. Both are useful, so the index takes either.
 */
export interface LibraryEntry {
  audioPath: string
  title: string
  artist: string | null
  duration: number | null
}

/**
 * Fold a name down to the part that identifies it.
 *
 * Case, punctuation, accents and spacing all vary between a YouTube title and
 * a tag written years ago, and none of that changes which song it is. The
 * Unicode classes matter: this library has Japanese and Chinese titles in it,
 * and an `[^a-z0-9]` filter would erase them to the empty string and make every
 * one of them look like a duplicate of the others.
 */
function fold(value: string | null | undefined) {
  return (value ?? '')
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * Drop the "(2)" Lyrigen itself adds when a name is already taken.
 *
 * This is the loop that made the problem compound. A song downloaded twice
 * becomes `Song.m4a` and `Song (2).m4a`; the copy is then a different title to
 * the duplicate check, so the next pass downloads it a third time as
 * `Song (3).m4a`, and so on. Duplicate *cleanup* keeps whichever copy is
 * better, which is often the numbered one — so the file left on disk is
 * precisely the one the check could not see.
 *
 * Only a bare number in trailing parentheses goes. "(Live)", "(Sped Up)" and
 * "(2024)" all survive, the last because a year is four digits.
 */
function stripCopyNumber(title: string) {
  return title.replace(/\s*\(\d{1,3}\)\s*$/, '').trim() || title
}

/** Artist + song + which edit it is. Two files agreeing on all three are the same download. */
function songKey(artist: string | null | undefined, title: string, variant: SongVariant | null) {
  return `${fold(primaryArtist(artist ?? null))}|${fold(stripCopyNumber(title))}|${variant ?? ''}`
}

/** Song + edit, for when the artist cannot be trusted on one side or the other. */
function titleKey(title: string, variant: SongVariant | null) {
  return `${fold(stripCopyNumber(title))}|${variant ?? ''}`
}

/**
 * The keys that say which song a file is, strongest first.
 *
 * Shared with the duplicate cleanup so "already have it" and "this is a
 * duplicate" can never disagree — one of them saying yes while the other says
 * no is how you end up with a library full of pairs.
 */
export function songIdentity(audioPath: string, title: string, artist: string | null) {
  const { name, videoId } = stripYoutubeIdSuffix(path.parse(audioPath).name)
  const parsed = parseSongName(title || name)
  const cleanTitle = parsed.title || title || name
  return {
    videoId,
    song: songKey(artist || parsed.artist || path.basename(path.dirname(audioPath)), cleanTitle, parsed.variant),
    title: titleKey(cleanTitle, parsed.variant),
    cleanTitle,
  }
}

interface LibraryIndex {
  byVideoId: Map<string, string>
  bySong: Map<string, string>
  byTitle: Map<string, Array<{ path: string; duration: number | null }>>
  count: number
}

const EMPTY_INDEX: LibraryIndex = { byVideoId: new Map(), bySong: new Map(), byTitle: new Map(), count: 0 }

export class Downloader {
  private readonly file: string
  private state: StoreShape
  private listeners = new Set<Listener>()
  private children = new Map<string, ChildProcess>()
  private running = new Set<string>()
  private knownArtists: () => Iterable<string> = () => []
  private libraryFolders: () => string[] = () => []
  private libraryEntries: () => Iterable<LibraryEntry> = () => []
  private libraryIndex: Promise<LibraryIndex> | null = null
  private inboxWatcher: fs.FSWatcher | null = null
  private inboxTimers = new Map<string, NodeJS.Timeout>()
  private paused = false
  private retryTimer: NodeJS.Timeout | null = null
  private persistTimer: NodeJS.Timeout | null = null
  private persistPending = false
  /**
   * Where the last scan for runnable work got to.
   *
   * With thousands of jobs, starting from the top every time a download
   * finishes makes the queue quadratic. The cursor only ever advances past jobs
   * that are settled for good; anything that returns to `queued` rewinds it.
   */
  private queueCursor = 0
  private musicBrainz: ((request: { title: string; artist?: string; album?: string; duration?: number | null }) => Promise<{ found: boolean; metadata?: Partial<{ title: string; artist: string; album: string; albumArtist: string; year: string; genre: string }>; confidence?: 'high' | 'medium' | 'low' | null }>) | null = null

  constructor(userDataPath: string) {
    this.file = path.join(userDataPath, 'downloads.json')
    this.state = this.load()
    // Anything that was mid-flight when Lyrigen last closed cannot be resumed; mark it so the person can retry.
    for (const job of this.state.jobs) {
      if (['done', 'error', 'cancelled', 'queued'].includes(job.status)) continue
      // Anything mid-flight when the app closed simply goes back in the queue.
      job.status = 'queued'; job.stage = 'Waiting'; job.retryAt = null; job.attempts = 0
    }
    setCookieSource(this.state.settings.cookieSource, this.state.settings.cookieProfile, this.state.settings.cookieFile)
    this.persist()
  }

  /** Library artists help the title parser decide which half of "A - B" is the artist. */
  setKnownArtistsProvider(provider: () => Iterable<string>) { this.knownArtists = provider }
  /** Optional MusicBrainz verifier, injected from main.ts so this module stays free of catalog code. */
  setMusicBrainzLookup(lookup: NonNullable<Downloader['musicBrainz']>) { this.musicBrainz = lookup }
  /** Folders that already hold music: the library roots plus the download destination. */
  setLibraryFoldersProvider(provider: () => string[]) { this.libraryFolders = provider; this.libraryIndex = null }
  /** Songs the library scan has already read tags for. Optional — the folder walk covers the rest. */
  setLibraryEntriesProvider(provider: () => Iterable<LibraryEntry>) { this.libraryEntries = provider; this.libraryIndex = null }
  /** Call when files move, arrive or are deleted, so the next check rebuilds. */
  invalidateLibraryIndex() { this.libraryIndex = null }

  /**
   * Index everything already on disk, so a playlist can be checked against it.
   *
   * Built once per queueing run and then reused: a 5,000-track playlist means
   * 5,000 lookups, and walking the folders for each one would take longer than
   * the downloads. The walk is name-only — no ffprobe — so ten thousand files
   * cost about a second.
   *
   * Three keys come out of it, strongest first: the YouTube id (yt-dlp leaves
   * it in the file name), artist + song + edit, and song + edit on its own for
   * the cases where one side's artist is really the uploader's channel name.
   */
  private async buildLibraryIndex(extraFolders: string[]): Promise<LibraryIndex> {
    const byVideoId = new Map<string, string>()
    const bySong = new Map<string, string>()
    const byTitle = new Map<string, Array<{ path: string; duration: number | null }>>()
    let count = 0

    const remember = (entry: LibraryEntry) => {
      count += 1
      const parsedName = stripYoutubeIdSuffix(path.parse(entry.audioPath).name)
      if (parsedName.videoId && !byVideoId.has(parsedName.videoId)) byVideoId.set(parsedName.videoId, entry.audioPath)
      // The folder above a song is almost always its artist, and the tag may
      // disagree with the file name, so every spelling gets indexed rather than
      // betting on one of them being the tidy one.
      const folderArtist = path.basename(path.dirname(entry.audioPath))
      const grandparent = path.basename(path.dirname(path.dirname(entry.audioPath)))
      for (const raw of new Set([entry.title, parsedName.name].filter(Boolean))) {
        const parsed = parseSongName(raw)
        const title = parsed.title || raw
        const variant = parsed.variant
        for (const artist of new Set([entry.artist, parsed.artist, folderArtist, grandparent].filter(Boolean))) {
          const key = songKey(artist, title, variant)
          if (!bySong.has(key)) bySong.set(key, entry.audioPath)
        }
        const loose = titleKey(title, variant)
        const bucket = byTitle.get(loose)
        if (bucket) { if (bucket.length < 8) bucket.push({ path: entry.audioPath, duration: entry.duration }) }
        else byTitle.set(loose, [{ path: entry.audioPath, duration: entry.duration }])
      }
    }

    const seen = new Set<string>()
    for (const entry of this.libraryEntries()) {
      const key = entry.audioPath.toLocaleLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      remember(entry)
    }
    const folders = Array.from(new Set([...this.libraryFolders(), ...extraFolders].filter(Boolean)))
    for (const folder of folders) {
      for (const filePath of await collectAudio(folder)) {
        const key = filePath.toLocaleLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        remember({ audioPath: filePath, title: path.parse(filePath).name, artist: null, duration: null })
      }
    }
    return { byVideoId, bySong, byTitle, count }
  }

  private libraryIndexFor(extraFolders: string[]) {
    if (!this.libraryIndex) this.libraryIndex = this.buildLibraryIndex(extraFolders).catch(error => {
      console.warn('Could not index the library for duplicate checks', error)
      this.libraryIndex = null
      return EMPTY_INDEX
    })
    return this.libraryIndex
  }

  /** How many songs the duplicate check is currently aware of, for the UI. */
  async libraryIndexSize(extraFolders: string[] = []) { return (await this.libraryIndexFor(extraFolders)).count }

  subscribe(listener: Listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(event: Parameters<Listener>[0], payload: unknown) { for (const listener of this.listeners) listener(event, payload) }

  private load(): StoreShape {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoreShape>
      return { settings: { ...defaultSettings(), ...(parsed.settings ?? {}) }, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [], organizeJournal: Array.isArray(parsed.organizeJournal) ? parsed.organizeJournal : [] }
    } catch { return { settings: defaultSettings(), jobs: [], organizeJournal: [] } }
  }

  /**
   * Write the queue to disk, at most once every couple of seconds.
   *
   * Every finished job used to rewrite the whole file. That costs nothing for
   * twenty songs and is brutal for five thousand: the file is megabytes, two
   * dozen downloads finish at once, and the main process ends up re-serialising
   * a list nobody is reading. Coalescing keeps the guarantee that matters — the
   * queue survives a restart — at a fraction of the cost. Pass `immediate` at
   * the moments worth paying for it: queueing, settings, shutdown.
   */
  private persist(immediate = false) {
    if (immediate) {
      if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null }
      this.persistPending = false
      this.writeState()
      return
    }
    this.persistPending = true
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      if (!this.persistPending) return
      this.persistPending = false
      this.writeState()
    }, 2000)
  }

  private writeState() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // The old cap was 300, which quietly threw away all but the tail of a
      // large playlist the moment anything was saved — so a restart halfway
      // through lost the queue. This one sits above anything anyone would
      // paste, and the file is no longer pretty-printed to pay for it.
      const snapshot = { ...this.state, jobs: this.state.jobs.slice(-MAX_PERSISTED_JOBS) }
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(snapshot), 'utf8')
      fs.renameSync(`${this.file}.tmp`, this.file)
    } catch (error) { console.warn('Could not persist downloads state', error) }
  }

  get settings() { return { ...this.state.settings } }
  updateSettings(patch: Partial<DownloadSettings>) {
    this.state.settings = { ...this.state.settings, ...patch }
    if ('cookieSource' in patch || 'cookieProfile' in patch || 'cookieFile' in patch) setCookieSource(this.state.settings.cookieSource, this.state.settings.cookieProfile, this.state.settings.cookieFile)
    if (!this.state.settings.destination) this.state.settings.destination = defaultDestination()
    this.persist()
    this.syncInboxWatcher()
    return this.settings
  }

  get jobs() { return this.state.jobs.map(job => ({ ...job })) }

  // ---------------------------------------------------------------------
  // Metadata resolution shared by downloads and the organiser
  // ---------------------------------------------------------------------

  /** Build song metadata from what yt-dlp knows about a video. */
  metadataFromInfo(info: VideoInfo): SongMetadata {
    const parsed = parseSongName(info.title, info.uploader || info.channel, this.knownArtists())
    // Genuine music metadata (YouTube Music / Topic channels) beats anything parsed out of the title.
    if (info.track && info.artist) {
      return {
        artist: info.artist, title: info.track, album: info.album || null, albumArtist: primaryArtist(info.artist), featuring: null,
        variant: parsed.variant, year: info.releaseYear ? String(info.releaseYear) : null, genre: null, confidence: 'high', origin: 'music-metadata',
      }
    }
    return {
      artist: parsed.artist, title: parsed.title, album: null, albumArtist: primaryArtist(parsed.artist), featuring: parsed.featuring,
      variant: parsed.variant, year: info.releaseYear ? String(info.releaseYear) : (info.uploadDate ? info.uploadDate.slice(0, 4) : null), genre: null,
      confidence: parsed.artistFromUploader ? 'low' : parsed.confidence, origin: 'title-parse',
    }
  }

  /** Build song metadata for an existing file from its tags and its name. */
  async metadataFromFile(filePath: string): Promise<{ metadata: SongMetadata; videoId: string | null; duration: number | null; tags: OrganizePlanItem['currentTags']; reason: string }> {
    const probed = await probe(filePath)
    const tags = probed?.tags ?? {}
    const { name, videoId } = stripYoutubeIdSuffix(path.parse(filePath).name)
    const current = { title: tags.title || null, artist: tags.artist || tags.album_artist || null, album: tags.album || null, genre: tags.genre || null }
    const urlId = (tags.comment || tags.purl || '').match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1] ?? null
    const resolvedVideoId = videoId || urlId
    // yt-dlp leaves fingerprints: title == video title, artist == uploader, genre == a YouTube category, comment == the watch URL.
    const looksLikeYtDlp = Boolean(resolvedVideoId) || /youtube\.com|youtu\.be/.test(tags.comment || tags.purl || '') || /^(?:People & Blogs|Music|Entertainment|Film & Animation|Gaming|Comedy|Education|Howto & Style)$/i.test(tags.genre || '')
    if (current.title && current.artist && !looksLikeYtDlp) {
      const variant = parseSongName(current.title).variant
      return {
        metadata: { artist: current.artist, title: current.title, album: current.album, albumArtist: tags.album_artist || primaryArtist(current.artist), featuring: null, variant, year: (tags.date || tags.year || '').slice(0, 4) || null, genre: current.genre, confidence: 'high', origin: 'tags' },
        videoId: resolvedVideoId, duration: probed?.duration ?? null, tags: current, reason: 'Clean tags',
      }
    }
    const parsed = parseSongName(current.title || name, looksLikeYtDlp ? current.artist : null, this.knownArtists())
    return {
      metadata: { artist: parsed.artist, title: parsed.title, album: null, albumArtist: primaryArtist(parsed.artist), featuring: parsed.featuring, variant: parsed.variant, year: (tags.date || '').slice(0, 4) || null, genre: /^(?:People & Blogs|Entertainment|Film & Animation|Gaming|Comedy|Education|Howto & Style)$/i.test(tags.genre || '') ? null : current.genre, confidence: parsed.artistFromUploader ? 'low' : parsed.confidence, origin: 'title-parse' },
      videoId: resolvedVideoId, duration: probed?.duration ?? null, tags: current, reason: looksLikeYtDlp ? 'yt-dlp download · parsed from title' : 'Parsed from file name',
    }
  }

  private async verifyWithMusicBrainz(metadata: SongMetadata, duration: number | null): Promise<SongMetadata> {
    if (!this.musicBrainz || !metadata.title) return metadata
    try {
      // Variants (sped up, nightcore) have a different length from the original recording, so only pass duration for untouched songs.
      const result = await this.musicBrainz({ title: metadata.title, artist: metadata.artist || undefined, duration: metadata.variant ? null : duration })
      if (result.found && result.metadata && (result.confidence === 'high' || (result.confidence === 'medium' && metadata.confidence !== 'high'))) {
        return {
          ...metadata,
          artist: result.metadata.artist || metadata.artist,
          title: result.metadata.title || metadata.title,
          album: result.metadata.album || metadata.album,
          albumArtist: result.metadata.albumArtist || primaryArtist(result.metadata.artist || metadata.artist),
          year: result.metadata.year || metadata.year,
          genre: result.metadata.genre || metadata.genre,
          confidence: 'high',
          origin: 'musicbrainz',
        }
      }
    } catch (error) { console.warn('MusicBrainz verification skipped', error) }
    return metadata
  }

  displayTitle(metadata: SongMetadata) {
    return metadata.featuring ? `${metadata.title} (feat. ${metadata.featuring})` : metadata.title
  }

  proposePath(metadata: SongMetadata, ext: string, destination: string, template: string, videoId?: string | null) {
    const relative = buildRelativePath(template, {
      artist: metadata.artist, albumArtist: metadata.albumArtist, album: metadata.album, title: this.displayTitle(metadata), year: metadata.year,
      variant: metadata.variant, genre: metadata.genre, videoId: videoId ?? null, ext,
    })
    return path.join(destination, relative)
  }

  // ---------------------------------------------------------------------
  // Inspect + queue
  // ---------------------------------------------------------------------

  async inspect(rawUrl: string, options: Partial<DownloadOptions> = {}): Promise<InspectResult> {
    const settings = { ...this.state.settings, ...options }
    const url = rawUrl.trim()
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Paste a full link starting with https://', items: [] }
    try {
      const info = await inspectUrl(url, { allowPlaylist: /[?&]list=|\/playlist|\/sets\//i.test(url) })
      const items: InspectResult['items'] = []
      if (info.isPlaylist) {
        // No cap: a 2,000-track playlist is a legitimate thing to paste. A
        // playlist can also list the same video twice, so collapse by id.
        const seen = new Set<string>()
        for (const entry of info.entries ?? []) {
          if (seen.has(entry.id)) continue
          seen.add(entry.id)
          const entryInfo: VideoInfo = { ...info, id: entry.id, title: entry.title, webpageUrl: entry.url, uploader: entry.uploader, channel: entry.uploader, duration: entry.duration, isPlaylist: false, entries: undefined, artist: null, track: null, album: null, thumbnail: `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg` }
          const metadata = this.metadataFromInfo(entryInfo)
          items.push({ url: entry.url, videoId: entry.id, info: entryInfo, metadata, proposedPath: this.proposePath(metadata, settings.format === 'best' ? 'm4a' : settings.format, settings.destination, settings.pathTemplate, entry.id), alreadyDownloaded: (await this.existingFileFor(metadata, entry.id, settings, entry.duration))?.path ?? null })
        }
        return { ok: true, items, playlistTitle: info.playlistTitle }
      }
      let metadata = this.metadataFromInfo(info)
      if (settings.useMusicBrainz) metadata = await this.verifyWithMusicBrainz(metadata, info.duration)
      return { ok: true, items: [{ url: info.webpageUrl, videoId: info.id, info, metadata, proposedPath: this.proposePath(metadata, settings.format === 'best' ? 'm4a' : settings.format, settings.destination, settings.pathTemplate, info.id), alreadyDownloaded: (await this.existingFileFor(metadata, info.id, settings, info.duration))?.path ?? null }] }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not read that link.', items: [] }
    }
  }

  private findExisting(videoId: string) {
    const done = this.state.jobs.find(job => job.videoId === videoId && job.status === 'done' && job.outputPath && fs.existsSync(job.outputPath))
    return done?.outputPath ?? null
  }

  /**
   * Is this song already on disk?
   *
   * The job history alone is not enough: clearing finished downloads, or
   * downloading before this check existed, loses the record while the file is
   * still sitting there. So also look where the file *would* go — under any
   * audio extension, since the chosen format may have changed since — and for
   * a sibling carrying the same video id.
   */
  private async existingFileFor(metadata: SongMetadata, videoId: string | null, options: DownloadOptions, duration: number | null = null): Promise<{ path: string; reason: string } | null> {
    // 1. This exact video, finished earlier in this install.
    if (videoId) {
      const known = this.findExisting(videoId)
      if (known) return { path: known, reason: 'downloaded before' }
    }
    // 2. Where this song would land, in case the history was cleared.
    const proposed = this.proposePath(metadata, options.format === 'best' ? '.m4a' : `.${options.format}`, options.destination, options.pathTemplate, videoId)
    if (fs.existsSync(proposed)) return { path: proposed, reason: 'already in the destination folder' }

    const index = await this.libraryIndexFor([options.destination])
    // 3. The same video id, wherever it was filed — yt-dlp leaves it in the name.
    if (videoId) {
      const byId = index.byVideoId.get(videoId)
      if (byId) return { path: byId, reason: 'same YouTube video' }
    }
    // 4. Same artist, same song, same edit.
    const bySong = index.bySong.get(songKey(metadata.artist, metadata.title, metadata.variant))
    if (bySong) return { path: bySong, reason: 'same artist and song' }
    // 5. Same song name, when the "artist" on this side is really an uploader.
    //    Length settles it when both sides know it; otherwise this only fires
    //    for a guessed artist, so a confident artist mismatch is never skipped.
    const loose = index.byTitle.get(titleKey(metadata.title, metadata.variant))
    if (loose?.length) {
      const sameLength = duration != null ? loose.find(item => item.duration != null && Math.abs(item.duration - duration) <= 5) : undefined
      if (sameLength) return { path: sameLength.path, reason: 'same song and length' }
      if (!metadata.artist || metadata.confidence === 'low') return { path: loose[0].path, reason: 'same song name' }
    }
    return null
  }

  /**
   * Add songs to the queue, leaving out anything already on disk.
   *
   * Scanning the whole job list once per item is fine for a handful and
   * quadratic for a playlist, so the ids already in flight live in a set that
   * this run adds to as it goes — which also means a playlist listing the same
   * song twice queues it once.
   */
  async enqueue(items: Array<{ url: string; videoId?: string | null; metadata?: SongMetadata | null; info?: DownloadJob['info'] }>, options: Partial<DownloadOptions> = {}): Promise<EnqueueResult> {
    const jobOptions: DownloadOptions = { ...this.state.settings, ...options }
    const created: DownloadJob[] = []
    const skipped: SkippedDownload[] = []
    const inFlight = new Set<string>()
    for (const job of this.state.jobs) if (job.videoId && IN_FLIGHT.has(job.status)) inFlight.add(job.videoId)
    for (const item of items) {
      const url = item.url.trim()
      if (!url) continue
      const videoId = item.videoId ?? url.match(/(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/)?.[1] ?? null
      // Already queued or running: never the same video twice at once.
      if (videoId && inFlight.has(videoId)) continue
      // Already on disk, here or anywhere else in the library: skip unless asked not to.
      if (jobOptions.skipDuplicates !== false && item.metadata) {
        const existing = await this.existingFileFor(item.metadata, videoId, jobOptions, item.info?.duration ?? null)
        if (existing) {
          skipped.push({ title: item.metadata.title, artist: item.metadata.artist, url, videoId, existingPath: existing.path, reason: existing.reason })
          continue
        }
      }
      if (videoId) inFlight.add(videoId)
      const job: DownloadJob = {
        id: crypto.randomUUID(), url, videoId, status: 'queued', stage: 'Waiting', progress: 0, speed: null, eta: null, totalSize: null, error: null,
        createdAt: new Date().toISOString(), finishedAt: null, info: item.info ?? null, metadata: item.metadata ?? null,
        outputPath: null, lyricPath: null, lyricSource: null, lyricRetimed: false, lyricEmbedded: false, attempts: 0, retryAt: null, options: jobOptions,
      }
      this.state.jobs.push(job)
      created.push(job)
    }
    this.persist(true)
    this.emit('jobs', this.jobs)
    void this.pump()
    return { created: created.map(job => ({ ...job })), skipped }
  }

  cancel(id: string) {
    const job = this.state.jobs.find(item => item.id === id)
    if (!job) return
    const child = this.children.get(id)
    if (child) { try { child.kill() } catch { /* already gone */ } }
    if (job.status !== 'done') { job.status = 'cancelled'; job.stage = 'Cancelled'; job.error = null; job.finishedAt = new Date().toISOString() }
    this.persist(); this.emit('job', { ...job })
  }

  retry(id: string) {
    const job = this.state.jobs.find(item => item.id === id)
    if (!job || this.running.has(id)) return
    Object.assign(job, { status: 'queued', stage: 'Waiting', progress: 0, speed: null, eta: null, error: null, finishedAt: null })
    this.queueCursor = 0
    this.persist(); this.emit('job', { ...job }); void this.pump()
  }

  remove(id: string) {
    this.cancel(id)
    this.state.jobs = this.state.jobs.filter(job => job.id !== id)
    this.persist(); this.emit('jobs', this.jobs)
  }

  clearFinished() {
    this.state.jobs = this.state.jobs.filter(job => !['done', 'error', 'cancelled'].includes(job.status))
    this.persist(); this.emit('jobs', this.jobs)
  }

  updateJobMetadata(id: string, metadata: SongMetadata) {
    const job = this.state.jobs.find(item => item.id === id)
    if (!job || job.status !== 'queued') return null
    job.metadata = { ...metadata, origin: 'manual' }
    this.persist(); this.emit('job', { ...job })
    return { ...job }
  }

  /** Paused holds the whole queue; anything running stops and goes back in line. */
  setPaused(paused: boolean) {
    this.paused = paused
    if (paused) {
      for (const [id, child] of this.children) { try { child.kill() } catch { /* already gone */ } this.children.delete(id) }
      for (const job of this.state.jobs) {
        if (['queued', 'downloading', 'converting', 'inspecting'].includes(job.status)) {
          this.update(job, { status: 'paused', stage: 'Paused', speed: null, eta: null })
        }
      }
    } else {
      for (const job of this.state.jobs) if (job.status === 'paused') this.update(job, { status: 'queued', stage: 'Waiting' })
      this.queueCursor = 0
      void this.pump()
    }
    this.persist()
    this.emit('jobs', this.jobs)
    return this.paused
  }

  get isPaused() { return this.paused }

  /**
   * Put a job back in line after a failure we expect to pass: 15s, 60s, then
   * 180s. Being offline does not burn an attempt, because the network coming
   * back is not the job's fault.
   */
  private holdForRetry(job: DownloadJob, message: string, offline: boolean) {
    const delays = [15_000, 60_000, 180_000]
    if (!offline) job.attempts += 1
    const wait = offline ? 30_000 : delays[Math.min(Math.max(job.attempts - 1, 0), delays.length - 1)]
    this.update(job, {
      status: 'waiting',
      stage: offline ? 'Waiting for the network...' : `Retrying in ${Math.round(wait / 1000)}s`,
      error: message, speed: null, eta: null,
      retryAt: new Date(Date.now() + wait).toISOString(),
    })
    this.startRetrySweeper()
  }

  /** One timer for the whole queue: promotes any `waiting` job whose time is up. */
  private startRetrySweeper() {
    if (this.retryTimer) return
    this.retryTimer = setInterval(() => {
      const now = Date.now()
      let promoted = false
      for (const job of this.state.jobs) {
        if (job.status !== 'waiting' || !job.retryAt) continue
        if (new Date(job.retryAt).getTime() > now) continue
        this.update(job, { status: 'queued', stage: 'Waiting', retryAt: null })
        this.queueCursor = 0
        promoted = true
      }
      if (!this.state.jobs.some(job => job.status === 'waiting') && this.retryTimer) {
        clearInterval(this.retryTimer)
        this.retryTimer = null
      }
      if (promoted) { this.persist(); void this.pump() }
    }, 5000)
  }

  private async pump() {
    if (this.paused) return
    // Each slot is a whole yt-dlp process plus, later, an ffmpeg pass, so the
    // ceiling is about processes rather than bandwidth. 24 is high enough that
    // a fast connection is the limit rather than this number.
    const limit = Math.max(1, Math.min(24, this.state.settings.concurrency || 2))
    while (this.running.size < limit) {
      while (this.queueCursor < this.state.jobs.length && SETTLED.has(this.state.jobs[this.queueCursor].status)) this.queueCursor += 1
      let next: DownloadJob | undefined
      for (let index = this.queueCursor; index < this.state.jobs.length; index += 1) {
        const candidate = this.state.jobs[index]
        if (candidate.status === 'queued' && !this.running.has(candidate.id)) { next = candidate; break }
      }
      if (!next) break
      this.running.add(next.id)
      void this.process(next.id).finally(() => { this.running.delete(next.id); this.children.delete(next.id); void this.pump() })
    }
  }

  private update(job: DownloadJob, patch: Partial<DownloadJob>) {
    Object.assign(job, patch)
    this.emit('job', { ...job })
  }

  private async process(id: string) {
    const job = this.state.jobs.find(item => item.id === id)
    if (!job) return
    const isCancelled = () => job.status === 'cancelled' || job.status === 'paused'
    job.attempts = Math.max(1, job.attempts)
    const tempDir = path.join(app.getPath('userData'), 'download-temp', job.id)
    try {
      await fs.promises.mkdir(tempDir, { recursive: true })
      // 1. Inspect (skipped when the GUI already inspected and handed us metadata).
      if (!job.info || !job.metadata) {
        this.update(job, { status: 'inspecting', stage: 'Reading link…' })
        const info = await inspectUrl(job.url)
        if (info.isPlaylist) throw new Error('This is a playlist. Inspect it first to pick the songs.')
        let metadata = this.metadataFromInfo(info)
        if (job.options.useMusicBrainz) metadata = await this.verifyWithMusicBrainz(metadata, info.duration)
        this.update(job, { videoId: info.id, info: { title: info.title, uploader: info.uploader, thumbnail: info.thumbnail, duration: info.duration, extractor: info.extractor }, metadata })
      }
      if (isCancelled()) return
      // 2. Download.
      this.update(job, { status: 'downloading', stage: 'Downloading…', progress: 0 })
      const outcome = await downloadAudio(job.url, tempDir, {
        format: job.options.format, quality: job.options.quality, embedThumbnail: job.options.embedThumbnail, premiumAudio: job.options.premiumAudio,
        onSpawn: child => this.children.set(job.id, child),
        onProgress: (progress: DownloadProgress) => {
          if (isCancelled()) return
          const stage = progress.stage === 'downloading' ? 'Downloading…' : progress.stage === 'converting' ? `Converting to ${job.options.format === 'best' ? 'audio' : job.options.format.toUpperCase()}…` : 'Embedding artwork…'
          this.update(job, { status: progress.stage === 'downloading' ? 'downloading' : 'converting', stage, progress: progress.percent, speed: progress.speed, eta: progress.eta, totalSize: progress.totalSize })
        },
      })
      if (isCancelled()) { await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined); return }
      const metadata = job.metadata!
      const probed = await probe(outcome.filePath)
      const fileDuration = probed?.duration ?? job.info?.duration ?? null
      // 3. Tags.
      this.update(job, { status: 'tagging', stage: 'Writing tags…', progress: 100, speed: null, eta: null })
      await writeTags(outcome.filePath, {
        title: this.displayTitle(metadata), artist: metadata.artist || job.info?.uploader || null, album: metadata.album || (metadata.variant ? metadata.variant : null), albumArtist: metadata.albumArtist || primaryArtist(metadata.artist),
        genre: metadata.genre, date: metadata.year, sourceUrl: job.url,
      }).catch(error => console.warn('Tag write failed; keeping yt-dlp tags', error))
      // 4. Destination.
      const ext = path.extname(outcome.filePath)
      const destination = job.options.organize
        ? this.proposePath(metadata, ext, job.options.destination, job.options.pathTemplate, job.videoId)
        : path.join(job.options.destination, `${sanitizeFileName(`${metadata.artist ? `${metadata.artist} - ` : ''}${this.displayTitle(metadata)}${metadata.variant ? ` (${metadata.variant})` : ''}`)}${ext}`)
      const finalPath = uniquePath(destination, candidate => fs.existsSync(candidate))
      await fs.promises.mkdir(path.dirname(finalPath), { recursive: true })
      // 5. Lyrics — before moving so a failure here never leaves a half-organised song.
      let lyricPath: string | null = null, lyricSource: string | null = null, lyricRetimed = false, lyricEmbedded = false
      if (job.options.fetchLyrics) {
        this.update(job, { status: 'lyrics', stage: 'Finding lyrics on Unison…' })
        const lyrics = await findBestLyrics({ trackName: metadata.title, artistName: metadata.artist, albumName: metadata.album, duration: metadata.variant ? null : fileDuration, videoId: job.videoId })
        // The sidecar belongs beside the song's final home; the tags go into the
        // file while it is still in the temp folder, before the move below.
        const saved = await this.saveLyricsBeside(finalPath, lyrics, { fileDuration, allowRetime: job.options.retimeLyrics && Boolean(metadata.variant), embed: job.options.embedLyrics, embedInto: outcome.filePath })
        lyricPath = saved.path; lyricSource = saved.source; lyricRetimed = saved.retimed
        lyricEmbedded = saved.embedded === 'id3' || saved.embedded === 'tag'
      }
      // 6. Move into place.
      this.update(job, { status: 'organizing', stage: 'Filing into your library…' })
      await moveFile(outcome.filePath, finalPath)
      if (outcome.thumbnailPath) {
        if (job.options.writeCoverFile) {
          const coverTarget = path.join(path.dirname(finalPath), 'cover.jpg')
          if (!fs.existsSync(coverTarget)) await moveFile(outcome.thumbnailPath, coverTarget).catch(() => undefined)
        }
        await fs.promises.rm(outcome.thumbnailPath, { force: true }).catch(() => undefined)
      }
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      this.update(job, { status: 'done', stage: lyricPath ? `Done · lyrics from ${lyricSource}${lyricEmbedded ? ', embedded' : ''}` : 'Done · no lyrics found', progress: 100, outputPath: finalPath, lyricPath, lyricSource, lyricRetimed, lyricEmbedded, finishedAt: new Date().toISOString(), speed: null, eta: null })
    } catch (error) {
      if (isCancelled()) { await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined); return }
      const message = error instanceof Error ? error.message : String(error)
      const offline = isOfflineError(message)
      // A sign-in wall fails the same way forever, so say what to do about it
      // rather than retrying into the same error three more times.
      if (isCookieLockedError(message)) {
        // Closing the browser clears the lock, but a Chromium one then fails to
        // decrypt, so saying "close it and retry" on its own wastes a trip.
        const chromium = isChromiumBrowser(this.state.settings.cookieSource)
        this.update(job, {
          status: 'error',
          stage: 'Browser is holding its cookies',
          error: chromium
            ? 'That browser has its cookie database open, so yt-dlp cannot read it. Closing it clears that, but Chromium browsers (Chrome, Edge, Brave, Opera GX) then refuse to decrypt the cookies anyway — export a cookies.txt instead and set it in Downloads settings.'
            : 'That browser has its cookie database open. Close it completely, including anything left in the system tray, and try again.',
          finishedAt: new Date().toISOString(), speed: null, eta: null,
        })
      } else if (isCookieDecryptError(message)) {
        this.update(job, { status: 'error', stage: 'Cookies could not be read', error: 'Windows would not decrypt that browser’s cookies. Chromium 127+ (Chrome, Edge, Opera GX, Brave) locks its cookie store so yt-dlp cannot read it. Use Firefox, or export a cookies.txt file and point Downloads settings at it.', finishedAt: new Date().toISOString(), speed: null, eta: null })
      } else if (needsCookies(message)) {
        this.update(job, { status: 'error', stage: 'Sign-in required', error: 'YouTube asked this download to prove it is not a bot. It only clears with a signed-in session: export a cookies.txt while logged into YouTube and set it in Downloads settings. The browser dropdown works for Firefox, but Chromium browsers (Chrome, Edge, Brave, Opera GX) encrypt their cookie store and cannot be read.', finishedAt: new Date().toISOString(), speed: null, eta: null })
      } else if (job.options.autoRetry !== false && (offline || isRetryableYtDlpError(message)) && job.attempts < 3) {
        this.holdForRetry(job, message, offline)
      } else {
        this.update(job, { status: 'error', stage: 'Failed', error: message, finishedAt: new Date().toISOString(), speed: null, eta: null })
      }
    } finally {
      this.persist()
    }
  }

  /**
   * Save a lyric result next to `audioPath` (same base name), and optionally
   * write it into the audio file's tags as well. Returns where it went.
   *
   * `embedInto` exists because the download pipeline fetches lyrics for the
   * song's *final* path while the audio itself is still in the temp folder —
   * the sidecar and the file it belongs to are not in the same place yet.
   */
  async saveLyricsBeside(audioPath: string, lyrics: LyricLookupResult, options: { fileDuration: number | null; allowRetime: boolean; overwrite?: boolean; embed?: boolean; embedInto?: string | null }): Promise<{ path: string | null; source: string | null; retimed: boolean; embedded: LyricEmbedOutcome | null }> {
    if (!lyrics.found) return { path: null, source: null, retimed: false, embedded: null }
    const format: LyricFormat = lyrics.ttmlLyrics ? 'ttml' : lyrics.syncedLyrics ? 'lrc' : 'plain'
    let content = lyrics.ttmlLyrics || lyrics.syncedLyrics || lyrics.plainLyrics || ''
    if (!content.trim()) return { path: null, source: null, retimed: false, embedded: null }
    let retimed = false
    const originalDuration = lyrics.candidate?.duration
    if (options.allowRetime && options.fileDuration && originalDuration && format !== 'plain') {
      const ratio = options.fileDuration / originalDuration
      // Anything more than 3% apart is a real speed change (nightcore ≈ 1.2–1.3×, slowed ≈ 0.8×); tiny deltas are just encoding slop.
      if (Math.abs(ratio - 1) > 0.03 && ratio > 0.5 && ratio < 2) { content = retimeLyrics(content, format, ratio); retimed = true }
    }
    const target = path.join(path.dirname(audioPath), `${path.parse(audioPath).name}${lyricExtension(format)}`)
    const embedTarget = options.embedInto ?? audioPath
    if (fs.existsSync(target) && !options.overwrite) {
      // The sidecar is already here, but the file's own tags may still be empty —
      // re-use what is on disk rather than refusing to embed anything.
      let embedded: LyricEmbedOutcome | null = null
      if (options.embed) embedded = await this.embedLyricsInto(embedTarget, await fs.promises.readFile(target, 'utf8').catch(() => content), format)
      return { path: target, source: 'existing file', retimed: false, embedded }
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(target, content, 'utf8')
    const embedded = options.embed ? await this.embedLyricsInto(embedTarget, content, format) : null
    return { path: target, source: lyrics.source ?? null, retimed, embedded }
  }

  /**
   * Flatten lyrics into the audio file's tags. Word-level timing cannot survive
   * the trip, so the `.ttml`/`.lrc` sidecar stays authoritative for Lyrigen and
   * the tags are there for every other player.
   */
  async embedLyricsInto(audioPath: string, content: string, format: LyricFormat): Promise<LyricEmbedOutcome | null> {
    if (!content.trim() || !fs.existsSync(audioPath)) return null
    try {
      return await embedLyrics(audioPath, { plain: lyricsToPlainText(content, format), lines: format === 'plain' ? null : lyricLines(content, format) })
    } catch (error) {
      console.warn('Could not embed lyrics', error)
      return 'failed'
    }
  }

  // ---------------------------------------------------------------------
  // Organiser for existing files
  // ---------------------------------------------------------------------

  async planOrganize(inputs: string[], options: { destination: string; pathTemplate: string; includeCleanFiles: boolean }, onProgress?: (completed: number, total: number) => void): Promise<OrganizePlanItem[]> {
    const files: string[] = []
    for (const input of inputs) {
      try {
        const stat = await fs.promises.stat(input)
        if (stat.isDirectory()) files.push(...await collectAudio(input))
        else if (AUDIO_EXTENSIONS.has(path.extname(input).toLocaleLowerCase())) files.push(input)
      } catch { /* skip missing */ }
    }
    const unique = Array.from(new Set(files))
    const plan: OrganizePlanItem[] = []
    let completed = 0
    for (const filePath of unique) {
      const { metadata, videoId, duration, tags, reason } = await this.metadataFromFile(filePath)
      const proposedPath = this.proposePath(metadata, path.extname(filePath), options.destination, options.pathTemplate, videoId)
      const sidecars = findSidecars(filePath)
      const samePlace = path.resolve(proposedPath).toLocaleLowerCase() === path.resolve(filePath).toLocaleLowerCase()
      const clean = metadata.origin === 'tags'
      if (!samePlace && (options.includeCleanFiles || !clean)) {
        plan.push({
          id: crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16), sourcePath: filePath, fileName: path.basename(filePath), videoId, duration,
          currentTags: tags, metadata, proposedPath, sidecars, hasLyrics: sidecars.some(file => /\.(lrc|ttml|yrc|txt)$/i.test(file)),
          selected: metadata.confidence !== 'low', reason,
        })
      }
      completed += 1
      onProgress?.(completed, unique.length)
    }
    return plan
  }

  /** Recompute the destination after the person edits artist/title in the review table. */
  replan(item: OrganizePlanItem, options: { destination: string; pathTemplate: string }): OrganizePlanItem {
    const metadata = { ...item.metadata, albumArtist: item.metadata.albumArtist || primaryArtist(item.metadata.artist), origin: 'manual' as const }
    return { ...item, metadata, proposedPath: this.proposePath(metadata, path.extname(item.sourcePath), options.destination, options.pathTemplate, item.videoId) }
  }

  async applyOrganize(items: OrganizePlanItem[], options: OrganizeApplyOptions, onProgress: (progress: OrganizeProgress) => void) {
    const moves: Array<{ from: string; to: string }> = []
    let done = 0
    for (const item of items) {
      if (!item.selected) { onProgress({ id: item.id, status: 'skipped', message: 'Not selected' }); continue }
      let tagWarning = ''
      try {
        if (!fs.existsSync(item.sourcePath)) throw new Error('The file is no longer there.')
        const target = uniquePath(this.proposePath(item.metadata, path.extname(item.sourcePath), options.destination, options.pathTemplate, item.videoId), candidate => fs.existsSync(candidate) && path.resolve(candidate) !== path.resolve(item.sourcePath))
        if (options.rewriteTags) {
          onProgress({ id: item.id, status: 'tagging', message: 'Writing clean tags…' })
          // Tags are a bonus; filing the song is the job. A file ffmpeg cannot
          // retag still gets moved, rather than being left where it was.
          await writeTags(item.sourcePath, {
            title: this.displayTitle(item.metadata), artist: item.metadata.artist, album: item.metadata.album || item.metadata.variant || null, albumArtist: item.metadata.albumArtist || primaryArtist(item.metadata.artist),
            genre: item.metadata.genre, date: item.metadata.year, sourceUrl: item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : null,
          }).catch(error => { console.warn(`Could not retag ${item.fileName}`, error); tagWarning = error instanceof Error ? error.message : String(error) })
        }
        onProgress({ id: item.id, status: 'moving', message: `Moving to ${path.relative(options.destination, target) || target}` })
        await fs.promises.mkdir(path.dirname(target), { recursive: true })
        await moveFile(item.sourcePath, target)
        moves.push({ from: item.sourcePath, to: target })
        // Sidecars (lyrics, cover, Lyrigen metadata overlay) travel with the song under its new name.
        for (const sidecar of item.sidecars) {
          const suffix = sidecar.slice(path.parse(item.sourcePath).name.length + path.dirname(sidecar).length + 1)
          const sidecarTarget = path.join(path.dirname(target), `${path.parse(target).name}${suffix}`)
          if (!fs.existsSync(sidecarTarget)) { await moveFile(sidecar, sidecarTarget).catch(() => undefined); moves.push({ from: sidecar, to: sidecarTarget }) }
        }
        if (options.fetchLyrics && !item.hasLyrics) {
          onProgress({ id: item.id, status: 'lyrics', message: 'Finding lyrics on Unison…' })
          const lyrics = await findBestLyrics({ trackName: item.metadata.title, artistName: item.metadata.artist, duration: item.metadata.variant ? null : item.duration, videoId: item.videoId })
          const saved = await this.saveLyricsBeside(target, lyrics, { fileDuration: item.duration, allowRetime: options.retimeLyrics && Boolean(item.metadata.variant), embed: options.embedLyrics })
          if (saved.path) moves.push({ from: '', to: saved.path })
          const embedded = saved.embedded === 'id3' || saved.embedded === 'tag'
          onProgress({ id: item.id, status: 'done', message: saved.path ? `Filed · lyrics from ${saved.source}${saved.retimed ? ' (re-timed)' : ''}${embedded ? ' (embedded)' : ''}` : 'Filed · no lyrics found', outputPath: target })
        } else onProgress({ id: item.id, status: 'done', message: tagWarning ? 'Filed · tags left as they were' : 'Filed', outputPath: target })
        done += 1
      } catch (error) {
        onProgress({ id: item.id, status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
    if (moves.length) { this.state.organizeJournal.push({ at: new Date().toISOString(), moves }); this.state.organizeJournal = this.state.organizeJournal.slice(-20); this.persist() }
    return { done, moved: moves.length }
  }

  /** Put the last batch back where it came from. Files written fresh (new lyrics) are deleted. */
  async undoOrganize() {
    const batch = this.state.organizeJournal.pop()
    if (!batch) return { undone: false, message: 'Nothing to undo.' }
    let restored = 0
    for (const move of [...batch.moves].reverse()) {
      try {
        if (!move.from) { await fs.promises.rm(move.to, { force: true }); continue }
        if (fs.existsSync(move.to) && !fs.existsSync(move.from)) { await fs.promises.mkdir(path.dirname(move.from), { recursive: true }); await moveFile(move.to, move.from); restored += 1 }
      } catch (error) { console.warn('Undo move failed', error) }
    }
    await pruneEmptyFolders(batch.moves.map(move => path.dirname(move.to)))
    this.persist()
    return { undone: restored > 0, message: `${restored} file${restored === 1 ? '' : 's'} moved back.` }
  }

  get canUndoOrganize() { return this.state.organizeJournal.length > 0 }

  // ---------------------------------------------------------------------
  // Inbox: watch a folder and auto-organise whatever lands in it
  // ---------------------------------------------------------------------

  syncInboxWatcher() {
    const { inboxEnabled, inboxFolder } = this.state.settings
    if (this.inboxWatcher) { this.inboxWatcher.close(); this.inboxWatcher = null }
    if (!inboxEnabled || !inboxFolder || !fs.existsSync(inboxFolder)) return
    try {
      this.inboxWatcher = fs.watch(inboxFolder, (_event, name) => {
        if (!name) return
        const filePath = path.join(inboxFolder, String(name))
        if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLocaleLowerCase()) || /\.part$|\.ytdl$|lyrigen-writing/.test(filePath)) return
        // Wait until the file has stopped growing — browsers and yt-dlp write in place.
        const existing = this.inboxTimers.get(filePath)
        if (existing) clearTimeout(existing)
        this.inboxTimers.set(filePath, setTimeout(() => void this.settleInboxFile(filePath), 4000))
      })
    } catch (error) { console.warn('Inbox watch unavailable', error) }
  }

  private async settleInboxFile(filePath: string) {
    this.inboxTimers.delete(filePath)
    try {
      const first = await fs.promises.stat(filePath)
      await new Promise(resolve => setTimeout(resolve, 3000))
      const second = await fs.promises.stat(filePath)
      if (first.size !== second.size) { this.inboxTimers.set(filePath, setTimeout(() => void this.settleInboxFile(filePath), 4000)); return }
      const settings = this.state.settings
      const [item] = await this.planOrganize([filePath], { destination: settings.destination, pathTemplate: settings.pathTemplate, includeCleanFiles: true })
      if (!item) return
      item.selected = true
      await this.applyOrganize([item], { destination: settings.destination, pathTemplate: settings.pathTemplate, rewriteTags: true, fetchLyrics: settings.fetchLyrics, retimeLyrics: settings.retimeLyrics, embedLyrics: settings.embedLyrics }, progress => this.emit('inbox', { file: path.basename(filePath), ...progress }))
    } catch (error) { console.warn('Inbox file could not be organised', error) }
  }

  dispose() {
    this.persist(true)
    if (this.inboxWatcher) this.inboxWatcher.close()
    for (const timer of this.inboxTimers.values()) clearTimeout(timer)
    for (const child of this.children.values()) { try { child.kill() } catch { /* already gone */ } }
  }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function sanitizeFileName(value: string) {
  return value.replace(/[<>:"/\\|?*\p{Cc}]/gu, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'Untitled'
}

async function moveFile(from: string, to: string) {
  try { await fs.promises.rename(from, to) } catch (error) {
    // Renames fail across drives; fall back to copy + delete.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await fs.promises.copyFile(from, to)
    await fs.promises.rm(from, { force: true })
  }
}

async function collectAudio(root: string) {
  const files: string[] = []
  const stack = [root]
  while (stack.length) {
    const directory = stack.pop()!
    let entries: fs.Dirent[]
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) { if (!entry.name.startsWith('.') && !/^(?:\$recycle\.bin|system volume information|node_modules)$/i.test(entry.name)) stack.push(full) }
      else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLocaleLowerCase())) files.push(full)
    }
  }
  return files
}

/** Files that belong to a song: same base name with a lyric / image / overlay extension. */
function findSidecars(audioPath: string) {
  const directory = path.dirname(audioPath), base = path.parse(audioPath).name
  const found: string[] = []
  for (const extension of SIDECAR_EXTENSIONS) {
    const candidate = path.join(directory, `${base}${extension}`)
    if (fs.existsSync(candidate)) found.push(candidate)
  }
  return found
}

async function pruneEmptyFolders(folders: string[]) {
  for (const folder of Array.from(new Set(folders)).sort((left, right) => right.length - left.length)) {
    try { if ((await fs.promises.readdir(folder)).length === 0) await fs.promises.rmdir(folder) } catch { /* not empty or gone */ }
  }
}
