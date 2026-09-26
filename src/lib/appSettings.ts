/**
 * The app-wide preferences (Settings screen), shared by everything that
 * obeys them. They live in the main process's state file; this keeps one
 * copy in the renderer, loads it once, and tells listeners when one changes —
 * so a switch flipped in Settings takes effect everywhere at once.
 */

export const DEFAULT_APP_SETTINGS: AppSettings = {
  autoplayOnStartup: false,
  resumePlayback: false,
  rescanOnStartup: true,
  closeToTray: false,
  autoFetchLyrics: true,
  reducedMotion: false,
  confirmDestructive: true,
}

export const SETTINGS_EVENT = 'lyrigen:settings'

let current: AppSettings = DEFAULT_APP_SETTINGS
let loading: Promise<AppSettings> | null = null

export function loadAppSettings(): Promise<AppSettings> {
  loading ??= window.electronAPI.getSettings()
    .then(stored => { current = { ...DEFAULT_APP_SETTINGS, ...(stored as Partial<AppSettings>) }; return current })
    .catch(() => current)
  return loading
}

/** The last known settings (defaults until loadAppSettings has resolved). */
export const appSettings = () => current

export function setAppSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
  current = { ...current, [key]: value }
  loading = Promise.resolve(current)
  void window.electronAPI.updateSettings({ [key]: value })
  if (key === 'reducedMotion') {
    document.documentElement.classList.toggle('reduce-motion', Boolean(value))
    // The player reads this before settings load, to draw its first frame right.
    try { localStorage.setItem('lyrigen-reduced-motion', String(Boolean(value))) } catch { /* not remembered */ }
  }
  window.dispatchEvent(new CustomEvent<AppSettings>(SETTINGS_EVENT, { detail: current }))
}
