import { useEffect, useRef, useState } from 'react'
import { Icon } from './common/Icon'
import { exportLyricDocument, exportLyricDocumentLrc, fromAlignmentJson, parseLyricDocument } from '../lib/lyrics'
import { prettyTime } from '../lib/format'

/**
 * Sync with AI: word-timed lyrics made on this computer.
 *
 * stable-ts drives faster-whisper in a background Python process, so the app
 * never waits on the model. Two ways in:
 *
 *  - Align (lyrics known). The words you already have are placed against the
 *    audio one by one. This is the accurate mode for songs: the model only
 *    decides *when* each word is sung, never *what* — transcription happily
 *    hears "my darling, what did you expect" as "my goal is what di…".
 *  - Transcribe (no lyrics). Whisper writes and times the words itself.
 *
 * The result goes through the same converter the player uses to import
 * alignment files, and is saved beside the song with the same save the
 * Lyrics Finder uses — backup of anything it replaces included.
 */

export interface SyncTarget { audioPath: string; title: string; artist: string | null; duration: number | null; lyricPath: string | null }

const MODELS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'tiny', label: 'Tiny', hint: '75 MB · fastest, roughest' },
  { value: 'base', label: 'Base', hint: '145 MB · good default' },
  { value: 'small', label: 'Small', hint: '480 MB · better with accents' },
  { value: 'medium', label: 'Medium', hint: '1.5 GB · strong, slow on CPU' },
  { value: 'large-v3', label: 'Large v3', hint: '3 GB · best; wants a GPU' },
]

