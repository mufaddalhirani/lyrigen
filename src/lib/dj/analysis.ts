/**
 * What the decks need to know about a song: its tempo, where the beats fall,
 * and a waveform to draw.
 *
 * The file is decoded once at 11 kHz (a quarter of CD rate — plenty for kick
 * drums and a waveform, and a quarter of the memory), then:
 *
 *  1. An onset curve at 100 frames a second: how sharply the bass (a one-pole
 *     low-pass around 150 Hz) and the full band get louder, frame to frame.
 *  2. Autocorrelation of that curve finds the repeating period between 70 and
 *     180 BPM, leaning towards the 90–140 range where most songs sit, so a
 *     120 BPM song is not called 60 or 240.
 *  3. A comb search around that tempo, in 0.02 BPM steps and every phase,
 *     finds the grid whose beats land on the most onsets. That gives both the
 *     precise tempo and where the first beat is — what beat-sync needs.
 *
 * All of it is a few passes over a few million numbers: well under a second.
 */

export interface TrackAnalysis {
  bpm: number | null
  /** Seconds to the first beat of the grid (0 ≤ firstBeat < one beat). */
  firstBeat: number
  duration: number
  /** Peak level per 10 ms frame, 0–1. */
  peaks: Float32Array
  /** How much of each frame is bass, 0–1 — colours the waveform. */
  lows: Float32Array
  frameRate: number
}

const RATE = 11025
const HOP = 110 // ≈ 10 ms at 11025 Hz
const FRAME_RATE = RATE / HOP

export async function analyzeAudio(bytes: ArrayBuffer): Promise<TrackAnalysis> {
  const context = new OfflineAudioContext(1, 1, RATE)
  const buffer = await context.decodeAudioData(bytes)
  const length = buffer.length
  const mono = new Float32Array(length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < length; i++) mono[i] += data[i] / buffer.numberOfChannels
  }

  const frames = Math.floor(length / HOP)
  const peaks = new Float32Array(frames)
  const lows = new Float32Array(frames)
  const lowEnergy = new Float32Array(frames)
  const fullEnergy = new Float32Array(frames)
  const alpha = 1 - Math.exp(-2 * Math.PI * 150 / RATE)
  let low = 0
  for (let f = 0; f < frames; f++) {
    let peak = 0, lowSum = 0, fullSum = 0
    for (let i = f * HOP, end = i + HOP; i < end; i++) {
      const sample = mono[i]
      low += alpha * (sample - low)
      const magnitude = Math.abs(sample)
      if (magnitude > peak) peak = magnitude
      lowSum += low * low
      fullSum += sample * sample
    }
    peaks[f] = peak
    lowEnergy[f] = Math.sqrt(lowSum / HOP)
    fullEnergy[f] = Math.sqrt(fullSum / HOP)
    lows[f] = fullSum > 0 ? Math.min(1, lowSum / fullSum * 1.6) : 0
  }
  // Loud masters and quiet ones should draw the same size.
  let loudest = 0
  for (let f = 0; f < frames; f++) if (peaks[f] > loudest) loudest = peaks[f]
  if (loudest > 0) for (let f = 0; f < frames; f++) peaks[f] /= loudest

  const onset = new Float32Array(frames)
  for (let f = 1; f < frames; f++) {
    onset[f] = Math.max(0, lowEnergy[f] - lowEnergy[f - 1]) * 2 + Math.max(0, fullEnergy[f] - fullEnergy[f - 1])
  }
  const { bpm, firstBeat } = findTempo(onset)
  return { bpm, firstBeat, duration: buffer.duration, peaks, lows, frameRate: FRAME_RATE }
}

