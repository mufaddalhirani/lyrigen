/**
 * Look-and-feel presets, in the spirit of the Better Lyrics theme marketplace.
 *
 * A theme is purely presentational: it swaps CSS custom properties (palette,
 * panel treatment, lyric typography and motion) via a `data-theme` attribute on
 * `<html>`. Nothing here changes behaviour, so a theme can never break
 * playback, and an unknown id simply falls back to the default.
 *
 * Fonts and lyric motion are chosen separately from the theme, because people
 * tend to want one theme's colours with another's typography.
 */

export interface ThemeOption {
  id: string
  label: string
  description: string
}

export const THEMES: ThemeOption[] = [
  { id: 'nocturne', label: 'Nocturne Bloom', description: 'The original. Warm rose accent on near-black, soft glass panels.' },
  { id: 'spotlight', label: 'Spotlight', description: 'High contrast. Dim everything but the line being sung.' },
  { id: 'lucid', label: 'Lucid', description: 'Cool frosted glass, cyan accent, heavier blur.' },
  { id: 'ember', label: 'Ember', description: 'Warm amber on deep brown, low glare for night listening.' },
  { id: 'paper', label: 'Paper', description: 'Light theme. Ink on off-white, for bright rooms.' },
  { id: 'monochrome', label: 'Monochrome', description: 'Greyscale and quiet. No colour, minimal motion.' },
]

export const FONTS: ThemeOption[] = [
  { id: 'system', label: 'System', description: 'Segoe UI Variable — the Windows default.' },
  { id: 'serif', label: 'Serif', description: 'Georgia. Lyrics read like a book.' },
  { id: 'rounded', label: 'Rounded', description: 'Nunito-style soft geometric sans.' },
  { id: 'mono', label: 'Mono', description: 'Cascadia Mono throughout.' },
  { id: 'condensed', label: 'Condensed', description: 'Narrow grotesque; fits more on a line.' },
]

/** How lyric lines move as they become active. */
export const LYRIC_MOTIONS: ThemeOption[] = [
  { id: 'glow', label: 'Glow', description: 'Active line brightens and lifts slightly.' },
  { id: 'scale', label: 'Scale', description: 'Active line grows; the rest shrink back.' },
  { id: 'blur', label: 'Focus', description: 'Inactive lines blur out of the way.' },
  { id: 'none', label: 'Still', description: 'No movement at all. Lightest on the GPU.' },
]

const KEYS = { theme: 'lyrigen-theme', font: 'lyrigen-font', motion: 'lyrigen-lyric-motion' } as const

function read(key: string, fallback: string, allowed: ThemeOption[]) {
  try {
    const value = localStorage.getItem(key)
    return value && allowed.some(option => option.id === value) ? value : fallback
  } catch {
    return fallback
  }
}

export function loadAppearance() {
  return {
    theme: read(KEYS.theme, 'nocturne', THEMES),
    font: read(KEYS.font, 'system', FONTS),
    motion: read(KEYS.motion, 'glow', LYRIC_MOTIONS),
  }
}

/** Write the choice to `<html>` so CSS can react, and remember it for next launch. */
export function applyAppearance(appearance: { theme: string; font: string; motion: string }) {
  const root = document.documentElement
  root.dataset.theme = appearance.theme
  root.dataset.font = appearance.font
  root.dataset.lyricMotion = appearance.motion
  try {
    localStorage.setItem(KEYS.theme, appearance.theme)
    localStorage.setItem(KEYS.font, appearance.font)
    localStorage.setItem(KEYS.motion, appearance.motion)
  } catch {
    /* private mode or blocked storage — the attributes above still applied */
  }
}
