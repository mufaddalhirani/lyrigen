import { useEffect, useRef, useState } from 'react'
import { Icon } from './common/Icon'
import { parseLyricDocument } from '../lib/lyrics'
import { prettyTime } from '../lib/format'
import { cancelSync, clearSyncJob, currentSyncJob, replaceExisting, runSync, useSyncJob } from '../lib/lyricSyncJob'

/**
 * Sync with AI: word- and syllable-timed lyrics made on this computer.
 *
 * The engine is Lyric Studio (lyric-studio/), run in a background Python
 * process so the app never waits on the model. Pick a song and the rest is
 * found for you: the song's own lyric file if it has one, otherwise the best
 * lyrics online. Whatever timing those carry decides how the song is synced:
 *
 *  - Word-timed by a person (TTML): that timing is kept — checked against this
 *    recording, since online files are often for a different master — and only
 *    syllables are added.
 *  - Line-timed (LRC): each line's words are aligned inside its own moment.
 *  - Plain text: aligned across the whole song. The model decides *when* each
 *    word is sung, never *what* — transcription happily hears "my darling,
 *    what did you expect" as "my goal is what di…".
 *  - Nothing: Whisper transcribes and times the words itself.
 *
 * Syllable level is what karaoke highlights: a held note stretches across its
 * syllable instead of the whole word lighting up at once. The engine returns
 * finished TTML and LRC, saved beside the song with the Lyrics Finder's save —
 * backup of anything it replaces included.
 */

/** `level` switches the sync level on arrival (the player's button asks for syllables). */
export interface SyncTarget { audioPath: string; title: string; artist: string | null; duration: number | null; lyricPath: string | null; level?: Level }

const MODELS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'tiny', label: 'Tiny', hint: '75 MB · fastest, roughest' },
  { value: 'base', label: 'Base', hint: '145 MB · good default' },
  { value: 'small', label: 'Small', hint: '480 MB · better with accents' },
  { value: 'medium', label: 'Medium', hint: '1.5 GB · strong, slow on CPU' },
  { value: 'large-v3', label: 'Large v3', hint: '3 GB · best; wants a GPU' },
]

const LANGUAGES: Array<[string, string]> = [['', 'Detect automatically'], ['en', 'English'], ['hi', 'Hindi'], ['ur', 'Urdu'], ['pa', 'Punjabi'], ['ta', 'Tamil'], ['te', 'Telugu'], ['bn', 'Bengali'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['fr', 'French'], ['de', 'German'], ['ar', 'Arabic'], ['tr', 'Turkish'], ['ru', 'Russian']]

export type SyncLevel = 'syllable' | 'word'
type Level = SyncLevel
type TimedWord = { word: string; start: number; end: number }
type TimedLine = { text: string; start: number; end: number | null; words?: TimedWord[] }
/** The lyrics to sync and where they came from. */
export type LyricSource = { text: string; lines: TimedLine[] | null; label: string; wordTimed: boolean; machine: boolean }

const EMPTY_SOURCE: LyricSource = { text: '', lines: null, label: '', wordTimed: false, machine: false }

// The panel's choices outlive the session. Storage can be missing or refuse
// writes; the defaults are fine then.
const PREFERENCES_KEY = 'lyrigen.aiSync'
type Preferences = { model: string; level: Level; language: string; format: 'ttml' | 'lrc'; embed: boolean }
const DEFAULT_PREFERENCES: Preferences = { model: 'base', level: 'syllable', language: '', format: 'ttml', embed: true }
function loadPreferences(): Preferences {
  try { return { ...DEFAULT_PREFERENCES, ...JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Partial<Preferences> } } catch { return DEFAULT_PREFERENCES }
}
function savePreferences(preferences: Preferences) {
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)) } catch { /* not remembered, still works */ }
}

/**
 * Lines (and, when a person timed them, words) from any lyric document.
 *
 * The TTML parser returns syllables of one word as separate pieces — "ri",
 * "ver " — so pieces are joined until one ends in a space; the engine wants
 * whole words and makes its own syllables.
 */