function findTempo(onset: Float32Array): { bpm: number | null; firstBeat: number } {
  const frames = onset.length
  if (frames < FRAME_RATE * 10) return { bpm: null, firstBeat: 0 }
  // Autocorrelation over (at most) two minutes from the middle of the song,
  // where the groove is, rather than the intro.
  const span = Math.min(frames, Math.round(FRAME_RATE * 120))
  const start = Math.max(0, Math.floor((frames - span) / 2))
  let bestLag = 0, bestScore = -Infinity
  const scores = new Map<number, number>()
  for (let lag = Math.floor(FRAME_RATE * 60 / 180); lag <= Math.ceil(FRAME_RATE * 60 / 70); lag++) {
    let sum = 0
    for (let i = start; i < start + span - lag; i++) sum += onset[i] * onset[i + lag]
    const bpm = 60 * FRAME_RATE / lag
    // Tempo prior: a gentle log-normal centred on 120 BPM.
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.55) ** 2)
    const score = sum * prior
    scores.set(lag, score)
    if (score > bestScore) { bestScore = score; bestLag = lag }
  }
  if (!bestLag || bestScore <= 0) return { bpm: null, firstBeat: 0 }
  const coarse = 60 * FRAME_RATE / bestLag

  // Autocorrelation finds *a* periodicity, which is often a relative of the
  // beat: half, double, or 2/3 of it (syncopated songs near 170 BPM came out
  // at ~115). Every metrical relative is tried, and each is scored by how well
  // it explains the song's repetition at three levels at once — its beat, two
  // beats, and a bar of four. The true beat lines up at all three; a 2/3 or 4/3
  // relative lands on 1.5, 3 and 6 beats, which a bar never repeats on.
  // (Half-time can still win a close call, which is harmless: every other
  // beat is still on the beat.)
  // Mean removed first: dense songs sit on a large constant floor that
  // otherwise drowns the differences between candidate tempos.
  const maxLag = Math.min(span - 1, Math.round(FRAME_RATE * 4 * 60 / 60) + 2)
  let mean = 0
  for (let i = start; i < start + span; i++) mean += onset[i]
  mean /= span
  const acf = new Float32Array(maxLag + 1)
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = start; i < start + span - lag; i++) sum += (onset[i] - mean) * (onset[i + lag] - mean)
    acf[lag] = sum / (span - lag)
  }
  const at = (lag: number) => {
    if (lag < 1 || lag >= maxLag) return 0
    const low = Math.floor(lag), t = lag - low
    // The best nearby value: tempo estimates are never exact to a frame.
    return Math.max(acf[low] * (1 - t) + acf[low + 1] * t, acf[low - 1] ?? 0, acf[low + 2] ?? 0)
  }
  const candidates = [1, 2, 0.5, 1.5, 2 / 3, 4 / 3, 0.75].map(ratio => coarse * ratio).filter(bpm => bpm >= 60 && bpm <= 200)
  let chosen = coarse, chosenScore = -Infinity
  for (const candidate of candidates) {
    const period = 60 * FRAME_RATE / candidate
    const prior = Math.exp(-0.5 * (Math.log2(candidate / 120) / 0.9) ** 2)
    const score = (at(period) + 0.6 * at(2 * period) + 0.6 * at(4 * period)) * prior
    if (score > chosenScore) { chosenScore = score; chosen = candidate }
  }
  let best = { ...combFit(onset, chosen, 0.1), contrast: 0 }
  best = { ...combFit(onset, best.bpm, 0.02, 0.012), contrast: 0 }
  const bpm = Math.round(best.bpm * 100) / 100
  return { bpm, firstBeat: best.phase / FRAME_RATE }
}

/**
 * The grid near `bpm` (±`span`) whose beats hit the most onset: its tempo,
 * phase, and contrast — mean onset on the beats over mean onset on the
 * points halfway between them.
 */
function combFit(onset: Float32Array, bpm: number, step: number, span = 0.03) {
  const frames = onset.length
  let best = { bpm, phase: 0, score: -Infinity, contrast: 0 }
  for (let tempo = bpm * (1 - span); tempo <= bpm * (1 + span); tempo += step) {
    const period = 60 * FRAME_RATE / tempo
    for (let phase = 0; phase < period; phase += 1) {
      let on = 0, off = 0, count = 0
      for (let position = phase; position < frames - 1; position += period) {
        const index = Math.round(position)
        on += onset[index] + 0.5 * onset[index + 1]
        const middle = Math.round(position + period / 2)
        if (middle < frames - 1) off += onset[middle] + 0.5 * onset[middle + 1]
        count++
      }
      const score = on / Math.max(1, count)
      if (score > best.score) best = { bpm: tempo, phase, score, contrast: (on + 1e-6) / (off + 1e-6) }
    }
  }
  return best
}
