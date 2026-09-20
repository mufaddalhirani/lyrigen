// Extracted from the former 45KB single-file App.tsx.

/** Seconds to m:ss, or an em dash when there is nothing to show. */
export function prettyTime(seconds: number | null | undefined) {
  if (!seconds) return '—'
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

/** Seconds to a human total, e.g. "3 hr 12 min". */
export function prettyTotal(seconds: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours ? `${hours} hr ${minutes} min` : `${minutes} min`
}

export function displayArtist(track: LibraryTrack) {
  return track.artist || 'Unknown artist'
}

/**
 * The lead name from an artist credit.
 *
 * Tags routinely hold a whole credit list — "Solya, Solya", "JVKE, Nick Jonas"
 * — and grouping on the raw string turns one artist into several, which is why
 * the same person can appear three times in the Artists grid. Grouping on the
 * lead name collapses them. Mirrors `primaryArtist` in electron/song-naming.ts.
 */
export function primaryArtistName(artist: string | null | undefined) {
  if (!artist) return 'Unknown artist'
  const [first] = artist
    .split(/\s*(?:,|&|\+|\/|;|\bx\b|\bvs\.?\b|\band\b|\bft\.?\b|\bfeat\.?\b|\bfeaturing\b|\bwith\b)\s*/i)
    .map(part => part.trim())
    .filter(Boolean)
  return first || artist
}

/** Reads a value written by a pre-2.0 build of Lyrigen. Never throws. */
export function legacyJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') as unknown
  } catch {
    return null
  }
}
