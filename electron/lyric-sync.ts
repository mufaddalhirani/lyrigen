import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { ffmpegLocation, run } from './media-tools'

/**
 * Local AI lyric sync: word- and syllable-level timing, made on this computer.
 *
 * The engine is Lyric Studio (lyric-studio/lyricstudio), which also installs
 * and runs on its own. Here it runs as `python -m lyricstudio.cli` in a child
 * process, so however long a song takes, the app's own threads never wait on
 * it. The worker writes one JSON event per line; this module relays them and
 * returns the timed segments together with the finished TTML and LRC — the
 * same files the standalone app saves, so a song synced in either plays the
 * same in both.
 */

export interface LyricSyncRequest {
  audioPath: string
  /** tiny, base, small, medium, large-v3 … */
  model: string
  /** Blank means detect. */
  language?: string | null
  /** When present the words are aligned rather than transcribed. */
  lyricsText?: string | null
  /**
   * The same lyrics with each line's start (and end) in seconds, when they came
   * from a line-synced file. Each line is then aligned only within its own
   * moment — much faster and far more reliable than aligning the whole song.
   */
  lyricsLines?: Array<{ text: string; start: number; end: number | null; words?: Array<{ word: string; start: number; end: number }> }> | null
  device?: 'auto' | 'cuda' | 'cpu'
  /** Syllables are what karaoke highlights; words are quicker and need less. */
  level?: 'word' | 'syllable'
}

export interface LyricSyncEvent {
  event: 'status' | 'device' | 'progress' | 'result' | 'error'
  stage?: string
  message?: string
  device?: string
  compute?: string
  note?: string
  percent?: number
}

export type LyricSyncMode = 'from-words' | 'align-lines' | 'align' | 'transcribe'

export interface LyricSyncResult {
  ok: boolean
  message?: string
  mode?: LyricSyncMode
  level?: 'word' | 'syllable'
  language?: string
  device?: string
  seconds?: number
  /** Why the timing was moved, re-done or fell back, in words; empty when nothing happened. */
  note?: string
  /** Syllable words placed by the aligner vs. split by length. */
  syllableStats?: { acoustic: number; fallback: number } | null
  segments?: Array<{ text: string; start: number; end: number; words: Array<{ word: string; start: number; end: number; syllables?: Array<{ text: string; start: number; end: number }> }> }>
  ttml?: string
  lrc?: string
}

export interface LyricSyncEnvironment {
  python: string | null
  pythonVersion: string | null
  packages: { stableTs: string | null; fasterWhisper: string | null }
  /** torch, transformers and uroman — what syllable timing needs on top. */
  syllables: boolean
  gpus: number
  /** Whether the CUDA 12 runtime faster-whisper needs is installed via pip. */
  cudaRuntime: boolean
  ready: boolean
  message: string
}

/** The folder that holds the lyricstudio package, for PYTHONPATH. */
function studioRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'lyric-studio') : path.join(app.getAppPath(), 'lyric-studio')
}

let environment: LyricSyncEnvironment | null = null

const PROBE = [
  'import json, sys, site, glob, os',
  'info = {"version": sys.version.split()[0], "executable": sys.executable, "stable": None, "fw": None, "gpus": 0, "cuda": False}',
  'try:\n import stable_whisper; info["stable"] = stable_whisper.__version__\nexcept Exception: pass',
  'try:\n import faster_whisper; info["fw"] = faster_whisper.__version__\nexcept Exception: pass',
  'try:\n import ctranslate2; info["gpus"] = ctranslate2.get_cuda_device_count()\nexcept Exception: pass',
  // find_spec, not import: importing torch alone takes seconds.
  'import importlib.util\ninfo["syllables"] = all(importlib.util.find_spec(name) for name in ("torch", "transformers", "uroman"))',
  'roots = []\ntry: roots += site.getsitepackages()\nexcept Exception: pass\ntry: roots.append(site.getusersitepackages())\nexcept Exception: pass',
  'info["cuda"] = any(glob.glob(os.path.join(r, "nvidia", "cublas", "bin", "cublas64_12.dll")) for r in roots)',
  'print(json.dumps(info))',
].join('\n')

/**
 * Find a Python that has the packages. `python` first, then the `py`
 * launcher; the Microsoft Store stub named python.exe prints nothing useful,
 * which the JSON parse catches.
 */
