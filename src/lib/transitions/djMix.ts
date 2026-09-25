import type { BeatGrid, MixInfo } from '../beat/beatClock'

/**
 * DJ-style transitions for the player.
 *
 * Architecture (why it is built this way):
 *  - Songs keep streaming from <audio> elements, so memory stays flat, a song
 *    starts at once, and everything bound to the player (lyrics, EQ, karaoke,
 *    seeking) keeps working. Decoding whole songs into buffers would give
 *    sample-exact starts, but costs ~110 MB per five-minute song and a rewrite.
 *  - Precision comes from two places instead. Every effect — EQ, filters,
 *    echo, reverb, the riser, the cuts — is scheduled on the AudioContext
 *    clock, so it lands sample-exactly where the beat grid says. An element's
 *    start is the one thing that is not exact, so the incoming song starts a
 *    moment early and silent, and a phase-locked loop pulls it onto the
 *    outgoing song's beat (a jump while it is silent, then rate nudges of at
 *    most 3%) and keeps it there for the rest of the mix.
 *  - Tempo is matched with the browser's pitch-preserving time-stretch, which
 *    stays clean within ±8%. Beyond that, beatmatching is skipped and a style
 *    that does not need it (echo out, build-up and drop) is used.
 *
 * Signal path per player ("strip"), ahead of the shared EQ and effects:
 *   source → gain → low shelf → mid peak → high shelf → sweep filter → out
 *                                          out → echo send / reverb send
 */

export type MixStyle = 'blend' | 'bass' | 'filter' | 'echo' | 'trail' | 'drop'

export const MIX_STYLES: Array<{ id: MixStyle; label: string; hint: string }> = [
  { id: 'blend', label: 'Slow blend', hint: '32 beats: the next song rises under this one, basslines swap halfway' },
  { id: 'bass', label: 'Bass swap', hint: '16 beats: the new song comes in without bass, then takes it on the downbeat' },
  { id: 'filter', label: 'Filter (muffle)', hint: 'The old song is muffled away while the new one opens up' },
  { id: 'echo', label: 'Echo out', hint: 'The old song repeats on the beat and fades as the new one lands' },
  { id: 'trail', label: 'Sound trail', hint: 'The old song dissolves into a reverb wash' },
  { id: 'drop', label: 'Build-up & drop', hint: 'A rising sweep, one beat of silence, then the new song hits' },
]

/** Beats the outgoing song must still be playing for, and where the new one enters. */
const SHAPE: Record<MixStyle, { outBeats: number; entry: number; beats: number; tail: number }> = {
  blend: { outBeats: 32, entry: 0, beats: 32, tail: 0 },
  bass: { outBeats: 16, entry: 0, beats: 16, tail: 0 },
  filter: { outBeats: 16, entry: 0, beats: 16, tail: 0 },
  echo: { outBeats: 4, entry: 4, beats: 8, tail: 6 },
  trail: { outBeats: 4, entry: 4, beats: 12, tail: 4 },
  drop: { outBeats: 15, entry: 16, beats: 16, tail: 0 },
}

const KILL = -26 // dB: an EQ band "killed" during a swap
const MAX_BEND = 0.08

// ---- the strips ---------------------------------------------------------------

export interface Strip { gain: GainNode; low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode; sweep: BiquadFilterNode; echo: GainNode; trail: GainNode }

export class MixBus {
  readonly main: Strip
  readonly ghost: Strip
  private delay: DelayNode
  private noise: AudioBuffer

