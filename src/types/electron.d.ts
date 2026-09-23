interface AudioMetadata {
  releaseDate?: string | null
  trackNumber?: number | null
  discNumber?: number | null
  composer?: string | null
  title: string | null
  artist: string | null
  album: string | null
  albumArtist: string | null
  year: number | null
  genre: string | null
  duration: number | null
  bitrate: number | null
  sampleRate: number | null
  bitsPerSample: number | null
  codec: string | null
  lossless: boolean | null
  cover: string | null
  fileSize: number | null
}

interface LibraryTrack {
  id: string
  title: string
  audioPath: string
  lyricPath: string | null
  album: string
  artist: string | null
  albumArtist: string | null
  year: number | null
  trackNumber: number | null
  discNumber: number | null
  duration: number | null
  relativePath: string
  coverPath: string | null
  videoPath: string | null
  fileSize: number
  format: string
  lossless: boolean | null
  kbps?: number | null
  sampleRate?: number | null
  bitDepth?: number | null
  codec?: string | null
  genre: string | null
  isDuplicate: boolean
  possibleDuplicate?: boolean
  favorite?: boolean
  rating?: number
  playCount?: number
  lastPlayed?: string | null
}

interface OnlineLyricsResult {
  found: boolean
  source?: string
  sourceUrl?: string
  id?: number | null
  instrumental?: boolean
  syncedLyrics?: string | null
  plainLyrics?: string | null
  /** Real, word-level Apple Music TTML from the free AMLL TTML DB, when a match was found there. */
  ttmlLyrics?: string | null
  /** The ranked candidate the content came from (Unison votes, sync type, …). */
  candidate?: LyricCandidate
  message?: string
}

interface SaveLyricsResult {
  saved: boolean
  path?: string
  message?: string
  /** True when the words also went into the audio file's own tags. */
  embedded?: boolean
}

interface AudioFileInspection {
  filePath: string
  fileName: string
  format: string
  metadata: AudioMetadata
}

interface TrackLookupMetadata {
  releaseDate?: string
  title: string
  artist: string
  album: string
  albumArtist: string
  year: string
  genre: string
  trackNumber: string
  discNumber: string
}

interface TrackLookupResult {
  found: boolean
  metadata?: Partial<TrackLookupMetadata>
  coverData?: string | null
  coverMime?: string | null
  source?: string | null
  sourceUrl?: string | null
  releaseId?: string | null
  recordingId?: string | null
  confidence?: 'high' | 'medium' | 'low' | null
  message?: string
}

interface WriteTrackMetadataRequest {
  filePath: string
  metadata: TrackLookupMetadata
  coverData?: string | null
  coverMime?: string | null
  backupOriginal?: boolean
  source?: string | null
  sourceUrl?: string | null
}

interface WriteTrackMetadataResult {
  written: boolean
  mode?: 'embedded' | 'sidecar'
  path?: string
  message?: string
}

interface SelectedLrcFile {
  path: string
  name: string
  content: string
}

type PlayerCommand = 'play-pause' | 'next' | 'previous' | 'mute'

interface LibraryScanResult {
  rootPath: string | null
  rootPaths?: string[]
  items: LibraryTrack[]
  scanId?: string
  progress?: { completed: number; total: number; phase: 'scanning' | 'complete' | 'error' }
  error?: string
}

interface QueueState {
  currentTrackId: string | null
  upcomingTrackIds: string[]
  historyTrackIds: string[]
  /**
   * Tracks queued by hand with "Play next" / "Play last". These play in the
   * order they were asked for even when shuffle is on — an explicit request is
   * not a suggestion.
   */
  manualTrackIds?: string[]
  shuffle: boolean
  repeat: 'off' | 'all' | 'one'
  autoplay: boolean
}

interface PlaylistRecord {
  id: string
  name: string
  trackIds: string[]
  smartRule?: string
  createdAt: string
  updatedAt: string
}

