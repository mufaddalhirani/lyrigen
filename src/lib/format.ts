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

/** Reads a value written by a pre-2.0 build of Lyrigen. Never throws. */
export function legacyJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') as unknown
  } catch {
    return null
  }
}
