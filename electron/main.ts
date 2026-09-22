import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import crypto from 'node:crypto'
import { MetadataFiles, readOverlay } from './metadata-files'
import { createRateLimiter, mapLimited, matchScore, cleanTitle } from './catalog'
import { createPlaylist, createStateStore, emptyQueue } from './state-store'
import { configureGraphics, reportGraphicsStatus } from './graphics'
import { getThumbnailUrl, pruneThumbnailCache } from './artwork-cache'
import { Downloader, songIdentity, type DownloadOptions, type DownloadSettings, type OrganizeApplyOptions, type OrganizePlanItem, type SongMetadata } from './downloader'
import { fetchLyricCandidate, findBestLyrics, lyricExtension, retimeLyrics, searchLyricCandidates, type LyricCandidate, type LyricLookupRequest } from './lyrics-sources'
import { inspectCookiesFile, isPreviewing, potStatus, previewUrl, setPotProviderFolder, setToolsFolder, startPotProvider, stopPotProvider, stopPreview, toolsStatus, updateYtDlp } from './media-tools'
import { setBetterLyricsApiKey } from './lyrics-sources'
import { PATH_PRESETS, primaryArtist } from './song-naming'

/** A listening recap for one window of time. Mirrored in src/types/electron.d.ts. */
export interface ListeningRecap {
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


// GPU compositing avoids making the CPU paint every glass/lyric animation
// (see graphics.ts; --safe-graphics is the explicit recovery mode).
const graphicsMode = configureGraphics()
app.setAppUserModelId('com.lyrigen.player')

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let isPlaying = false
let isMini = false
let restoreBounds: Electron.Rectangle | null = null
const libraryWatchers = new Map<string, fs.FSWatcher>()
let libraryWatchTimer: NodeJS.Timeout | null = null
let stateStore: ReturnType<typeof createStateStore> | null = null
let scanId = 0
let lastFileBackup: { originalPath: string; backupPath: string } | null = null

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const smokeTestArgument = process.argv.find(argument => argument.startsWith('--smoke-test='))
const smokeTestScreenshot = smokeTestArgument?.slice('--smoke-test='.length)
const smokeLibraryArgument = process.argv.find(argument => argument.startsWith('--library-root='))
const smokeLibraryRoot = smokeLibraryArgument?.slice('--library-root='.length)
const shouldOpenFirstTrack = process.argv.includes('--smoke-open-first')
const smokeTrackArgument = process.argv.find(argument => argument.startsWith('--smoke-track='))
const smokeTrackTitle = smokeTrackArgument?.slice('--smoke-track='.length)
const shouldOpenSettings = process.argv.includes('--smoke-open-settings')
const shouldOpenMini = process.argv.includes('--smoke-open-mini')
const shouldSmokeScroll = process.argv.includes('--smoke-scroll')
const shouldSmokeBackToLibrary = process.argv.includes('--smoke-back-to-library')
const shouldSmokeVisualModes = process.argv.includes('--smoke-visual-modes')
const shouldOpenConverter = process.argv.includes('--smoke-open-converter')
const shouldSmokeConverterSample = process.argv.includes('--smoke-converter-sample')

if (smokeTestScreenshot) {
  app.setPath('userData', path.join(process.cwd(), '.lyrigen-smoke-profile'))
} else if (process.env.LYRIGEN_USER_DATA) {
  // Throwaway profile for scripted checks (scripts/smoke-downloads.mjs) so they never touch real settings or history.
  app.setPath('userData', process.env.LYRIGEN_USER_DATA)
}

type LibraryTrack = {
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
  genre: string | null
  isDuplicate: boolean
  possibleDuplicate?: boolean
  favorite?: boolean
  rating?: number
  playCount?: number
  lastPlayed?: string | null
}

type LibraryScanResult = {
  rootPath: string | null
  rootPaths?: string[]
  items: LibraryTrack[]
  scanId?: string
  progress?: { completed: number; total: number; phase: 'scanning' | 'complete' | 'error' }
  error?: string
}

function getStateStore() {
  if (!stateStore) stateStore = createStateStore(app.getPath('userData'))
  return stateStore
}

function withStoredTrackState(items: LibraryTrack[]) {
  const state = getStateStore().get()
  const playCounts = new Map<string, number>()
  const lastPlayed = new Map<string, string>()
  for (const entry of state.playHistory) { playCounts.set(entry.trackId, (playCounts.get(entry.trackId) ?? 0) + 1); lastPlayed.set(entry.trackId, entry.playedAt) }
  const favorites = new Set(state.favorites)
  return items.map(item => ({
    ...item,
    favorite: favorites.has(item.id),
    rating: state.ratings[item.id] ?? 0,
    playCount: playCounts.get(item.id) ?? 0,
    lastPlayed: lastPlayed.get(item.id) ?? null,
  }))
}

const audioExtensions = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif'])
const lyricExtensions = ['.ttml', '.lrc', '.yrc', '.txt']
const videoExtensions = ['.mp4', '.webm', '.mkv', '.mov', '.m4v']
const coverFileNames = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'folder.jpg', 'folder.png']
const ignoredDirectories = new Set(['$recycle.bin', 'system volume information', 'node_modules'])

type TagMetadata = {
  title: string
  artist: string
  album: string
  albumArtist: string
  year: string
  genre: string
  trackNumber: string
  discNumber: string
}

type MetadataLookupRequest = {
  title: string
  artist?: string
  album?: string
  duration?: number | null
}

const waitForMusicBrainz = createRateLimiter(1100)
const waitForLrclib = createRateLimiter(350)
/** MusicBrainz occasionally answers 429/503 under load. One polite retry (honouring Retry-After) keeps bulk metadata runs from failing on a single hiccup, without hammering the free service. */
async function fetchMusicBrainzJson<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForMusicBrainz()
    const response = await fetch(url, { headers: { 'User-Agent': 'Lyrigen/2.1.0 (desktop metadata studio)' }, signal: AbortSignal.timeout(12_000) })
    if (response.ok) return response.json() as Promise<T>
    if ((response.status === 429 || response.status === 503) && attempt === 0) {
      const retryAfter = Number(response.headers.get('retry-after') || 2)
      await new Promise(resolve => setTimeout(resolve, Math.min(8_000, Math.max(1, retryAfter) * 1000)))
      continue
    }
    throw new Error(`MusicBrainz returned ${response.status}`)
  }
  throw new Error('MusicBrainz is unavailable right now.')
}
let metadataFiles: MetadataFiles | null = null
function tagFiles() { return metadataFiles ??= new MetadataFiles(app.getPath('userData')) }

async function backupFile(filePath: string) {
  const backupPath = `${filePath}.lyrigen-backup`
  try {
    await fs.promises.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  lastFileBackup = { originalPath: filePath, backupPath }
  return backupPath
}

function normaliseSearchText(value: string) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function escapeMusicBrainz(value: string) {
  return value.replace(/["\\]/g, ' ').trim()
}

function creditNames(credits: Array<{ name?: string; artist?: { name?: string } }> | undefined) {
  return credits?.map(credit => credit.name || credit.artist?.name).filter(Boolean).join(', ') || ''
}

async function fetchCoverData(releaseId: string) {
  for (const suffix of ['front-500']) {
    try {
      const response = await fetch(`https://coverartarchive.org/release/${releaseId}/${suffix}`, { signal: AbortSignal.timeout(12_000) })
      if (!response.ok) continue
      const mime = response.headers.get('content-type') || 'image/jpeg'
      if (!/^image\/(jpeg|png|webp)/i.test(mime)) continue
      if (Number(response.headers.get('content-length')) > 5_000_000) continue
      const reader = response.body?.getReader()
      if (!reader) continue
      const chunks: Uint8Array[] = []; let size = 0
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 5_000_000) { await reader.cancel(); throw new Error('Artwork too large') } chunks.push(value) }
      const data = Buffer.concat(chunks)
      return { data: `data:${mime};base64,${data.toString('base64')}`, mime }
    } catch {
      // Try the next Cover Art Archive size before reporting no artwork.
    }
  }
  return null
}

function getIconPath() {
  return path.join(app.getAppPath(), 'assets', 'lyrigen-icon.png')
}

async function collectLibraryFiles(rootPath: string) {
  const files: string[] = []
  const directories = [rootPath]

  while (directories.length > 0) {
    const directory = directories.pop()!
    let entries: fs.Dirent[]

    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true })
    } catch (error) {
      console.warn(`Skipping unreadable directory: ${directory}`, error)
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        const normalizedName = entry.name.toLocaleLowerCase()
        if (!entry.name.startsWith('.') && !ignoredDirectories.has(normalizedName)) {
          directories.push(fullPath)
        }
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }
  }

  return files
}

const indexCache = new Map<string, { stamp: string; value: Awaited<ReturnType<typeof readIndexMetadata>> }>()
async function extractIndexMetadata(filePath: string) {
  const stat = await fs.promises.stat(filePath)
  const overlay = await readOverlay(filePath)
  const stamp = `${stat.size}:${stat.mtimeMs}:${JSON.stringify(overlay)}`
  const cached = indexCache.get(filePath)
  if (cached?.stamp === stamp) return cached.value
  const value = await readIndexMetadata(filePath)
  indexCache.set(filePath, { stamp, value })
  return value
}
async function readIndexMetadata(filePath: string) {
  try {
    const mm = await import('music-metadata')
    const metadata = await mm.parseFile(filePath)
    const overlay = await readOverlay(filePath)
    let embeddedCoverPath: string | null = overlay.coverPath || null
    const picture = metadata.common.picture?.[0]
    if (!embeddedCoverPath && picture) {
      const folder = path.join(app.getPath('userData'), 'artwork')
      await fs.promises.mkdir(folder, { recursive: true })
      const hash = crypto.createHash('sha256').update(picture.data).digest('hex').slice(0, 24)
      embeddedCoverPath = path.join(folder, hash + '.jpg')
      if (!fs.existsSync(embeddedCoverPath)) {
        const thumb = nativeImage.createFromBuffer(Buffer.from(picture.data)).resize({ width: 500 })
        if (!thumb.isEmpty()) await fs.promises.writeFile(embeddedCoverPath, thumb.toJPEG(86))
        else embeddedCoverPath = null
      }
    }
    return {
      title: overlay.title || metadata.common.title || null,
      artist: overlay.artist || metadata.common.artist || null,
      album: overlay.album || metadata.common.album || null,
      albumArtist: overlay.albumArtist || metadata.common.albumartist || null,
      year: Number(overlay.year) || metadata.common.year || null,
      genre: overlay.genre || metadata.common.genre?.[0] || null,
      duration: metadata.format.duration || null,
      lossless: metadata.format.lossless ?? null,
      trackNumber: Number(overlay.trackNumber) || metadata.common.track.no || null,
      discNumber: Number(overlay.discNumber) || metadata.common.disk.no || null,
      embeddedCoverPath,
    }
  } catch {
    return { title: null, artist: null, album: null, albumArtist: null, year: null, genre: null, duration: null, lossless: null, trackNumber: null, discNumber: null, embeddedCoverPath: null }
  }
}

