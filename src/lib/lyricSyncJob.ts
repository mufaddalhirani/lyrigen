import { useSyncExternalStore } from 'react'
import { exportLyricDocument, exportLyricDocumentLrc, fromAlignmentJson } from './lyrics'
import type { LyricSource, SyncLevel, SyncTarget } from '../components/AiLyricSync'

/**
 * The AI sync that is running, kept outside the panel that started it.
 *
 * A sync takes minutes, and people wander off meanwhile — to play a song, or
 * anywhere else — which unmounts the Lyrics screen. The Python job never
 * cared, but the panel's state went with it: coming back showed an idle panel
 * over a job still running. Here the job, its progress and its result outlive
 * the panel, and anything can show them: the panel, the player's button, the
 * sidebar.
 */

export type SyncPhase = 'idle' | 'running' | 'done' | 'error'

export interface SyncJob {
  target: SyncTarget | null
  /** What was sent, so a reopened panel shows the lyrics being synced. */
  source: LyricSource | null
  lyrics: string
  level: SyncLevel
  phase: SyncPhase
  status: string
  percent: number | null
  device: { name: string; note: string } | null
  startedAt: number
  outcome: { path?: string; needsOverwrite?: boolean } | null
}

export interface SyncRun {
  target: SyncTarget
  source: LyricSource
  lyrics: string
  level: SyncLevel
  request: Parameters<Window['electronAPI']['startLyricSync']>[0]
  format: 'ttml' | 'lrc'
  overwrite: boolean
  embed: boolean
  flash: (message: string) => void
  onSaved: () => void
}

const IDLE: SyncJob = { target: null, source: null, lyrics: '', level: 'word', phase: 'idle', status: '', percent: null, device: null, startedAt: 0, outcome: null }
let job = IDLE
// Bumped by cancel, so a cancelled run's late answer is ignored.
let generation = 0
/** A finished result waiting on "replace the existing file". */
let pending: { run: SyncRun; content: string } | null = null
const listeners = new Set<() => void>()

function set(patch: Partial<SyncJob>) {
  job = { ...job, ...patch }
  listeners.forEach(listener => listener())
}

let listening = false
function subscribe(listener: () => void) {
  if (!listening) {
    listening = true
    window.electronAPI.onLyricSyncEvent(event => {
      if (job.phase !== 'running') return
      if (event.event === 'status' && event.message) set({ status: event.message })
      if (event.event === 'progress' && typeof event.percent === 'number') set({ percent: event.percent })
      if (event.event === 'device' && event.device) set({ device: { name: event.device === 'cuda' ? 'GPU' : 'CPU', note: event.note ?? '' } })
    })
  }
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const useSyncJob = () => useSyncExternalStore(subscribe, () => job)
export const currentSyncJob = () => job

/** Forgets a finished job once another song is picked; a running one stays. */
export function clearSyncJob() {
  if (job.phase === 'running' || job === IDLE) return
  pending = null
  set(IDLE)
}

// Returns true once the file is on disk. The save also embeds the words in
// the song's tags, which rewrites the audio file — so "done" must wait for
// it, or closing the app in that moment leaves half-written files behind.
async function save(run: SyncRun, content: string, replace: boolean) {
  const saved = await window.electronAPI.saveLyricFile(run.target.audioPath, content, run.format, { overwrite: replace, embed: run.embed })
  if (saved.saved) {
    pending = null
    set({ outcome: { path: saved.path, needsOverwrite: false } })
    run.flash(`${run.level === 'syllable' ? 'Syllable' : 'Word'}-synced lyrics saved beside ${run.target.title}${saved.embedded ? ', and embedded in the file' : ''}.`)
    run.onSaved()
    return true
  }
  if (saved.path && !replace) {
    // A lyric file is already there; keep the result and let the person decide.
    pending = { run, content }
    set({ outcome: { path: saved.path, needsOverwrite: true } })
    run.flash(`${run.target.title} is synced. It already has a lyric file — replace it from Lyrics Finder.`)
    return true
  }
  set({ phase: 'error', status: saved.message ?? 'The lyric file could not be saved.' })
  return false
}

export function replaceExisting() {
  if (pending) void save(pending.run, pending.content, true)
}

export async function runSync(run: SyncRun) {
  if (job.phase === 'running') return
  const mine = ++generation
  pending = null
  set({ target: run.target, source: run.source, lyrics: run.lyrics, level: run.level, phase: 'running', status: 'Starting…', percent: null, device: null, startedAt: Date.now(), outcome: null })
  try {
    const result = await window.electronAPI.startLyricSync(run.request)
    if (mine !== generation) return
    if (!result.ok || !result.segments?.length) { set({ phase: 'error', status: result.message ?? 'The sync produced nothing.' }); return }
    // The engine writes the files itself; the renderer's converter is only a
    // fallback for an engine too old to send them.
    const document = fromAlignmentJson(JSON.stringify({ segments: result.segments }))
    const content = run.format === 'ttml' ? result.ttml ?? exportLyricDocument(document) : result.lrc ?? exportLyricDocumentLrc(document)
    const words = result.segments.reduce((sum, segment) => sum + segment.words.length, 0)
    set({ status: 'Saving beside the song…' })
    if (!await save(run, content, run.overwrite)) return
    const verb = result.mode === 'transcribe' ? 'Transcribed' : result.mode === 'from-words' ? `Kept the ${run.source.machine ? 'existing' : 'person-made'} timing of` : 'Aligned'
    const stats = result.syllableStats ? ` · syllables: ${result.syllableStats.acoustic} words timed by ear, ${result.syllableStats.fallback} split by length` : ''
    const processor = result.device === 'cuda' ? 'GPU' : 'CPU'
    const device = result.note ? { name: job.device?.name ?? processor, note: [job.device?.note, result.note].filter(Boolean).join(' ') } : job.device
    set({ phase: 'done', percent: 100, device, status: `${verb} ${words} words over ${result.segments.length} lines${result.level === 'syllable' ? ', syllable by syllable,' : ''} on the ${processor} in ${result.seconds}s${stats}.` })
  } catch (error) {
    if (mine === generation) set({ phase: 'error', status: error instanceof Error ? error.message : String(error) })
  }
}

export async function cancelSync() {
  generation++
  await window.electronAPI.cancelLyricSync()
  set({ phase: 'idle', status: 'Cancelled.', percent: null })
}
