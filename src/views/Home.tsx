// Extracted from the former 45KB single-file App.tsx.

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Artwork } from '../components/common/Artwork'
import { Icon } from '../components/common/Icon'
import { QualityBadge } from '../components/common/QualityBadge'
import { Stat } from '../components/common/Stat'
import { displayArtist, prettyTotal } from '../lib/format'
import { buildSuggestions, randomRun } from '../lib/suggestions'

/**
 * Home, borrowing what the big players get right:
 *
 * - Spotify greets you by the time of day, and opens with a grid of quick
 *   tiles for what you were just listening to — one click back into it.
 * - Apple Music and Spotify tint the page with the colour of the music, so
 *   the room changes with the record instead of wearing one fixed gradient.
 * - YouTube Music keeps shelves of artwork below ("Listen again" and friends),
 *   which the suggestion strips here already are.
 */

export function greeting(date = new Date()) {
  const hour = date.getHours()
  if (hour < 5) return 'Still up'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/** The colour of a cover, read in the main process. Null while unknown. */
function useArtworkColor(coverPath: string | null | undefined) {
  const [color, setColor] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setColor(null)
    if (!coverPath) return
    window.electronAPI.getArtworkColor(coverPath).then(value => { if (active) setColor(value) }).catch(() => undefined)
    return () => { active = false }
  }, [coverPath])
  return color
}

/** A "Singles" folder is a bucket, not a record — those play as one song. */
function isRealAlbum(track: LibraryTrack) {
  return Boolean(track.album) && !/^(singles?|sped up|slowed|nightcore|unknown)$/i.test(track.album)
}

