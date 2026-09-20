/**
 * Smart collections: saved views over the library, not copies.
 *
 * Shared between the card grid and the opened collection so the title, the
 * icon and — importantly — the "nothing here" wording all come from one place.
 * An empty collection is a normal outcome (no lossless files yet, nothing
 * favourited), and saying so is the difference between a working feature and
 * a blank screen.
 */

export type SmartIcon = 'heart' | 'spark' | 'album' | 'play' | 'queue'

export interface SmartCollection {
  id: string
  title: string
  detail: string
  icon: SmartIcon
  /** Shown instead of an empty track list. */
  empty: string
}

export function smartCollections(counts: { favorites: number }): SmartCollection[] {
  return [
    { id: 'favorites', title: 'Favorites', detail: `${counts.favorites} saved tracks`, icon: 'heart', empty: 'Nothing favourited yet. Use the heart on any song and it will show up here.' },
    { id: 'lyrics', title: 'Needs lyrics', detail: 'Tracks to give a lyric pass', icon: 'spark', empty: 'Every song already has a lyric file. Nothing to do here.' },
    { id: 'lossless', title: 'Lossless', detail: 'High-fidelity local files', icon: 'album', empty: 'No lossless files in your library yet — FLAC, ALAC and WAV land here.' },
    { id: 'videos', title: 'Music videos', detail: 'Matched local visuals', icon: 'play', empty: 'No matched videos. Put a video file beside a song with the same name and it appears here.' },
    { id: 'duplicates', title: 'Possible duplicates', detail: 'Metadata matches to review', icon: 'queue', empty: 'No likely duplicates found. Your library looks tidy.' },
    { id: 'unrated', title: 'Unrated', detail: 'Give your library a little shape', icon: 'spark', empty: 'Everything has a rating. Nicely done.' },
  ]
}

export function smartCollection(id: string | null) {
  if (!id) return null
  return smartCollections({ favorites: 0 }).find(collection => collection.id === id) ?? null
}