/** A listening recap for one window of time. Mirrored in src/types/electron.d.ts. */
interface ListeningRecap {
  range: 'week' | 'month' | 'year' | 'all'
  plays: number
  /** Total listening time in seconds, counting each play as a full listen. */
  seconds: number
  distinctTracks: number
  distinctArtists: number
  topTracks: Array<{ id: string; title: string; artist: string | null; plays: number; seconds: number }>
  topArtists: Array<{ name: string; plays: number; seconds: number }>
  topGenres: Array<{ name: string; plays: number }>
  perDay: Array<{ date: string; plays: number }>
  /** What one bar covers, so the chart can label itself honestly. */
  bucketSize: 'day' | 'week' | 'month'
  peakDay: { date: string; plays: number } | null
}

interface DuplicateGroup {
  key: string
  title: string
  keep: { path: string; reason: string }
  remove: Array<{ path: string; size: number }>
}

interface LibraryStats {
  tracks: number
  albums: number
  artists: number
  genres: number
  favorites: number
  totalDuration: number
  recent: LibraryTrack[]
  mostPlayed: LibraryTrack[]
  needsAttention: LibraryTrack[]
}

interface CatalogResult {
  id: string
  title: string
  artist?: string
  album?: string
  source: string
  sourceUrl?: string
  kind: 'lyrics' | 'metadata' | 'audio'
  syncedLyrics?: string | null
  plainLyrics?: string | null
  confidence?: 'high' | 'medium' | 'low'
  payload?: unknown
}

/** App-level preferences, stored in the persisted `settings` bag. */
interface AppSettings {
  /** Start playing the last track automatically when Lyrigen opens. */
  autoplayOnStartup: boolean
  /** Pick each track up where you stopped, rather than from the beginning. */
  resumePlayback: boolean
  /** Rescan library folders on launch instead of trusting the cache. */
  rescanOnStartup: boolean
  /** Closing the window leaves Lyrigen running in the tray. */
  closeToTray: boolean
  /** Fetch lyrics automatically for a track that has none. */
  autoFetchLyrics: boolean
  /** Turn off ambient and per-line animation everywhere. */
  reducedMotion: boolean
  /** Confirm before the Organizer moves anything. */
  confirmDestructive: boolean
}

interface AppInfo { version: string; electron: string; dataFolder: string; platform: string }

interface SettingsState {
  visualMode: string
  lyricFontSize: number
  lyricDensity: 'compact' | 'comfortable' | 'airy'
  crossfade: boolean
  highContrast: boolean
  reducedMotion: boolean
}


// ---------------------------------------------------------------------------
// Downloads, organiser, Lyrics Finder
// ---------------------------------------------------------------------------

type SongVariant = 'Sped Up' | 'Nightcore' | 'Slowed' | 'Slowed + Reverb' | 'Reverb' | 'Lo-Fi' | 'Daycore' | '8D' | 'Bass Boosted' | 'Remix' | 'Acoustic' | 'Live' | 'Instrumental' | 'Karaoke' | 'Cover' | 'Mashup'
type AudioFormat = 'best' | 'mp3' | 'm4a' | 'opus' | 'flac'
type AudioQuality = 'best' | 'high' | 'medium'
type DownloadJobStatus = 'queued' | 'inspecting' | 'downloading' | 'converting' | 'tagging' | 'lyrics' | 'organizing' | 'done' | 'error' | 'cancelled' | 'paused' | 'waiting'
type LyricFormat = 'ttml' | 'lrc' | 'plain'
type LyricSync = 'syllable' | 'richsync' | 'linesync' | 'plain'
type LyricSourceId = 'betterlyrics' | 'binilyrics' | 'unison' | 'amll' | 'lrclib'

interface SongMetadata {
  artist: string | null
  title: string
  album: string | null
  albumArtist: string | null
  featuring: string | null
  variant: SongVariant | null
  year: string | null
  genre: string | null
  confidence: 'high' | 'medium' | 'low'
  origin: 'music-metadata' | 'title-parse' | 'tags' | 'manual' | 'musicbrainz'
}