export function Home({ stats, library, onPlay, onOpenLibrary, onInspect: _onInspect, onFavorite: _onFavorite, onPlayNext: _onPlayNext, onPlayLast: _onPlayLast, onRating: _onRating, onPlaylist: _onPlaylist, onPlayRun }: { stats: LibraryStats | null; library: LibraryTrack[]; onPlay: (track: LibraryTrack) => void; onOpenLibrary: () => void; onInspect: (track: LibraryTrack) => void; onFavorite: (track: LibraryTrack) => void; onPlayNext: (track: LibraryTrack) => void; onPlayLast: (track: LibraryTrack) => void; onRating: (track: LibraryTrack) => void; onPlaylist: (track: LibraryTrack) => void; onPlayRun: (tracks: LibraryTrack[]) => void }) {
  const suggestions = useMemo(() => buildSuggestions(library), [library])
  const recent = stats?.recent?.length ? stats.recent : []
  const mostPlayed = stats?.mostPlayed?.filter(track => (track.playCount ?? 0) > 0) ?? []
  const lead = recent[0] ?? null
  const tint = useArtworkColor(lead?.coverPath)

  // One tile per record: recent plays first, topped up from the library.
  const quickTiles = useMemo(() => {
    const seen = new Set<string>()
    const tiles: LibraryTrack[] = []
    for (const track of [...recent, ...mostPlayed, ...library]) {
      const key = isRealAlbum(track) ? `${track.albumArtist || track.artist}|${track.album}`.toLocaleLowerCase() : track.id
      if (seen.has(key)) continue
      seen.add(key)
      tiles.push(track)
      if (tiles.length === 8) break
    }
    return tiles
  }, [recent, mostPlayed, library])

  const playRecord = (track: LibraryTrack) => {
    if (!isRealAlbum(track)) { onPlay(track); return }
    const album = library
      .filter(item => item.album === track.album && (item.albumArtist || item.artist) === (track.albumArtist || track.artist))
      .sort((left, right) => (left.discNumber ?? 1) - (right.discNumber ?? 1) || (left.trackNumber ?? 0) - (right.trackNumber ?? 0))
    if (album.length > 1) onPlayRun(album); else onPlay(track)
  }

  if (!library.length) {
    return <div className="home-view"><div className="empty-card"><span className="empty-icon"><Icon name="music" size={28} /></span><h3>A softer library starts here.</h3><p>Your files never leave this computer. Add one or more folders to begin.</p><button className="ghost-button" onClick={onOpenLibrary}>Set up library</button></div></div>
  }

  return <div className="home-view">

    {lead ? (
      <section className="continue-hero" style={tint ? { '--hero-tint': tint } as CSSProperties : undefined}>
        <div className="continue-backdrop" aria-hidden="true"><Artwork track={lead} large /></div>
        <button className="continue-art" onClick={() => onPlay(lead)} aria-label={`Play ${lead.title}`}><Artwork track={lead} large /></button>
        <div className="continue-copy">
          <span className="hero-kicker">CONTINUE LISTENING</span>
          <h3>{lead.title}</h3>
          <p>{displayArtist(lead)}{lead.album ? <> <i>·</i> {lead.album}</> : null} <QualityBadge source={lead} /></p>
          <div className="hero-actions">
            <button className="accent-button" onClick={() => onPlay(lead)}><Icon name="play" size={15} /> Play</button>
            {isRealAlbum(lead) && <button className="ghost-button" onClick={() => playRecord(lead)}><Icon name="library" size={15} /> Play {lead.album}</button>}
            {library.length > 1 && <button className="ghost-button" onClick={() => onPlayRun(randomRun(library))}><Icon name="spark" size={15} /> Shuffle everything</button>}
          </div>
        </div>
      </section>
    ) : (
      <section className="welcome-hero"><div><span className="hero-kicker">THE ROOM IS READY</span><h3>Let the next song<br /><i>find you.</i></h3><p>{library.length} tracks in your local library. No accounts, no noise.</p><div className="hero-actions"><button className="accent-button" onClick={onOpenLibrary}><Icon name="library" size={16} /> Open library</button>{library.length > 1 && <button className="ghost-button" onClick={() => onPlayRun(randomRun(library))}><Icon name="spark" size={15} /> Shuffle everything</button>}</div></div><div className="hero-orbit"><span /><span /><span /></div></section>
    )}

    <section className="home-section">
      <div className="section-heading"><div><span className="kicker">{recent.length ? 'PICK UP AGAIN' : 'FROM YOUR LIBRARY'}</span><h3>Jump back in</h3></div><button className="text-link" onClick={onOpenLibrary}>See library <Icon name="chevron" size={14} /></button></div>
      <div className="quick-grid">
        {quickTiles.map(track => (
          <button key={track.id} className="quick-tile" onClick={() => playRecord(track)} title={isRealAlbum(track) ? `Play ${track.album}` : `Play ${track.title}`}>
            <Artwork track={track} />
            <span><strong>{isRealAlbum(track) ? track.album : track.title}</strong><small>{displayArtist(track)}</small></span>
            <i className="quick-play"><Icon name="play" size={14} /></i>
          </button>
        ))}
      </div>
    </section>

    <div className="stats-grid"><Stat label="Tracks" value={String(stats?.tracks ?? library.length)} /><Stat label="Albums" value={String(stats?.albums ?? '—')} /><Stat label="Favorites" value={String(stats?.favorites ?? 0)} /><Stat label="Listening time" value={stats ? prettyTotal(stats.totalDuration) : '—'} /></div>

    {suggestions.map(section => <section className="home-section" key={section.id}><div className="section-heading"><div><span className="kicker">{section.reason.toLocaleUpperCase()}</span><h3>{section.title}</h3></div><button className="text-link" onClick={() => onPlayRun(section.tracks)}>Play all <Icon name="chevron" size={14} /></button></div><div className="album-strip">{section.tracks.slice(0, 8).map(track => <button key={track.id} className="album-card" onClick={() => onPlay(track)}><Artwork track={track} large /><strong>{track.title}</strong><span>{displayArtist(track)}</span></button>)}</div></section>)}
    {mostPlayed.length > 0 && <section className="home-section"><div className="section-heading"><div><span className="kicker">YOUR RHYTHM</span><h3>Most played</h3></div></div><div className="album-strip">{mostPlayed.slice(0, 8).map(track => <button key={track.id} className="album-card" onClick={() => onPlay(track)}><Artwork track={track} large /><strong>{track.title}</strong><span>{displayArtist(track)}</span></button>)}</div></section>}
  </div>
}
