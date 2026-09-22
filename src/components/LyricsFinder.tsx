import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './common/Icon'
import { parseLyricDocument } from '../lib/lyrics'
import { prettyTime } from '../lib/format'

/**
 * Pick lyrics for one song by hand.
 *
 * Searches Unison (crowdsourced, votes + confidence), the AMLL TTML DB and
 * LRCLIB with the song's metadata, lists every candidate with what it is
 * (word-synced / line-synced / plain, how many votes, how far off in length)
 * and previews the actual lines before anything is written. For sped-up or
 * slowed edits the timings can be stretched to fit the file's duration.
 */

export interface FinderTrack {
  audioPath: string
  title: string
  artist: string | null
  album: string | null
  /** Seconds. */
  duration: number | null
  videoId?: string | null
  hasLyricFile?: boolean
}

interface Props {
  track: FinderTrack
  onClose: () => void
  /** When given (the Player), the chosen lyrics are also loaded into the running view. */
  onApply?: (content: string, format: LyricFormat, sourceLabel: string) => void
  onSaved?: (path: string) => void
}

const SOURCES: Array<{ id: LyricSourceId; label: string }> = [{ id: 'betterlyrics', label: 'Better Lyrics' }, { id: 'binilyrics', label: 'BiniLyrics' }, { id: 'unison', label: 'Unison' }, { id: 'amll', label: 'AMLL' }, { id: 'lrclib', label: 'LRCLIB' }]
const SYNC_LABEL: Record<LyricSync, string> = { syllable: 'Syllable-synced', richsync: 'Word-synced', linesync: 'Line-synced', plain: 'Plain text' }

/** Guess a YouTube id from a yt-dlp style file name so Unison can answer exactly. */
function videoIdFromPath(audioPath: string) {
  return audioPath.match(/[[(]([A-Za-z0-9_-]{11})[\])]\.[A-Za-z0-9]+$/)?.[1] ?? null
}

function cleanForSearch(title: string) {
  return title.replace(/\s*[[(][^)\]]*(?:sped|speed|slowed|reverb|nightcore|lyrics?|official|audio|video|8d|remix)[^)\]]*[)\]]/gi, '').replace(/\s*[|｜].*$/, '').replace(/\s*[[(][A-Za-z0-9_-]{11}[)\]]\s*$/, '').trim()
}

