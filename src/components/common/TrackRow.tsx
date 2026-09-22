// Extracted from the former 45KB single-file App.tsx.

import { type KeyboardEvent } from 'react'
import { Artwork } from './Artwork'
import { Icon } from './Icon'
import { QualityBadge } from './QualityBadge'
import { displayArtist, prettyTime } from '../../lib/format'

/**
 * Tags often hold several genres in one string — "Art Rock;Folk;Chamber;
 * Ambient;Baroque Pop" — which ran straight over the duration column. Show the
 * first two, readably; the tooltip keeps the rest.
 */
function shortGenre(genre: string | null) {
  if (!genre) return '—'
  const parts = genre.split(/\s*[;/|]\s*|\s*,\s*/).filter(Boolean)
  return parts.slice(0, 2).join(' · ') + (parts.length > 2 ? ' …' : '')
}

export function TrackRow({ track, onPlay, onPlayNext, onPlayLast, onFavorite, onRating, onInspect, onPlaylist, dataTrackIndex }: { track: LibraryTrack; onPlay: () => void; onPlayNext: () => void; onPlayLast: () => void; onFavorite: () => void; onRating: () => void; onInspect: () => void; onPlaylist: () => void; dataTrackIndex?: number }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPlay() } }
  return <div className="track-row" data-track-index={dataTrackIndex} role="button" tabIndex={0} onDoubleClick={onPlay} onKeyDown={onKeyDown}><button className="row-art-button" onClick={onPlay} aria-label={`Play ${track.title}`}><Artwork track={track} /></button><div className="track-title"><strong>{track.title}</strong><span>{displayArtist(track)} <i>·</i> {track.album || 'Single'}</span><small>{track.format}<QualityBadge source={track} /></small></div><div className="track-album">{track.album || 'Single'}</div><div className="track-meta" title={track.genre || undefined}>{shortGenre(track.genre)}</div><div className="track-duration">{prettyTime(track.duration)}</div><div className="row-actions"><button onClick={onPlayNext} title="Play next" aria-label={`Play ${track.title} next`}><Icon name="queue" size={15} /></button><button onClick={onPlayLast} title="Play last" aria-label={`Play ${track.title} last`}><Icon name="plus" size={15} /></button><button className={track.favorite ? 'is-favorite' : ''} onClick={onFavorite} title="Favorite" aria-label={`Favorite ${track.title}`}><Icon name="heart" size={15} /></button><button onClick={onRating} title="Rating" aria-label={`Rate ${track.title}`}>{track.rating ? `${track.rating}★` : '☆'}</button><button onClick={onPlaylist} title="Add to playlist" aria-label={`Add ${track.title} to playlist`}><Icon name="playlist" size={15} /></button><button onClick={onInspect} title="Metadata" aria-label={`Inspect ${track.title}`}><Icon name="more" size={17} /></button></div></div>
}