async function scanLibrary(rootPath: string | null): Promise<LibraryScanResult> {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return { rootPath: null, items: [], error: rootPath ? 'The saved music folder is no longer available.' : undefined }
  }

  const files = await collectLibraryFiles(rootPath)
  const currentScanId = `scan-${Date.now()}-${++scanId}`
  const audioFiles = files.filter(filePath => audioExtensions.has(path.extname(filePath).toLocaleLowerCase()))
  win?.webContents.send('scan-progress', { completed: 0, total: audioFiles.length, phase: 'scanning', rootPath })
  const filesByDirectory = new Map<string, Map<string, string>>()

  for (const filePath of files) {
    const directory = path.dirname(filePath)
    const directoryFiles = filesByDirectory.get(directory) ?? new Map<string, string>()
    directoryFiles.set(path.basename(filePath).toLocaleLowerCase(), filePath)
    filesByDirectory.set(directory, directoryFiles)
  }

  let completed = 0
  const items = (await mapLimited(audioFiles, 4, async (audioPath): Promise<LibraryTrack> => {
      const directory = path.dirname(audioPath)
      const directoryFiles = filesByDirectory.get(directory) ?? new Map<string, string>()
      const title = path.parse(audioPath).name
      const normalizedTitle = title.toLocaleLowerCase()
      const lyricPath = lyricExtensions
        .map(extension => directoryFiles.get(`${normalizedTitle}${extension}`))
        .find(Boolean) ?? null
      const coverPath = [
        ...coverFileNames.map(fileName => directoryFiles.get(fileName)),
        ...['.jpg', '.jpeg', '.png', '.webp'].map(extension => directoryFiles.get(`${normalizedTitle}${extension}`)),
      ].find(Boolean) ?? null
      const videoPath = videoExtensions
        .map(extension => directoryFiles.get(`${normalizedTitle}${extension}`))
        .find(Boolean) ?? null
      let fileSize = 0
      try {
        fileSize = fs.statSync(audioPath).size
      } catch {
        // A disappearing file should not break the rest of the scan.
      }

      const indexed = await extractIndexMetadata(audioPath)
      completed += 1
      if (completed % 20 === 0 || completed === audioFiles.length) win?.webContents.send('scan-progress', { completed, total: audioFiles.length, phase: 'scanning', rootPath })
      return {
        id: audioPath.toLocaleLowerCase(),
        title: indexed.title || title,
        audioPath,
        lyricPath,
        album: indexed.album || path.basename(directory),
        artist: indexed.artist,
        albumArtist: indexed.albumArtist,
        year: indexed.year,
        trackNumber: indexed.trackNumber,
        discNumber: indexed.discNumber,
        duration: indexed.duration,
        relativePath: path.relative(rootPath, audioPath),
        coverPath: indexed.embeddedCoverPath || coverPath,
        videoPath,
        fileSize,
        format: path.extname(audioPath).slice(1).toLocaleUpperCase(),
        lossless: indexed.lossless ?? (['.flac', '.wav', '.aiff', '.aif', '.alac'].includes(path.extname(audioPath).toLocaleLowerCase()) ? true : null),
        genre: indexed.genre,
        isDuplicate: false,
      }
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, undefined, {
      numeric: true,
      sensitivity: 'base',
    }))

  const duplicateKeys = new Map<string, number>()
  for (const item of items) {
    const key = `${item.title.toLocaleLowerCase()}|${item.fileSize}`
    duplicateKeys.set(key, (duplicateKeys.get(key) ?? 0) + 1)
  }
  for (const item of items) {
    item.possibleDuplicate = (duplicateKeys.get(`${item.title.toLocaleLowerCase()}|${item.fileSize}`) ?? 0) > 1
  }

  const hydratedItems = withStoredTrackState(items)
  win?.webContents.send('scan-progress', { completed: hydratedItems.length, total: audioFiles.length, phase: 'complete', rootPath })
  return { rootPath, rootPaths: [rootPath], items: hydratedItems, scanId: currentScanId, progress: { completed: hydratedItems.length, total: audioFiles.length, phase: 'complete' } }
}

let libraryCache: LibraryScanResult | null = null
/**
 * Forget everything cached about what is on disk.
 *
 * Two caches describe the same thing from different angles: the library scan,
 * and the downloader's index of songs you already have. Moving, deleting or
 * retagging files invalidates both, and letting them drift apart is how you end
 * up downloading a song the app can already see.
 */
function forgetLibrary() {
  libraryCache = null
  downloader?.invalidateLibraryIndex()
}
let activeScan: Promise<LibraryScanResult> | null = null
async function scanAllLibraries(rootPaths: string[]): Promise<LibraryScanResult> {
  if (activeScan) await activeScan
  activeScan = scanAllLibrariesImpl(rootPaths)
  try { libraryCache = await activeScan; return libraryCache } finally { activeScan = null }
}
async function scanAllLibrariesImpl(rootPaths: string[]): Promise<LibraryScanResult> {
  const validRoots = rootPaths.filter(rootPath => rootPath && fs.existsSync(rootPath))
  if (!validRoots.length) return { rootPath: null, rootPaths, items: [], error: rootPaths.length ? 'One or more saved music folders are no longer available.' : undefined }
  const results = await mapLimited(validRoots, 1, rootPath => scanLibrary(rootPath))
  const items = Array.from(new Map(results.flatMap(result => result.items).map(item => [item.id, item])).values())
  const duplicateKeys = new Map<string, number>()
  for (const item of items) {
    const key = `${item.title.toLocaleLowerCase()}|${item.fileSize}`
    duplicateKeys.set(key, (duplicateKeys.get(key) ?? 0) + 1)
  }
  const markedItems = items.map(item => ({
    ...item,
    possibleDuplicate: (duplicateKeys.get(`${item.title.toLocaleLowerCase()}|${item.fileSize}`) ?? 0) > 1,
  }))
  return { rootPath: validRoots[0], rootPaths, items: markedItems, scanId: `scan-${Date.now()}-${++scanId}`, progress: { completed: markedItems.length, total: markedItems.length, phase: 'complete' as const } }
}

function saveLibraryRoot(rootPath: string) {
  getStateStore().update(state => {
    state.libraryRoots = Array.from(new Set([rootPath, ...state.libraryRoots]))
  })
}

function readSavedLibraryRoots() {
  return getStateStore().get().libraryRoots
}

function watchLibrary(_rootPath: string | null) {
  const roots = readSavedLibraryRoots()
  for (const [root, watcher] of libraryWatchers) if (!roots.includes(root)) { watcher.close(); libraryWatchers.delete(root) }
  if (smokeTestScreenshot) return
  for (const root of roots) {
    if (libraryWatchers.has(root) || !fs.existsSync(root)) continue
    try {
      libraryWatchers.set(root, fs.watch(root, { recursive: true }, (_event, name) => {
        if (name && /(?:lyrigen-writing|\.tmp|\.bak|lyrigen-backup)$/.test(String(name))) return
        if (libraryWatchTimer) clearTimeout(libraryWatchTimer)
        libraryWatchTimer = setTimeout(() => {
          void scanAllLibraries(readSavedLibraryRoots()).then(result => win?.webContents.send('library-updated', result)).catch(console.error)
        }, 1500)
      }))
    } catch (error) { console.warn('Folder watch unavailable', error) }
  }
}

function sendPlayerCommand(command: 'play-pause' | 'next' | 'previous' | 'mute') {
  win?.webContents.send('player-command', command)
}

function buildTrayMenu() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Lyrigen', click: () => { win?.show(); win?.focus() } },
    { type: 'separator' },
    { label: isPlaying ? 'Pause' : 'Play', click: () => sendPlayerCommand('play-pause') },
    { label: 'Previous Track', click: () => sendPlayerCommand('previous') },
    { label: 'Next Track', click: () => sendPlayerCommand('next') },
    { type: 'separator' },
    { label: 'Quit Lyrigen', click: () => app.quit() },
  ]))
}

function createTray() {
  if (smokeTestScreenshot || tray) return
  const image = nativeImage.createFromPath(getIconPath()).resize({ width: 20, height: 20 })
  if (image.isEmpty()) return
  tray = new Tray(image)
  tray.setToolTip('Lyrigen')
  tray.on('double-click', () => { win?.show(); win?.focus() })
  buildTrayMenu()
}

function registerMediaShortcuts() {
  if (smokeTestScreenshot) return
  const registrations: Array<[Electron.Accelerator, Parameters<typeof sendPlayerCommand>[0]]> = [
    ['MediaPlayPause', 'play-pause'],
    ['MediaNextTrack', 'next'],
    ['MediaPreviousTrack', 'previous'],
  ]
  for (const [accelerator, command] of registrations) {
    try {
      globalShortcut.register(accelerator, () => sendPlayerCommand(command))
    } catch (error) {
      console.warn(`Could not register ${accelerator}`, error)
    }
  }
}


/**
 * Keep a window inside the screen's *work area* — the desktop minus the
 * taskbar. A frameless window is not given the usual shell treatment, so
 * without this it happily sizes itself over the taskbar and the bottom of the
 * app becomes unreachable.
 */