  constructor(readonly context: AudioContext, main: AudioNode, ghost: AudioNode, private output: AudioNode) {
    // Shared echo (beat-timed, thinned so repeats never muddy the new bass)
    // and a reverb for trails; each strip has its own send into them.
    const echoIn = context.createGain()
    this.delay = context.createDelay(2)
    const feedback = context.createGain(); feedback.gain.value = 0.55
    const thin = context.createBiquadFilter(); thin.type = 'highpass'; thin.frequency.value = 320
    const soft = context.createBiquadFilter(); soft.type = 'lowpass'; soft.frequency.value = 6500
    echoIn.connect(this.delay).connect(thin).connect(soft).connect(feedback).connect(this.delay)
    soft.connect(output)
    const reverb = context.createConvolver()
    reverb.buffer = impulse(context, 3.5)
    const reverbOut = context.createGain(); reverbOut.gain.value = 0.8
    reverb.connect(reverbOut).connect(output)
    const strip = (source: AudioNode, gain: number): Strip => {
      const s: Strip = {
        gain: context.createGain(),
        low: context.createBiquadFilter(), mid: context.createBiquadFilter(), high: context.createBiquadFilter(),
        sweep: context.createBiquadFilter(), echo: context.createGain(), trail: context.createGain(),
      }
      s.low.type = 'lowshelf'; s.low.frequency.value = 180
      s.mid.type = 'peaking'; s.mid.frequency.value = 1000; s.mid.Q.value = 0.7
      s.high.type = 'highshelf'; s.high.frequency.value = 4000
      source.connect(s.gain).connect(s.low).connect(s.mid).connect(s.high).connect(s.sweep).connect(output)
      s.sweep.connect(s.echo).connect(echoIn)
      s.sweep.connect(s.trail).connect(reverb)
      this.neutral(s, gain)
      return s
    }
    this.main = strip(main, 1)
    this.ghost = strip(ghost, 0)
    this.noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }

  /** Every control of a strip back to flat, from `at` (default: now). */
  neutral(s: Strip, gain: number, at = this.context.currentTime) {
    for (const param of [s.gain.gain, s.low.gain, s.mid.gain, s.high.gain, s.sweep.frequency, s.sweep.Q, s.echo.gain, s.trail.gain]) param.cancelScheduledValues(at)
    s.gain.gain.setValueAtTime(gain, at)
    s.low.gain.setValueAtTime(0, at); s.mid.gain.setValueAtTime(0, at); s.high.gain.setValueAtTime(0, at)
    s.sweep.type = 'allpass'; s.sweep.frequency.setValueAtTime(1000, at); s.sweep.Q.setValueAtTime(0.7, at)
    s.echo.gain.setValueAtTime(0, at); s.trail.gain.setValueAtTime(0, at)
  }

  setEchoBeat(seconds: number) { this.delay.delayTime.value = Math.min(1.9, seconds) }

  /** Build-up noise: filtered white noise sweeping up and swelling from `start` to `end`. */
  riser(start: number, end: number, peak = 0.16) {
    const source = this.context.createBufferSource()
    source.buffer = this.noise
    source.loop = true
    const band = this.context.createBiquadFilter(); band.type = 'bandpass'; band.Q.value = 1.4
    const gain = this.context.createGain()
    band.frequency.setValueAtTime(500, start)
    band.frequency.exponentialRampToValueAtTime(9000, end)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(peak, end - 0.02)
    gain.gain.linearRampToValueAtTime(0, end)
    source.connect(band).connect(gain).connect(this.output)
    source.start(start)
    source.stop(end + 0.05)
    source.onended = () => { source.disconnect(); band.disconnect(); gain.disconnect() }
    return () => { try { source.stop() } catch { /* not started */ } }
  }
}

function impulse(context: AudioContext, seconds: number) {
  const length = Math.round(context.sampleRate * seconds)
  const buffer = context.createBuffer(2, length, context.sampleRate)
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.6
  }
  return buffer
}

// ---- planning -----------------------------------------------------------------

const barStarts = (grid: BeatGrid, every: number) => (k: number) => ((k - grid.downbeat) % every + every) % every === 0

/** The style Auto picks: beatmatched mixes when the tempos agree, otherwise ones that do not need it. */
export function chooseStyle(preference: MixStyle | 'auto', out: MixInfo, incoming: MixInfo | null): MixStyle | null {
  if (!out.grid) return null
  const bend = incoming?.grid ? tempoBend(out.grid.bpm, incoming.grid.bpm) : null
  const matchable = bend != null && Math.abs(bend - 1) <= MAX_BEND
  // Two songs playing together at different tempos would clash: fall back to echo.
  if (preference !== 'auto') return !matchable && (preference === 'blend' || preference === 'bass' || preference === 'filter') ? 'echo' : preference
  if (!matchable) return incoming?.grid && Math.abs((bend ?? 2) - 1) < 0.2 ? 'drop' : 'echo'
  return out.grid.bpm >= 112 ? 'bass' : 'blend'
}

