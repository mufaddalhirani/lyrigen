// Extracted from the former 45KB single-file App.tsx.

/** The top-level navigation destinations in the sidebar. */
export type View =
  | 'metadata' | 'folders' | 'home' | 'library' | 'albums' | 'artists'
  | 'genres' | 'playlists' | 'smart' | 'listening' | 'discover' | 'sound'
  | 'downloads' | 'organizer' | 'lyrics' | 'settings'

/** Whether a collection renders as rows or as cover cards. */
export type LibraryMode = 'list' | 'grid'

export type SortMode = 'title' | 'artist' | 'album' | 'recent' | 'plays'
