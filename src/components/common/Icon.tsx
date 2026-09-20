import { MATERIAL_ICONS, MATERIAL_ICON_VIEWBOX, type MaterialIconName } from './material-icons'

/** Names this component has always accepted, kept so call sites did not have to change. */
export type IconName =
  | 'home' | 'library' | 'album' | 'artist' | 'genre' | 'playlist' | 'spark' | 'clock'
  | 'search' | 'plus' | 'folder' | 'more' | 'play' | 'heart' | 'queue' | 'sliders'
  | 'refresh' | 'back' | 'close' | 'chevron' | 'music' | 'external' | 'grid' | 'list'
  | 'check' | 'undo' | 'download' | 'lyrics'

/** The few names that do not match a Material Symbol one-for-one. */
const ALIASES: Partial<Record<IconName, MaterialIconName>> = { sliders: 'tune' }

/**
 * An icon from Google Material Symbols (Rounded).
 *
 * These are filled shapes on a 960-unit grid, so `fill` does the drawing and
 * there is no stroke width to set — the opposite of the hand-drawn stroke set
 * this replaced. Path data is bundled rather than fetched from Google Fonts so
 * the app renders identically offline.
 */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const path = MATERIAL_ICONS[ALIASES[name] ?? (name as MaterialIconName)]
  if (!path) return null
  return (
    <svg width={size} height={size} viewBox={MATERIAL_ICON_VIEWBOX} fill="currentColor" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  )
}