/** Rate that makes `incomingBpm` match `outBpm` (half or double time, whichever is closest). */
export function tempoBend(outBpm: number, incomingBpm: number) {
  return [0.5, 1, 2].map(multiple => outBpm * multiple / incomingBpm).reduce((best, value) => Math.abs(value - 1) < Math.abs(best - 1) ? value : best)
}

/**
 * Where in the outgoing song (media seconds) the mix starts: the last phrase
 * start (16 beats, else a bar) that leaves room for the style before the
 * song's audible end — not its file end, which is often silence.
 */
export function planMixStart(out: MixInfo, style: MixStyle): number | null {
  const grid = out.grid
  if (!grid) return null
  const beat = 60 / grid.bpm
  const needed = SHAPE[style].outBeats * beat
  for (const every of [16, 4]) {
    const isStart = barStarts(grid, every)
    for (let k = Math.floor((out.soundEnd - needed - grid.firstBeat) / beat); k > 0; k--) {
      const at = grid.firstBeat + k * beat
      if (at < out.duration * 0.5) break
      if (isStart(k)) return at
    }
  }
  return null
}

// ---- a running transition -----------------------------------------------------

export interface MixRequest { style: MixStyle; out: MixInfo; incoming: MixInfo | null; target: number }

/**
 * One transition, from the moment the incoming song is playing (silently)
 * until the outgoing one is gone and the tempo has eased back.
 */
export class TransitionRun {
  private timer = 0
  private glideTimer = 0
  private stopRiser: (() => void) | null = null
  private errors: number[] = []
  private done = false
  finished = false
  /** For checks (window.lyrigenMix with the debug flag): what was chosen and how tight the lock is, in ms. */
  readonly stats = { style: '' as string, beatmatch: false, bend: 1, entryIn: 0, entryMedia: 0, lockedErrors: [] as number[] }

  constructor(
    private bus: MixBus,
    private outgoing: HTMLAudioElement,
    private incoming: HTMLAudioElement,
    private request: MixRequest,
    private baseRate: () => number,
    private onDone: () => void,
  ) {}