export function LyricsFinder({ track, onClose, onApply, onSaved }: Props) {
  const [song, setSong] = useState(cleanForSearch(track.title))
  const [artist, setArtist] = useState(track.artist || '')
  const [album, setAlbum] = useState(track.album || '')
  const [useDuration, setUseDuration] = useState(true)
  const [sources, setSources] = useState<LyricSourceId[]>(['betterlyrics', 'binilyrics', 'unison', 'amll', 'lrclib'])
  const [busy, setBusy] = useState(false)
  const [candidates, setCandidates] = useState<LyricCandidate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ content: string; format: LyricFormat; retimed: boolean } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [retime, setRetime] = useState(true)
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)
  const videoId = track.videoId ?? videoIdFromPath(track.audioPath)

  const selected = candidates.find(candidate => candidate.id === selectedId) ?? null
  const durationDelta = selected?.duration && track.duration ? selected.duration - track.duration : null
  const speedMismatch = Boolean(durationDelta !== null && track.duration && Math.abs(durationDelta) / track.duration > 0.03 && selected?.format !== 'plain')

  const search = async () => {
    const run = ++generation.current
    setBusy(true); setMessage(''); setCandidates([]); setSelectedId(null); setPreview(null)
    try {
      const results = await window.electronAPI.searchLyricCandidates({ trackName: song.trim(), artistName: artist.trim() || null, albumName: album.trim() || null, duration: useDuration ? track.duration : null, videoId, sources })
      if (run !== generation.current) return
      setCandidates(results)
      if (!results.length) setMessage('Nothing matched. Try fewer words in the title, drop the album, or untick "match length".')
      else setSelectedId(results[0].id)
    } catch {
      if (run === generation.current) setMessage('The lyric services could not be reached.')
    } finally { if (run === generation.current) setBusy(false) }
  }

  useEffect(() => { void search() // eslint-disable-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selected) { setPreview(null); return }
    let active = true
    setPreviewBusy(true)
    window.electronAPI.fetchLyricCandidate(selected, { retimeToDuration: retime && speedMismatch ? track.duration : null })
      .then(result => { if (active) setPreview(result) })
      .catch(() => { if (active) setPreview(null) })
      .finally(() => { if (active) setPreviewBusy(false) })
    return () => { active = false }
  }, [selected, retime, speedMismatch, track.duration])

  const lines = useMemo(() => {
    if (!preview) return []
    try {
      const document = parseLyricDocument(preview.content, preview.format === 'plain' ? 'txt' : preview.format, (track.duration ?? 0) * 1000)
      return document.lines.slice(0, 120).map(line => ({ time: line.startTime, text: line.words.map(word => word.word).join(''), translation: line.translatedLyric }))
    } catch {
      return preview.content.split(/\r?\n/).filter(Boolean).slice(0, 120).map(text => ({ time: 0, text, translation: '' }))
    }
  }, [preview, track.duration])

  const save = async (overwrite = false) => {
    if (!selected || !preview) return
    setSaving(true); setMessage('')
    const result = await window.electronAPI.saveLyricFile(track.audioPath, preview.content, preview.format, { overwrite, embed: true })
    setSaving(false)
    if (result.saved && result.path) { setMessage(`Saved ${result.path.split(/[\\/]/).pop()} beside the song${result.embedded ? ' and into its tags' : ''}.`); onSaved?.(result.path); onApply?.(preview.content, preview.format, selected.sourceLabel) }
    else if (result.path && !overwrite) {
      if (window.confirm(`${result.path.split(/[\\/]/).pop()} already exists. Replace it? The old file is backed up first.`)) return save(true)
    } else setMessage(result.message || 'Could not save the lyric file.')
  }

  const toggleSource = (id: LyricSourceId) => setSources(current => current.includes(id) ? (current.length > 1 ? current.filter(item => item !== id) : current) : [...current, id])

  return <div className="finder-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="finder-dialog" role="dialog" aria-modal="true" aria-label="Lyrics finder">
      <div className="finder-head">
        <div><span className="kicker">LYRICS FINDER</span><h3>{track.title}</h3><p>{track.artist || 'Unknown artist'}{track.album ? ` · ${track.album}` : ''}{track.duration ? ` · ${prettyTime(track.duration)}` : ''}{videoId ? ` · YouTube ${videoId}` : ''}</p></div>
        <button onClick={onClose} aria-label="Close lyrics finder"><Icon name="close" size={17} /></button>
      </div>
      <form className="finder-search" onSubmit={event => { event.preventDefault(); void search() }}>
        <label><span>Song</span><input value={song} onChange={event => setSong(event.target.value)} /></label>
        <label><span>Artist</span><input value={artist} onChange={event => setArtist(event.target.value)} placeholder="Any" /></label>
        <label><span>Album</span><input value={album} onChange={event => setAlbum(event.target.value)} placeholder="Any" /></label>
        <div className="sources">{SOURCES.map(source => <button type="button" key={source.id} className={sources.includes(source.id) ? 'on' : ''} onClick={() => toggleSource(source.id)}>{source.label}</button>)}<button type="button" className={useDuration ? 'on' : ''} onClick={() => setUseDuration(value => !value)} title="Prefer entries whose length matches this file">Match length</button></div>
        <button type="submit" className="accent-button" disabled={busy || !song.trim()}>{busy ? 'Searching…' : 'Search'}</button>
      </form>
      <div className="finder-body">
        <div className="finder-results">
          {candidates.map(candidate => {
            const delta = candidate.duration && track.duration ? Math.round(candidate.duration - track.duration) : null
            const exact = Boolean(videoId && candidate.videoId === videoId)
            return <button key={candidate.id} className={`finder-result ${candidate.id === selectedId ? 'active' : ''}`} onClick={() => setSelectedId(candidate.id)}>
              <div>
                <strong>{candidate.song}</strong>
                <span>{candidate.artist || 'Unknown artist'}{candidate.album ? ` · ${candidate.album}` : ''}{candidate.submitter ? ` · by ${candidate.submitter}` : ''}</span>
                <div className="badges">
                  <span className={`chip source-${candidate.source}`}>{candidate.sourceLabel}</span>
                  <span className={`chip sync-${candidate.syncType}`}>{SYNC_LABEL[candidate.syncType]}</span>
                  {exact && <span className="chip exact">Exact video match</span>}
                  {candidate.source === 'unison' && <span className={`chip ${candidate.confidence}`}>{candidate.confidence} confidence</span>}
                  {candidate.language && <span className="chip">{candidate.language}</span>}
                  {delta !== null && <span className={`chip ${Math.abs(delta) <= 3 ? 'high' : Math.abs(delta) > 20 ? 'low' : ''}`}>{delta === 0 ? 'same length' : `${delta > 0 ? '+' : ''}${delta}s`}</span>}
                </div>
              </div>
              <div className="side">{candidate.votes !== null && <><b>{candidate.votes}</b>votes</>}<span>{Math.round(candidate.match * 100)}% match</span></div>
            </button>
          })}
          {!candidates.length && <div className="finder-empty">{busy ? 'Searching Better Lyrics, BiniLyrics, Unison, AMLL and LRCLIB…' : message || 'Search to see candidates.'}</div>}
        </div>
        <div className="finder-preview">
          <div className="finder-preview-head">
            {selected ? <>
              <span className={`chip source-${selected.source}`}>{selected.sourceLabel}</span>
              <span>{preview ? `${preview.format.toUpperCase()} · ${lines.length}${lines.length === 120 ? '+' : ''} lines` : previewBusy ? 'Loading…' : 'Preview unavailable'}</span>
              {preview?.retimed && <span className="chip variant">re-timed to this file</span>}
              <span className="spacer" />
              {speedMismatch && <label className="toggle" style={{ padding: '4px 8px' }}><input type="checkbox" checked={retime} onChange={event => setRetime(event.target.checked)} /><span><strong style={{ fontSize: 10.5 }}>Fit timing to this file</strong><small>Source is {durationDelta! > 0 ? 'longer' : 'shorter'} by {Math.abs(Math.round(durationDelta!))}s — likely a speed edit</small></span></label>}
              {selected.sourceUrl && <button className="mini-button" onClick={() => void window.electronAPI.openExternal(selected.sourceUrl!)}>Open source ↗</button>}
            </> : <span>Select a candidate to preview it.</span>}
          </div>
          <div className="finder-lines">
            {lines.map((line, index) => <div key={index}><span>{line.time ? prettyTime(line.time / 1000) : ''}</span><em>{line.text}{line.translation && <i>{line.translation}</i>}</em></div>)}
            {selected && !lines.length && !previewBusy && <div className="finder-empty">This entry has no readable lines.</div>}
          </div>
        </div>
      </div>
      <div className="finder-foot">
        <p>{message || (track.hasLyricFile ? 'This song already has a lyric file; saving will ask before replacing it.' : 'Saving writes a .ttml / .lrc / .txt beside the song so it loads offline next time.')} Lyrics from Better Lyrics (better-lyrics.boidu.dev), Unison (unison.boidu.dev), the AMLL TTML DB and LRCLIB.</p>
        <div className="row">
          {onApply && <button className="ghost-button" disabled={!preview || !lines.length} onClick={() => { if (preview && selected) { onApply(preview.content, preview.format, selected.sourceLabel); onClose() } }}>Use now</button>}
          <button className="accent-button" disabled={!preview || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Use these lyrics'}</button>
        </div>
      </div>
    </section>
  </div>
}
