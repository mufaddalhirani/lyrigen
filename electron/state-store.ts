import fs from 'node:fs'
import path from 'node:path'

export type QueueState = {
  currentTrackId: string | null
  upcomingTrackIds: string[]
  historyTrackIds: string[]
  shuffle: boolean
  repeat: 'off' | 'all' | 'one'
  autoplay: boolean
}

export type PlaylistRecord = {
  id: string
  name: string
  trackIds: string[]
  smartRule?: string
  createdAt: string
  updatedAt: string
}

export type PersistentState = {
  schemaVersion: 3
  libraryRoots: string[]
  playlists: PlaylistRecord[]
  favorites: string[]
  ratings: Record<string, number>
  /** `seconds` is the track's length at the time it was played, for listening totals. */
  playHistory: Array<{ trackId: string; playedAt: string; positionMs?: number; seconds?: number }>
  resumePositions: Record<string, number>
  queue: QueueState
  settings: Record<string, unknown>
  remoteCache: Record<string, { savedAt: string; source: string; payload: unknown }>
  migration: { importedLegacy: boolean; importedAt: string | null }
}

const emptyQueue = (): QueueState => ({
  currentTrackId: null,
  upcomingTrackIds: [],
  historyTrackIds: [],
  shuffle: false,
  repeat: 'off',
  autoplay: true,
})

function defaultState(): PersistentState {
  return {
    schemaVersion: 3,
    libraryRoots: [],
    playlists: [],
    favorites: [],
    ratings: {},
    playHistory: [],
    resumePositions: {},
    queue: emptyQueue(),
    settings: { visualMode: 'balanced', lyricFontSize: 1, lyricDensity: 'comfortable', crossfade: false },
    remoteCache: {},
    migration: { importedLegacy: false, importedAt: null },
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export class StateStore {
  private readonly filePath: string
  private readonly fallbackPath: string
  private useFallback = false
  private state: PersistentState

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'lyrigen-state.json')
    this.fallbackPath = path.join(process.cwd(), '.lyrigen-runtime-state.json')
    this.state = this.load()
  }

  private load() {
    const defaults = defaultState()
    for (const candidate of [this.filePath, this.fallbackPath]) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as Partial<PersistentState>
        return {
          ...defaults,
          ...parsed,
          queue: { ...defaults.queue, ...(parsed.queue ?? {}) },
          settings: { ...defaults.settings, ...(parsed.settings ?? {}) },
          migration: { ...defaults.migration, ...(parsed.migration ?? {}) },
        }
      } catch {
        // Try the next recovery location.
      }
    }
    // Import the old single-root config without deleting it. The old file is
    // deliberately kept as a recovery source for users rolling back.
    try {
      const legacyPath = path.join(path.dirname(this.filePath), 'library.json')
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as { rootPath?: string; roots?: string[] }
      const roots = Array.from(new Set([...(legacy.roots ?? []), ...(legacy.rootPath ? [legacy.rootPath] : [])]))
      defaults.libraryRoots = roots
      defaults.migration = { importedLegacy: roots.length > 0, importedAt: roots.length > 0 ? new Date().toISOString() : null }
    } catch {
      // First launch.
    }
    this.persist(defaults)
    return defaults
  }

  get(): PersistentState {
    return clone(this.state)
  }

  update(mutator: (state: PersistentState) => void) {
    const next = clone(this.state)
    mutator(next)
    this.state = next
    this.persist(next)
    return clone(next)
  }

  private persist(state: PersistentState) {
    const destinations = this.useFallback ? [this.fallbackPath] : [this.filePath, this.fallbackPath]
    for (const destination of destinations) {
      try {
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        const temporaryPath = `${destination}.tmp`
        fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), 'utf-8')
        fs.renameSync(temporaryPath, destination)
        return
      } catch (error) {
        console.warn(`Lyrigen state persistence unavailable at ${destination}`, error)
        this.useFallback = true
      }
    }
  }
}

export function createStateStore(userDataPath: string) {
  return new StateStore(userDataPath)
}

export function createPlaylist(name: string): PlaylistRecord {
  const now = new Date().toISOString()
  return { id: `playlist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: name.trim() || 'New playlist', trackIds: [], createdAt: now, updatedAt: now }
}

export { emptyQueue }
