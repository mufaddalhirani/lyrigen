import { primaryArtistName } from './format'

/**
 * Suggestions built entirely from your own library and play counts.
 *
 * No service, no model, no account — just the four questions a music app can
 * answer honestly from local data:
 *
 *  - **Speed dial**: what you reach for most.
 *  - **Quick picks**: more from the artists you have been playing, weighted
 *    toward tracks you have not worn out.
 *  - **Forgotten**: things you own and have never played.
 *  - **On repeat lately**: recent plays, most-played first.
 *
 * Everything is derived, so it changes as you listen without anything being
 * stored beyond the play history that already exists.
 */

export interface Suggestion {
  id: string
  title: string
  reason: string
  tracks: LibraryTrack[]
}

const plays = (track: LibraryTrack) => track.playCount ?? 0

function shuffled<T>(items: T[]) {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[swap]] = [copy[swap], copy[index]]
  }
  return copy
}

/** Artists ranked by how much you have played them. */
function favouriteArtists(library: LibraryTrack[], limit = 6) {
  const totals = new Map<string, number>()
  for (const track of library) {
    if (!plays(track)) continue
    const artist = primaryArtistName(track.artist)
    totals.set(artist, (totals.get(artist) ?? 0) + plays(track))
  }
  return [...totals.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([artist]) => artist)
}

export function buildSuggestions(library: LibraryTrack[]): Suggestion[] {
  if (!library.length) return []
  const played = library.filter(track => plays(track) > 0)
  const artists = favouriteArtists(library)

  const speedDial = [...played].sort((left, right) => plays(right) - plays(left)).slice(0, 12)

  // More from artists you already play, preferring tracks you have played
  // least — the point is to surface what you have been missing, not to replay
  // the same six songs.
  const quickPicks = shuffled(
    library.filter(track => artists.includes(primaryArtistName(track.artist))),
  ).sort((left, right) => plays(left) - plays(right)).slice(0, 12)

  const forgotten = shuffled(library.filter(track => !plays(track))).slice(0, 12)

  const lately = [...played]
    .filter(track => track.lastPlayed)
    .sort((left, right) => String(right.lastPlayed).localeCompare(String(left.lastPlayed)))
    .slice(0, 12)

  return [
    { id: 'speed-dial', title: 'Speed dial', reason: 'Your most-played, ready to go', tracks: speedDial },
    { id: 'quick-picks', title: 'Quick picks', reason: artists.length ? `More from ${artists.slice(0, 2).join(' and ')}` : 'From around your library', tracks: quickPicks },
    { id: 'lately', title: 'On repeat lately', reason: 'Recently played', tracks: lately },
    { id: 'forgotten', title: 'Never played', reason: 'In your library, never opened', tracks: forgotten },
  ].filter(section => section.tracks.length > 0)
}

/** A shuffled run through the whole library, for "just play something". */
export function randomRun(library: LibraryTrack[], size = 50) {
  return shuffled(library).slice(0, size)
}
