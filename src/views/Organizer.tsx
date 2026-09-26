import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/common/Icon'
import { prettyTime } from '../lib/format'
import { loadAppSettings } from '../lib/appSettings'

/**
 * Organizer: take folders of loose downloads ("title (sped up) [id].m4a"),
 * work out artist / title / variant for each, show the proposed move, let the
 * person correct anything, then move files (and their lyric / cover
 * sidecars) into the chosen layout. Nothing moves until "Move" is pressed,
 * and the last batch can be undone.
 */

const VARIANTS: Array<SongVariant | ''> = ['', 'Sped Up', 'Nightcore', 'Slowed', 'Slowed + Reverb', 'Reverb', 'Lo-Fi', 'Daycore', '8D', 'Bass Boosted', 'Remix', 'Acoustic', 'Live', 'Instrumental', 'Karaoke', 'Cover', 'Mashup']

type RowState = { status: 'moving' | 'tagging' | 'lyrics' | 'done' | 'error' | 'skipped'; message: string }

export function Organizer({ libraryRoots, flash }: { libraryRoots: string[]; flash: (message: string) => void }) {
  const [settings, setSettings] = useState<DownloadSettings | null>(null)
  const [presets, setPresets] = useState<PathPreset[]>([])
  const [sources, setSources] = useState<string[]>([])
  const [destination, setDestination] = useState('')
  const [template, setTemplate] = useState('')
  const [includeClean, setIncludeClean] = useState(false)
  const [rewriteTags, setRewriteTags] = useState(true)
  const [fetchLyrics, setFetchLyrics] = useState(true)
  const [retime, setRetime] = useState(true)
  const [embedLyrics, setEmbedLyrics] = useState(true)
  const [plan, setPlan] = useState<OrganizePlanItem[]>([])
  const [scanning, setScanning] = useState<{ completed: number; total: number } | null>(null)
  const [applying, setApplying] = useState(false)
  const [rows, setRows] = useState<Record<string, RowState>>({})
  // The latest results, for code that runs after an await (state would be stale there).
  const rowsRef = useRef<Record<string, RowState>>({})
  const [canUndo, setCanUndo] = useState(false)
  const replanTimers = useRef(new Map<string, number>())

  useEffect(() => {
    let active = true
    void window.electronAPI.getDownloadSettings().then(result => {
      if (!active) return
      setSettings(result.settings); setPresets(result.presets)
      setDestination(current => current || libraryRoots[0] || result.settings.destination)
      setTemplate(current => current || result.settings.pathTemplate)
    })
    void window.electronAPI.canUndoOrganize().then(value => { if (active) setCanUndo(value) })
    const off = window.electronAPI.onOrganizeProgress(progress => {
      if (progress.phase === 'planning') setScanning({ completed: progress.completed, total: progress.total })
      else setRows(current => { const next = { ...current, [progress.id]: { status: progress.status, message: progress.message } }; rowsRef.current = next; return next })
    })
    return () => { active = false; off() }
  }, [libraryRoots])

  const addFolders = async () => { const chosen = await window.electronAPI.chooseOrganizeSources(); if (chosen.length) setSources(current => Array.from(new Set([...current, ...chosen]))) }

  const scan = async () => {
    if (!sources.length) return
    setScanning({ completed: 0, total: 0 }); setRows({}); setPlan([])
    try {
      const result = await window.electronAPI.planOrganize(sources, { destination, pathTemplate: template, includeCleanFiles: includeClean })
      setPlan(result)
      if (!result.length) flash(includeClean ? 'Everything is already where the layout says it should be.' : 'No messy files found. Tick "include clean files" to re-file tagged songs too.')
    } finally { setScanning(null) }
  }

  const edit = (id: string, patch: Partial<SongMetadata>) => {
    setPlan(current => current.map(item => item.id === id ? { ...item, metadata: { ...item.metadata, ...patch, origin: 'manual', confidence: 'high' } } : item))
    const timer = replanTimers.current.get(id)
    if (timer) window.clearTimeout(timer)
    replanTimers.current.set(id, window.setTimeout(async () => {
      const item = planRef.current.find(entry => entry.id === id)
      if (!item) return
      const replanned = await window.electronAPI.replanOrganizeItem(item, { destination, pathTemplate: template })
      setPlan(current => current.map(entry => entry.id === id ? { ...entry, proposedPath: replanned.proposedPath, metadata: { ...entry.metadata, albumArtist: replanned.metadata.albumArtist } } : entry))
    }, 300))
  }
  const planRef = useRef(plan)
  planRef.current = plan

  // Layout/destination changes re-path every row without re-probing files.
  useEffect(() => {
    if (!plan.length) return
    let active = true
    void Promise.all(plan.map(item => window.electronAPI.replanOrganizeItem(item, { destination, pathTemplate: template }))).then(result => { if (active) setPlan(current => current.map(item => { const next = result.find(entry => entry.id === item.id); return next ? { ...item, proposedPath: next.proposedPath } : item })) })
    return () => { active = false }
  }, [destination, template]) // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async () => {
    const selected = plan.filter(item => item.selected)
    if (!selected.length) return
    // Settings → Confirm before filing files.
    if ((await loadAppSettings()).confirmDestructive && !window.confirm(`Move ${selected.length} song${selected.length === 1 ? '' : 's'} into ${destination || 'the library'}? Undo can put the batch back.`)) return
    setApplying(true); setRows({}); rowsRef.current = {}
    try {
      const result = await window.electronAPI.applyOrganize(plan, { destination, pathTemplate: template, rewriteTags, fetchLyrics, retimeLyrics: retime, embedLyrics })
      flash(`${result.done} song${result.done === 1 ? '' : 's'} filed.`)
      setCanUndo(await window.electronAPI.canUndoOrganize())
      // Songs that failed stay in the plan so they can be tried again.
      setPlan(current => current.filter(item => !item.selected || rowsRef.current[item.id]?.status === 'error'))
    } finally { setApplying(false) }
  }

  const undo = async () => { const result = await window.electronAPI.undoOrganize(); flash(result.message); setCanUndo(await window.electronAPI.canUndoOrganize()) }

  const selectedCount = plan.filter(item => item.selected).length
  const stats = useMemo(() => ({ low: plan.filter(item => item.metadata.confidence === 'low').length, variants: plan.filter(item => item.metadata.variant).length, withLyrics: plan.filter(item => item.hasLyrics).length }), [plan])
  const relative = (target: string) => target.toLocaleLowerCase().startsWith(destination.toLocaleLowerCase()) ? target.slice(destination.length).replace(/^[\\/]/, '') : target

  return <section className="tool-page">
    <div className="tool-hero">
      <span className="hero-kicker">AUTO FILE SORT</span>
      <h3>Every download<br /><i>in its place.</i></h3>
      <p>Point this at folders full of downloads named like "all the stars - kendrick lamar (sped up) [g7eBUcivTE0].m4a". Lyrigen reads each file's real length and tags, works out the artist, title and edit type, and shows exactly where it would move each one before it touches anything. Lyric and cover files travel with their song.</p>
      <div className="plan-toolbar">
        <button className="accent-button" onClick={() => void addFolders()}><Icon name="folder" size={15} /> Choose folders…</button>
        {libraryRoots.length > 0 && <button className="ghost-button" onClick={() => setSources(current => Array.from(new Set([...current, ...libraryRoots])))}>Use library folders</button>}
        {settings && <button className="ghost-button" onClick={() => setSources(current => Array.from(new Set([...current, settings.destination])))}>Use download folder</button>}
        {canUndo && <button className="ghost-button" onClick={() => void undo()}><Icon name="undo" size={14} /> Undo last move</button>}
      </div>
      {sources.length > 0 && <div className="plan-sources" style={{ marginTop: 10 }}>{sources.map(source => <span key={source} title={source}><Icon name="folder" size={12} /><em>{source}</em><button aria-label={`Remove ${source}`} onClick={() => setSources(current => current.filter(item => item !== source))}>×</button></span>)}</div>}
    </div>

    <div className="tool-columns">
      <div className="tool-panel">
        <div className="tool-panel-head">
          <strong>Plan</strong>
          <div className="row">
            {plan.length > 0 && <span>{plan.length} files · {selectedCount} selected{stats.low ? ` · ${stats.low} low-confidence unticked` : ''}{stats.variants ? ` · ${stats.variants} speed/edit variants` : ''}</span>}
            {plan.length > 0 && <button className="mini-button" onClick={() => setPlan(current => current.map(item => ({ ...item, selected: true })))}>Select all</button>}
            {plan.length > 0 && <button className="mini-button" onClick={() => setPlan(current => current.map(item => ({ ...item, selected: item.metadata.confidence !== 'low' })))}>Confident only</button>}
          </div>
        </div>
        <div className="inspect-footer">
          <p>{plan.length ? 'Sidecar lyrics, covers and Lyrigen metadata move with each song. Undo puts the last batch back.' : 'Files are only ever moved, never deleted. Tag rewrites keep the audio stream untouched.'}</p>
          <div className="row" style={{ display: 'flex', gap: 8 }}>
            <button className="ghost-button" disabled={!sources.length || Boolean(scanning) || applying} onClick={() => void scan()}><Icon name="search" size={15} /> {scanning ? 'Scanning…' : plan.length ? 'Rescan' : 'Scan'}</button>
            <button className="accent-button" disabled={!selectedCount || applying || Boolean(scanning)} onClick={() => void apply()}>{applying ? 'Moving…' : `Move ${selectedCount} file${selectedCount === 1 ? '' : 's'}`}</button>
          </div>
        </div>
        <div className="plan-table">
          {plan.length > 0 && <div className="plan-head"><span /><span>Current file</span><span>Detected song</span><span>Moves to</span></div>}
          {plan.map(item => {
            const state = rows[item.id]
            return <div className={`plan-row ${item.selected ? '' : 'deselected'}`} key={item.id}>
              <input type="checkbox" checked={item.selected} disabled={applying} onChange={event => setPlan(current => current.map(entry => entry.id === item.id ? { ...entry, selected: event.target.checked } : entry))} aria-label={`Include ${item.fileName}`} />
              <div className="plan-current"><strong title={item.sourcePath}>{item.fileName}</strong><span>{item.reason}{item.duration ? ` · ${prettyTime(item.duration)}` : ''}{item.currentTags.artist ? ` · tagged "${item.currentTags.artist}"` : ''}</span></div>
              <div className="plan-edit">
                <input value={item.metadata.artist || ''} disabled={applying} placeholder="Artist" aria-label="Artist" onChange={event => edit(item.id, { artist: event.target.value || null })} />
                <input value={item.metadata.title} disabled={applying} placeholder="Title" aria-label="Title" onChange={event => edit(item.id, { title: event.target.value })} />
                <input value={item.metadata.album || ''} disabled={applying} placeholder={item.metadata.variant || 'Singles'} aria-label="Album" onChange={event => edit(item.id, { album: event.target.value || null })} />
                <select value={item.metadata.variant || ''} disabled={applying} aria-label="Variant" onChange={event => edit(item.id, { variant: (event.target.value || null) as SongVariant | null })}>{VARIANTS.map(variant => <option key={variant} value={variant}>{variant || 'Original'}</option>)}</select>
                <div className="chips"><span className={`chip ${item.metadata.confidence}`}>{item.metadata.origin === 'manual' ? 'edited' : item.metadata.origin === 'tags' ? 'from tags' : `${item.metadata.confidence} confidence`}</span>{item.metadata.featuring && <span className="chip">feat. {item.metadata.featuring}</span>}{item.hasLyrics && <span className="chip high">has lyrics</span>}{item.videoId && <span className="chip">yt {item.videoId}</span>}</div>
              </div>
              <div className="plan-target"><span>{relative(item.proposedPath)}</span>{state && <small className={state.status === 'done' ? 'ok' : state.status === 'error' ? 'error' : ''}>{state.message}</small>}</div>
            </div>
          })}
          {!plan.length && <div className="tool-panel-empty">{scanning ? 'Reading files…' : sources.length ? 'Press Scan to see what would move.' : 'Choose one or more folders to start.'}</div>}
        </div>
        {scanning && <div className="progress-line"><span>Scanning {scanning.completed} / {scanning.total || '…'}</span><div className="bar"><i style={{ '--progress': `${scanning.total ? scanning.completed / scanning.total * 100 : 5}%` } as React.CSSProperties} /></div></div>}
      </div>

      <aside className="tool-panel">
        <div className="tool-panel-head"><strong>Layout</strong></div>
        <div className="tool-panel-body settings-grid">
          <div className="field"><span>Destination</span><div className="path-field"><input type="text" value={destination} onChange={event => setDestination(event.target.value)} /><button onClick={() => void window.electronAPI.chooseDownloadFolder(destination).then(folder => { if (folder) setDestination(folder) })}>Browse</button></div></div>
          <label><span>Folder layout</span><select value={presets.some(preset => preset.template === template) ? template : 'custom'} onChange={event => { if (event.target.value !== 'custom') setTemplate(event.target.value) }}>{presets.map(preset => <option key={preset.id} value={preset.template}>{preset.label}</option>)}<option value="custom">Custom template</option></select></label>
          <label><span>Template</span><input type="text" value={template} onChange={event => setTemplate(event.target.value)} spellCheck={false} /></label>
          <p className="settings-note">{presets.find(preset => preset.template === template)?.hint ?? 'Fields: {artist} {album} {title} {variant} {year} {genre} {id}; add a fallback with a pipe, e.g. {album|Singles}.'}</p>
          <div className="toggle-list">
            <label className="toggle"><input type="checkbox" checked={includeClean} onChange={event => setIncludeClean(event.target.checked)} /><span><strong>Include files that already have clean tags</strong><small>Off = only fix files that look like raw downloads (uploader as artist, [videoId] names, YouTube categories as genre).</small></span></label>
            <label className="toggle"><input type="checkbox" checked={rewriteTags} onChange={event => setRewriteTags(event.target.checked)} /><span><strong>Write clean tags</strong><small>ffmpeg rewrites title / artist / album in place (stream copy, no quality loss) and drops YouTube descriptions.</small></span></label>
            <label className="toggle"><input type="checkbox" checked={fetchLyrics} onChange={event => setFetchLyrics(event.target.checked)} /><span><strong>Fetch missing lyrics</strong><small>Unison by video id first, then AMLL TTML DB and LRCLIB.</small></span></label>
            <label className="toggle"><input type="checkbox" checked={embedLyrics} disabled={!fetchLyrics} onChange={event => setEmbedLyrics(event.target.checked)} /><span><strong>Embed lyrics in the file</strong><small>Writes the words into the song's own tags so other players see them. The synced sidecar stays for Lyrigen.</small></span></label>
            <label className="toggle"><input type="checkbox" checked={retime} onChange={event => setRetime(event.target.checked)} /><span><strong>Re-time lyrics for speed edits</strong></span></label>
          </div>
          <p className="settings-note">Tip: set the destination to a library folder so the sorted songs appear in Lyrigen straight away. Turn on the inbox watcher in Downloads → options to do this automatically for anything new.</p>
        </div>
      </aside>
    </div>
  </section>
}