function clampToWorkArea(bounds: Electron.Rectangle): Electron.Rectangle {
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.max(880, Math.min(bounds.width, area.width))
  const height = Math.max(600, Math.min(bounds.height, area.height))
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 880,
    minHeight: 600,
    frame: false,
    backgroundColor: '#120f18',
    icon: getIconPath(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  win.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[renderer] ${message}`)
  })

  // A frameless window's own maximize can spill past the taskbar, so pin it
  // to the work area instead.
  win.on('maximize', () => { if (win) win.setBounds(screen.getDisplayMatching(win.getBounds()).workArea) })
  win.on('unmaximize', () => { if (win) win.setBounds(clampToWorkArea(win.getBounds())) })

  win.once('ready-to-show', () => {
    if (!win || smokeTestScreenshot) return
    const saved = getStateStore().get().windowBounds
    // Reopen where it was left rather than maximised every time.
    if (saved?.maximized) win.setBounds(screen.getDisplayMatching(win.getBounds()).workArea)
    else if (saved) win.setBounds(clampToWorkArea(saved))
    else win.setBounds(clampToWorkArea(win.getBounds()))
    win.show()
  })

  // Remember size and position, debounced so dragging does not thrash the disk.
  let saveTimer: NodeJS.Timeout | null = null
  const rememberBounds = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized()) return
      const maximized = win.isMaximized()
      const bounds = win.getBounds()
      getStateStore().update(state => { state.windowBounds = { ...bounds, maximized } })
    }, 600)
  }
  win.on('resize', rememberBounds)
  win.on('move', rememberBounds)

  win.webContents.once('did-finish-load', async () => {
    if (!win || !smokeTestScreenshot) return

    try {
      await new Promise(resolve => setTimeout(resolve, smokeLibraryRoot ? 2500 : 750))
      if (shouldOpenConverter) {
        await win.webContents.executeJavaScript("document.querySelector('.sidebar-section button:nth-of-type(2)')?.click()")
        await new Promise(resolve => setTimeout(resolve, 350))
        if (shouldSmokeConverterSample) {
          await win.webContents.executeJavaScript(`(async () => {
            const input = document.querySelector('.lrc-dropzone input')
            if (!(input instanceof HTMLInputElement)) return { loaded: false, reason: 'file input missing' }
            const transfer = new DataTransfer()
            transfer.items.add(new File(['[ti:Smoke Test]\\n[ar:Lyrigen]\\n[00:01.00]First line\\n[00:04.50]Second line'], 'smoke-test.lrc', { type: 'text/plain' }))
            input.files = transfer.files
            input.dispatchEvent(new Event('change', { bubbles: true }))
            await new Promise(resolve => setTimeout(resolve, 350))
            return { loaded: Boolean(document.querySelector('.conversion-list-row')), preview: document.querySelector('.ttml-preview')?.textContent || '' }
          })()`)
        }
        await new Promise(resolve => setTimeout(resolve, 250))
        const converterDebug = await win.webContents.executeJavaScript(`(() => ({
          hasDropzone: Boolean(document.querySelector('.lrc-dropzone')),
          hasPreview: Boolean(document.querySelector('.converter-preview-panel')),
          loadedFiles: document.querySelectorAll('.conversion-list-row').length,
          previewText: document.querySelector('.ttml-preview')?.textContent || ''
        }))()`)
        console.log(`[smoke-converter] ${JSON.stringify(converterDebug)}`)
        win.showInactive()
        win.webContents.invalidate()
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      if (shouldOpenFirstTrack || smokeTrackTitle) {
        // The normal app opens on its lightweight Home dashboard. Move into
        // the library before selecting a track in smoke verification.
        await win.webContents.executeJavaScript("document.querySelector('.nav[aria-label=\\\"Library\\\"] button:nth-child(2)')?.click()")
        await new Promise(resolve => setTimeout(resolve, 250))
        const selectorScript = smokeTrackTitle
          ? `Array.from(document.querySelectorAll('[data-track-index]')).find(element => element.textContent?.toLocaleLowerCase().includes(${JSON.stringify(smokeTrackTitle.toLocaleLowerCase())}))?.click()`
          : "document.querySelector('[data-track-index=\"0\"]')?.click()"
        await win.webContents.executeJavaScript(selectorScript)
        await new Promise(resolve => setTimeout(resolve, 1500))
        if (shouldOpenSettings) {
          await win.webContents.executeJavaScript("document.querySelector('[aria-label=\"Sound and lyrics settings\"]')?.click()")
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        if (shouldOpenMini) {
          await win.webContents.executeJavaScript("document.querySelector('[aria-label=\"Mini player\"]')?.click()")
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        if (shouldSmokeVisualModes) {
          await win.webContents.executeJavaScript("document.querySelector('[aria-label=\"Sound and lyrics settings\"]')?.click()")
          await new Promise(resolve => setTimeout(resolve, 250))
          const visualModeCheck = await win.webContents.executeJavaScript(`(async () => {
            const select = document.querySelector('select[aria-label="Visual mode"]')
            if (!select) return { modes: [], reason: 'visual mode selector missing' }
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
            const modes = ['lyrics', 'cover', 'vinyl', 'visualizer']
            const results = []
            for (const mode of modes) {
              setter?.call(select, mode)
              select.dispatchEvent(new Event('change', { bubbles: true }))
              await new Promise(resolve => setTimeout(resolve, 60))
              results.push({ mode, className: document.querySelector('.player-shell')?.className || '' })
            }
            return { modes: results }
          })()`)
          console.log(`[smoke-visual-modes] ${JSON.stringify(visualModeCheck)}`)
        }
        win.showInactive()
        win.webContents.invalidate()
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      if (shouldSmokeScroll && (shouldOpenFirstTrack || smokeTrackTitle)) {
        const scrollCheck = await win.webContents.executeJavaScript(`(async () => {
          const root = document.querySelector('.amll-lyric-player')
          if (!root) return { changed: false, reason: 'no lyric player' }
          const lines = () => Array.from(root.querySelectorAll('[class*="lyricLineWrapper"]')).slice(0, 4).map(node => node.style.transform)
          const before = lines()
          root.dispatchEvent(new WheelEvent('wheel', { deltaY: 180, bubbles: true, cancelable: true }))
          await new Promise(resolve => setTimeout(resolve, 180))
          const after = lines()
          return { changed: JSON.stringify(before) !== JSON.stringify(after), before, after }
        })()`)
        console.log(`[smoke-scroll] ${JSON.stringify(scrollCheck)}`)
      }
      if (shouldSmokeBackToLibrary && (shouldOpenFirstTrack || smokeTrackTitle)) {
        const playbackBefore = await win.webContents.executeJavaScript(`(() => {
          const audio = document.querySelector('audio:not(.track-preloader)')
          if (!audio) return null
          audio.dataset.smokePlaybackMarker = 'preserve'
          return { time: audio.currentTime, paused: audio.paused }
        })()`)
        await win.webContents.executeJavaScript("document.querySelector('.back-button')?.click()")
        await new Promise(resolve => setTimeout(resolve, 500))
        const miniCheck = await win.webContents.executeJavaScript(`(() => {
          const root = document.getElementById('root')
          const mini = document.querySelector('.mini-player.in-app-mini')
          const audio = document.querySelector('audio:not(.track-preloader)')
          const bounds = mini?.getBoundingClientRect()
          return {
            hasLibrary: Boolean(root?.querySelector('[aria-label="Library"]')),
            hasMiniPlayer: Boolean(mini),
            hasNowPlaying: (root?.innerText || '').includes('NOW PLAYING'),
            playbackContinues: Boolean(audio && audio.dataset.smokePlaybackMarker === 'preserve' && !audio.paused),
            timeAfter: audio?.currentTime ?? null,
            miniBounds: bounds ? { width: Math.round(bounds.width), height: Math.round(bounds.height), centerDelta: Math.round(Math.abs((bounds.left + bounds.width / 2) - window.innerWidth / 2)) } : null
          }
        })()`)
        console.log(`[smoke-back-to-library] ${JSON.stringify({ before: playbackBefore, ...miniCheck })}`)
      }
      const rootText = await win.webContents.executeJavaScript("document.getElementById('root')?.innerText || ''")
      const lyricDebug = await win.webContents.executeJavaScript(`(() => {
        const element = document.querySelector('.amll-lyric-player')
        if (!element) return null
        const bounds = element.getBoundingClientRect()
        return { children: element.childElementCount, text: element.textContent?.slice(0, 160), width: bounds.width, height: bounds.height }
      })()`)
      const image = await win.capturePage()
      fs.writeFileSync(path.resolve(smokeTestScreenshot), image.toPNG())
      console.log(`[smoke-test] ${rootText.replace(/\s+/g, ' ').trim()}`)
      console.log(`[smoke-test-lyrics] ${JSON.stringify(lyricDebug)}`)
      app.exit(rootText.length > 40 ? 0 : 1)
    } catch (error) {
      console.error('[smoke-test] Failed to verify renderer', error)
      app.exit(1)
    }
  })

  if (VITE_DEV_SERVER_URL) {
    void win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    const indexPath = path.join(process.env.DIST || path.join(__dirname, '../dist'), 'index.html')
    void win.loadFile(indexPath)
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
  win = null
})

app.whenReady().then(() => {
  console.log(`[graphics] requested mode: ${graphicsMode}`)
  reportGraphicsStatus()
  createWindow()
  createTray()
  registerMediaShortcuts()
  getDownloader().syncInboxWatcher()
  void pruneThumbnailCache().catch(() => undefined)
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
  else { win?.show(); win?.focus() }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  libraryWatchers.forEach(watcher => watcher.close())
  if (libraryWatchTimer) clearTimeout(libraryWatchTimer)
  stopPreview()
  stopPotProvider()
  downloader?.dispose()
})

// ---------------------------------------------------------------------------
// Downloads (yt-dlp + ffmpeg), organiser, and the Lyrics Finder
// ---------------------------------------------------------------------------

let downloader: Downloader | null = null
function getDownloader() {
  if (!downloader) {
    downloader = new Downloader(app.getPath('userData'))
    setToolsFolder(downloader.settings.toolsFolder)
    setPotProviderFolder(downloader.settings.potProviderFolder)
    setBetterLyricsApiKey(downloader.settings.betterLyricsApiKey)
    downloader.setKnownArtistsProvider(() => (libraryCache?.items ?? []).flatMap(item => [item.artist, item.albumArtist]).filter((name): name is string => Boolean(name)))
    // Everywhere a song might already be. The roots cover the folders a person
    // pointed Lyrigen at; the scan results add the artist and length that only
    // reading the tags can give, which is what makes a match trustworthy when
    // the YouTube title calls the uploader the artist.
    downloader.setLibraryFoldersProvider(() => readSavedLibraryRoots())
    downloader.setLibraryEntriesProvider(() => (libraryCache?.items ?? []).map(item => ({ audioPath: item.audioPath, title: item.title, artist: item.artist ?? item.albumArtist, duration: item.duration })))
    downloader.setMusicBrainzLookup(request => lookupTrackMetadata(request))
    downloader.subscribe((event, payload) => {
      win?.webContents.send(event === 'job' ? 'download-job' : event === 'jobs' ? 'download-jobs' : event === 'inbox' ? 'inbox-progress' : 'organize-progress', payload)
      // A finished download or organise pass changes the library on disk; the folder watcher usually catches it, but not when the destination is outside every library root.
      if (event === 'job' && (payload as { status?: string }).status === 'done') { libraryCache = null }
    })
  }
  return downloader
}

ipcMain.handle('tools-status', () => toolsStatus())
ipcMain.handle('pot-status', () => potStatus())
// Only ever reached because Premium audio was switched on in settings, which is
// the consent for Lyrigen to run a service it did not install.
ipcMain.handle('start-pot-provider', () => startPotProvider())
ipcMain.handle('choose-tools-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Folder containing yt-dlp.exe and ffmpeg.exe' })
  if (result.canceled || !result.filePaths[0]) return toolsStatus()
  getDownloader().updateSettings({ toolsFolder: result.filePaths[0] })
  setToolsFolder(result.filePaths[0])
  return toolsStatus()
})
ipcMain.handle('update-yt-dlp', () => updateYtDlp().catch(error => ({ ok: false, message: error instanceof Error ? error.message : String(error) })))
ipcMain.handle('get-download-settings', () => ({ settings: getDownloader().settings, presets: PATH_PRESETS }))
/**
 * Which configured folders and files are no longer there.
 *
 * Settings point at paths, and paths outlive nothing. A library root that was
 * renamed, a destination on a drive that is unplugged, a cookies.txt that the
 * browser overwrote with a fresh export under a new name — each one makes
 * Lyrigen quietly behave as though the library were empty, which looks exactly
 * like a broken duplicate check. Saying so is the whole fix.
 */
ipcMain.handle('check-download-paths', () => {
  const settings = getDownloader().settings
  const missing: Array<{ kind: 'destination' | 'library' | 'cookies'; path: string }> = []
  if (settings.destination && !fs.existsSync(settings.destination)) missing.push({ kind: 'destination', path: settings.destination })
  for (const root of readSavedLibraryRoots()) if (!fs.existsSync(root)) missing.push({ kind: 'library', path: root })
  if (settings.cookieFile && !fs.existsSync(settings.cookieFile)) missing.push({ kind: 'cookies', path: settings.cookieFile })
  return missing
})
ipcMain.handle('update-download-settings', (_event, patch: Partial<DownloadSettings>) => {
  const settings = getDownloader().updateSettings(patch)
  if ('toolsFolder' in patch) setToolsFolder(settings.toolsFolder)
  if ('betterLyricsApiKey' in patch) setBetterLyricsApiKey(settings.betterLyricsApiKey)
  return settings
})
ipcMain.handle('choose-download-folder', async (_event, current?: string) => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: current || undefined })
  return result.canceled ? null : result.filePaths[0] ?? null
})
ipcMain.handle('inspect-download-url', (_event, url: string, options?: Partial<DownloadOptions>) => getDownloader().inspect(url, options))
ipcMain.handle('enqueue-downloads', (_event, items: Array<{ url: string; videoId?: string | null; metadata?: SongMetadata | null; info?: unknown }>, options?: Partial<DownloadOptions>) => getDownloader().enqueue(items as Parameters<Downloader['enqueue']>[0], options))
ipcMain.handle('list-downloads', () => getDownloader().jobs)
ipcMain.handle('cancel-download', (_event, id: string) => getDownloader().cancel(id))
ipcMain.handle('retry-download', (_event, id: string) => getDownloader().retry(id))
ipcMain.handle('remove-download', (_event, id: string) => getDownloader().remove(id))
ipcMain.handle('clear-finished-downloads', () => getDownloader().clearFinished())
ipcMain.handle('set-downloads-paused', (_event, paused: boolean) => getDownloader().setPaused(paused))
ipcMain.handle('downloads-paused', () => getDownloader().isPaused)
ipcMain.handle('update-download-metadata', (_event, id: string, metadata: SongMetadata) => getDownloader().updateJobMetadata(id, metadata))
ipcMain.handle('preview-download-url', async (_event, url: string) => {
  try { await previewUrl(url); return { playing: true } } catch (error) { return { playing: false, message: error instanceof Error ? error.message : String(error) } }
})
ipcMain.handle('stop-preview', () => { stopPreview(); return { playing: isPreviewing() } })

ipcMain.handle('choose-organize-sources', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'multiSelections'], title: 'Folders to organise' })
  return result.canceled ? [] : result.filePaths
})
ipcMain.handle('plan-organize', (_event, inputs: string[], options: { destination: string; pathTemplate: string; includeCleanFiles: boolean }) =>
  getDownloader().planOrganize(inputs, options, (completed, total) => win?.webContents.send('organize-progress', { phase: 'planning', completed, total })))
ipcMain.handle('replan-organize-item', (_event, item: OrganizePlanItem, options: { destination: string; pathTemplate: string }) => getDownloader().replan(item, options))
ipcMain.handle('apply-organize', async (_event, items: OrganizePlanItem[], options: OrganizeApplyOptions) => {
  const result = await getDownloader().applyOrganize(items, options, progress => win?.webContents.send('organize-progress', { phase: 'applying', ...progress }))
  forgetLibrary()
  win?.webContents.send('library-updated', await scanAllLibraries(readSavedLibraryRoots()))
  return result
})
ipcMain.handle('undo-organize', async () => {
  const result = await getDownloader().undoOrganize()
  forgetLibrary()
  win?.webContents.send('library-updated', await scanAllLibraries(readSavedLibraryRoots()))
  return result
})
ipcMain.handle('can-undo-organize', () => getDownloader().canUndoOrganize)

ipcMain.handle('search-lyric-candidates', (_event, request: LyricLookupRequest) => searchLyricCandidates(request))
ipcMain.handle('fetch-lyric-candidate', async (_event, candidate: LyricCandidate, options?: { retimeToDuration?: number | null }) => {
  const fetched = await fetchLyricCandidate(candidate)
  if (!fetched) return null
  let content = fetched.content, retimed = false
  if (options?.retimeToDuration && candidate.duration && fetched.format !== 'plain') {
    const ratio = options.retimeToDuration / candidate.duration
    if (Math.abs(ratio - 1) > 0.03 && ratio > 0.5 && ratio < 2) { content = retimeLyrics(content, fetched.format, ratio); retimed = true }
  }
  return { content, format: fetched.format, retimed }
})
/** Save chosen lyrics beside a song with the matching extension for the format. */
ipcMain.handle('save-lyric-file', async (_event, audioPath: string, content: string, format: 'ttml' | 'lrc' | 'plain', options?: { overwrite?: boolean; embed?: boolean }) => {
  try {
    if (!audioExtensions.has(path.extname(audioPath).toLocaleLowerCase()) || !fs.existsSync(audioPath)) return { saved: false, message: 'The audio file is unavailable.' }
    const targetPath = path.join(path.dirname(audioPath), `${path.parse(audioPath).name}${lyricExtension(format)}`)
    if (fs.existsSync(targetPath) && !options?.overwrite) return { saved: false, path: targetPath, message: 'A lyric file already exists. Choose overwrite to replace it.' }
    if (fs.existsSync(targetPath)) await backupFile(targetPath)
    await fs.promises.writeFile(targetPath, content, 'utf8')
    const embedded = options?.embed ? await getDownloader().embedLyricsInto(audioPath, content, format) : null
    forgetLibrary()
    return { saved: true, path: targetPath, embedded: embedded === 'id3' || embedded === 'tag' }
  } catch (error) {
    console.error('Unable to save lyrics', error)
    return { saved: false, message: 'Lyrigen could not save the lyric file.' }
  }
})
/** Bulk: auto-pick the best lyrics for each track and save beside it. Streams per-track progress. */
ipcMain.handle('fetch-lyrics-for-tracks', async (_event, tracks: Array<{ id: string; audioPath: string; title: string; artist: string | null; album: string | null; duration: number | null }>, options?: { overwrite?: boolean; retime?: boolean; embed?: boolean }) => {
  const results: Array<{ id: string; saved: boolean; source: string | null; path: string | null; message: string | null; retimed: boolean; embedded: boolean }> = []
  for (const track of tracks) {
    win?.webContents.send('lyrics-batch-progress', { id: track.id, status: 'searching' })
    try {
      const nameInfo = await getDownloader().metadataFromFile(track.audioPath)
      const variant = nameInfo.metadata.variant
      const lyrics = await findBestLyrics({ trackName: nameInfo.metadata.title || track.title, artistName: nameInfo.metadata.artist || track.artist, albumName: track.album, duration: variant ? null : track.duration, videoId: nameInfo.videoId })
      const saved = await getDownloader().saveLyricsBeside(track.audioPath, lyrics, { fileDuration: track.duration ?? nameInfo.duration, allowRetime: Boolean(options?.retime) && Boolean(variant), overwrite: options?.overwrite, embed: options?.embed })
      const entry = { id: track.id, saved: Boolean(saved.path && saved.source !== 'existing file'), source: saved.source, path: saved.path, message: lyrics.found ? null : (lyrics.message ?? 'No match'), retimed: saved.retimed, embedded: saved.embedded === 'id3' || saved.embedded === 'tag' }
      results.push(entry)
      win?.webContents.send('lyrics-batch-progress', { ...entry, status: entry.saved ? 'saved' : 'missed' })
    } catch (error) {
      const entry = { id: track.id, saved: false, source: null, path: null, message: error instanceof Error ? error.message : String(error), retimed: false, embedded: false }
      results.push(entry)
      win?.webContents.send('lyrics-batch-progress', { ...entry, status: 'missed' })
    }
  }
  forgetLibrary()
  win?.webContents.send('library-updated', await scanAllLibraries(readSavedLibraryRoots()))
  return results
})

ipcMain.handle('select-library', async (): Promise<LibraryScanResult> => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) {
    return scanAllLibraries(smokeLibraryRoot ? [smokeLibraryRoot] : readSavedLibraryRoots())
  }

  const folderPath = result.filePaths[0]
  try {
    saveLibraryRoot(folderPath)
    watchLibrary(folderPath)
    return await scanAllLibraries(readSavedLibraryRoots())
  } catch (error) {
    console.error('Unable to read selected folder', error)
    return { rootPath: folderPath, items: [], error: 'Lyrigen could not read that folder.' }
  }
})

ipcMain.handle('get-library', () => {
  const roots = smokeLibraryRoot ? [smokeLibraryRoot] : readSavedLibraryRoots()
  const rootPath = roots[0] ?? null
  watchLibrary(rootPath)
  return libraryCache && !activeScan ? { ...libraryCache, items: withStoredTrackState(libraryCache.items) } : activeScan || scanAllLibraries(roots)
})
ipcMain.handle('rescan-library', () => scanAllLibraries(smokeLibraryRoot ? [smokeLibraryRoot] : readSavedLibraryRoots()))

ipcMain.handle('get-library-roots', () => getStateStore().get().libraryRoots)
ipcMain.handle('add-library-root', async (): Promise<LibraryScanResult> => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths[0]) return scanAllLibraries(readSavedLibraryRoots())
  saveLibraryRoot(result.filePaths[0])
  watchLibrary(result.filePaths[0])
  return scanAllLibraries(readSavedLibraryRoots())
})
ipcMain.handle('remove-library-root', (_event, rootPath: string) => {
  getStateStore().update(state => { state.libraryRoots = state.libraryRoots.filter(root => root !== rootPath) })
  return scanAllLibraries(readSavedLibraryRoots())
})

async function currentLibraryItems() {
  const roots = smokeLibraryRoot ? [smokeLibraryRoot] : readSavedLibraryRoots()
  const result = activeScan ? await activeScan : libraryCache || await scanAllLibraries(roots)
  return withStoredTrackState(result.items)
}

async function currentLibraryStats() {
  const items = await currentLibraryItems()
  const state = getStateStore().get()
  const albums = new Set(items.map(item => `${item.album.toLocaleLowerCase()}|${item.artist || ''}`))
  const artists = new Set(items.map(item => item.artist || 'Unknown artist'))
  const genres = new Set(items.map(item => item.genre).filter(Boolean))
  const withStats = withStoredTrackState(items)
  const recent = [...withStats].filter(item => item.lastPlayed).sort((left, right) => String(right.lastPlayed).localeCompare(String(left.lastPlayed))).slice(0, 8)
  const mostPlayed = [...withStats].sort((left, right) => (right.playCount ?? 0) - (left.playCount ?? 0)).slice(0, 8)
  const needsAttention = withStats.filter(item => !item.lyricPath || !item.artist || item.possibleDuplicate).slice(0, 8)
  return {
    tracks: items.length,
    albums: albums.size,
    artists: artists.size,
    genres: genres.size,
    favorites: state.favorites.length,
    totalDuration: items.reduce((sum, item) => sum + (item.duration ?? 0), 0),
    recent,
    mostPlayed,
    needsAttention,
  }
}

ipcMain.handle('query-library', async (_event, rawQuery: { text?: string; genre?: string; album?: string; artist?: string; favorite?: boolean; lossless?: boolean; hasLyrics?: boolean; duplicate?: boolean }) => {
  const query = rawQuery || {}
  const text = normaliseSearchText(query.text || '')
  const items = withStoredTrackState(await currentLibraryItems())
  return items.filter(item => {
    const haystack = normaliseSearchText([item.title, item.artist, item.album, item.relativePath, item.genre].filter(Boolean).join(' '))
    if (text && !haystack.includes(text)) return false
    if (query.genre && item.genre !== query.genre) return false
    if (query.album && item.album !== query.album) return false
    if (query.artist && item.artist !== query.artist) return false
    if (query.favorite && !item.favorite) return false
    if (query.lossless && !item.lossless) return false
    if (query.hasLyrics && !item.lyricPath) return false
    if (query.duplicate && !item.possibleDuplicate) return false
    return true
  })
})

ipcMain.handle('get-library-stats', () => currentLibraryStats())
ipcMain.handle('get-playlists', () => getStateStore().get().playlists)
ipcMain.handle('create-playlist', (_event, name: string) => getStateStore().update(state => { state.playlists.push(createPlaylist(name)) }).playlists)
ipcMain.handle('rename-playlist', (_event, id: string, name: string) => getStateStore().update(state => {
  const playlist = state.playlists.find(item => item.id === id)
  if (playlist) { playlist.name = name.trim() || playlist.name; playlist.updatedAt = new Date().toISOString() }
}).playlists)
ipcMain.handle('delete-playlist', (_event, id: string) => getStateStore().update(state => { state.playlists = state.playlists.filter(item => item.id !== id) }).playlists)
ipcMain.handle('add-tracks-to-playlist', (_event, id: string, trackIds: string[]) => getStateStore().update(state => {
  const playlist = state.playlists.find(item => item.id === id)
  if (playlist) { playlist.trackIds = Array.from(new Set([...playlist.trackIds, ...trackIds])); playlist.updatedAt = new Date().toISOString() }
}).playlists)
ipcMain.handle('remove-tracks-from-playlist', (_event, id: string, trackIds: string[]) => getStateStore().update(state => {
  const remove = new Set(trackIds)
  const playlist = state.playlists.find(item => item.id === id)
  if (playlist) { playlist.trackIds = playlist.trackIds.filter(trackId => !remove.has(trackId)); playlist.updatedAt = new Date().toISOString() }
}).playlists)
ipcMain.handle('reorder-playlist', (_event, id: string, trackIds: string[]) => getStateStore().update(state => {
  const playlist = state.playlists.find(item => item.id === id)
  if (playlist) { playlist.trackIds = [...trackIds]; playlist.updatedAt = new Date().toISOString() }
}).playlists)

ipcMain.handle('get-queue-state', () => getStateStore().get().queue)
ipcMain.handle('update-queue-state', (_event, queue: QueueState) => getStateStore().update(state => {
  state.queue = { ...emptyQueue(), ...queue, upcomingTrackIds: [...new Set(queue.upcomingTrackIds)], historyTrackIds: [...new Set(queue.historyTrackIds)].slice(-100) }
}).queue)
ipcMain.handle('set-favorite', async (_event, trackId: string, favorite: boolean) => {
  getStateStore().update(state => { state.favorites = favorite ? Array.from(new Set([...state.favorites, trackId])) : state.favorites.filter(id => id !== trackId) })
  return currentLibraryStats()
})
ipcMain.handle('set-rating', async (_event, trackId: string, rating: number) => {
  getStateStore().update(state => { if (rating > 0) state.ratings[trackId] = Math.max(1, Math.min(5, Math.round(rating))); else delete state.ratings[trackId] })
  return currentLibraryStats()
})
ipcMain.handle('record-play', (_event, trackId: string, seconds?: number) => {
  getStateStore().update(state => {
    state.playHistory.push({ trackId, playedAt: new Date().toISOString(), seconds: Number.isFinite(seconds) ? Math.max(0, Math.round(seconds!)) : undefined })
    // A year's recap needs more than a few hundred entries. At roughly 80 bytes
    // each this is a couple of megabytes at the cap, which is fine on disk.
    state.playHistory = state.playHistory.slice(-20_000)
  })
})

/**
 * Listening recap for a window of time.
 *
 * Built from `playHistory` joined against the library, so it reflects what is
 * actually on disk now: a track that has been deleted stops skewing the totals.
 * `seconds` is the track's length when it was played, which counts a play as a
 * full listen — Lyrigen records one play per track per load, not per second, so
 * this is an honest approximation rather than measured playtime.
 */
ipcMain.handle('get-listening-recap', (_event, range: 'week' | 'month' | 'year' | 'all' = 'week'): ListeningRecap => {
  const state = getStateStore().get()
  const days = range === 'week' ? 7 : range === 'month' ? 30 : range === 'year' ? 365 : 0
  const since = days ? Date.now() - days * 86_400_000 : 0
  const byId = new Map((libraryCache?.items ?? []).map(item => [item.id, item]))

  const entries = state.playHistory.filter(entry => {
    const at = Date.parse(entry.playedAt)
    return Number.isFinite(at) && (!since || at >= since) && byId.has(entry.trackId)
  })

  const tally = <T,>(key: (entry: typeof entries[number]) => T | null) => {
    const counts = new Map<T, { plays: number; seconds: number }>()
    for (const entry of entries) {
      const value = key(entry)
      if (value === null || value === undefined || value === '') continue
      const bucket = counts.get(value) ?? { plays: 0, seconds: 0 }
      bucket.plays += 1
      bucket.seconds += entry.seconds ?? byId.get(entry.trackId)?.duration ?? 0
      counts.set(value, bucket)
    }
    return [...counts.entries()].sort((left, right) => right[1].plays - left[1].plays)
  }

  const seconds = entries.reduce((total, entry) => total + (entry.seconds ?? byId.get(entry.trackId)?.duration ?? 0), 0)
  // Artists are credited to the lead name, so "A, B" and "A" are one artist.
  const artists = tally(entry => primaryArtist(byId.get(entry.trackId)?.artist ?? null))
  const genres = tally(entry => byId.get(entry.trackId)?.genre ?? null)
  const tracks = tally(entry => entry.trackId)

  // Bucket so the chart stays legible: a year as 365 bars is sub-pixel and
  // reads as an empty axis. Days for short ranges, weeks for a year, months
  // for all time — never more than ~52 bars.
  const oldest = entries.length ? Math.min(...entries.map(entry => Date.parse(entry.playedAt))) : Date.now()
  const span = days || Math.max(1, Math.ceil((Date.now() - oldest) / 86_400_000))
  const bucketSize: ListeningRecap['bucketSize'] = span <= 31 ? 'day' : span <= 400 ? 'week' : 'month'
  const step = bucketSize === 'day' ? 1 : bucketSize === 'week' ? 7 : 30
  const count = Math.max(1, Math.min(Math.ceil(span / step), 52))

  const startOfBucket = (at: number) => {
    const offset = Math.floor((Date.now() - at) / (step * 86_400_000))
    return new Date(Date.now() - offset * step * 86_400_000).toISOString().slice(0, 10)
  }
  const bucketCounts = new Map<string, number>()
  for (const entry of entries) {
    const key = startOfBucket(Date.parse(entry.playedAt))
    bucketCounts.set(key, (bucketCounts.get(key) ?? 0) + 1)
  }
  const perDay: ListeningRecap['perDay'] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * step * 86_400_000).toISOString().slice(0, 10)
    perDay.push({ date, plays: bucketCounts.get(date) ?? 0 })
  }
  const peak = perDay.reduce<ListeningRecap['peakDay']>((best, day) => (!best || day.plays > best.plays ? day : best), null)

  return {
    range,
    plays: entries.length,
    seconds,
    distinctTracks: tracks.length,
    distinctArtists: artists.length,
    topTracks: tracks.slice(0, 8).map(([id, value]) => ({
      id,
      title: byId.get(id)?.title ?? 'Unknown',
      artist: byId.get(id)?.artist ?? null,
      plays: value.plays,
      seconds: value.seconds,
    })),
    topArtists: artists.slice(0, 8).map(([name, value]) => ({ name: String(name), plays: value.plays, seconds: value.seconds })),
    topGenres: genres.slice(0, 6).map(([name, value]) => ({ name: String(name), plays: value.plays })),
    perDay,
    bucketSize,
    peakDay: peak && peak.plays > 0 ? peak : null,
  }
})
// Kept separate from record-play so periodic "where was I" saves during
// playback never inflate play-count/recently-played stats.
ipcMain.handle('save-resume-position', (_event, trackId: string, positionMs: number) => {
  getStateStore().update(state => { state.resumePositions[trackId] = Math.max(0, Math.round(positionMs)) })
})
ipcMain.handle('get-resume-position', (_event, trackId: string) => getStateStore().get().resumePositions[trackId] ?? null)
/**
 * Duplicate cleanup.
 *
 * Grouping used to be title plus exact file size, which only ever caught a
 * literal copy of a file. The same song downloaded twice — different day,
 * different upload, different bitrate — sailed past it, and that is exactly
 * what a library assembled from YouTube fills up with. So a group is now the
 * same video id, or the same artist + song + edit, with lengths that agree;
 * "(Sped Up)" stays a different song from the original, on purpose.
 *
 * One file in each group is always kept, and the choice is not arbitrary: a
 * copy with lyrics beside it wins, then the bigger file (which on two copies of
 * one song means the better bitrate), then the shorter path, which favours the
 * organised location over a loose download folder. Everything else goes to the
 * Recycle Bin rather than being unlinked, so a wrong call costs a restore
 * instead of the file.
 */
interface DuplicateGroup {
  key: string
  title: string
  keep: { path: string; reason: string }
  remove: Array<{ path: string; size: number }>
}

/** Two recordings this far apart in length are different versions, not copies. */
const DUPLICATE_LENGTH_TOLERANCE = 10

function planDuplicateCleanup(): DuplicateGroup[] {
  const items = libraryCache?.items ?? []
  const groups = new Map<string, LibraryTrack[]>()
  for (const item of items) {
    const identity = songIdentity(item.audioPath, item.title, item.artist ?? item.albumArtist)
    const key = identity.videoId ? `v:${identity.videoId}` : `s:${identity.song}`
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const plan: DuplicateGroup[] = []
  for (const [key, tracks] of groups) {
    if (tracks.length < 2) continue
    // A group keyed on the song name still has to agree on length, or a radio
    // edit and an extended mix would look like one file too many.
    for (const [index, bucket] of bucketByLength(tracks).entries()) {
      if (bucket.length < 2) continue
      const ranked = [...bucket].sort((left, right) => {
        const lyrics = Number(Boolean(right.lyricPath)) - Number(Boolean(left.lyricPath))
        if (lyrics) return lyrics
        const size = right.fileSize - left.fileSize
        if (size) return size
        return left.audioPath.length - right.audioPath.length
      })
      const [keep, ...rest] = ranked
      const bigger = rest.every(track => track.fileSize < keep.fileSize)
      plan.push({
        key: `${key}#${index}`,
        title: keep.artist ? `${keep.artist} — ${keep.title}` : keep.title,
        keep: { path: keep.audioPath, reason: keep.lyricPath ? 'has lyrics beside it' : bigger ? 'biggest file' : 'shortest path' },
        remove: rest.map(track => ({ path: track.audioPath, size: track.fileSize })),
      })
    }
  }
  return plan.sort((left, right) => right.remove.length - left.remove.length)
}

