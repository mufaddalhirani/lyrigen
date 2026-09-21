// Extracted from the former 45KB single-file App.tsx.

import { useEffect, useMemo, useState } from 'react'
import { Artwork } from '../components/common/Artwork'
import type { SmartCollection } from '../lib/smart'
import { DuplicateCleanup } from '../components/DuplicateCleanup'
import { Icon } from '../components/common/Icon'
import { TrackRow } from '../components/common/TrackRow'
import { primaryArtistName, displayArtist } from '../lib/format'
import type { View, LibraryMode, SortMode } from '../types/views'

export function CollectionView({ view, tracks, genres, smart, onLeaveSmart, onLibraryChanged, flash, mode, setMode, sort, setSort, genreFilter, setGenreFilter, onPlay, onPlayNext, onPlayLast, onFavorite, onRating, onInspect, onPlaylist, onOpenPlaylist, playlists }: { view: View; tracks: LibraryTrack[]; albums: LibraryTrack[]; artists: string[]; genres: string[]; mode: LibraryMode; setMode: (mode: LibraryMode) => void; sort: SortMode; setSort: (sort: SortMode) => void; genreFilter: string; setGenreFilter: (genre: string) => void; onPlay: (track: LibraryTrack, source?: LibraryTrack[]) => void; onPlayNext: (track: LibraryTrack) => void; onPlayLast: (track: LibraryTrack) => void; onFavorite: (track: LibraryTrack) => void; onRating: (track: LibraryTrack) => void; onInspect: (track: LibraryTrack) => void; onPlaylist: (track: LibraryTrack) => void; onOpenPlaylist: (id: string) => void; playlists: PlaylistRecord[]; smart?: SmartCollection | null; onLeaveSmart?: () => void; onLibraryChanged?: () => void; flash?: (message: string) => void }) {
  const [group, setGroup] = useState('')
  const [page, setPage] = useState(1)
  useEffect(() => { setGroup(''); setPage(1) }, [view])
  useEffect(() => { setPage(1) }, [tracks, group])
  const entityView = ['folders', 'albums', 'artists', 'genres'].includes(view)

  /**
   * One pass over the library builds every group's tracks. This used to be a
   * `tracks.find` plus a `tracks.filter` *inside* the render loop for each
   * group -- O(groups x tracks) string work on every render, which on a few
   * thousand tracks ran into the millions of operations per frame.
   */
  const groupIndex = useMemo(() => {
    const folderOf = (track: LibraryTrack) => track.relativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || 'Root'
    const keyOf = (track: LibraryTrack) =>
      view === 'folders' ? folderOf(track)
      : view === 'albums' ? `${track.album} · ${track.albumArtist || track.artist || ''}`
      : view === 'artists' ? primaryArtistName(track.artist)
      : track.genre || 'Unknown genre'

    const map = new Map<string, LibraryTrack[]>()
    for (const track of tracks) {
      const key = keyOf(track)
      const bucket = map.get(key)
      if (bucket) bucket.push(track)
      else map.set(key, [track])
    }
    const names = Array.from(map.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return { map, names, keyOf }
  }, [tracks, view])

  const selectedTracks = useMemo(() => {
    if (!group) return tracks
    const bucket = groupIndex.map.get(group) ?? []
    return [...bucket].sort((a, b) =>
      (a.discNumber || 0) - (b.discNumber || 0) ||
      (a.trackNumber || 0) - (b.trackNumber || 0) ||
      a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }))
  }, [group, groupIndex, tracks])

  const groups = groupIndex.names
  const visible = useMemo(() => selectedTracks.slice(0, page * 100), [selectedTracks, page])
  return <section className="collection-view">
    <div className="collection-toolbar">{smart ? <button className="back-link" onClick={() => onLeaveSmart?.()}><Icon name="back" size={15} /> All smart collections</button> : <div className="segmented-tabs">{[['folders','Folders'],['library','Songs'],['albums','Albums'],['artists','Artists'],['genres','Genres']].map(([key,label]) => <button key={key} className={view === key ? 'active' : ''} onClick={() => window.dispatchEvent(new CustomEvent('view-' + key))}>{label}</button>)}</div>}<div className="collection-controls"><select aria-label="Genre filter" value={genreFilter} onChange={event => setGenreFilter(event.target.value)}><option value="">All genres</option>{genres.map(genre => <option key={genre}>{genre}</option>)}</select><select aria-label="Sort tracks" value={sort} onChange={event => setSort(event.target.value as SortMode)}><option value="title">Title / playlist order</option><option value="artist">Artist</option><option value="album">Album</option><option value="recent">Recently played</option><option value="plays">Most played</option></select><button onClick={() => setMode(mode === 'list' ? 'grid' : 'list')} aria-label="Toggle grid view"><Icon name={mode === 'list' ? 'grid' : 'list'} /></button></div></div>
    {group && <div className="collection-breadcrumb"><button className="text-link" onClick={() => setGroup('')}>← All {view}</button><strong>{group}</strong><button className="accent-button" onClick={() => selectedTracks[0] && onPlay(selectedTracks[0], selectedTracks)}>Play collection</button></div>}
    {view === 'playlists' && <div className="playlist-filter-row">{playlists.map(item => <button key={item.id} onClick={() => onOpenPlaylist(item.id)}>{item.name}<span>{item.trackIds.length}</span></button>)}</div>}
    {smart?.id === 'duplicates' && <DuplicateCleanup onDone={() => onLibraryChanged?.()} flash={flash ?? (() => undefined)} />}
    {smart && !visible.length ? <div className="collection-empty"><strong>{smart.title}</strong><p>{smart.empty}</p></div> : entityView && !group ? <div className="entity-grid">{groups.map(key => { const bucket = groupIndex.map.get(key) ?? []; return <button key={key} className="entity-card" onClick={() => setGroup(key)}><Artwork track={bucket[0]} large /><strong>{key}</strong><span>{bucket.length} tracks</span></button> })}</div> : mode === 'grid' ? <div className="track-grid">{visible.map(track => <div className="grid-track" key={track.id}><button onClick={() => onPlay(track, selectedTracks)}><Artwork track={track} large /><strong>{track.title}</strong><span>{displayArtist(track)}</span></button></div>)}</div> : <div className="table-wrap"><div className="table-head"><span>TRACK</span><span>ALBUM</span><span>GENRE</span><span>TIME</span><span /></div>{visible.map((track,index) => <TrackRow key={track.id} track={track} dataTrackIndex={index} onPlay={() => onPlay(track, selectedTracks)} onPlayNext={() => onPlayNext(track)} onPlayLast={() => onPlayLast(track)} onFavorite={() => onFavorite(track)} onRating={() => onRating(track)} onInspect={() => onInspect(track)} onPlaylist={() => onPlaylist(track)} />)}</div>}
    {(!entityView || group) && visible.length < selectedTracks.length && <button className="ghost-button load-more" onClick={() => setPage(value => value + 1)}>Show next 100 · {selectedTracks.length - visible.length} remaining</button>}
    {!tracks.length && !smart && <div className="empty-card"><h3>No tracks match</h3><p>Clear your filters or add a music folder.</p></div>}
  </section>
}
