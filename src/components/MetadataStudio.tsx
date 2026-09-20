import { useEffect, useRef, useState } from 'react'

interface Row { file: string; current: AudioMetadata; result?: TrackLookupResult; selected: boolean; status: string }
const fields = ['title', 'artist', 'album', 'albumArtist', 'releaseDate', 'year', 'genre', 'trackNumber', 'discNumber'] as const
const labels: Record<string, string> = { title: 'Title', artist: 'Artists / singers', album: 'Album', albumArtist: 'Album artist', releaseDate: 'Release date', year: 'Year', genre: 'Genre', trackNumber: 'Track', discNumber: 'Disc' }
export function MetadataStudio({ library, onApplied }: { library: LibraryTrack[]; onApplied: () => void }) {
  const [rows, setRows] = useState<Row[]>([])
  const [focused, setFocused] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const cancel = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancel.current = true } }, [])
  const update = (file: string, patch: Partial<Row>) => { if (mounted.current) setRows(current => current.map(row => row.file === file ? { ...row, ...patch } : row)) }
  const load = async (paths: string[]) => {
    if (!paths.length) return
    setBusy(true); setProgress('Reading file tags…')
    try {
      const result = await window.electronAPI.inspectAudioFiles(paths)
      if (!mounted.current) return
      setRows(result.map(file => ({ file: file.filePath, current: file.metadata, selected: false, status: 'Ready to look up' })))
      setFocused(result[0]?.filePath ?? '')
      setProgress(`${result.length} files ready`)
    } catch { setProgress('Some files could not be read.') } finally { if (mounted.current) setBusy(false) }
  }
  const lookup = async (onlyFailed = false) => {
    cancel.current = false; setBusy(true)
    try {
      const targets = rows.filter(row => !onlyFailed || !row.result?.found)
      for (let index = 0; index < targets.length && !cancel.current; index++) {
        const row = targets[index]
        setProgress(`Looking up ${index + 1} of ${targets.length}${onlyFailed ? ' (retrying failed)' : ''}`)
        update(row.file, { status: 'Searching MusicBrainz…' })
        try {
          const result = await window.electronAPI.lookupTrackMetadata({ title: row.current.title || row.file.split(/[\\/]/).pop() || '', artist: row.current.artist || undefined, album: row.current.album || undefined, duration: row.current.duration })
          update(row.file, { result, selected: result.found && result.confidence === 'high', status: result.found ? `${result.confidence} confidence · review` : result.message || 'No match' })
        } catch { update(row.file, { selected: false, status: 'Service unavailable — retry later' }) }
      }
      if (mounted.current) setProgress(cancel.current ? 'Stopped. Completed results are kept.' : 'Review the matches before applying. Only high-confidence matches are selected automatically.')
    } finally { if (mounted.current) setBusy(false) }
  }
  const failedCount = rows.filter(row => !row.result?.found).length
  const apply = async () => {
    cancel.current = false; setBusy(true); let written = 0
    const selected = rows.filter(row => row.selected && row.result?.found)
    try {
      for (const row of selected) {
        if (cancel.current) break
        setProgress(`Applying ${written + 1} of ${selected.length}`)
        try {
          const result = await window.electronAPI.writeTrackMetadata({ filePath: row.file, metadata: { title: row.current.title || '', artist: row.current.artist || '', album: row.current.album || '', albumArtist: row.current.albumArtist || '', year: String(row.current.year || ''), genre: row.current.genre || '', trackNumber: String(row.current.trackNumber || ''), discNumber: String(row.current.discNumber || ''), ...row.result!.metadata }, coverData: row.result!.coverData, coverMime: row.result!.coverMime, source: row.result!.source, sourceUrl: row.result!.sourceUrl, backupOriginal: true })
          if (result.written) written++
          update(row.file, { selected: false, status: result.written ? `Applied · ${result.mode === 'embedded' ? 'MP3 tags + artwork' : 'Lyrigen sidecar'}` : result.message || 'Could not apply' })
        } catch { update(row.file, { status: 'Could not write this file. Check folder access.' }) }
      }
      if (mounted.current) setProgress(`${written} files updated. Originals are recoverable through Undo.`)
      if (written) onApplied()
    } finally { if (mounted.current) setBusy(false) }
  }
  const row = rows.find(item => item.file === focused)
  const selectedCount = rows.filter(item => item.selected).length
  return <section className="metadata-studio">
    <div className="studio-intro"><div><span className="kicker">METADATA STUDIO</span><h3>Give every song its details.</h3><p>Research titles, artists, albums, release dates and covers from MusicBrainz and Cover Art Archive.</p></div><button className="ghost-button" disabled={busy} onClick={async () => { const result = await window.electronAPI.undoLastFileEdit(); setProgress(result.message || 'Undo complete'); if (result.undone) onApplied() }}>Undo last edit</button></div>
    <div className="studio-toolbar"><button className="accent-button" disabled={busy} onClick={() => void window.electronAPI.selectAudioFiles().then(load)}>Add audio files</button><button className="ghost-button" disabled={busy} onClick={() => void window.electronAPI.selectAudioFolder().then(load)}>Add a folder</button><button className="ghost-button" disabled={busy || !library.length} onClick={() => void load(library.map(track => track.audioPath))}>Use library ({library.length})</button><button className="ghost-button" disabled={busy || !rows.length} onClick={() => void lookup()}>Research all</button>{rows.some(row => row.result) && failedCount > 0 && <button className="ghost-button" disabled={busy} onClick={() => void lookup(true)}>Retry failed ({failedCount})</button>}{busy && <button className="ghost-button" onClick={() => { cancel.current = true; setProgress('Stopping after the current file…') }}>Stop</button>}</div>
    <p className="studio-status" role="status">{progress || 'Add files to start. Searches send song tags, never your audio recordings.'}</p>
    <div className="studio-workspace"><div className="studio-files"><div className="studio-list-head"><span>{rows.length} files · {selectedCount} selected</span><button disabled={busy} onClick={() => setRows(current => current.map(item => ({ ...item, selected: item.result?.confidence === 'high' })))}>Select high confidence</button></div>{rows.map(item => <div key={item.file} className={`studio-file ${focused === item.file ? 'selected' : ''}`}><input type="checkbox" aria-label={`Apply ${item.current.title || item.file}`} checked={item.selected} disabled={busy || !item.result?.found} onChange={event => update(item.file, { selected: event.target.checked })} /><button onClick={() => setFocused(item.file)}><strong>{item.current.title || item.file.split(/[\\/]/).pop()}</strong><span>{item.current.artist || 'Unknown artist'}</span><small>{item.status}</small></button></div>)}{!rows.length && <div className="studio-empty">Add one song or a whole music folder.<br />Your matches will appear here.</div>}</div>
    <div className="studio-review">{row ? <><div className="studio-review-head">{(row.result?.coverData || row.current.cover) && <img src={row.result?.coverData || row.current.cover || ''} alt="Proposed album cover" />}<div><h3>{row.result?.metadata?.title || row.current.title || 'Review details'}</h3><p>{row.result?.source || 'Current file tags'}{row.result?.confidence ? ` · ${row.result.confidence} confidence` : ''}</p>{row.result?.sourceUrl && <button className="text-link" onClick={() => void window.electronAPI.openExternal(row.result!.sourceUrl!)}>View source ↗</button>}</div></div><div className="tag-comparison"><div className="comparison-header"><span>FIELD</span><span>CURRENT</span><span>PROPOSED</span></div>{fields.map(field => <label key={field}><span>{labels[field]}</span><span>{String(row.current[field as keyof AudioMetadata] || '—')}</span><input aria-label={`Proposed ${labels[field]}`} disabled={busy || !row.result?.found} value={String(row.result?.metadata?.[field] || '')} onChange={event => update(row.file, { result: { ...row.result!, metadata: { ...row.result!.metadata, [field]: event.target.value } } })} placeholder="Keep current" /></label>)}</div><p className="studio-file-path">{row.file}</p></> : <div className="studio-empty">Compare the catalog result with your existing tags before applying.</div>}</div></div>
    <div className="studio-footer"><p>MP3 tags are embedded without removing unrelated tags. Other formats use a sidecar that Lyrigen reads. Missing catalog fields keep your current values.</p><button className="accent-button" disabled={busy || !selectedCount} onClick={() => void apply()}>Apply selected ({selectedCount})</button></div>
  </section>
}