/** Split a group into runs of tracks that are the same length. */
function bucketByLength(tracks: LibraryTrack[]) {
  const buckets: LibraryTrack[][] = []
  for (const track of [...tracks].sort((left, right) => (left.duration ?? 0) - (right.duration ?? 0))) {
    const bucket = buckets.find(candidate => candidate.some(other =>
      track.duration == null || other.duration == null || Math.abs(other.duration - track.duration) <= DUPLICATE_LENGTH_TOLERANCE))
    if (bucket) bucket.push(track); else buckets.push([track])
  }
  return buckets
}

ipcMain.handle('plan-duplicate-cleanup', async () => {
  // Opening this straight after launch used to report a tidy library, because
  // nothing had been scanned yet and an empty list looks the same as no
  // duplicates. Scan first, then answer.
  if (!libraryCache) await scanAllLibraries(readSavedLibraryRoots())
  return planDuplicateCleanup()
})

/** Send the chosen files to the Recycle Bin. Never unlinks. */
ipcMain.handle('trash-files', async (_event, paths: string[]) => {
  let trashed = 0
  const failed: string[] = []
  for (const target of paths) {
    try {
      await shell.trashItem(target)
      trashed += 1
    } catch (error) {
      console.warn('Could not trash', target, error)
      failed.push(path.basename(target))
    }
  }
  forgetLibrary()
  return { trashed, failed }
})

