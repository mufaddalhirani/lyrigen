/**
 * Audio quality tiers, the way Apple Music badges them.
 *
 * Apple draws the lines like this: "Lossless" is CD quality up to 24-bit/48 kHz,
 * and "Hi-Res Lossless" is anything above 48 kHz. Lossy files have no Apple
 * badge, but they are most of a YouTube library, and the difference between
 * YouTube's 130 kbps stream and the 256 kbps Premium one is the whole point of
 * the upgrade tool — so those get tiers too, measured from the file.
 */

export type QualityTier = 'hires' | 'lossless' | 'high' | 'standard' | 'low'

export interface QualityInfo {
  tier: QualityTier
  /** Short badge text. Empty for the standard tier, which gets no badge. */
  label: string
  /** Full description for a tooltip. */
  detail: string
}

type QualitySource = { lossless?: boolean | null; kbps?: number | null; sampleRate?: number | null; bitDepth?: number | null; codec?: string | null; format?: string }

function describe(source: QualitySource) {
  const parts: string[] = []
  const codec = source.codec?.replace(/^MPEG-4\/AAC.*/i, 'AAC').replace(/^MPEG 1 Layer 3/i, 'MP3') || source.format
  if (codec) parts.push(codec)
  if (source.bitDepth && source.lossless) parts.push(`${source.bitDepth}-bit`)
  if (source.sampleRate) parts.push(`${(source.sampleRate / 1000).toFixed(source.sampleRate % 1000 ? 1 : 0)} kHz`)
  if (source.kbps && !source.lossless) parts.push(`${source.kbps} kbps`)
  return parts.join(' · ')
}

export function qualityOf(source: QualitySource): QualityInfo {
  const detail = describe(source)
  if (source.lossless) {
    if ((source.sampleRate ?? 0) > 48_000) return { tier: 'hires', label: 'Hi-Res Lossless', detail }
    return { tier: 'lossless', label: 'Lossless', detail }
  }
  const kbps = source.kbps ?? null
  // 200 separates YouTube's two tiers cleanly; cover art adds only a few kbps.
  if (kbps != null && kbps >= 200) return { tier: 'high', label: `${kbps >= 250 ? 256 : kbps}K`, detail: `${detail} — high quality` }
  if (kbps != null && kbps < 96) return { tier: 'low', label: 'Low', detail: `${detail} — low quality; worth upgrading` }
  return { tier: 'standard', label: '', detail }
}
