import type { ThemeOption } from './themes'

/**
 * The now-playing views. Chosen from the picker in the player's top bar or
 * from Sound Lab → Appearance; both write here, and the player follows the
 * change straight away through a window event.
 */
export type VisualMode = 'balanced' | 'lyrics' | 'kinetic' | 'cover' | 'vinyl' | 'visualizer' | 'brat'

export const VISUAL_MODES: Array<ThemeOption & { id: VisualMode }> = [
  { id: 'balanced', label: 'Balanced', description: 'Cover, details and lyrics together' },
  { id: 'lyrics', label: 'Lyrics only', description: 'A calm, focused lyric view' },
  { id: 'kinetic', label: 'Kinetic', description: 'Words land as they are sung, held notes stand out, the line moves with the beat' },
  { id: 'cover', label: 'Cover only', description: 'Large album artwork and details' },
  { id: 'vinyl', label: 'Spinning vinyl', description: 'Album art as a gentle record' },
  { id: 'visualizer', label: 'Visualizer', description: 'Lightweight bars that follow the music' },
  { id: 'brat', label: 'brat', description: 'Lime green; each word flies in from alternate sides as it is sung' },
]

const KEY = 'lyrigen-visual-mode-v1'
export const VISUAL_MODE_EVENT = 'lyrigen:visual-mode'

export function loadVisualMode(): VisualMode {
  try {
    const saved = localStorage.getItem(KEY)
    return VISUAL_MODES.some(mode => mode.id === saved) ? saved as VisualMode : 'balanced'
  } catch {
    return 'balanced'
  }
}

export function saveVisualMode(mode: VisualMode) {
  try { localStorage.setItem(KEY, mode) } catch { /* not remembered, still applied */ }
  window.dispatchEvent(new CustomEvent<VisualMode>(VISUAL_MODE_EVENT, { detail: mode }))
}
