import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/instrument-serif/400.css'
import '@fontsource/instrument-serif/400-italic.css'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import App from './App'
import { applyAppearance, loadAppearance } from './lib/themes'

// Apply the saved theme before the first paint so the window never flashes the
// default palette on the way to the chosen one.
applyAppearance(loadAppearance())

// The renderer can also be previewed in a regular browser during design QA.
// Electron replaces this with the real, main-process-only bridge at runtime.
if (!window.electronAPI) {
  const emptyStats: LibraryStats = { tracks: 0, albums: 0, artists: 0, genres: 0, favorites: 0, totalDuration: 0, recent: [], mostPlayed: [], needsAttention: [] }
  window.electronAPI = {
    getLibrary: async () => ({ rootPath: null, items: [] }), getLibraryStats: async () => emptyStats, getPlaylists: async () => [], getQueueState: async () => ({ currentTrackId: null, upcomingTrackIds: [], historyTrackIds: [], shuffle: false, repeat: 'off', autoplay: true }), getLibraryRoots: async () => [],
    onScanProgress: () => () => undefined, onLibraryUpdated: () => () => undefined, getMediaUrl: async (filePath: string) => filePath,
    updateQueueState: async (queue: QueueState) => queue, setFavorite: async () => emptyStats, setRating: async () => emptyStats, getAudioMetadata: async () => null,
    openExternal: async () => false, toggleFullscreen: () => undefined, minimizeWindow: () => undefined, closeWindow: () => undefined,
    onPlayerCommand: () => () => undefined, onMiniModeChanged: () => () => undefined, updatePlayerState: () => undefined, importLegacyState: async () => undefined,
  } as unknown as ElectronAPI
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
