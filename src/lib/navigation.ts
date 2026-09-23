import type { LibraryMode, SortMode, View } from '../types/views'

/**
 * Per-view UI state, so moving between screens does not throw away what you
 * were doing.
 *
 * Switching views used to clear the search box and the open collection every
 * time, which meant a trip to Downloads and back cost you your place. Each
 * view now keeps its own search, sort, layout, genre filter and open
 * collection, restored when you return to it.
 *
 * Kept in localStorage rather than the main-process store because it is pure
 * interface state: losing it costs nothing, and it must be readable during the
 * first render without waiting on IPC.
 */

export interface ViewMemory {
  query: string
  sort: SortMode
  mode: LibraryMode
  genreFilter: string
  activePlaylistId: string | null
}

export const BLANK_VIEW: ViewMemory = { query: '', sort: 'title', mode: 'list', genreFilter: '', activePlaylistId: null }

const KEY = 'lyrigen-view-memory-v1'

type Store = Partial<Record<View, ViewMemory>> & { lastView?: View }

function read(): Store {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}') as Store
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function rememberView(view: View, memory: ViewMemory) {
  try {
    const store = read()
    store[view] = memory
    store.lastView = view
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    /* storage blocked — the app just forgets, which is the old behaviour */
  }
}

export function recallView(view: View): ViewMemory {
  return { ...BLANK_VIEW, ...(read()[view] ?? {}) }
}

/** Where the app was last time, so a restart lands where you left off. */
export function recallLastView(): View | null {
  const last = read().lastView
  // Tool screens are transient; reopening straight into one is disorienting.
  return last && !['metadata', 'downloads', 'organizer', 'lyrics', 'dj'].includes(last) ? last : null
}
