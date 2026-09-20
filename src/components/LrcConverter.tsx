import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { convertLrcToTtml, ttmlFileName, type LrcConversionResult } from '../lib/lrcToTtml'

type ConverterDocument = {
  id: string
  name: string
  source: string
  sourcePath?: string
  result: LrcConversionResult
}

type LrcInput = { name: string; source: string; sourcePath?: string }

function FileGlyph() {
  return <svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.8h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1Z" /><path d="M14 3.8v4h4M8 12h8M8 16h6" /></svg>
}

function DownloadGlyph() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14" /></svg>
}

function readBrowserFile(file: File): Promise<LrcInput> {
  return file.text().then(source => ({ name: file.name, source, sourcePath: (file as File & { path?: string }).path }))
}

export function LrcConverter({ onMessage }: { onMessage?: (message: string) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [documents, setDocuments] = useState<ConverterDocument[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isPicking, setIsPicking] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [localMessage, setLocalMessage] = useState('')

  const selected = documents.find(document => document.id === selectedId) ?? documents[0] ?? null
  const totalLines = useMemo(() => documents.reduce((sum, document) => sum + document.result.cues.length, 0), [documents])
  const notify = (message: string) => {
    setLocalMessage(message)
    onMessage?.(message)
  }

  const addInputs = (inputs: LrcInput[]) => {
    const nextDocuments = inputs.map((input, index): ConverterDocument => ({
      id: `${input.name}-${input.source.length}-${Date.now()}-${index}`,
      name: input.name,
      source: input.source,
      sourcePath: input.sourcePath,
      result: convertLrcToTtml(input.source),
    }))
    if (!nextDocuments.length) return
    setDocuments(current => [...current, ...nextDocuments])
    setSelectedId(nextDocuments[nextDocuments.length - 1].id)
    notify(`${nextDocuments.length} LRC ${nextDocuments.length === 1 ? 'file is' : 'files are'} ready to convert.`)
  }

  const handleBrowserFiles = async (files: FileList | File[]) => {
    const candidates = Array.from(files).filter(file => file.name.toLocaleLowerCase().endsWith('.lrc'))
    if (!candidates.length) {
      notify('Choose an .lrc file to get started.')
      return
    }
    addInputs(await Promise.all(candidates.map(readBrowserFile)))
  }

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void handleBrowserFiles(event.target.files)
    event.target.value = ''
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    if (event.dataTransfer.files.length) void handleBrowserFiles(event.dataTransfer.files)
  }

  const chooseFiles = async () => {
    setIsPicking(true)
    try {
      const files = await window.electronAPI.chooseLrcFiles()
      addInputs(files.map(file => ({ name: file.name, source: file.content, sourcePath: file.path })))
    } catch {
      notify('Lyrigen could not open those files.')
    } finally {
      setIsPicking(false)
    }
  }

  const downloadTtml = (document: ConverterDocument) => {
    const url = URL.createObjectURL(new Blob([document.result.ttml], { type: 'application/ttml+xml;charset=utf-8' }))
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = ttmlFileName(document.name)
    anchor.click()
    URL.revokeObjectURL(url)
    notify(`${ttmlFileName(document.name)} downloaded.`)
  }

  const saveBesideSource = async (document: ConverterDocument) => {
    if (!document.sourcePath) {
      downloadTtml(document)
      notify('This dropped file does not expose its folder, so the TTML was downloaded instead.')
      return
    }
    setIsSaving(true)
    try {
      const result = await window.electronAPI.saveTtmlFile(document.sourcePath, document.result.ttml)
      notify(result.saved ? `${ttmlFileName(document.name)} saved beside the LRC.` : (result.message || 'Could not save the TTML file.'))
    } catch {
      notify('Could not save the TTML file beside the LRC.')
    } finally {
      setIsSaving(false)
    }
  }

  const saveAllBesideSources = async () => {
    const readyDocuments = documents.filter(document => document.sourcePath && document.result.cues.length)
    if (!readyDocuments.length) {
      notify('Use Choose files when you want to save a batch beside the originals.')
      return
    }
    setIsSaving(true)
    try {
      const results = await Promise.all(readyDocuments.map(document => window.electronAPI.saveTtmlFile(document.sourcePath!, document.result.ttml)))
      const savedCount = results.filter(result => result.saved).length
      notify(`${savedCount} of ${readyDocuments.length} TTML ${savedCount === 1 ? 'file' : 'files'} saved beside the originals.`)
    } catch {
      notify('Some TTML files could not be saved.')
    } finally {
      setIsSaving(false)
    }
  }

  const removeSelected = () => {
    if (!selected) return
    const next = documents.filter(document => document.id !== selected.id)
    setDocuments(next)
    setSelectedId(next[0]?.id ?? '')
    notify('Removed from the conversion queue.')
  }

  return <div className="converter-page">
    <section className="converter-intro liquid-panel">
      <div>
        <span className="free-badge">LOCAL TOOL · NO UPLOADS</span>
        <h2>Turn LRC into TTML in one calm pass.</h2>
        <p>Drop timestamped lyrics here. Lyrigen keeps the original timing, estimates gentle word flow for Apple-style playback, and writes a ready-to-use TTML file.</p>
      </div>
      <div className="converter-steps" aria-label="Conversion steps"><span><b>01</b><em>Drop</em></span><i /> <span><b>02</b><em>Review</em></span><i /> <span><b>03</b><em>Export</em></span></div>
    </section>

    <div className="converter-workspace">
      <section className="converter-input-panel liquid-panel">
        <div className="converter-panel-heading"><div><span>INPUT QUEUE</span><h3>{documents.length ? `${documents.length} ${documents.length === 1 ? 'file' : 'files'} loaded` : 'Start with an LRC file'}</h3></div><button className="secondary-glass-button converter-pick-button" onClick={() => void chooseFiles()} disabled={isPicking}>{isPicking ? 'Opening…' : 'Choose files'}</button></div>
        <div className={`lrc-dropzone ${isDragging ? 'is-dragging' : ''}`} onDragEnter={event => { event.preventDefault(); setIsDragging(true) }} onDragOver={event => event.preventDefault()} onDragLeave={event => { if (event.currentTarget === event.target) setIsDragging(false) }} onDrop={handleDrop} onClick={() => inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click() }}>
          <input ref={inputRef} type="file" accept=".lrc,text/plain" multiple onChange={handleInputChange} />
          <div className="dropzone-icon"><FileGlyph /></div><strong>Drop .lrc files here</strong><span>or click to browse from this computer</span><small>Multiple files are supported</small>
        </div>
        {documents.length > 0 && <div className="conversion-list">{documents.map(document => <button className={`conversion-list-row ${selected?.id === document.id ? 'active' : ''} ${document.result.cues.length ? '' : 'invalid'}`} key={document.id} onClick={() => setSelectedId(document.id)}><span className="conversion-status">{document.result.cues.length ? '✓' : '!'}</span><span><strong>{document.name}</strong><small>{document.result.cues.length ? `${document.result.cues.length} timed lines` : 'No timestamps found'}</small></span><em>{document.result.cues.length ? 'READY' : 'CHECK'}</em></button>)}</div>}
        {documents.length > 1 && <div className="queue-actions"><button className="clear-queue-button" onClick={() => { setDocuments([]); setSelectedId(''); notify('Conversion queue cleared.') }}>Clear queue</button><button className="batch-save-button" onClick={() => void saveAllBesideSources()} disabled={isSaving}>Save all beside LRC</button></div>}
      </section>

      <section className="converter-preview-panel liquid-panel">
        {selected ? <>
          <div className="converter-preview-heading"><div><span>PREVIEW</span><h3>{ttmlFileName(selected.name)}</h3></div><span className="line-count">{selected.result.cues.length} lines · estimated word flow</span></div>
          <div className="ttml-preview">{selected.result.cues.length ? selected.result.cues.slice(0, 12).map(cue => <div className="ttml-preview-line" key={`${cue.startTime}-${cue.text}`}><time>{formatPreviewTime(cue.startTime)}</time><span>{cue.text}</span></div>) : <div className="converter-empty-inline"><strong>This file needs a quick check.</strong><span>No valid [mm:ss.xx] timestamps were found.</span></div>}{selected.result.cues.length > 12 && <small className="preview-more">+ {selected.result.cues.length - 12} more lines in the exported file</small>}</div>
          {selected.result.warnings.length > 0 && <div className="converter-note"><span>i</span><p>{selected.result.warnings.join(' ')}</p></div>}
          <div className="converter-actions"><button className="secondary-glass-button" onClick={removeSelected}>Remove</button><div><button className="secondary-glass-button" onClick={() => downloadTtml(selected)} disabled={!selected.result.cues.length}><DownloadGlyph />Download TTML</button><button className="primary-glass-button converter-save-button" onClick={() => void saveBesideSource(selected)} disabled={!selected.result.cues.length || isSaving}><DownloadGlyph />{isSaving ? 'Saving…' : 'Save beside LRC'}</button></div></div>
        </> : <div className="converter-empty"><div className="empty-quote">“</div><h3>Your TTML preview will appear here.</h3><p>Choose an LRC file or drop one into the queue. Everything stays on this computer.</p></div>}
      </section>
    </div>
    <div className="converter-footer"><span>{totalLines ? `${totalLines} timed lines ready across the queue.` : 'Tip: a line such as [01:24.50] becomes a timed TTML paragraph.'}</span>{localMessage && <strong>{localMessage}</strong>}</div>
  </div>
}

function formatPreviewTime(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}
