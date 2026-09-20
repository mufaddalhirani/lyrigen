import { MATERIAL_ICONS, MATERIAL_ICON_VIEWBOX, type MaterialIconName } from './material-icons'

/**
 * A Google Material Symbol, drawn from embedded path data.
 *
 * Material Symbols are filled shapes on a 960-unit grid (hence the unusual
 * viewBox), so unlike the older stroke-based `Icon` they take `fill` and
 * ignore stroke width. The paths ship inside the bundle instead of coming
 * from fonts.googleapis.com, because the app has to work offline.
 */
export function MaterialIcon({ name, size = 20, className }: { name: MaterialIconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={MATERIAL_ICON_VIEWBOX}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={MATERIAL_ICONS[name]} />
    </svg>
  )
}