interface ToolStatus { name: 'yt-dlp' | 'ffmpeg' | 'ffprobe' | 'ffplay'; path: string | null; version: string | null; ok: boolean }
interface QualityCheckStep { id: 'tools' | 'engine' | 'signin' | 'token' | 'stream'; label: string; state: 'ok' | 'warn' | 'fail' | 'skip'; detail: string }
interface QualityCheckResult {
  steps: QualityCheckStep[]
  expected: { formatId: string; codec: string; kbps: number | null; sampleRate: number | null; premium: boolean; converted: string | null } | null
  headline: string
  testedUrl: string
}
interface UpgradeCandidate { path: string; videoId: string; kbps: number | null; codec: string | null; title: string; artist: string | null }
interface LibraryQualityReport {
  scanned: number
  premium: number
  lossless: number
  upgradable: UpgradeCandidate[]
  noBetterStream: number
  unknownSource: number
  bands: { under96: number; to160: number; to200: number; over200: number }
}
interface LyricSyncEnvironment {
  python: string | null
  pythonVersion: string | null
  packages: { stableTs: string | null; fasterWhisper: string | null }
  /** torch, transformers and uroman — what syllable timing needs on top. */
  syllables: boolean
  gpus: number
  cudaRuntime: boolean
  ready: boolean
  message: string
}
type LyricSyncWord = { word: string; start: number; end: number }
interface LyricSyncRequest { audioPath: string; model: string; level?: 'word' | 'syllable'; language?: string | null; lyricsText?: string | null; lyricsLines?: Array<{ text: string; start: number; end: number | null; words?: LyricSyncWord[] }> | null; device?: 'auto' | 'cuda' | 'cpu' }
interface LyricSyncEvent { event: 'status' | 'device' | 'progress'; stage?: string; message?: string; device?: string; compute?: string; note?: string; percent?: number }
interface LyricSyncResult {
  ok: boolean
  message?: string
  mode?: 'from-words' | 'align-lines' | 'align' | 'transcribe'
  level?: 'word' | 'syllable'
  language?: string
  device?: string
  seconds?: number
  note?: string
  syllableStats?: { acoustic: number; fallback: number } | null
  segments?: Array<{ text: string; start: number; end: number; words: Array<LyricSyncWord & { syllables?: Array<{ text: string; start: number; end: number }> }> }>
  /** The finished files, made by the engine — what Lyric Studio itself saves. */
  ttml?: string
  lrc?: string
}
interface PotStatus { folder: string | null; plugin: boolean; running: boolean }
interface JsRuntimeStatus { available: boolean; kind: 'deno' | 'node' | 'bun' | 'electron' | null; path: string | null }
interface ToolsStatus { tools: ToolStatus[]; searchedFolders: string[]; ready: boolean; jsRuntime: JsRuntimeStatus }

/** A song that was not queued, and what Lyrigen already has in its place. */
interface SkippedDownload {
  title: string
  artist: string | null
  url: string
  videoId: string | null
  existingPath: string
  reason: string
}

interface EnqueueResult {
  created: DownloadJob[]
  skipped: SkippedDownload[]
}

interface DownloadOptions {
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
  skipDuplicates: boolean
  autoRetry: boolean
  premiumAudio: boolean
}

interface DownloadSettings extends DownloadOptions {
  toolsFolder: string | null
  concurrency: number
  /** Optional Better Lyrics API key. Without one only their cached songs answer. */
  betterLyricsApiKey: string | null
  cookieSource: 'none' | 'chrome' | 'edge' | 'firefox' | 'brave' | 'opera' | 'vivaldi' | 'chromium'
  cookieProfile: string
  cookieFile: string
  potProviderFolder: string | null
  inboxFolder: string | null
  inboxEnabled: boolean
}

interface PathPreset { id: string; label: string; template: string; hint: string }

interface VideoInfo {
  id: string
  title: string
  webpageUrl: string
  uploader: string | null
  channel: string | null
  artist: string | null
  track: string | null
  album: string | null
  releaseYear: number | null
  uploadDate: string | null
  duration: number | null
  thumbnail: string | null
  extractor: string
  isPlaylist: boolean
  playlistTitle?: string | null
}

interface InspectItem { url: string; videoId: string; info: VideoInfo; metadata: SongMetadata; proposedPath: string; alreadyDownloaded: string | null }
interface InspectResult { ok: boolean; error?: string; items: InspectItem[]; playlistTitle?: string | null }