export async function lyricSyncEnvironment(refresh = false): Promise<LyricSyncEnvironment> {
  if (environment && !refresh) return environment
  const candidates: Array<[string, string[]]> = [['python', []], ['py', ['-3']], ['python3', []]]
  for (const [command, prefix] of candidates) {
    try {
      const result = await run(command, [...prefix, '-c', PROBE], { timeoutMs: 60_000 })
      const line = result.stdout.trim().split(/\r?\n/).pop() ?? ''
      if (result.code !== 0 || !line.startsWith('{')) continue
      const info = JSON.parse(line) as { version: string; executable: string; stable: string | null; fw: string | null; gpus: number; cuda: boolean; syllables: boolean }
      const ready = Boolean(info.stable && info.fw)
      environment = {
        python: info.executable, pythonVersion: info.version,
        packages: { stableTs: info.stable, fasterWhisper: info.fw }, syllables: info.syllables,
        gpus: info.gpus, cudaRuntime: info.cuda, ready,
        message: !ready
          ? `Python ${info.version} is here, but ${[info.stable ? '' : 'stable-ts', info.fw ? '' : 'faster-whisper'].filter(Boolean).join(' and ')} is missing. Install with: pip install stable-ts faster-whisper`
          : info.gpus > 0 && !info.cuda
            ? 'Ready on the CPU. A GPU is present, but the CUDA 12 libraries faster-whisper needs are not: pip install nvidia-cublas-cu12 nvidia-cudnn-cu12'
            : info.gpus > 0 ? 'Ready — the GPU will be used.' : 'Ready on the CPU.',
      }
      return environment
    } catch { /* try the next one */ }
  }
  environment = { python: null, pythonVersion: null, packages: { stableTs: null, fasterWhisper: null }, syllables: false, gpus: 0, cudaRuntime: false, ready: false, message: 'Python was not found. Install Python 3, then: pip install stable-ts faster-whisper' }
  return environment
}

let current: ChildProcess | null = null
let cancelled = false

export function cancelLyricSync() {
  if (!current?.pid) return false
  cancelled = true
  // The worker starts ffmpeg itself; take the whole tree down, not just Python.
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(current.pid), '/T', '/F'], { windowsHide: true })
  else current.kill('SIGTERM')
  return true
}

export async function runLyricSync(request: LyricSyncRequest, onEvent: (event: LyricSyncEvent) => void): Promise<LyricSyncResult> {
  if (current) return { ok: false, message: 'A sync is already running. Wait for it, or cancel it first.' }
  const env = await lyricSyncEnvironment()
  if (!env.ready || !env.python) return { ok: false, message: env.message }
  if (!fs.existsSync(request.audioPath)) return { ok: false, message: 'That audio file is no longer there.' }
  const root = studioRoot()
  if (!fs.existsSync(path.join(root, 'lyricstudio', 'cli.py'))) return { ok: false, message: 'The lyric sync engine (Lyric Studio) is missing from this install.' }
  const level = request.level === 'syllable' && env.syllables ? 'syllable' : 'word'

  const args = ['-m', 'lyricstudio.cli', '--audio', request.audioPath, '--model', request.model || 'base', '--device', request.device ?? 'auto', '--level', level]
  if (request.language) args.push('--language', request.language)
  const ffmpegDir = ffmpegLocation()
  if (ffmpegDir) args.push('--ffmpeg-dir', ffmpegDir)
  let lyricsFile: string | null = null
  if (request.lyricsLines?.length) {
    lyricsFile = path.join(os.tmpdir(), `lyrigen-lines-${process.pid}-${Date.now()}.json`)
    fs.writeFileSync(lyricsFile, JSON.stringify(request.lyricsLines), 'utf8')
    args.push('--lines-file', lyricsFile)
  } else if (request.lyricsText?.trim()) {
    lyricsFile = path.join(os.tmpdir(), `lyrigen-lyrics-${process.pid}-${Date.now()}.txt`)
    fs.writeFileSync(lyricsFile, request.lyricsText, 'utf8')
    args.push('--lyrics-file', lyricsFile)
  }

  cancelled = false
  let result: LyricSyncResult | null = null
  let lastError = ''
  try {
    await new Promise<void>(resolve => {
      const pythonPath = [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
      const child = spawn(env.python!, args, { windowsHide: true, env: { ...process.env, PYTHONPATH: pythonPath, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } })
      current = child
      let stdoutBuffer = '', stderrBuffer = ''
      let workerReportsProgress = false
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split(/\r?\n/)
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim().startsWith('{')) continue
          try {
            const event = JSON.parse(line) as LyricSyncEvent & Omit<LyricSyncResult, 'ok'>
            if (event.event === 'result') {
              const { event: _kind, stage: _stage, compute: _compute, percent: _percent, ...rest } = event
              result = { ok: true, ...rest }
            }
            else if (event.event === 'error') lastError = event.message ?? 'The sync failed.'
            else {
              if (event.event === 'progress') workerReportsProgress = true
              onEvent(event)
            }
          } catch { /* not ours */ }
        }
      })
      // stable-ts draws its alignment progress bar on stderr ("Align:  35%|…");
      // alignment has no callback, so that bar is the only progress there is.
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderrBuffer = (stderrBuffer + chunk).slice(-4000)
        // Once the worker reports its own progress (line by line), the per-clip
        // bars would only make the meter jump backwards, so they are ignored.
        if (workerReportsProgress) return
        const matches = [...chunk.matchAll(/Align:\s+(\d+)%/g)]
        const last = matches[matches.length - 1]
        if (last) onEvent({ event: 'progress', percent: Number(last[1]) })
      })
      child.on('error', error => { lastError = error.message; resolve() })
      child.on('close', code => {
        if (!result && !lastError && code !== 0) lastError = stderrBuffer.trim().split(/\r?\n/).filter(Boolean).pop() ?? `The worker stopped (code ${code}).`
        resolve()
      })
    })
  } finally {
    current = null
    if (lyricsFile) fs.promises.rm(lyricsFile, { force: true }).catch(() => undefined)
  }
  if (cancelled) return { ok: false, message: 'Cancelled.' }
  return result ?? { ok: false, message: lastError || 'The sync produced nothing.' }
}