const LANGUAGES: Array<[string, string]> = [['', 'Detect automatically'], ['en', 'English'], ['hi', 'Hindi'], ['ur', 'Urdu'], ['pa', 'Punjabi'], ['ta', 'Tamil'], ['te', 'Telugu'], ['bn', 'Bengali'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['fr', 'French'], ['de', 'German'], ['ar', 'Arabic'], ['tr', 'Turkish'], ['ru', 'Russian']]

type Phase = 'idle' | 'running' | 'done' | 'error'

type TimedLine = { text: string; start: number; end: number | null }

/**
 * The lyrics a song already has: the plain lines to show and edit, plus each
 * line's timing when the file was line-synced. Those timings are what let the
 * model align a line only within its own moment — seconds instead of minutes,
 * and reliable even on songs with long intros.
 */
async function existingLyrics(lyricPath: string | null): Promise<{ text: string; lines: TimedLine[] | null }> {
  if (!lyricPath) return { text: '', lines: null }
  const content = await window.electronAPI.readFile(lyricPath).catch(() => null)
  if (!content) return { text: '', lines: null }
  const extension = lyricPath.split('.').pop()?.toLocaleLowerCase() ?? 'txt'
  try {
    const document = parseLyricDocument(content, extension === 'ttml' || extension === 'yrc' || extension === 'lrc' ? extension : 'txt')
    const rows = document.lines
      .map(line => ({ text: line.words.map(word => word.word).join('').trim(), start: line.startTime / 1000, end: line.endTime / 1000 }))
      .filter(line => line.text)
    const timed = document.timing !== 'unsynced' && rows.length > 0 && rows.some(line => line.start > 0)
    return {
      text: rows.map(line => line.text).join('\n'),
      // Line starts are real in any synced file; ends are the next line's start.
      lines: timed ? rows.map((line, index) => ({ text: line.text, start: line.start, end: rows[index + 1]?.start ?? null })) : null,
    }
  } catch {
    return { text: content.replace(/\[[^\]]*\]|<[^>]*>/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n'), lines: null }
  }
}

export function AiLyricSync({ target, onPickTarget, onSaved, flash }: { target: SyncTarget | null; onPickTarget: (target: SyncTarget) => void; onSaved: () => void; flash: (message: string) => void }) {
  const [environment, setEnvironment] = useState<LyricSyncEnvironment | null>(null)
  const [model, setModel] = useState('base')
  const [language, setLanguage] = useState('')
  const [format, setFormat] = useState<'ttml' | 'lrc'>('ttml')
  const [lyrics, setLyrics] = useState('')
  const [embed, setEmbed] = useState(true)
  const [overwrite, setOverwrite] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [status, setStatus] = useState('')
  const [percent, setPercent] = useState<number | null>(null)
  const [device, setDevice] = useState<{ name: string; note: string } | null>(null)
  const [outcome, setOutcome] = useState<{ path?: string; words: number; lines: number; seconds?: number; mode?: string; language?: string; needsOverwrite?: boolean } | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const startedAt = useRef(0)
  const pending = useRef<{ content: string; format: 'ttml' | 'lrc' } | null>(null)
  // What the song's own lyric file said, so edits can be told apart from it.
  const [source, setSource] = useState<{ text: string; lines: TimedLine[] | null }>({ text: '', lines: null })

  useEffect(() => { void window.electronAPI.lyricSyncEnvironment().then(setEnvironment).catch(() => undefined) }, [])

  // A new song brings its own lyrics, if it has any, ready to align.
  useEffect(() => {
    let active = true
    setOutcome(null); setPhase('idle'); setStatus(''); setPercent(null); setDevice(null)
    void existingLyrics(target?.lyricPath ?? null).then(found => { if (active) { setSource(found); setLyrics(found.text) } })
    return () => { active = false }
  }, [target?.audioPath])

  useEffect(() => {
    if (phase !== 'running') return
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 500)
    return () => window.clearInterval(timer)
  }, [phase])

  useEffect(() => window.electronAPI.onLyricSyncEvent(event => {
    if (event.event === 'status' && event.message) setStatus(event.message)
    if (event.event === 'progress' && typeof event.percent === 'number') setPercent(event.percent)
    if (event.event === 'device' && event.device) setDevice({ name: event.device === 'cuda' ? 'GPU' : 'CPU', note: event.note ?? '' })
  }), [])

  const browse = async () => {
    const [file] = await window.electronAPI.selectAudioFiles()
    if (!file) return
    const name = file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? file
    onPickTarget({ audioPath: file, title: name, artist: null, duration: null, lyricPath: null })
  }

  // Returns true once the file is on disk. The save also embeds the words in
  // the song's tags, which rewrites the audio file — so "done" must wait for
  // it, or closing the app in that moment leaves half-written files behind.
  const save = async (content: string, chosen: 'ttml' | 'lrc', replace: boolean) => {
    if (!target) return false
    const saved = await window.electronAPI.saveLyricFile(target.audioPath, content, chosen, { overwrite: replace, embed })
    if (saved.saved) {
      pending.current = null
      setOutcome(current => ({ ...(current ?? { words: 0, lines: 0 }), path: saved.path, needsOverwrite: false }))
      flash(`Word-synced lyrics saved beside ${target.title}${saved.embedded ? ', and embedded in the file' : ''}.`)
      onSaved()
      return true
    }
    if (saved.path && !replace) {
      // A lyric file is already there; keep the result and let the person decide.
      pending.current = { content, format: chosen }
      setOutcome(current => ({ ...(current ?? { words: 0, lines: 0 }), path: saved.path, needsOverwrite: true }))
      return true
    }
    setPhase('error'); setStatus(saved.message ?? 'The lyric file could not be saved.')
    return false
  }

  const generate = async () => {
    if (!target || phase === 'running') return
    setPhase('running'); setOutcome(null); setPercent(null); setDevice(null); setElapsed(0)
    setStatus('Starting…')
    startedAt.current = Date.now()
    // Line timings only still describe the text if it has not been edited.
    const useLines = Boolean(source.lines && lyrics.trim() === source.text.trim())
    const result = await window.electronAPI.startLyricSync({
      audioPath: target.audioPath, model, language: language || null,
      lyricsText: lyrics.trim() || null,
      lyricsLines: useLines ? source.lines : null,
    })
    if (!result.ok || !result.segments?.length) { setPhase('error'); setStatus(result.message ?? 'The sync produced nothing.'); return }
    try {
      const document = fromAlignmentJson(JSON.stringify({ segments: result.segments }))
      const content = format === 'ttml' ? exportLyricDocument(document) : exportLyricDocumentLrc(document)
      const words = result.segments.reduce((sum, segment) => sum + segment.words.length, 0)
      setOutcome({ words, lines: result.segments.length, seconds: result.seconds, mode: result.mode, language: result.language })
      setStatus('Saving beside the song…')
      const saved = await save(content, format, overwrite)
      if (!saved) return
      setPhase('done'); setPercent(100)
      setStatus(`${result.mode === 'transcribe' ? 'Transcribed' : 'Aligned'} ${words} words over ${result.segments.length} lines on the ${result.device === 'cuda' ? 'GPU' : 'CPU'} in ${result.seconds}s.`)
    } catch (error) {
      setPhase('error'); setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const cancel = async () => { await window.electronAPI.cancelLyricSync(); setPhase('idle'); setStatus('Cancelled.'); setPercent(null) }
  const lineCount = lyrics.trim().split(/\r?\n/).filter(Boolean).length
  const mode: 'align-lines' | 'align' | 'transcribe' = !lyrics.trim() ? 'transcribe' : source.lines && lyrics.trim() === source.text.trim() ? 'align-lines' : 'align'
  const modelHint = MODELS.find(item => item.value === model)?.hint ?? ''
  const modeSummary = mode === 'align-lines'
    ? `Will time the words of ${lineCount} lines, each within its own line's moment — seconds, even on the CPU`
    : mode === 'align'
      ? `Will align ${lineCount} lines of plain text across the whole song — pick Small or larger; on the CPU this takes minutes`
      : 'Will transcribe the vocals'

  return (
    <div className="tool-panel ai-sync">
      <div className="tool-panel-head">
        <div>
          <strong>Sync with AI</strong>
          <span className="ai-sync-sub">stable-ts + faster-whisper, on this computer · nothing is uploaded</span>
        </div>
        <span className={`chip ${environment?.ready ? (environment.gpus > 0 && environment.cudaRuntime ? 'high' : 'medium') : 'low'}`} title={environment?.message}>
          {!environment ? 'Checking…' : !environment.ready ? 'Setup needed' : environment.gpus > 0 && environment.cudaRuntime ? 'GPU ready' : 'CPU ready'}
        </span>
      </div>
      <div className="tool-panel-body ai-sync-body">
        {environment && !environment.ready && <p className="cookie-status bad">{environment.message}</p>}
        {environment?.ready && environment.gpus > 0 && !environment.cudaRuntime && <p className="settings-note" style={{ margin: 0 }}>Your GPU can make this several times faster once faster-whisper has its CUDA 12 libraries: <b>pip install nvidia-cublas-cu12 nvidia-cudnn-cu12</b>. Until then it runs on the CPU.</p>}

        <div className="ai-sync-song">
          {target ? <>
            <div><strong>{target.title}</strong><span>{target.artist ?? 'Unknown artist'}{target.duration ? ` · ${prettyTime(target.duration)}` : ''}</span><small title={target.audioPath}>{target.audioPath}</small></div>
          </> : <div><strong>No song chosen</strong><span>Press <b>AI sync</b> on any song in the table below, or pick a file.</span></div>}
          <button className="ghost-button" disabled={phase === 'running'} onClick={() => void browse()}><Icon name="folder" size={14} /> Choose a file…</button>
        </div>

        <div className="ai-sync-grid">
          <label><span>Model</span><select value={model} disabled={phase === 'running'} onChange={event => setModel(event.target.value)}>{MODELS.map(item => <option key={item.value} value={item.value}>{item.label} — {item.hint}</option>)}</select></label>
          <label><span>Language</span><select value={language} disabled={phase === 'running'} onChange={event => setLanguage(event.target.value)}>{LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
          <label><span>Save as</span><select value={format} disabled={phase === 'running'} onChange={event => setFormat(event.target.value as 'ttml' | 'lrc')}><option value="ttml">TTML — word by word in Lyrigen</option><option value="lrc">LRC — word-timed, for other players too</option></select></label>
        </div>

        <label className="ai-sync-lyrics">
          <span>{mode === 'align-lines' ? 'Lyrics to align — from the song’s synced file; editing them drops its line timings' : mode === 'align' ? 'Lyrics to align — edit freely, one line per sung line' : 'Lyrics (optional) — paste them for much better accuracy'}</span>
          <textarea value={lyrics} disabled={phase === 'running'} onChange={event => setLyrics(event.target.value)} placeholder={'Leave empty to let the model transcribe.\nPaste the real lyrics and it will align them instead — far more accurate for singing.'} spellCheck={false} />
        </label>

        <div className="toggle-list" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <label className="toggle" style={{ padding: '6px 10px' }}><input type="checkbox" checked={embed} onChange={event => setEmbed(event.target.checked)} /><span><strong>Also embed in the song file</strong></span></label>
          <label className="toggle" style={{ padding: '6px 10px' }}><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} /><span><strong>Replace an existing lyric file</strong></span></label>
        </div>

        {(phase !== 'idle' || status) && <div className={`ai-sync-status ${phase}`}>
          <div className="ai-sync-status-line">
            {phase === 'running' && <i className="ai-sync-spinner" aria-hidden="true" />}
            <span>{status}</span>
            {device && <em className="chip" title={device.note}>{device.name}</em>}
            {phase === 'running' && <small>{elapsed}s</small>}
          </div>
          {phase === 'running' && <div className={`ai-sync-bar ${percent == null ? 'indeterminate' : ''}`}><b style={{ width: `${percent ?? 30}%` }} /></div>}
          {device?.note && <small className="ai-sync-note">{device.note}</small>}
          {outcome?.needsOverwrite && <p className="cookie-status bad" style={{ margin: 0 }}>A lyric file already exists at {outcome.path}. <button className="text-link" onClick={() => { if (pending.current) void save(pending.current.content, pending.current.format, true) }}>Replace it (the old one is backed up)</button></p>}
          {outcome?.path && !outcome.needsOverwrite && <p className="cookie-status ok" style={{ margin: 0 }}>✓ Saved to {outcome.path}. Play the song to see it word by word — machine timing is good, not perfect, so the lyric editor is there for touch-ups.</p>}
        </div>}

        <div className="ai-sync-actions">
          <small>{modeSummary} · {model} model ({modelHint})</small>
          {phase === 'running'
            ? <button className="ghost-button" onClick={() => void cancel()}><Icon name="close" size={14} /> Cancel</button>
            : <button className="accent-button" disabled={!target || !environment?.ready} onClick={() => void generate()}><Icon name="spark" size={15} /> Generate synced lyrics</button>}
        </div>
      </div>
    </div>
  )
}
