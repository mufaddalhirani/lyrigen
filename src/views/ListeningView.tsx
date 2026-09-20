// Extracted from the former 45KB single-file App.tsx.

import { useEffect, useState } from 'react'
import { Artwork } from '../components/common/Artwork'
import { displayArtist, prettyTotal } from '../lib/format'

type Range = 'week' | 'month' | 'year' | 'all'

const RANGES: Array<{ id: Range; label: string; blurb: string }> = [
  { id: 'week', label: 'This week', blurb: 'the last 7 days' },
  { id: 'month', label: 'This month', blurb: 'the last 30 days' },
  { id: 'year', label: 'This year', blurb: 'the last 365 days' },
  { id: 'all', label: 'All time', blurb: 'everything Lyrigen has seen' },
]

function hoursListened(seconds: number) {
  if (seconds < 3600) return { value: Math.round(seconds / 60), unit: seconds === 60 ? 'minute' : 'minutes' }
  const hours = seconds / 3600
  return { value: hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10, unit: 'hours' }
}

function dayLabel(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Plays per day.
 *
 * One series, so no legend — the heading names it — and one hue taken from the
 * theme accent. Only the busiest day is labelled directly; a number over every
 * bar would be noise. Each bar carries its own title for hover.
 */
function PlaysPerDay({ perDay, peakDay, bucketSize }: { perDay: ListeningRecap['perDay']; peakDay: ListeningRecap['peakDay']; bucketSize: ListeningRecap['bucketSize'] }) {
  const max = Math.max(...perDay.map(day => day.plays), 1)
  if (!perDay.length) return null
  return (
    <figure className="plays-chart">
      <figcaption>
        Plays per {bucketSize}
        {peakDay && <span> · busiest was {dayLabel(peakDay.date)} with {peakDay.plays} {peakDay.plays === 1 ? 'play' : 'plays'}</span>}
      </figcaption>
      <div className="plays-bars" role="img" aria-label={`Plays per ${bucketSize} across ${perDay.length} ${bucketSize}s, busiest ${peakDay ? `${dayLabel(peakDay.date)} with ${peakDay.plays}` : 'none'}`}>
        {perDay.map(day => (
          <span
            key={day.date}
            className={`plays-bar ${peakDay && day.date === peakDay.date && day.plays > 0 ? 'peak' : ''}`}
            style={{ height: `${day.plays ? Math.max((day.plays / max) * 100, 4) : 1.5}%` }}
            title={`${bucketSize === 'day' ? dayLabel(day.date) : `${bucketSize === 'week' ? 'Week of' : 'Month from'} ${dayLabel(day.date)}`} — ${day.plays} ${day.plays === 1 ? 'play' : 'plays'}`}
          />
        ))}
      </div>
      <div className="plays-axis"><span>{dayLabel(perDay[0].date)}</span><span>{dayLabel(perDay[perDay.length - 1].date)}</span></div>
    </figure>
  )
}

export function ListeningView({ stats, tracks, onPlay }: { stats: LibraryStats | null; tracks: LibraryTrack[]; onPlay: (track: LibraryTrack) => void }) {
  const [range, setRange] = useState<Range>('week')
  const [recap, setRecap] = useState<ListeningRecap | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    window.electronAPI.getListeningRecap(range)
      .then(result => { if (active) setRecap(result) })
      .catch(() => { if (active) setRecap(null) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [range])

  const recent = stats?.recent ?? []
  const listened = hoursListened(recap?.seconds ?? 0)
  const blurb = RANGES.find(option => option.id === range)?.blurb ?? ''
  const nothingYet = !loading && recap && recap.plays === 0

  return (
    <section className="listening-page">
      <div className="listening-summary">
        <div>
          <span className="hero-kicker">A SMALL RECORD OF YOUR DAYS</span>
          <h3>Your listening,<br /><i>over time.</i></h3>
          <p>History stays on this computer. Nothing is uploaded and no account is involved.</p>
        </div>
        <div className="listening-number">
          <strong>{stats?.totalDuration ? prettyTotal(stats.totalDuration) : '—'}</strong>
          <span>indexed duration</span>
        </div>
      </div>

      <div className="recap-card">
        <div className="recap-head">
          <div>
            <span className="kicker">RECAP</span>
            <h3>What you played over {blurb}.</h3>
          </div>
          <div className="recap-ranges">
            {RANGES.map(option => (
              <button key={option.id} className={option.id === range ? 'on' : ''} onClick={() => setRange(option.id)} aria-pressed={option.id === range}>{option.label}</button>
            ))}
          </div>
        </div>

        {nothingYet ? (
          <div className="history-empty">Nothing played in {blurb}. Put a song on and this fills in by itself.</div>
        ) : (
          <>
            <div className="recap-figures">
              <div><strong>{recap?.plays ?? '—'}</strong><span>{recap?.plays === 1 ? 'play' : 'plays'}</span></div>
              <div><strong>{recap ? listened.value : '—'}</strong><span>{listened.unit} listened</span></div>
              <div><strong>{recap?.distinctTracks ?? '—'}</strong><span>different songs</span></div>
              <div><strong>{recap?.distinctArtists ?? '—'}</strong><span>artists</span></div>
            </div>

            {recap && <PlaysPerDay perDay={recap.perDay} peakDay={recap.peakDay} bucketSize={recap.bucketSize} />}

            <div className="recap-lists">
              <div>
                <span className="kicker">TOP ARTISTS</span>
                {recap?.topArtists.length
                  ? <ol>{recap.topArtists.map(artist => <li key={artist.name}><b>{artist.name}</b><em>{artist.plays}</em></li>)}</ol>
                  : <p className="recap-none">No artist data yet.</p>}
              </div>
              <div>
                <span className="kicker">TOP SONGS</span>
                {recap?.topTracks.length
                  ? <ol>{recap.topTracks.map(track => <li key={track.id}><b>{track.title}<small>{track.artist || 'Unknown artist'}</small></b><em>{track.plays}</em></li>)}</ol>
                  : <p className="recap-none">No song data yet.</p>}
              </div>
              <div>
                <span className="kicker">TOP GENRES</span>
                {recap?.topGenres.length
                  ? <ol>{recap.topGenres.map(genre => <li key={genre.name}><b>{genre.name}</b><em>{genre.plays}</em></li>)}</ol>
                  : <p className="recap-none">Tag your files with genres and they will rank here.</p>}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="history-card">
        <div className="section-heading">
          <div><span className="kicker">RECENTLY PLAYED</span><h3>Back through the last few listens</h3></div>
        </div>
        {recent.length ? recent.map(track => (
          <button className="history-row" key={track.id} onClick={() => onPlay(track)}>
            <Artwork track={track} />
            <span><strong>{track.title}</strong><small>{displayArtist(track)} · {track.album || 'Single'}</small></span>
            <em>{track.lastPlayed ? new Date(track.lastPlayed).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}</em>
          </button>
        )) : <div className="history-empty">Play a track and it will appear here, with its last-played time and count.</div>}
      </div>

      <div className="history-side">
        <span className="kicker">LIBRARY PULSE</span>
        <div>
          <strong>{recap?.topTracks[0]?.title || 'Nothing played yet'}</strong>
          <span>{recap?.topTracks[0] ? `${recap.topTracks[0].plays} plays ${blurb}` : 'Your most-played tracks will surface here.'}</span>
        </div>
        <div>
          <strong>{tracks.filter(track => track.favorite).length}</strong>
          <span>favorites held close</span>
        </div>
      </div>
    </section>
  )
}