  start() {
    const { bus, outgoing, incoming, request } = this
    const context = bus.context
    const grid = request.out.grid!
    const shape = SHAPE[request.style]
    const rateOut = outgoing.playbackRate || 1
    const beatMedia = 60 / grid.bpm
    const beat = beatMedia / rateOut // real seconds per beat
    const now = context.currentTime
    const position = outgoing.currentTime

    // T0: the planned phrase start if there is still time to line up to it,
    // else the next bar.
    const margin = 0.45
    let startMedia = request.target
    if ((startMedia - position) / rateOut < margin) {
      const isBar = barStarts(grid, 4)
      let k = Math.ceil((position + margin * rateOut - grid.firstBeat) / beatMedia)
      while (!isBar(k)) k++
      startMedia = grid.firstBeat + k * beatMedia
    }
    const t0 = now + (startMedia - position) / rateOut
    const at = (b: number) => t0 + b * beat

    // Tempo: bend the new song onto this one's, if it is close enough.
    const base = this.baseRate()
    const inGrid = request.incoming?.grid ?? null
    const bend = inGrid ? tempoBend(grid.bpm * rateOut, inGrid.bpm * base) : 1
    // Only the styles where both songs play together need matched tempos.
    const overlapping = request.style === 'blend' || request.style === 'bass' || request.style === 'filter'
    const beatmatch = overlapping && inGrid != null && Math.abs(bend - 1) <= MAX_BEND
    const rateIn = beatmatch ? base * bend : base
    incoming.playbackRate = rateIn
    Object.assign(this.stats, { style: request.style, beatmatch, bend: rateIn / base })

    // Entry, landing on beat `entry`: where the new song's beat is in full
    // (its intro or build-up skipped), else its first downbeat with sound.
    const entryAt = at(shape.entry)
    this.stats.entryIn = entryAt - now
    let entryMedia = request.incoming?.soundStart ?? 0
    const inBeat = inGrid ? 60 / inGrid.bpm : 0
    if (inGrid && request.incoming?.beatIn != null) entryMedia = request.incoming.beatIn
    else if (inGrid) {
      const isBar = barStarts(inGrid, 4)
      let j = Math.max(0, Math.ceil((entryMedia - 0.05 - inGrid.firstBeat) / inBeat))
      while (!isBar(j)) j++
      entryMedia = inGrid.firstBeat + j * inBeat
    }
    while (entryMedia - (entryAt - now) * rateIn < 0) entryMedia += inGrid ? 4 * inBeat : 1
    incoming.currentTime = entryMedia - (entryAt - context.currentTime) * rateIn
    this.stats.entryMedia = Math.round(entryMedia * 10) / 10

    // Echo repeats every ¾ beat: rhythmic, and between the new song's kicks.
    bus.setEchoBeat(beat * 0.75)
    this.schedule(request.style, at, now)

    // Phase lock: before the entry, jump onto the grid (it is silent then);
    // after it, nudge the rate. Measured against the outgoing element itself,
    // so both songs are compared in the same clock.
    const outAtEntry = startMedia + shape.entry * beatMedia
    const end = at(shape.beats) + shape.tail
    this.timer = window.setInterval(() => {
      const t = context.currentTime
      if (t > end) { this.finish(); return }
      if (!beatmatch && t > entryAt + 0.2) return
      const expected = entryMedia + ((outgoing.currentTime - outAtEntry) / rateOut) * rateIn
      const error = incoming.currentTime - expected
      this.errors.push(error)
      if (this.errors.length > 5) this.errors.shift()
      const smooth = [...this.errors].sort((a, b) => a - b)[this.errors.length >> 1]
      if (t > entryAt) this.stats.lockedErrors.push(Math.round(smooth * 1000))
      if (t < entryAt - 0.08) {
        if (Math.abs(smooth) > 0.015) { incoming.currentTime -= smooth; this.errors = [] }
      } else if (beatmatch) {
        if (Math.abs(smooth) > 0.25) { this.abort(); return } // someone seeked
        const nudge = Math.abs(smooth) < 0.004 ? 0 : Math.max(-0.03, Math.min(0.03, smooth * 1.6))
        incoming.playbackRate = rateIn * (1 - nudge)
      }
    }, 40)
  }