ipcMain.handle('get-settings', () => getStateStore().get().settings)

/** Say whether a cookies.txt actually holds a YouTube login, before yt-dlp tries it. */
ipcMain.handle('inspect-cookies-file', (_event, filePath: string) => inspectCookiesFile(filePath))

/** Pick a cookies.txt, so nobody has to paste a path by hand. */
ipcMain.handle('choose-cookies-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose your exported cookies.txt',
    properties: ['openFile'],
    filters: [{ name: 'Cookies', extensions: ['txt'] }],
  })
  if (result.canceled || !result.filePaths[0]) return null
  return { path: result.filePaths[0], ...inspectCookiesFile(result.filePaths[0]) }
})

/**
 * Maintenance actions for the Settings screen.
 *
 * Each one is destructive in a small, named way, so the UI asks first and the
 * handler just does what it says. Nothing here touches your audio files.
 */
ipcMain.handle('clear-play-history', () => {
  const before = getStateStore().get().playHistory.length
  getStateStore().update(state => { state.playHistory = [] })
  forgetLibrary()
  return { cleared: before }
})

ipcMain.handle('clear-resume-positions', () => {
  const before = Object.keys(getStateStore().get().resumePositions).length
  getStateStore().update(state => { state.resumePositions = {} })
  return { cleared: before }
})