function lyricsFromContent(content: string, extension: string, label: string): LyricSource {
  try {
    const document = parseLyricDocument(content, extension)
    const rows = document.lines
      .map(line => ({ text: line.words.map(word => word.word).join('').replace(/\s+/g, ' ').trim(), start: line.startTime / 1000, end: line.endTime / 1000, pieces: line.words }))
      .filter(line => line.text)
    const timed = document.timing !== 'unsynced' && rows.length > 0 && rows.some(line => line.start > 0)
    const wordTimed = timed && document.timing === 'word'
    const lines = timed ? rows.map((line, index): TimedLine => {
      // Line starts are real in any synced file; ends are the next line's start.
      const entry: TimedLine = { text: line.text, start: line.start, end: rows[index + 1]?.start ?? null }
      if (!wordTimed) return entry
      const words: TimedWord[] = []
      let joining = false
      for (const piece of line.pieces) {
        if (!piece.word.trim()) { joining = false; continue }
        const startsWord = !joining || /^\s/.test(piece.word)
        if (startsWord) words.push({ word: piece.word.trim(), start: piece.startTime / 1000, end: piece.endTime / 1000 })
        else { const last = words[words.length - 1]; last.word += piece.word.trim(); last.end = piece.endTime / 1000 }
        joining = !/\s$/.test(piece.word)
      }
      return words.length ? { ...entry, words } : entry
    }) : null
    // An earlier AI sync (Lyrigen's or Lyric Studio's) says so in its metadata.
    const machine = document.metadata.some(([key]) => key === 'lyrigen:alignment')
    return { text: rows.map(line => line.text).join('\n'), lines, label, wordTimed: Boolean(lines?.every(line => line.words)), machine }
  } catch {
    const text = content.replace(/\[[^\]]*\]|<[^>]*>/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n')
    return { text, lines: null, label, wordTimed: false, machine: false }
  }
}

async function lyricsFromFile(lyricPath: string | null): Promise<LyricSource | null> {
  if (!lyricPath) return null
  const content = await window.electronAPI.readFile(lyricPath).catch(() => null)
  if (!content?.trim()) return null
  const extension = lyricPath.split('.').pop()?.toLocaleLowerCase() ?? 'txt'
  const found = lyricsFromContent(content, extension === 'ttml' || extension === 'yrc' || extension === 'lrc' ? extension : 'txt', 'the song’s own lyric file')
  return found.text ? found : null
}

async function lyricsOnline(target: SyncTarget): Promise<LyricSource | { missing: string }> {
  const result = await window.electronAPI.findOnlineLyrics({ trackName: target.title, artistName: target.artist, duration: target.duration, audioPath: target.audioPath })
  if (!result.found) return { missing: result.instrumental ? 'This song is marked instrumental — there is nothing to sync.' : result.message || 'No lyrics found online.' }
  const source = result.source || 'online'
  const found = result.ttmlLyrics ? lyricsFromContent(result.ttmlLyrics, 'ttml', source)
    : result.syncedLyrics ? lyricsFromContent(result.syncedLyrics, 'lrc', source)
      : lyricsFromContent(result.plainLyrics ?? '', 'txt', source)
  return found.text ? found : { missing: 'The lyrics found online were empty.' }
}

function describeSource(source: LyricSource) {
  if (!source.label) return ''
  const timing = source.wordTimed ? (source.machine ? 'word-timed by an earlier AI sync' : 'word-timed by a person') : source.lines ? 'line-timed' : 'plain text'
  return `From ${source.label} · ${source.text.split('\n').length} lines · ${timing}`
}

