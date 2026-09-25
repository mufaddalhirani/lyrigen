import type { BeatSample } from './beatClock'

/**
 * The interlude visualizer: what plays between sung lines.
 *
 *   ▂▃▅▇█▇▅▃▂   frequency bars, bass in the middle, treble to the edges —
 *                they jump on each kick and fall back slowly, so the beat
 *                reads even at a glance
 *   ■ □ □ □     the bar, beat by beat, the downbeat accented
 *   3 · 2 · 1   and over the last four beats before the next line, a
 *                karaoke count-in: when to come back in
 *
 * One small canvas; drawn only while it is on screen.
 */

export interface InterludeState {
  /** Seconds until the next sung line, or null when none follows. */
  nextLineIn: number | null
}

const BANDS = 24

export class InterludeVisualizer {
  readonly canvas = document.createElement('canvas')
  private levels = new Float32Array(BANDS)
  private peaks = new Float32Array(BANDS)
  private beatFlash = 0
  private lastIndex = Number.NaN
  private idle = 0

  constructor(className: string, private width = 360, private height = 104) {
    this.canvas.className = className
    this.canvas.width = width
    this.canvas.height = height
    this.canvas.setAttribute('aria-hidden', 'true')
  }

  draw(sample: BeatSample, state: InterludeState, delta: number, still: boolean) {
    const context = this.canvas.getContext('2d')
    if (!context) return
    const { width, height } = this
    const style = getComputedStyle(this.canvas)
    const ink = style.color || '#fff'
    const accent = style.getPropertyValue('--viz-accent').trim() || '#e8a3b3'
    context.clearRect(0, 0, width, height)

    // -- bars ---------------------------------------------------------------
    const barsHeight = height * 0.62
    const bins = sample.spectrum
    this.idle += delta / 1000
    for (let i = 0; i < BANDS; i++) {
      const distance = Math.abs(i - (BANDS - 1) / 2) / ((BANDS - 1) / 2)
      let target: number
      if (bins && !still) {
        // Log-spaced bands from ~40 Hz (middle) to ~8 kHz (edges).
        const from = Math.max(1, Math.round(2 * Math.pow(170, distance)))
        const to = Math.max(from + 1, Math.round(2 * Math.pow(170, Math.min(1, distance + 1 / BANDS * 2))))
        let peak = 0
        for (let b = from; b < to && b < bins.length; b++) if (bins[b] > peak) peak = bins[b]
        target = Math.min(1, (peak / 255) * (0.85 + distance * 0.5))
        target = Math.max(target, target * (1 + sample.pulse * 0.25))
      } else {
        target = 0.12 + 0.08 * Math.sin(this.idle * 2 + i * 0.5)
      }
      // Fast attack, slow release: kicks jump, tails fall.
      this.levels[i] += (target - this.levels[i]) * (target > this.levels[i] ? 0.7 : 0.12)
      this.peaks[i] = Math.max(this.levels[i], this.peaks[i] - delta / 1000 * 0.6)
    }
    const gap = 4
    const barWidth = (width - gap * (BANDS - 1)) / BANDS
    context.globalAlpha = 0.9
    context.fillStyle = ink
    for (let i = 0; i < BANDS; i++) {
      const h = Math.max(3, this.levels[i] * barsHeight)
      context.fillRect(i * (barWidth + gap), barsHeight - h, barWidth, h)
      // A thin cap holds each band's recent peak.
      context.globalAlpha = 0.45
      context.fillRect(i * (barWidth + gap), barsHeight - Math.max(3, this.peaks[i] * barsHeight) - 3, barWidth, 1.5)
      context.globalAlpha = 0.9
    }

    // -- beat counter / count-in --------------------------------------------
    if (sample.index !== this.lastIndex) { this.lastIndex = sample.index; this.beatFlash = 1 }
    this.beatFlash = Math.max(0, this.beatFlash - delta / 260)
    const beatsLeft = state.nextLineIn != null && sample.beatSeconds > 0 ? Math.ceil(state.nextLineIn / sample.beatSeconds - 0.05) : Infinity
    const countIn = beatsLeft <= 4 && beatsLeft >= 1
    const row = barsHeight + (height - barsHeight) * 0.55
    const cell = 12, spacing = 16
    const startX = (width - (4 * cell + 3 * spacing)) / 2
    for (let beat = 0; beat < 4; beat++) {
      const x = startX + beat * (cell + spacing)
      let alpha: number, fill: string
      if (countIn) {
        // Squares that remain before the entry, counting down.
        const lit = beat < beatsLeft
        alpha = lit ? 1 : 0.15
        fill = accent
      } else {
        const current = beat === sample.barBeat
        alpha = current ? 0.45 + 0.55 * this.beatFlash : 0.18
        fill = beat === 0 ? accent : ink
      }
      context.globalAlpha = alpha
      context.fillStyle = fill
      context.fillRect(x, row - cell / 2, cell, cell)
    }
    context.globalAlpha = 1
    if (countIn) {
      context.fillStyle = accent
      context.font = '600 13px "Geist Mono Variable", "Cascadia Mono", monospace'
      context.textAlign = 'left'
      context.fillText(String(beatsLeft), startX + 4 * cell + 3 * spacing + 12, row + 5)
    }
  }
}