/** Forget the saved window size so the next launch starts fresh. */
ipcMain.handle('reset-window-bounds', () => {
  getStateStore().update(state => { delete state.windowBounds })
  if (win) win.setBounds(screen.getDisplayMatching(win.getBounds()).workArea)
  return true
})

/** Where the app keeps its state, for anyone who wants to look or back it up. */
ipcMain.handle('open-data-folder', async () => {
  await shell.openPath(app.getPath('userData'))
  return app.getPath('userData')
})

ipcMain.handle('get-app-info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  dataFolder: app.getPath('userData'),
  platform: process.platform,
}))

ipcMain.handle('update-settings', (_event, settings: Record<string, unknown>) => getStateStore().update(state => { state.settings = { ...state.settings, ...settings } }).settings)
ipcMain.handle('import-legacy-state', (_event, legacy: { rootPath?: string | null; playlist?: unknown; genres?: unknown; listeningStats?: unknown; visualMode?: string | null }) => {
  getStateStore().update(state => {
    if (state.settings.legacyRendererImported) return
    if (legacy.rootPath && fs.existsSync(legacy.rootPath)) state.libraryRoots = Array.from(new Set([legacy.rootPath, ...state.libraryRoots]))
    const paths = Array.isArray(legacy.playlist) ? legacy.playlist.map(item => typeof item === 'string' ? item : (item as { audioPath?: string })?.audioPath).filter((item): item is string => Boolean(item)) : []
    if (paths.length && !state.queue.currentTrackId) state.queue = { ...state.queue, currentTrackId: paths[0].toLocaleLowerCase(), upcomingTrackIds: paths.slice(1).map(item => item.toLocaleLowerCase()) }
    if (legacy.listeningStats && typeof legacy.listeningStats === 'object') {
      for (const [trackId, raw] of Object.entries(legacy.listeningStats as Record<string, { plays?: number; lastPlayed?: string }>)) {
        const plays = Math.min(50, Math.max(0, Number(raw?.plays || 0)))
        for (let index = 0; index < plays; index += 1) state.playHistory.push({ trackId: trackId.toLocaleLowerCase(), playedAt: raw?.lastPlayed || new Date().toISOString() })
      }
      state.playHistory = state.playHistory.slice(-500)
    }
    if (legacy.visualMode) state.settings.visualMode = legacy.visualMode
    state.settings.legacyGenres = legacy.genres ?? state.settings.legacyGenres
    state.settings.legacyRendererImported = true
    state.migration.importedLegacy = true
    state.migration.importedAt = new Date().toISOString()
  })
})