export function AiLyricSync({ target, onPickTarget, onSaved, flash }: { target: SyncTarget | null; onPickTarget: (target: SyncTarget) => void; onSaved: () => void; flash: (message: string) => void }) {
  const [environment, setEnvironment] = useState<LyricSyncEnvironment | null>(null)
  const [preferences, setPreferences] = useState(loadPreferences)
  const { model, level, language, format, embed } = preferences
  const choose = (patch: Partial<Preferences>) => setPreferences(current => { const next = { ...current, ...patch }; savePreferences(next); return next })
  const [lyrics, setLyrics] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  // The running job lives outside this panel, so leaving the screen (to play
  // a song, say) neither stops it nor forgets it.
  const job = useSyncJob()
  const { phase, status, percent, device, outcome } = job
  const [, tick] = useState(0)
  // Where the lyrics came from, so edits can be told apart from them.
  const [source, setSource] = useState<LyricSource>(EMPTY_SOURCE)
  const [lookup, setLookup] = useState<{ busy: boolean; message: string }>({ busy: false, message: '' })
  const lookupGeneration = useRef(0)

  useEffect(() => { void window.electronAPI.lyricSyncEnvironment().then(setEnvironment).catch(() => undefined) }, [])

  const adopt = (found: LyricSource) => { setSource(found); setLyrics(found.text) }

  const findOnline = async (song: SyncTarget) => {
    const generation = ++lookupGeneration.current
    setLookup({ busy: true, message: 'Looking the lyrics up online…' })
    const found = await lyricsOnline(song).catch(() => ({ missing: 'The lyric services could not be reached.' }))
    if (generation !== lookupGeneration.current) return
    if ('missing' in found) setLookup({ busy: false, message: `${found.missing} Paste them below, or leave it empty to transcribe.` })
    else { adopt(found); setLookup({ busy: false, message: '' }) }
  }

  // A new song brings its lyrics along: its own file first, else the best
  // match online — nothing to copy and paste.
  useEffect(() => {
    let active = true
    lookupGeneration.current += 1
    setLookup({ busy: false, message: '' })
    // Back on the song being synced (or just synced): show what was sent.
    const current = currentSyncJob()
    if (target && current.source && current.phase !== 'idle' && current.target?.audioPath === target.audioPath) {
      setSource(current.source); setLyrics(current.lyrics)
      return
    }
    clearSyncJob()
    adopt(EMPTY_SOURCE)
    if (!target) return
    if (target.level) choose({ level: target.level })
    void lyricsFromFile(target.lyricPath).then(found => {
      if (!active) return
      if (found) adopt(found)
      else void findOnline(target)
    })
    return () => { active = false }
  }, [target?.audioPath])

  useEffect(() => {
    if (phase !== 'running') return
    const timer = window.setInterval(() => tick(count => count + 1), 500)
    return () => window.clearInterval(timer)
  }, [phase])
  const elapsed = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000))

  const browse = async () => {
    const [file] = await window.electronAPI.selectAudioFiles()
    if (!file) return
    const name = file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? file
    onPickTarget({ audioPath: file, title: name, artist: null, duration: null, lyricPath: null })
  }

  const edited = lyrics.trim() !== source.text.trim()
  const lines = !edited ? source.lines : null
  const syllablesReady = Boolean(environment?.syllables)
  const effectiveLevel: Level = level === 'syllable' && syllablesReady ? 'syllable' : 'word'

  const generate = () => {
    if (!target || phase === 'running') return
    void runSync({
      target, source, lyrics, level: effectiveLevel, format, overwrite, embed, flash, onSaved,
      // Timings only still describe the text if it has not been edited.
      request: { audioPath: target.audioPath, model, level: effectiveLevel, language: language || null, lyricsText: lyrics.trim() || null, lyricsLines: lines },
    })
  }

  // A job can be for another song than the one on show (picked while it ran).
  const jobSong = job.target && job.target.audioPath !== target?.audioPath ? `${job.target.title}: ` : ''
  const lineCount = lyrics.trim().split(/\r?\n/).filter(Boolean).length
  const mode: 'from-words' | 'align-lines' | 'align' | 'transcribe' = !lyrics.trim() ? 'transcribe' : lines && source.wordTimed ? 'from-words' : lines ? 'align-lines' : 'align'
  const modelHint = MODELS.find(item => item.value === model)?.hint ?? ''
  const madeBy = source.machine ? 'the earlier sync made' : 'a person made'
  const modeSummary = {
    'from-words': effectiveLevel === 'syllable' ? `Keeps the word timing ${madeBy} for ${lineCount} lines (checked against this recording) and adds syllables` : `Keeps the word timing ${madeBy} for ${lineCount} lines, checked against this recording`,
    'align-lines': `Will time the words of ${lineCount} lines, each within its own line's moment — seconds, even on the CPU`,
    align: `Will align ${lineCount} lines of plain text across the whole song — pick Small or larger; on the CPU this takes minutes`,
    transcribe: 'Will transcribe the vocals',
  }[mode]
  const lyricsLabel = source.label && !edited ? describeSource(source) : edited && source.label ? 'Edited — the timing that came with them is dropped' : 'Lyrics'
  const running = phase === 'running'

  return (
    <div className="tool-panel ai-sync">
      <div className="tool-panel-head">
        <div>
          <strong>Sync with AI</strong>
          <span className="ai-sync-sub">Lyric Studio engine · word or syllable timing for karaoke · on this computer, nothing is uploaded</span>
        </div>
        <span className={`chip ${environment?.ready ? (environment.gpus > 0 && environment.cudaRuntime ? 'high' : 'medium') : 'low'}`} title={environment?.message}>
          {!environment ? 'Checking…' : !environment.ready ? 'Setup needed' : environment.gpus > 0 && environment.cudaRuntime ? 'GPU ready' : 'CPU ready'}
        </span>
      </div>
      <div className="tool-panel-body ai-sync-body">
        {environment && !environment.ready && <p className="cookie-status bad">{environment.message}</p>}
        {environment?.ready && environment.gpus > 0 && !environment.cudaRuntime && <p className="settings-note" style={{ margin: 0 }}>Your GPU can make this several times faster once faster-whisper has its CUDA 12 libraries: <b>pip install nvidia-cublas-cu12 nvidia-cudnn-cu12</b>. Until then it runs on the CPU.</p>}
        {environment?.ready && !environment.syllables && <p className="settings-note" style={{ margin: 0 }}>Syllable timing needs three more packages: <b>pip install torch transformers uroman</b> (or run Lyric Studio’s installer). Until then songs are synced word by word.</p>}

        <div className="ai-sync-song">
          {target ? <>
            <div><strong>{target.title}</strong><span>{target.artist ?? 'Unknown artist'}{target.duration ? ` · ${prettyTime(target.duration)}` : ''}</span><small title={target.audioPath}>{target.audioPath}</small></div>
          </> : <div><strong>No song chosen</strong><span>Press <b>AI sync</b> on any song in the table below, or pick a file.</span></div>}
          <button className="ghost-button" disabled={running} onClick={() => void browse()}><Icon name="folder" size={14} /> Choose a file…</button>
        </div>

        <div className="ai-sync-grid">
          <label><span>Sync level</span><select value={effectiveLevel} disabled={running} onChange={event => choose({ level: event.target.value as Level })}>
            <option value="syllable" disabled={!syllablesReady}>Syllable — karaoke{syllablesReady ? '' : ' (needs setup)'}</option>
            <option value="word">Word — quicker</option>
          </select></label>
          <label><span>Model</span><select value={model} disabled={running} onChange={event => choose({ model: event.target.value })}>{MODELS.map(item => <option key={item.value} value={item.value}>{item.label} — {item.hint}</option>)}</select></label>
          <label><span>Language</span><select value={language} disabled={running} onChange={event => choose({ language: event.target.value })}>{LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
          <label><span>Save as</span><select value={format} disabled={running} onChange={event => choose({ format: event.target.value as 'ttml' | 'lrc' })}><option value="ttml">TTML — {effectiveLevel === 'syllable' ? 'syllable' : 'word'} by {effectiveLevel === 'syllable' ? 'syllable' : 'word'} in Lyrigen</option><option value="lrc">LRC — {effectiveLevel}-timed, for other players too</option></select></label>
        </div>

        <div className="ai-sync-lyrics">
          <div className="ai-sync-lyrics-head">
            <span className={source.label && !edited ? 'found' : ''}>{lookup.busy ? 'Looking the lyrics up online…' : lyricsLabel}</span>
            <button className="text-link" disabled={!target || running || lookup.busy} onClick={() => { if (target) void findOnline(target) }}><Icon name="search" size={12} /> {source.label ? 'Search online again' : 'Find online'}</button>
            {lyrics && <button className="text-link" disabled={running} onClick={() => { adopt(EMPTY_SOURCE); setLookup({ busy: false, message: '' }) }}>Clear</button>}
          </div>
          {lookup.message && !lookup.busy && <small className="ai-sync-note">{lookup.message}</small>}
          <textarea value={lyrics} disabled={running || lookup.busy} onChange={event => setLyrics(event.target.value)} aria-label="Lyrics to sync" placeholder={'Lyrics are found by themselves when you pick a song.\nOr paste them here — one line per sung line. Leave empty to let the model transcribe.'} spellCheck={false} />
        </div>

        <div className="toggle-list" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <label className="toggle" style={{ padding: '6px 10px' }}><input type="checkbox" checked={embed} onChange={event => choose({ embed: event.target.checked })} /><span><strong>Also embed in the song file</strong></span></label>
          <label className="toggle" style={{ padding: '6px 10px' }}><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} /><span><strong>Replace an existing lyric file</strong></span></label>
        </div>

        {(phase !== 'idle' || status) && <div className={`ai-sync-status ${phase}`}>
          <div className="ai-sync-status-line">
            {running && <i className="ai-sync-spinner" aria-hidden="true" />}
            <span>{jobSong}{status}</span>
            {device && <em className="chip" title={device.note}>{device.name}</em>}
            {running && <small>{elapsed}s</small>}
          </div>
          {running && <div className={`ai-sync-bar ${percent == null ? 'indeterminate' : ''}`}><b style={{ width: `${percent ?? 30}%` }} /></div>}
          {device?.note && <small className="ai-sync-note">{device.note}</small>}
          {outcome?.needsOverwrite && <p className="cookie-status bad" style={{ margin: 0 }}>A lyric file already exists at {outcome.path}. <button className="text-link" onClick={replaceExisting}>Replace it (the old one is backed up)</button></p>}
          {outcome?.path && !outcome.needsOverwrite && <p className="cookie-status ok" style={{ margin: 0 }}>✓ Saved to {outcome.path}. Play the song to see it {job.level === 'syllable' ? 'syllable by syllable' : 'word by word'} — machine timing is good, not perfect, so the lyric editor is there for touch-ups.</p>}
        </div>}

        <div className="ai-sync-actions">
          <small>{modeSummary} · {model} model ({modelHint})</small>
          {running
            ? <button className="ghost-button" onClick={() => void cancelSync()}><Icon name="close" size={14} /> Cancel</button>
            : <button className="accent-button" disabled={!target || !environment?.ready || lookup.busy} onClick={generate}><Icon name="spark" size={15} /> Generate synced lyrics</button>}
        </div>
      </div>
    </div>
  )
}

/** The sidebar's Lyrics Finder count — or, while a sync runs, its progress. */
export function LyricsNavBadge({ missing }: { missing: number }) {
  const job = useSyncJob()
  if (job.phase !== 'running') return <b>{missing || ''}</b>
  return <b className="nav-sync" title={`Lyric Studio is syncing ${job.target?.title ?? 'a song'}`}>{job.percent != null ? `${Math.round(job.percent)}%` : 'sync'}</b>
}