  /** The automation for each style, all on the audio clock. */
  private schedule(style: MixStyle, at: (beat: number) => number, now: number) {
    const { main: incoming, ghost: out } = this.bus
    this.bus.neutral(incoming, 0, now)
    this.bus.neutral(out, out.gain.gain.value, now)
    const ramp = (param: AudioParam, from: number, to: number, b0: number, b1: number, shape: 'lin' | 'in' | 'out' | 'exp' = 'lin') => {
      const start = at(b0)
      const duration = Math.max(0.02, at(b1) - start)
      const curve = new Float32Array(48)
      for (let i = 0; i < curve.length; i++) {
        const x = i / (curve.length - 1)
        curve[i] = shape === 'exp' ? from * (to / from) ** x
          : shape === 'in' ? from + (to - from) * Math.sin(x * Math.PI / 2) // equal-power rise
            : shape === 'out' ? to + (from - to) * Math.cos(x * Math.PI / 2) // equal-power fall
              : from + (to - from) * x
      }
      param.setValueAtTime(from, start)
      param.setValueCurveAtTime(curve, start + 0.001, duration)
    }
    // A switch on the beat, with 12 ms of ramp so it does not click.
    const set = (param: AudioParam, from: number, to: number, b: number) => { param.setValueAtTime(from, at(b) - 0.012); param.linearRampToValueAtTime(to, at(b)) }
    // Filter type is not automatable, so the frequency it starts at is set now.
    const sweep = (s: typeof out, type: BiquadFilterType, frequency: number) => { s.sweep.type = type; s.sweep.frequency.setValueAtTime(frequency, now) }

    switch (style) {
      case 'blend':
        incoming.low.gain.setValueAtTime(KILL, now)
        ramp(incoming.gain.gain, 0, 1, 0, 16, 'in')
        ramp(incoming.low.gain, KILL, 0, 16, 17)
        ramp(out.low.gain, 0, KILL, 16, 17)
        ramp(out.high.gain, 0, -6, 16, 32)
        ramp(out.gain.gain, 1, 0, 16, 32, 'out')
        break
      case 'bass':
        incoming.low.gain.setValueAtTime(KILL, now)
        ramp(incoming.gain.gain, 0, 1, 0, 4, 'in')
        set(incoming.low.gain, KILL, 0, 8)
        set(out.low.gain, 0, KILL, 8)
        ramp(out.mid.gain, 0, -6, 8, 16)
        ramp(out.gain.gain, 1, 0, 8, 16, 'out')
        break
      case 'filter':
        sweep(out, 'lowpass', 20000); sweep(incoming, 'highpass', 900)
        ramp(out.sweep.frequency, 20000, 280, 0, 12, 'exp')
        ramp(out.sweep.Q, 0.7, 4, 0, 12)
        ramp(out.gain.gain, 1, 0, 10, 16, 'out')
        ramp(incoming.sweep.frequency, 900, 20, 0, 12, 'exp')
        ramp(incoming.gain.gain, 0, 1, 0, 8, 'in')
        break
      case 'echo':
        ramp(out.echo.gain, 0, 0.9, 0, 4)
        set(out.gain.gain, 1, 0, 4)
        incoming.gain.gain.setValueAtTime(0, now)
        set(incoming.gain.gain, 0, 1, 4)
        incoming.low.gain.setValueAtTime(KILL, now)
        ramp(incoming.low.gain, KILL, 0, 4, 8)
        ramp(out.echo.gain, 0.9, 0, 4.05, 5)
        break
      case 'trail':
        ramp(out.trail.gain, 0, 1, 1, 4)
        set(out.gain.gain, 1, 0, 4)
        ramp(out.trail.gain, 1, 0, 4.05, 5)
        sweep(incoming, 'highpass', 400)
        ramp(incoming.gain.gain, 0, 1, 4, 6, 'in')
        ramp(incoming.sweep.frequency, 400, 20, 4, 12, 'exp')
        break
      case 'drop':
        sweep(out, 'highpass', 20)
        ramp(out.sweep.frequency, 20, 900, 0, 15, 'exp')
        this.stopRiser = this.bus.riser(at(0), at(15))
        set(out.gain.gain, 1, 0, 15) // one beat of silence…
        incoming.gain.gain.setValueAtTime(0, now)
        set(incoming.gain.gain, 0, 1, 16) // …then the new song hits
        break
    }
  }

  private finish() {
    if (this.done) return
    this.done = true
    window.clearInterval(this.timer)
    this.outgoing.pause()
    this.bus.neutral(this.bus.ghost, 0)
    this.bus.neutral(this.bus.main, 1)
    // Ease the new song back to its own tempo over about eight bars.
    const from = this.incoming.playbackRate
    const to = this.baseRate()
    const started = performance.now()
    const seconds = Math.abs(from - to) > 0.002 ? 16 : 0
    const step = () => {
      const progress = seconds ? Math.min(1, (performance.now() - started) / 1000 / seconds) : 1
      if (!this.incoming.paused) this.incoming.playbackRate = from + (to - from) * progress
      if (progress >= 1) { window.clearInterval(this.glideTimer); this.finished = true; this.onDone() }
    }
    this.glideTimer = window.setInterval(step, 100)
    step()
  }

  /** Stops the mix where it is: the old song fades out quickly, the new one is left flat and audible. */
  abort(keepIncomingSilent = false) {
    if (this.finished) return
    window.clearInterval(this.timer)
    window.clearInterval(this.glideTimer)
    this.stopRiser?.()
    const now = this.bus.context.currentTime
    this.bus.neutral(this.bus.ghost, this.bus.ghost.gain.gain.value, now)
    this.bus.ghost.gain.gain.linearRampToValueAtTime(0, now + 0.25)
    window.setTimeout(() => { this.outgoing.pause(); this.bus.neutral(this.bus.ghost, 0) }, 300)
    this.bus.neutral(this.bus.main, this.bus.main.gain.gain.value, now)
    this.bus.main.gain.gain.linearRampToValueAtTime(keepIncomingSilent ? 0 : 1, now + 0.2)
    this.done = true
    this.finished = true
    this.onDone()
  }
}
