// Extracted from the former 45KB single-file App.tsx.

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Artwork } from '../components/common/Artwork'
import { Icon } from '../components/common/Icon'
import { QualityBadge } from '../components/common/QualityBadge'
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
  // Built once per visit (and again only if songs are added or removed): the
  // strips hold random picks, and rebuilding them on every library update — the
  // rescan just after launch, a favourite toggled — reshuffled them under you.
  const suggestions = useMemo(() => buildSuggestions(library), [library.length]) // eslint-disable-line react-hooks/exhaustive-deps
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

  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  const numberFormat = new Intl.NumberFormat()

  return <div className="home-view ed-home">
    <header className="ed-masthead">
      <h1 className="ed-greeting">{greeting()}<em>.</em></h1>
      <p className="ed-dateline">{today}<br />{numberFormat.format(library.length)} songs on this computer</p>
    </header>

    {lead ? (
      <section className="ed-feature" style={tint ? { '--hero-tint': tint } as CSSProperties : undefined}>
        <button className="ed-feature-art" onClick={() => onPlay(lead)} aria-label={`Play ${lead.title}`}><Artwork track={lead} large /></button>
        <div className="ed-feature-copy">
          <span className="ed-kicker"><b>No. 01</b> — Continue listening</span>
          <h2 className="ed-feature-title">{lead.title}</h2>
          <p className="ed-feature-meta">{displayArtist(lead)}{lead.album ? <><i>/</i>{lead.album}</> : null}<QualityBadge source={lead} /></p>
          <div className="ed-actions">
            <button className="ed-primary" onClick={() => onPlay(lead)}><Icon name="play" size={14} /> Play</button>
            {isRealAlbum(lead) && <button className="ed-link" onClick={() => playRecord(lead)}>Play the album</button>}
            {library.length > 1 && <button className="ed-link" onClick={() => onPlayRun(randomRun(library))}>Shuffle everything</button>}
          </div>
        </div>
      </section>
    ) : (
      <section className="ed-feature ed-feature-empty">
        <div className="ed-feature-copy" style={{ gridColumn: '1 / -1' }}>
          <span className="ed-kicker"><b>No. 01</b> — The room is ready</span>
          <h2 className="ed-feature-title">Let the next song <i>find you.</i></h2>
          <div className="ed-actions">
            <button className="ed-primary" onClick={onOpenLibrary}><Icon name="library" size={14} /> Open the library</button>
            {library.length > 1 && <button className="ed-link" onClick={() => onPlayRun(randomRun(library))}>Shuffle everything</button>}
          </div>
        </div>
      </section>
    )}

    <dl className="ed-index">
      <div><dt>Songs</dt><dd>{numberFormat.format(stats?.tracks ?? library.length)}</dd></div>
      <div><dt>Albums</dt><dd>{stats?.albums != null ? numberFormat.format(stats.albums) : '—'}</dd></div>
      <div><dt>Favourites</dt><dd>{numberFormat.format(stats?.favorites ?? 0)}</dd></div>
      <div><dt>Playing time</dt><dd>{stats ? prettyTotal(stats.totalDuration) : '—'}</dd></div>
    </dl>

    <section className="ed-section">
      <header className="ed-section-head"><h3>Jump back in</h3><span className="ed-kicker">{recent.length ? 'Pick up again' : 'From your library'}</span><button className="ed-link" onClick={onOpenLibrary}>See the library</button></header>
      <ol className="ed-list">
        {quickTiles.map((track, index) => (
          <li key={track.id}>
            <button onClick={() => playRecord(track)} title={isRealAlbum(track) ? `Play ${track.album}` : `Play ${track.title}`}>
              <span className="ed-num">{String(index + 1).padStart(2, '0')}</span>
              <Artwork track={track} />
              <span><strong>{isRealAlbum(track) ? track.album : track.title}</strong><small>{displayArtist(track)}</small></span>
            </button>
          </li>
        ))}
      </ol>
    </section>

    {suggestions.map(section => <section className="ed-section" key={section.id}><header className="ed-section-head"><h3>{section.title}</h3><span className="ed-kicker">{section.reason}</span><button className="ed-link" onClick={() => onPlayRun(section.tracks)}>Play all</button></header><div className="album-strip">{section.tracks.slice(0, 8).map(track => <button key={track.id} className="album-card" onClick={() => onPlay(track)}><Artwork track={track} large /><strong>{track.title}</strong><span>{displayArtist(track)}</span></button>)}</div></section>)}
    {mostPlayed.length > 0 && <section className="ed-section"><header className="ed-section-head"><h3>Most played</h3><span className="ed-kicker">Your rhythm</span></header><div className="album-strip">{mostPlayed.slice(0, 8).map(track => <button key={track.id} className="album-card" onClick={() => onPlay(track)}><Artwork track={track} large /><strong>{track.title}</strong><span>{displayArtist(track)}</span></button>)}</div></section>}
  </div>
}