ipcMain.handle('get-cached-catalog-results', (_event, key?: string) => {
  const cache = getStateStore().get().remoteCache
  if (key) return cache[key]?.payload ?? []
  return Object.values(cache).flatMap(entry => Array.isArray(entry.payload) ? entry.payload : [])
})
ipcMain.handle('search-catalog', async (_event, request: { title?: string; artist?: string; album?: string; sources?: string[] }) => {
  const title = request?.title?.trim() || ''
  const artist = request?.artist?.trim() || ''
  const album = request?.album?.trim() || ''
  const key = JSON.stringify({ title: normaliseSearchText(title), artist: normaliseSearchText(artist), album: normaliseSearchText(album), sources: request?.sources ?? ['lrclib', 'musicbrainz', 'archive'] })
  const cached = getStateStore().get().remoteCache[key]
  if (cached && Date.now() - new Date(cached.savedAt).getTime() < 15 * 60 * 1000) return cached.payload
  const results: Array<{ id: string; title: string; artist?: string; album?: string; source: string; sourceUrl?: string; kind: 'lyrics' | 'metadata' | 'audio'; syncedLyrics?: string | null; plainLyrics?: string | null; confidence?: 'high' | 'medium' | 'low'; payload?: unknown }> = []
  const sources = request?.sources ?? ['lrclib', 'musicbrainz', 'archive']
  if (sources.includes('lrclib') && title) {
    try {
      await waitForLrclib()
      const params = new URLSearchParams({ q: [title, artist, album].filter(Boolean).join(' ') })
      const response = await fetch(`https://lrclib.net/api/search?${params}`, { headers: { 'User-Agent': 'Lyrigen/2.1.0 (local music player)' }, signal: AbortSignal.timeout(10_000) })
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after') || 1)
        await new Promise(resolve => setTimeout(resolve, Math.min(10_000, Math.max(1, retryAfter) * 1000)))
      } else if (response.ok) {
        const matches = await response.json() as Array<{ id?: number; trackName?: string; artistName?: string; albumName?: string; syncedLyrics?: string | null; plainLyrics?: string | null }>
        for (const match of matches.slice(0, 8)) results.push({ id: `lrclib-${match.id ?? Math.random()}`, title: match.trackName || title, artist: match.artistName || artist, album: match.albumName || album, source: 'LRCLIB', sourceUrl: match.id ? `https://lrclib.net/api/get/${match.id}` : undefined, kind: 'lyrics', syncedLyrics: match.syncedLyrics, plainLyrics: match.plainLyrics, confidence: match.syncedLyrics ? 'high' : 'medium' })
      }
    } catch (error) { console.warn('LRCLIB catalog search failed', error) }
  }
  if (sources.includes('musicbrainz') && title) {
    try {
      const query = `recording:"${escapeMusicBrainz(title)}"${artist ? ` AND artist:"${escapeMusicBrainz(artist)}"` : ''}`
      const params = new URLSearchParams({ query, fmt: 'json', limit: '8' })
      const data = await fetchMusicBrainzJson<{ recordings?: Array<{ id?: string; title?: string; score?: number; 'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }> }> }>(`https://musicbrainz.org/ws/2/recording?${params}`)
      for (const match of data.recordings ?? []) results.push({ id: `musicbrainz-${match.id ?? Math.random()}`, title: match.title || title, artist: creditNames(match['artist-credit']) || artist, source: 'MusicBrainz', sourceUrl: match.id ? `https://musicbrainz.org/recording/${match.id}` : undefined, kind: 'metadata', confidence: Number(match.score || 0) > 85 ? 'high' : 'medium', payload: match })
    } catch (error) { console.warn('MusicBrainz catalog search failed', error) }
  }
  if (sources.includes('archive') && (title || artist)) {
    try {
      const query = encodeURIComponent(`title:"${title}"${artist ? ` AND creator:"${artist}"` : ''}`)
      const response = await fetch(`https://archive.org/advancedsearch.php?q=${query}&fl[]=identifier,title,creator&rows=12&page=1&output=json`, { signal: AbortSignal.timeout(10_000) })
      if (response.ok) {
        const data = await response.json() as { response?: { docs?: Array<{ identifier?: string; title?: string; creator?: string | string[] }> } }
        for (const match of data.response?.docs ?? []) results.push({ id: `archive-${match.identifier ?? Math.random()}`, title: match.title || title, artist: Array.isArray(match.creator) ? match.creator[0] : match.creator || artist, source: 'Internet Archive', sourceUrl: match.identifier ? `https://archive.org/details/${match.identifier}` : undefined, kind: 'audio', confidence: 'low', payload: match })
      }
    } catch (error) { console.warn('Internet Archive catalog search failed', error) }
  }
  getStateStore().update(state => { state.remoteCache[key] = { savedAt: new Date().toISOString(), source: 'catalog', payload: results } })
  return results
})

ipcMain.handle('select-audio-files', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio files', extensions: [...audioExtensions].map(extension => extension.slice(1)) }],
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('select-audio-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths[0]) return []
  const files = await collectLibraryFiles(result.filePaths[0])
  return files.filter(filePath => audioExtensions.has(path.extname(filePath).toLocaleLowerCase()))
})

ipcMain.handle('read-file', async (_event, filePath: string) => {
  try {
    return await fs.promises.readFile(filePath, 'utf-8')
  } catch (error) {
    console.error('Failed to read file', error)
    return null
  }
})

ipcMain.handle('get-media-url', (_event, filePath: string) => pathToFileURL(filePath).toString())
ipcMain.handle('get-artwork-url', (_event, filePath: string, size: number) => getThumbnailUrl(filePath, size))

async function extractAudioMetadata(filePath: string) {
  const mm = await import('music-metadata')
  const metadata = await mm.parseFile(filePath)
  const overlay = await readOverlay(filePath)
  const picture = metadata.common.picture?.[0]
  const cover = overlay.coverPath ? pathToFileURL(overlay.coverPath).toString() : picture ? `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}` : null
  return {
    title: overlay.title || metadata.common.title || null,
    artist: overlay.artist || metadata.common.artist || null,
    album: overlay.album || metadata.common.album || null,
    albumArtist: overlay.albumArtist || metadata.common.albumartist || null,
    year: Number(overlay.year) || metadata.common.year || null,
    genre: overlay.genre || metadata.common.genre?.[0] || null,
    duration: metadata.format.duration || null,
    bitrate: metadata.format.bitrate || null,
    sampleRate: metadata.format.sampleRate || null,
    bitsPerSample: metadata.format.bitsPerSample || null,
    codec: metadata.format.codec || metadata.format.container || null,
    lossless: metadata.format.lossless ?? null,
    cover,
    releaseDate: overlay.releaseDate || (metadata.common.date ?? null),
    trackNumber: Number(overlay.trackNumber) || metadata.common.track.no || null,
    discNumber: Number(overlay.discNumber) || metadata.common.disk.no || null,
    composer: overlay.composer || metadata.common.composer?.join(', ') || null,
    fileSize: (() => {
      try { return fs.statSync(filePath).size } catch { return null }
    })(),
  }
}

ipcMain.handle('get-audio-metadata', async (_event, filePath: string) => {
  try {
    return await extractAudioMetadata(filePath)
  } catch (error) {
    console.error('Failed to extract metadata', error)
    return null
  }
})

ipcMain.handle('inspect-audio-files', async (_event, filePaths: string[]) => {
  const results: Array<{ filePath: string; fileName: string; format: string; metadata: Awaited<ReturnType<typeof extractAudioMetadata>> }> = []
  for (const filePath of [...new Set(filePaths)]) {
    if (!audioExtensions.has(path.extname(filePath).toLocaleLowerCase()) || !fs.existsSync(filePath)) continue
    try {
      const metadata = await extractAudioMetadata(filePath)
      results.push({ filePath, fileName: path.basename(filePath), format: path.extname(filePath).slice(1).toLocaleUpperCase(), metadata })
    } catch (error) {
      console.warn(`Unable to read metadata from ${filePath}`, error)
      results.push({
        filePath,
        fileName: path.basename(filePath),
        format: path.extname(filePath).slice(1).toLocaleUpperCase(),
        metadata: {
          title: null, artist: null, album: null, albumArtist: null, year: null, genre: null,
          releaseDate: null, trackNumber: null, discNumber: null, composer: null,
          duration: null, bitrate: null, sampleRate: null, bitsPerSample: null, codec: null, lossless: null, cover: null, fileSize: (() => {
            try { return fs.statSync(filePath).size } catch { return null }
          })(),
        },
      })
    }
  }
  return results
})

async function lookupTrackMetadata(rawRequest: MetadataLookupRequest) {
  const request = rawRequest || { title: '' }
  try {
    const escapedTitle = escapeMusicBrainz(cleanTitle(request.title || ''))
    if (!escapedTitle) return { found: false, message: 'Add a title before searching.' }
    const escapedArtist = escapeMusicBrainz(request.artist || '')
    const query = `recording:"${escapedTitle}"${escapedArtist ? ` AND artist:"${escapedArtist}"` : ''}`
    const params = new URLSearchParams({ query, fmt: 'json', limit: '8', inc: 'releases+artist-credits+tags+media' })
    const data = await fetchMusicBrainzJson<{
      recordings?: Array<{
        id?: string
        title?: string
        score?: number
        length?: number
        tags?: Array<{ name?: string; count?: number }>
        'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>
        releases?: Array<{
          id?: string
          title?: string
          date?: string
          media?: Array<{ position?: number; tracks?: Array<{ position?: number; recording?: { id?: string } }> }>
        }>
      }>
    }>(`https://musicbrainz.org/ws/2/recording?${params}`)
    const candidates = data.recordings || []
    if (!candidates.length) return { found: false, message: 'No confident catalog match found.' }
    const wantedTitle = normaliseSearchText(cleanTitle(request.title || ''))
    const wantedArtist = normaliseSearchText(request.artist || '')
    const wantedAlbum = normaliseSearchText(request.album || '')
    const ranked = candidates.map(candidate => {
      const candidateTitle = normaliseSearchText(candidate.title || '')
      const candidateArtist = normaliseSearchText(creditNames(candidate['artist-credit']))
      const titleMatch = candidateTitle === wantedTitle ? 38 : candidateTitle.includes(wantedTitle) || wantedTitle.includes(candidateTitle) ? 20 : 0
      const artistMatch = wantedArtist && (candidateArtist.includes(wantedArtist) || wantedArtist.includes(candidateArtist)) ? 35 : 0
      const score = Number(candidate.score || 0)
      const durationPenalty = request.duration && candidate.length && Math.abs(request.duration - candidate.length / 1000) > 15 ? 80 : 0
      return { candidate, rank: score + titleMatch + artistMatch - durationPenalty }
    }).sort((left, right) => right.rank - left.rank)
    const best = ranked[0].candidate
    const artist = creditNames(best['artist-credit']) || request.artist || ''
    const releases = best.releases || []
    const release = releases.find(item => wantedAlbum && normaliseSearchText(item.title || '') === wantedAlbum) || releases.find(item => item.date) || releases[0]
    const track = release?.media?.flatMap(media => media.tracks || []).find(item => item.recording?.id === best.id)
    const cover = release?.id ? await fetchCoverData(release.id) : null
    const { confidence } = matchScore(request, { title: best.title, artist, album: release?.title, duration: best.length ? best.length / 1000 : null })
    return {
      found: true,
      metadata: {
        title: best.title || request.title,
        artist,
        album: release?.title || request.album || '',
        albumArtist: artist,
        year: release?.date?.slice(0, 4) || '',
        releaseDate: release?.date || '',
        genre: best.tags?.sort((left, right) => (right.count || 0) - (left.count || 0))[0]?.name || '',
        trackNumber: track?.position ? String(track.position) : '',
        discNumber: release?.media?.find(media => media.tracks?.some(item => item.recording?.id === best.id))?.position ? String(release.media.find(media => media.tracks?.some(item => item.recording?.id === best.id))?.position) : '',
      },
      coverData: cover?.data || null,
      coverMime: cover?.mime || null,
      source: 'MusicBrainz',
      sourceUrl: best.id ? `https://musicbrainz.org/recording/${best.id}` : null,
      releaseId: release?.id || null,
      recordingId: best.id || null,
      confidence,
    }
  } catch (error) {
    console.error('Unable to look up track metadata', error)
    return { found: false, message: 'The public catalog is unavailable right now.' }
  }
}
ipcMain.handle('lookup-track-metadata', (_event, rawRequest: MetadataLookupRequest) => lookupTrackMetadata(rawRequest))

async function applyMetadata(request: Parameters<MetadataFiles['write']>[0]) {
  try {
    const result = await tagFiles().write(request)
    indexCache.delete(request.filePath)
    forgetLibrary()
    return result
  } catch (error) { return { written: false, message: error instanceof Error ? error.message : 'Metadata could not be applied.' } }
}
ipcMain.handle('write-track-metadata', (_event, request: Parameters<MetadataFiles['write']>[0]) => applyMetadata(request))
ipcMain.handle('update-track-metadata', async (_event, request: { audioPath: string; metadata: TagMetadata }) => {
  const result = await applyMetadata({ filePath: request.audioPath, metadata: request.metadata })
  return { ...result, updated: result.written }
})
ipcMain.handle('update-artwork', async (_event, request: { audioPath: string; imagePath?: string; imageData?: string; mimeType?: string }) => {
  try {
    const coverData = request.imagePath ? `data:${request.mimeType || 'image/jpeg'};base64,${(await fs.promises.readFile(request.imagePath)).toString('base64')}` : request.imageData
    const result = await applyMetadata({ filePath: request.audioPath, metadata: {}, coverData })
    return { ...result, updated: result.written }
  } catch { return { updated: false, message: 'Artwork could not be applied.' } }
})
ipcMain.handle('undo-last-file-edit', async () => {
  try {
    const result = await tagFiles().undo()
    if (result.undone) { indexCache.clear(); forgetLibrary(); win?.webContents.send('library-updated', await scanAllLibraries(readSavedLibraryRoots())); return result }
    if (!lastFileBackup) return result
    await fs.promises.copyFile(lastFileBackup.backupPath, lastFileBackup.originalPath)
    lastFileBackup = null
    return { undone: true, message: 'Previous lyric file restored.' }
  } catch { return { undone: false, message: 'The edit could not be restored.' } }
})

ipcMain.handle('find-online-lyrics', async (_event, request: {
  trackName: string
  artistName?: string | null
  albumName?: string | null
  duration?: number | null
  videoId?: string | null
  audioPath?: string | null
}) => {
  let lookup: LyricLookupRequest = { trackName: request.trackName, artistName: request.artistName, albumName: request.albumName, duration: request.duration, videoId: request.videoId }
  // A yt-dlp download carries its video id in the file name or comment tag, which Unison can answer exactly;
  // its tags are the uploader + raw video title, so the parsed song name is the better search key.
  if (request.audioPath && fs.existsSync(request.audioPath)) {
    try {
      const nameInfo = await getDownloader().metadataFromFile(request.audioPath)
      if (nameInfo.videoId) lookup.videoId = nameInfo.videoId
      if (nameInfo.metadata.origin === 'title-parse') lookup = { ...lookup, trackName: nameInfo.metadata.title || lookup.trackName, artistName: nameInfo.metadata.artist || lookup.artistName }
      if (nameInfo.metadata.variant) lookup.duration = null
    } catch (error) { console.warn('Could not derive song name from file', error) }
  }
  return findBestLyrics(lookup)
})

ipcMain.handle('save-lyrics', async (_event, audioPath: string, lyricText: string, options?: { overwrite?: boolean }) => {
  try {
    if (!audioExtensions.has(path.extname(audioPath).toLocaleLowerCase()) || !fs.existsSync(audioPath)) {
      return { saved: false, message: 'The audio file is unavailable.' }
    }
    const targetPath = path.join(path.dirname(audioPath), `${path.parse(audioPath).name}.lrc`)
    if (fs.existsSync(targetPath) && !options?.overwrite) return { saved: false, path: targetPath, message: 'A lyric file already exists. Choose overwrite to replace it.' }
    if (fs.existsSync(targetPath)) await backupFile(targetPath)
    await fs.promises.writeFile(targetPath, lyricText, { encoding: 'utf-8' })
    return { saved: true, path: targetPath }
  } catch (error) {
    console.error('Unable to save lyrics', error)
    return { saved: false, message: 'Lyrigen could not save the lyric file.' }
  }
})

ipcMain.handle('save-ttml', async (_event, audioPath: string, ttmlText: string, options?: { overwrite?: boolean }) => {
  try {
    if (!audioExtensions.has(path.extname(audioPath).toLocaleLowerCase()) || !fs.existsSync(audioPath)) {
      return { saved: false, message: 'The audio file is unavailable.' }
    }
    const targetPath = path.join(path.dirname(audioPath), `${path.parse(audioPath).name}.ttml`)
    if (fs.existsSync(targetPath) && !options?.overwrite) return { saved: false, path: targetPath, message: 'A TTML lyric file already exists. Choose overwrite to replace it.' }
    if (fs.existsSync(targetPath)) await backupFile(targetPath)
    await fs.promises.writeFile(targetPath, ttmlText, { encoding: 'utf-8' })
    return { saved: true, path: targetPath }
  } catch (error) {
    console.error('Unable to save TTML lyrics', error)
    return { saved: false, message: 'Lyrigen could not save the TTML lyric file.' }
  }
})

ipcMain.handle('choose-lrc-files', async (): Promise<Array<{ path: string; name: string; content: string }>> => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'LRC lyrics', extensions: ['lrc'] }],
  })
  if (result.canceled) return []

  const files: Array<{ path: string; name: string; content: string }> = []
  for (const filePath of result.filePaths) {
    try {
      files.push({ path: filePath, name: path.basename(filePath), content: await fs.promises.readFile(filePath, 'utf-8') })
    } catch (error) {
      console.warn('Unable to read LRC file', filePath, error)
    }
  }
  return files
})

