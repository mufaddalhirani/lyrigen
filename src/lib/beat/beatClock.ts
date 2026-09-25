import { analyzeAudio } from '../dj/analysis'

/**
 * Where the beats are, for visuals that move with the music.
 *
 * Guessing beats from loudness in real time is always late and often wrong
 * (a loud vocal is not a kick). So each song's beat grid is found once — the
 * same analysis the DJ decks use: tempo, the first beat, and which beat is the
 * "1" of the bar — and remembered. With the grid, a beat lands exactly when
 * the audio says it does. The live spectrum then only has to say how *hard*
 * each beat hits, which it is good at.
 *
 * Songs without a steady grid (rubato, spoken word) fall back to live kick
 * detection: an adaptive threshold on the rise in bass energy.
 */

export interface BeatGrid {
  bpm: number
  /** Seconds to the first beat of the grid. */
  firstBeat: number
  /** Which beat index (0–3) of the grid is the bar's downbeat. */
  downbeat: number
}

export interface BeatSample {
  hasGrid: boolean
  bpm: number | null
  /** Beat length in seconds (real time, after playback speed). */
  beatSeconds: number
  /** Beat number since the grid began (can be negative in an intro). */
  index: number
  /** 0 at a beat, rising to 1 just before the next. */
  phase: number
  /** Position in the bar: 0 is the downbeat. */
  barBeat: number
  /** 1 at a beat, decaying to 0 — how much to move right now. */
  pulse: number
  /** Kick strength of the most recent beat, 0–1. */
  strength: number
  /** Bass and overall level right now, 0–1. */
  bass: number
  level: number
  /** The live spectrum (byte magnitudes), or null when silent. */
  spectrum: Uint8Array | null
}

const GRID_KEY = (path: string) => `lyrigen-beatgrid-v1:${path.toLocaleLowerCase()}`

function readCached(path: string): BeatGrid | null | undefined {
  try {
    const raw = localStorage.getItem(GRID_KEY(path))
    if (raw === null) return undefined
    return JSON.parse(raw) as BeatGrid | null
  } catch {
    return undefined
  }
}

/** The song's beat grid: cached, or found now (about a second of background work). */
export async function loadBeatGrid(path: string): Promise<BeatGrid | null> {
  const cached = readCached(path)
  if (cached !== undefined) return cached
  const bytes = await window.electronAPI.readAudioBytes(path)
  if (!bytes) return null
  const analysis = await analyzeAudio(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  let grid: BeatGrid | null = null
  if (analysis.bpm) {
    // The downbeat is the beat position (of four) where the bass hits hardest on average.
    const beat = 60 / analysis.bpm
    const scores = [0, 0, 0, 0]
    for (let k = 0; analysis.firstBeat + k * beat < analysis.duration; k++) {
      const frame = Math.round((analysis.firstBeat + k * beat) * analysis.frameRate)
      let hit = 0
      for (let f = frame - 1; f <= frame + 2; f++) if (f >= 0 && f < analysis.peaks.length) hit = Math.max(hit, analysis.peaks[f] * analysis.lows[f])
      scores[k % 4] += hit
    }
    grid = { bpm: analysis.bpm, firstBeat: analysis.firstBeat, downbeat: scores.indexOf(Math.max(...scores)) }
  }
  try { localStorage.setItem(GRID_KEY(path), JSON.stringify(grid)) } catch { /* recomputed next time */ }
  return grid
}

export class BeatClock {
  grid: BeatGrid | null = null
  private bins: Uint8Array<ArrayBuffer> = new Uint8Array(1024)
  private cached: { at: number; value: BeatSample } | null = null
  private bassAverage = 0.25
  private lastBeatIndex = Number.NaN
  private strength = 0.6
  private previousBass = 0
  private liveBeatAt = -Infinity
  private liveCount = 0
  private fluxAverage = 0.02

  constructor(private audio: () => HTMLAudioElement | null, private analyser: () => AnalyserNode | null) {}

  /** Everything a visual needs this frame. Cheap, and the same for every caller in one frame. */
  sample(): BeatSample {
    const now = performance.now()
    if (this.cached && now - this.cached.at < 6) return this.cached.value
    const audio = this.audio()
    const playing = Boolean(audio && !audio.paused)
    const rate = audio?.playbackRate || 1
    const node = this.analyser()
    let bass = 0, level = 0, spectrum: Uint8Array | null = null
    if (node && playing) {
      if (this.bins.length !== node.frequencyBinCount) this.bins = new Uint8Array(node.frequencyBinCount)
      node.getByteFrequencyData(this.bins)
      // 2048-point FFT at 44.1/48 kHz: bins 1–6 are roughly 20–140 Hz, the kick.
      let sum = 0
      for (let i = 1; i <= 6; i++) sum += this.bins[i]
      bass = sum / (6 * 255)
      let all = 0
      const top = Math.min(this.bins.length, 400)
      for (let i = 0; i < top; i++) all += this.bins[i]
      level = all / (top * 255)
      spectrum = this.bins
    }
    this.bassAverage = this.bassAverage * 0.985 + bass * 0.015

    let value: BeatSample
    if (this.grid && audio) {
      const beatSeconds = 60 / this.grid.bpm
      const position = (audio.currentTime - this.grid.firstBeat) / beatSeconds
      const index = Math.floor(position)
      const phase = position - index
      if (index !== this.lastBeatIndex && phase < 0.35) {
        this.lastBeatIndex = index
        // How hard this beat hits, relative to the song's own bass.
        this.strength = Math.max(0.25, Math.min(1, bass / Math.max(0.08, this.bassAverage * 1.25)))
      }
      const barBeat = ((index - this.grid.downbeat) % 4 + 4) % 4
      const accent = barBeat === 0 ? 1 : 0.7
      value = {
        hasGrid: true, bpm: this.grid.bpm * rate, beatSeconds: beatSeconds / rate, index, phase, barBeat,
        pulse: playing ? Math.exp(-phase * 6) * this.strength * accent : 0,
        strength: this.strength, bass, level, spectrum,
      }
    } else {
      // No grid: a kick is a sharp rise in bass well above its recent average.
      const flux = Math.max(0, bass - this.previousBass)
      this.fluxAverage = this.fluxAverage * 0.97 + flux * 0.03
      if (playing && flux > Math.max(0.035, this.fluxAverage * 2.6) && bass > 0.3 && now - this.liveBeatAt > 240) {
        this.liveBeatAt = now
        this.liveCount++
        this.strength = Math.min(1, 0.4 + flux * 6)
      }
      const since = (now - this.liveBeatAt) / 1000
      value = {
        hasGrid: false, bpm: null, beatSeconds: 0.5, index: this.liveCount, phase: Math.min(1, since / 0.5), barBeat: this.liveCount % 4,
        pulse: playing ? Math.exp(-since * 9) * this.strength : 0, strength: this.strength, bass, level, spectrum,
      }
    }
    this.previousBass = bass
    this.cached = { at: now, value }
    return value
  }
}
