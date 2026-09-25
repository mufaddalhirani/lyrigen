import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/common/Icon'
import { Stat } from '../components/common/Stat'
import { LyricsFinder, type FinderTrack } from '../components/LyricsFinder'
import { AiLyricSync, type SyncTarget } from '../components/AiLyricSync'
import { currentSyncJob } from '../lib/lyricSyncJob'
import { displayArtist, prettyTime } from '../lib/format'

/**
 * Lyrics hub: the whole library's lyric coverage in one table. Bulk-fetch
 * the best match for every song that has none (Unison → AMLL → LRCLIB, saved
 * beside the file), or open the finder on one song to pick by hand.
 */

type RowStatus = { status: 'searching' | 'saved' | 'missed'; source?: string | null; message?: string | null; retimed?: boolean; embedded?: boolean }

/** A song sent from the player's "Sync syllables with AI" button. */
export type SyncRequest = { id: number; target: SyncTarget }

export function LyricsHub({ library, onRefresh, flash, request, onRequestHandled }: { library: LibraryTrack[]; onRefresh: () => void; flash: (message: string) => void; request?: SyncRequest | null; onRequestHandled?: () => void }) {
  const [filter, setFilter] = useState<'missing' | 'all'>('missing')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rows, setRows] = useState<Record<string, RowStatus>>({})
  const [busy, setBusy] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const [retime, setRetime] = useState(true)
  const [embed, setEmbed] = useState(true)
  const [finder, setFinder] = useState<FinderTrack | null>(null)

  useEffect(() => window.electronAPI.onLyricsBatchProgress(progress => setRows(current => ({ ...current, [progress.id]: { status: progress.status, source: progress.source, message: progress.message, retimed: progress.retimed } }))), [])

  const tracks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return library
      .filter(track => filter === 'all' || !track.lyricPath)
      .filter(track => !normalized || [track.title, track.artist, track.album].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalized))
      .sort((left, right) => displayArtist(left).localeCompare(displayArtist(right)) || left.title.localeCompare(right.title))
  }, [library, filter, query])

  const counts = useMemo(() => {
    const withLyrics = library.filter(track => track.lyricPath)
    return {
      total: library.length,
      withLyrics: withLyrics.length,
      wordSynced: withLyrics.filter(track => /\.(ttml|yrc)$/i.test(track.lyricPath!)).length,
      missing: library.length - withLyrics.length,
    }
  }, [library])

  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const selectVisible = () => setSelected(new Set(tracks.map(track => track.id)))

  const fetchSelected = async (ids = Array.from(selected)) => {
    const targets = library.filter(track => ids.includes(track.id))
    if (!targets.length) return
    setBusy(true)
    try {
      const results = await window.electronAPI.fetchLyricsForTracks(targets.map(track => ({ id: track.id, audioPath: track.audioPath, title: track.title, artist: track.artist, album: track.album, duration: track.duration })), { overwrite, retime, embed })
      const saved = results.filter(result => result.saved).length
      flash(`${saved} of ${results.length} songs got lyrics.`)
      setSelected(new Set())
      onRefresh()
    } finally { setBusy(false) }
  }

  // Coming back while a sync runs (or just finished) reopens it on that song.
  const [syncTarget, setSyncTarget] = useState<SyncTarget | null>(() => { const job = currentSyncJob(); return job.phase === 'idle' ? null : job.target })
  const syncPanel = useRef<HTMLDivElement>(null)
  const openSync = (track: LibraryTrack) => {
    setSyncTarget({ audioPath: track.audioPath, title: track.title, artist: displayArtist(track), duration: track.duration, lyricPath: track.lyricPath })
    syncPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  useEffect(() => {
    if (!request) return
    setSyncTarget(request.target)
    requestAnimationFrame(() => syncPanel.current?.scrollIntoView({ block: 'start' }))
    onRequestHandled?.()
  }, [request?.id])
  const openFinder = (track: LibraryTrack) => setFinder({ audioPath: track.audioPath, title: track.title, artist: track.artist, album: track.album, duration: track.duration, hasLyricFile: Boolean(track.lyricPath) })

  return <section className="tool-page">
    <div className="tool-hero">
      <span className="hero-kicker">UNISON · AMLL TTML DB · LRCLIB</span>
      <h3>Give every song<br /><i>its words.</i></h3>
      <p>Unison is the crowdsourced lyric database behind the Better Lyrics extension: word-synced TTML and line-synced LRC ranked by community votes, matched by song name or exactly by YouTube video id. Lyrigen saves matches beside your files so they load offline in the player.</p>
      <div className="lyrics-stats"><Stat label="Tracks" value={String(counts.total)} /><Stat label="With lyrics" value={String(counts.withLyrics)} /><Stat label="Word-synced" value={String(counts.wordSynced)} /><Stat label="Missing" value={String(counts.missing)} /></div>
    </div>

    <div ref={syncPanel}><AiLyricSync target={syncTarget} onPickTarget={setSyncTarget} onSaved={onRefresh} flash={flash} /></div>

    <div className="tool-panel">
      <div className="tool-panel-head">
        <div className="row" style={{ alignItems: 'center' }}>
          <div className="segmented-tabs"><button className={filter === 'missing' ? 'active' : ''} onClick={() => setFilter('missing')}>Missing lyrics ({counts.missing})</button><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All songs</button></div>
          <label className="search-field" style={{ height: 32, width: 240 }}><Icon name="search" size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter by title, artist, album" /></label>
        </div>
        <div className="row">
          <button className="mini-button" disabled={!tracks.length} onClick={selectVisible}>Select shown ({tracks.length})</button>
          <button className="mini-button" disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      </div>
      <div className="lyrics-table">
        <div className="lyrics-head"><span /><span>Song</span><span>Album</span><span>Length</span><span>Lyrics</span><span /></div>
        {tracks.map(track => {
          const row = rows[track.id]
          const format = track.lyricPath?.split('.').pop()?.toLocaleUpperCase()
          return <div className="lyrics-row" key={track.id}>
            <input type="checkbox" checked={selected.has(track.id)} onChange={() => toggle(track.id)} aria-label={`Select ${track.title}`} />
            <div className="title"><strong>{track.title}</strong><span>{displayArtist(track)}</span></div>
            <div className="album">{track.album || '—'}</div>
            <div className="duration">{prettyTime(track.duration)}</div>
            <div className="state">
              {row?.status === 'searching' ? <span className="chip">searching…</span>
                : row?.status === 'saved' ? <><span className="chip high">saved{row.retimed ? ' · re-timed' : ''}{row.embedded ? ' · embedded' : ''}</span><small>{row.source}</small></>
                : row?.status === 'missed' ? <><span className="chip low">no match</span><small title={row.message || ''}>{row.message}</small></>
                : track.lyricPath ? <span className={`chip ${format === 'TTML' || format === 'YRC' ? 'sync-richsync' : format === 'LRC' ? 'sync-linesync' : 'sync-plain'}`}>{format === 'TTML' || format === 'YRC' ? `Word-synced · ${format}` : format === 'LRC' ? 'Line-synced · LRC' : 'Plain text'}</span>
                : <span className="chip">none</span>}
            </div>
            <div className="actions"><button className="mini-button" onClick={() => openFinder(track)}>Find…</button><button className="mini-button" title="Time the words with the local AI model" onClick={() => openSync(track)}>AI sync</button></div>
          </div>
        })}
        {!tracks.length && <div className="tool-panel-empty">{library.length ? (filter === 'missing' ? 'Every song has a lyric file. Switch to "All songs" to replace any of them.' : 'No songs match that filter.') : 'Add a library folder first.'}</div>}
      </div>
      <div className="inspect-footer">
        <div className="toggle-list" style={{ display: 'flex', gap: 8 }}>
          <label className="toggle" style={{ padding: '6px 10px' }}><input type="checkbox" checked={retime} onChange={event => setRetime(event.target.checked)} /><span><strong>Re-time for speed edits</strong></span></label>
          <label className="toggle" style={{ padding: '6px 10px' }}><input type="checkbox" checked={embed} onChange={event => setEmbed(event.target.checked)} /><span><strong>Embed in the song file</strong></span></label>
          <label className="toggle" style={{ padding: '6px 10px' }}><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} /><span><strong>Replace existing lyric files</strong></span></label>
        </div>
        <div className="row" style={{ display: 'flex', gap: 8 }}>
          {filter === 'missing' && counts.missing > 0 && <button className="ghost-button" disabled={busy} onClick={() => void fetchSelected(library.filter(track => !track.lyricPath).map(track => track.id))}>{busy ? 'Working…' : `Fetch all ${counts.missing} missing`}</button>}
          <button className="accent-button" disabled={busy || !selected.size} onClick={() => void fetchSelected()}><Icon name="spark" size={15} /> {busy ? 'Working…' : `Fetch for ${selected.size} selected`}</button>
        </div>
      </div>
    </div>
    <p className="attribution">Lyrics from <button onClick={() => void window.electronAPI.openExternal('https://unison.boidu.dev')}>Unison (unison.boidu.dev)</button>, the <button onClick={() => void window.electronAPI.openExternal('https://amll.dev')}>AMLL TTML DB</button> and <button onClick={() => void window.electronAPI.openExternal('https://lrclib.net')}>LRCLIB</button>. Unison's corpus is ODbL-licensed and community-submitted; if a match is wrong you can vote or report it on the site.</p>
    {finder && <LyricsFinder track={finder} onClose={() => setFinder(null)} onSaved={() => { onRefresh() }} />}
  </section>
}