ipcMain.handle('save-ttml-file', async (_event, lrcPath: string, ttmlText: string) => {
  try {
    if (path.extname(lrcPath).toLocaleLowerCase() !== '.lrc' || !fs.existsSync(lrcPath)) {
      return { saved: false, message: 'The LRC file is unavailable.' }
    }
    const targetPath = path.join(path.dirname(lrcPath), `${path.parse(lrcPath).name}.ttml`)
    if (fs.existsSync(targetPath)) return { saved: false, path: targetPath, message: 'A TTML file already exists beside this LRC.' }
    await fs.promises.writeFile(targetPath, ttmlText, { encoding: 'utf-8', flag: 'wx' })
    return { saved: true, path: targetPath }
  } catch (error) {
    console.error('Unable to save standalone TTML lyrics', error)
    return { saved: false, message: 'Lyrigen could not save the TTML lyric file.' }
  }
})

ipcMain.handle('choose-alignment-json', async (): Promise<{ path: string; name: string; content: string } | null> => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Whisper / stable-ts alignment JSON', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePaths[0]) return null
  try {
    const filePath = result.filePaths[0]
    return { path: filePath, name: path.basename(filePath), content: await fs.promises.readFile(filePath, 'utf-8') }
  } catch (error) {
    console.warn('Unable to read alignment JSON file', error)
    return null
  }
})

ipcMain.handle('lookup-musicbrainz', async (_event, title: string, artist?: string | null) => {
  try {
    const escapedTitle = title.replace(/["\\]/g, ' ').trim()
    const escapedArtist = artist?.replace(/["\\]/g, ' ').trim()
    const query = `recording:"${escapedTitle}"${escapedArtist ? ` AND artist:"${escapedArtist}"` : ''}`
    const params = new URLSearchParams({ query, fmt: 'json', limit: '5' })
    const response = await fetch(`https://musicbrainz.org/ws/2/recording?${params}`, {
      headers: { 'User-Agent': 'Lyrigen/2.0.0 (https://musicbrainz.org/)' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`MusicBrainz returned ${response.status}`)
    const data = await response.json() as { recordings?: unknown[] }
    return { found: Boolean(data.recordings?.length), recordings: data.recordings ?? [] }
  } catch (error) {
    console.error('Unable to query MusicBrainz', error)
    return { found: false, recordings: [] }
  }
})

ipcMain.handle('show-item-in-folder', (_event, filePath: string) => shell.showItemInFolder(filePath))
ipcMain.handle('open-external', (_event, url: string) => {
  if (/^https:\/\//i.test(url)) return shell.openExternal(url)
  return false
})

ipcMain.on('player-state', (_event, state: { playing?: boolean; title?: string }) => {
  isPlaying = Boolean(state.playing)
  tray?.setToolTip(state.title ? `${state.title} · Lyrigen` : 'Lyrigen')
  buildTrayMenu()
})

ipcMain.on('window-minimize', () => win?.minimize())

ipcMain.on('window-toggle-fullscreen', () => {
  if (win) win.setFullScreen(!win.isFullScreen())
})

ipcMain.on('window-set-mini', (_event, enabled: boolean) => {
  if (!win || enabled === isMini) return
  if (enabled) {
    restoreBounds = win.getBounds()
    isMini = true
    win.setFullScreen(false)
    win.unmaximize()
    win.setAlwaysOnTop(true, 'floating')
    win.setMinimumSize(420, 176)
    win.setResizable(false)
    win.setBounds({ width: 420, height: 176 })
    win.center()
  } else {
    isMini = false
    win.setAlwaysOnTop(false)
    win.setResizable(true)
    win.setMinimumSize(880, 600)
    if (restoreBounds) win.setBounds(restoreBounds)
    else win.maximize()
  }
  win.webContents.send('mini-mode-changed', isMini)
})

/**
 * Closing hides to the tray when asked, rather than quitting.
 *
 * Playback carries on, and the tray menu is the way back or out. Default is a
 * real close: a window that refuses to shut is a nasty surprise for anyone who
 * has not opted in.
 */
ipcMain.on('window-close', () => {
  if (!win) return
  const closeToTray = Boolean(getStateStore().get().settings.closeToTray)
  if (closeToTray) { win.hide(); createTray() } else win.close()
})
