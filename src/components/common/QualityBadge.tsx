import { qualityOf } from '../../lib/quality'

type Props = { source: Parameters<typeof qualityOf>[0]; showStandard?: boolean }

/**
 * A small quality pill in the style of Apple Music's Lossless badge: a
 * waveform mark and a word. The standard tier stays quiet unless asked for,
 * so a badge means something when it appears.
 */
export function QualityBadge({ source, showStandard = false }: Props) {
  const quality = qualityOf(source)
  if (!quality.label && !showStandard) return null
  return (
    <span className={`quality-badge tier-${quality.tier}`} title={quality.detail}>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 5v2M3.5 3v6M6 1.5v9M8.5 3.5v5M11 5v2" /></svg>
      {quality.label || quality.detail.split(' · ').slice(-1)[0]}
    </span>
  )
}