interface DownloadJob {
  id: string
  url: string
  videoId: string | null
  status: DownloadJobStatus
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
  outputPath: string | null
  lyricPath: string | null
  lyricSource: string | null
  lyricRetimed: boolean
  lyricEmbedded: boolean
  audio?: { codec: string | null; kbps: number | null; sampleRate: number | null } | null
  upgradeOf?: { path: string; kbps: number | null; kept?: boolean } | null
  attempts: number
  retryAt: string | null
  options: DownloadOptions
}

interface OrganizePlanItem {
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

interface OrganizeApplyOptions { destination: string; pathTemplate: string; rewriteTags: boolean; fetchLyrics: boolean; retimeLyrics: boolean; embedLyrics: boolean }
type OrganizeProgress =
  | { phase: 'planning'; completed: number; total: number }
  | { phase: 'applying'; id: string; status: 'moving' | 'tagging' | 'lyrics' | 'done' | 'error' | 'skipped'; message: string; outputPath?: string | null }

interface LyricCandidate {
  id: string
  source: LyricSourceId
  sourceLabel: string
  sourceUrl: string | null
  song: string
  artist: string
  album: string | null
  duration: number | null
  format: LyricFormat
  syncType: LyricSync
  language: string | null
  confidence: 'high' | 'medium' | 'low'
  votes: number | null
  score: number | null
  submitter: string | null
  videoId: string | null
  match: number
  content?: string
}

interface LyricLookupRequest { trackName: string; artistName?: string | null; albumName?: string | null; duration?: number | null; videoId?: string | null; sources?: LyricSourceId[] }
interface LyricsBatchProgress { id: string; status: 'searching' | 'saved' | 'missed'; source?: string | null; path?: string | null; message?: string | null; retimed?: boolean }

interface ElectronAPI {
  selectLibrary: () => Promise<LibraryScanResult>
  getLibrary: () => Promise<LibraryScanResult>
  rescanLibrary: () => Promise<LibraryScanResult>
  queryLibrary: (query: { text?: string; genre?: string; album?: string; artist?: string; favorite?: boolean; lossless?: boolean; hasLyrics?: boolean; duplicate?: boolean }) => Promise<LibraryTrack[]>
  getLibraryStats: () => Promise<LibraryStats>
  getLibraryRoots: () => Promise<string[]>
  addLibraryRoot: () => Promise<LibraryScanResult>
  removeLibraryRoot: (rootPath: string) => Promise<LibraryScanResult>
  getPlaylists: () => Promise<PlaylistRecord[]>
  createPlaylist: (name: string) => Promise<PlaylistRecord[]>
  renamePlaylist: (id: string, name: string) => Promise<PlaylistRecord[]>
  deletePlaylist: (id: string) => Promise<PlaylistRecord[]>
  addTracksToPlaylist: (playlistId: string, trackIds: string[]) => Promise<PlaylistRecord[]>
  removeTracksFromPlaylist: (playlistId: string, trackIds: string[]) => Promise<PlaylistRecord[]>
  reorderPlaylist: (playlistId: string, trackIds: string[]) => Promise<PlaylistRecord[]>
  getQueueState: () => Promise<QueueState>
  updateQueueState: (queue: QueueState) => Promise<QueueState>
  setFavorite: (trackId: string, favorite: boolean) => Promise<LibraryStats>
  setRating: (trackId: string, rating: number) => Promise<LibraryStats>
  recordPlay: (trackId: string, seconds?: number) => Promise<void>
  getListeningRecap: (range: 'week' | 'month' | 'year' | 'all') => Promise<ListeningRecap>
  saveResumePosition: (trackId: string, positionMs: number) => Promise<void>
  getResumePosition: (trackId: string) => Promise<number | null>
  getSettings: () => Promise<SettingsState>
  updateSettings: (settings: Partial<SettingsState>) => Promise<SettingsState>
  planDuplicateCleanup: () => Promise<DuplicateGroup[]>
  checkDownloadPaths: () => Promise<Array<{ kind: 'destination' | 'library' | 'cookies'; path: string }>>
  getArtworkColor: (filePath: string) => Promise<string | null>
  lyricSyncEnvironment: (refresh?: boolean) => Promise<LyricSyncEnvironment>
  startLyricSync: (request: LyricSyncRequest) => Promise<LyricSyncResult>
  cancelLyricSync: () => Promise<boolean>
  onLyricSyncEvent: (callback: (event: LyricSyncEvent) => void) => () => void
  getPotStatus: () => Promise<PotStatus>
  startPotProvider: () => Promise<PotStatus>
  checkDownloadQuality: (url?: string | null) => Promise<QualityCheckResult>
  scanLibraryQuality: () => Promise<LibraryQualityReport>
  enqueueUpgrades: (candidates: UpgradeCandidate[]) => Promise<number>
  onLibraryQualityProgress: (callback: (progress: { done: number; total: number }) => void) => () => void
  trashFiles: (paths: string[]) => Promise<{ trashed: number; failed: string[] }>
  inspectCookiesFile: (filePath: string) => Promise<{ ok: boolean; message: string }>
  chooseCookiesFile: () => Promise<{ path: string; ok: boolean; message: string } | null>
  clearPlayHistory: () => Promise<{ cleared: number }>
  clearResumePositions: () => Promise<{ cleared: number }>
  resetWindowBounds: () => Promise<boolean>
  openDataFolder: () => Promise<string>
  getAppInfo: () => Promise<AppInfo>
  importLegacyState: (legacy: { rootPath?: string | null; playlist?: unknown; genres?: unknown; listeningStats?: unknown; visualMode?: string | null }) => Promise<void>
  searchCatalog: (query: { title?: string; artist?: string; album?: string; sources?: string[] }) => Promise<CatalogResult[]>
  getCachedCatalogResults: (key?: string) => Promise<CatalogResult[]>
  saveLyrics: (audioPath: string, lyricText: string, options?: { overwrite?: boolean }) => Promise<SaveLyricsResult>
  saveTtml: (audioPath: string, ttmlText: string, options?: { overwrite?: boolean }) => Promise<SaveLyricsResult>
  undoLastFileEdit: () => Promise<{ undone: boolean; message?: string }>
  updateTrackMetadata: (request: { audioPath: string; metadata: Record<string, string | number | null>; backupOriginal?: boolean }) => Promise<{ updated: boolean; message?: string; mode?: string }>
  updateArtwork: (request: { audioPath: string; imagePath?: string; imageData?: string; mimeType?: string; backupOriginal?: boolean }) => Promise<{ updated: boolean; message?: string; mode?: string }>
  readFile: (filePath: string) => Promise<string | null>
  getMediaUrl: (filePath: string) => Promise<string>
  getAudioMetadata: (filePath: string) => Promise<AudioMetadata | null>
  selectAudioFiles: () => Promise<string[]>
  selectAudioFolder: () => Promise<string[]>
  inspectAudioFiles: (filePaths: string[]) => Promise<AudioFileInspection[]>
  lookupTrackMetadata: (request: { title: string; artist?: string; album?: string; duration?: number | null }) => Promise<TrackLookupResult>
  writeTrackMetadata: (request: WriteTrackMetadataRequest) => Promise<WriteTrackMetadataResult>
  findOnlineLyrics: (request: { trackName: string; artistName?: string | null; albumName?: string | null; duration?: number | null; videoId?: string | null; audioPath?: string | null }) => Promise<OnlineLyricsResult>
  chooseLrcFiles: () => Promise<SelectedLrcFile[]>
  saveTtmlFile: (lrcPath: string, ttmlText: string) => Promise<SaveLyricsResult>
  chooseAlignmentJson: () => Promise<{ path: string; name: string; content: string } | null>
  lookupMusicBrainz: (title: string, artist?: string | null) => Promise<{ found: boolean; recordings: unknown[] }>
  showItemInFolder: (filePath: string) => Promise<void>
  openExternal: (url: string) => Promise<void | boolean>
  updatePlayerState: (state: { playing: boolean; title?: string }) => void
  onPlayerCommand: (callback: (command: PlayerCommand) => void) => () => void
  onMiniModeChanged: (callback: (enabled: boolean) => void) => () => void
  onLibraryUpdated: (callback: (result: LibraryScanResult) => void) => () => void
  onScanProgress: (callback: (progress: { completed: number; total: number; phase: 'scanning' | 'complete' | 'error'; rootPath?: string }) => void) => () => void
  getArtworkUrl: (filePath: string, size: number) => Promise<string | null>
  getArtworkData: (source: string, size?: number) => Promise<string | null>
  getToolsStatus: () => Promise<ToolsStatus>
  chooseToolsFolder: () => Promise<ToolsStatus>
  updateYtDlp: () => Promise<{ ok: boolean; message: string }>
  getDownloadSettings: () => Promise<{ settings: DownloadSettings; presets: PathPreset[] }>
  updateDownloadSettings: (patch: Partial<DownloadSettings>) => Promise<DownloadSettings>
  chooseDownloadFolder: (current?: string) => Promise<string | null>
  inspectDownloadUrl: (url: string, options?: Partial<DownloadOptions>) => Promise<InspectResult>
  enqueueDownloads: (items: Array<{ url: string; videoId?: string | null; metadata?: SongMetadata | null; info?: DownloadJob['info'] }>, options?: Partial<DownloadOptions>) => Promise<EnqueueResult>
  listDownloads: () => Promise<DownloadJob[]>
  cancelDownload: (id: string) => Promise<void>
  retryDownload: (id: string) => Promise<void>
  removeDownload: (id: string) => Promise<void>
  clearFinishedDownloads: () => Promise<void>
  setDownloadsPaused: (paused: boolean) => Promise<boolean>
  areDownloadsPaused: () => Promise<boolean>
  updateDownloadMetadata: (id: string, metadata: SongMetadata) => Promise<DownloadJob | null>
  previewDownloadUrl: (url: string) => Promise<{ playing: boolean; message?: string }>
  stopPreview: () => Promise<{ playing: boolean }>
  chooseOrganizeSources: () => Promise<string[]>
  planOrganize: (inputs: string[], options: { destination: string; pathTemplate: string; includeCleanFiles: boolean }) => Promise<OrganizePlanItem[]>
  replanOrganizeItem: (item: OrganizePlanItem, options: { destination: string; pathTemplate: string }) => Promise<OrganizePlanItem>
  applyOrganize: (items: OrganizePlanItem[], options: OrganizeApplyOptions) => Promise<{ done: number; moved: number }>
  undoOrganize: () => Promise<{ undone: boolean; message: string }>
  canUndoOrganize: () => Promise<boolean>
  searchLyricCandidates: (request: LyricLookupRequest) => Promise<LyricCandidate[]>
  fetchLyricCandidate: (candidate: LyricCandidate, options?: { retimeToDuration?: number | null }) => Promise<{ content: string; format: LyricFormat; retimed: boolean } | null>
  saveLyricFile: (audioPath: string, content: string, format: LyricFormat, options?: { overwrite?: boolean; embed?: boolean }) => Promise<SaveLyricsResult>
  fetchLyricsForTracks: (tracks: Array<{ id: string; audioPath: string; title: string; artist: string | null; album: string | null; duration: number | null }>, options?: { overwrite?: boolean; retime?: boolean; embed?: boolean }) => Promise<Array<{ id: string; saved: boolean; source: string | null; path: string | null; message: string | null; retimed: boolean; embedded: boolean }>>
  onDownloadJob: (callback: (job: DownloadJob) => void) => () => void
  onDownloadJobs: (callback: (jobs: DownloadJob[]) => void) => () => void
  onOrganizeProgress: (callback: (progress: OrganizeProgress) => void) => () => void
  onInboxProgress: (callback: (progress: { file: string; status: string; message: string }) => void) => () => void
  onLyricsBatchProgress: (callback: (progress: LyricsBatchProgress) => void) => () => void
  minimizeWindow: () => void
  toggleFullscreen: () => void
  setMiniMode: (enabled: boolean) => void
  closeWindow: () => void
}

interface Window {
  electronAPI: ElectronAPI
}
