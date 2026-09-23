import { analyzeAudio, type TrackAnalysis } from './analysis'
import { playPad } from './sampler'

/**
 * The DJ engine: two decks, a mixer, a sampler, automix and a recorder.
 *
 * It lives outside React, as one object for the life of the app, so music
 * keeps playing while you look at another screen. The interface subscribes to
 * it and redraws on changes; the playheads and meters are read straight from
 * the engine sixty times a second instead of going through React state.
 *
 * Signal path, per deck:
 *   <audio> → trim → low / mid / high EQ → filter → dry ┐
 *                                              └→ effect → wet ┴→ volume → crossfader → master
 * Master: → limiter → meter → speakers (and the recorder, while recording).
 *
 * Playback is an ordinary <audio> element per deck: songs stream from disk
 * instead of sitting decoded in memory, and Chromium time-stretches it, which
 * is what keylock uses (preservesPitch). The decoded copy used for the beat
 * grid and waveform is a small 11 kHz one, thrown away after analysis.
 */

export type DeckId = 'a' | 'b'
export type EffectKind = 'none' | 'echo' | 'reverb' | 'flanger' | 'crush'
export const EFFECTS: Array<{ id: EffectKind; label: string }> = [
  { id: 'none', label: 'No effect' }, { id: 'echo', label: 'Echo' }, { id: 'reverb', label: 'Reverb' },
  { id: 'flanger', label: 'Flanger' }, { id: 'crush', label: 'Bitcrush' },
]
export const TEMPO_RANGES = [0.08, 0.16, 0.5] as const

export interface DeckTrack { audioPath: string; title: string; artist: string | null; coverPath: string | null; duration: number | null }

export interface DeckState {
  track: DeckTrack | null
  loading: boolean
  error: string | null
  analysis: TrackAnalysis | null
  playing: boolean
  /** Tempo change as a fraction: 0.05 is +5%. */
  pitch: number
  range: (typeof TEMPO_RANGES)[number]
  keylock: boolean
  synced: boolean
  cue: number
  hotcues: Array<number | null>
  loop: { start: number; end: number; beats: number | null } | null
  effect: EffectKind
  effectAmount: number
  trim: number
  volume: number
  /** EQ positions, 0–1 with 0.5 flat and 0 a kill. */
  eq: { low: number; mid: number; high: number }
  /** −1 (low-pass) … 0 (off) … 1 (high-pass). */
  filter: number
}

const blankDeck = (): DeckState => ({
  track: null, loading: false, error: null, analysis: null, playing: false, pitch: 0, range: 0.08, keylock: true, synced: false,
  cue: 0, hotcues: [null, null, null, null], loop: null, effect: 'none', effectAmount: 0.5, trim: 1, volume: 0.9,
  eq: { low: 0.5, mid: 0.5, high: 0.5 }, filter: 0,
})

type Listener = () => void

const cuesKey = (path: string) => `lyrigen-dj-cues:${path.toLocaleLowerCase()}`

function eqDb(position: number) {
  return position < 0.5 ? -40 * (0.5 - position) / 0.5 : 12 * (position - 0.5)
}

function impulse(context: AudioContext, seconds = 2.6) {
  const length = Math.round(context.sampleRate * seconds)
  const buffer = context.createBuffer(2, length, context.sampleRate)
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3
  }
  return buffer
}

class Deck {
  readonly element = new Audio()
  state: DeckState = blankDeck()
  private nodes: {
    trim: GainNode; low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode; filter: BiquadFilterNode
    dry: GainNode; wet: GainNode; send: GainNode; volume: GainNode; fader: GainNode; meter: AnalyserNode
  } | null = null
  private effectNodes: AudioNode[] = []
  private effectCleanup: (() => void) | null = null
  private meterData = new Float32Array(512)
  private loadToken = 0
  /** A momentary effect is holding the playhead (roll, brake); the loop keeps its own state. */
  momentary: { kind: 'roll'; resumeAt: number; startedAt: number; rate: number } | { kind: 'brake' } | null = null

  constructor(readonly id: DeckId, private engine: DjEngine) {
    this.element.preload = 'auto'
    this.element.preservesPitch = true
    this.element.addEventListener('ended', () => { this.state.playing = false; this.engine.changed() })
    this.element.addEventListener('pause', () => { if (this.state.playing && !this.momentary) { this.state.playing = false; this.engine.changed() } })
    this.element.addEventListener('error', () => { if (this.state.track) { this.state.error = 'This file could not be played.'; this.state.loading = false; this.engine.changed() } })
  }

  /** Wires the deck into the mixer — done on the first user gesture, when the AudioContext may start. */
  connect(context: AudioContext, destination: AudioNode) {
    if (this.nodes) return
    const source = context.createMediaElementSource(this.element)
    const trim = context.createGain()
    const low = context.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 220
    const mid = context.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.7
    const high = context.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 3500
    const filter = context.createBiquadFilter(); filter.type = 'allpass'; filter.Q.value = 0.9
    const dry = context.createGain()
    const send = context.createGain()
    const wet = context.createGain(); wet.gain.value = 0
    const volume = context.createGain()
    const fader = context.createGain()
    const meter = context.createAnalyser(); meter.fftSize = 512
    source.connect(trim).connect(low).connect(mid).connect(high).connect(filter)
    filter.connect(dry).connect(volume)
    filter.connect(send)
    wet.connect(volume)
    volume.connect(fader).connect(destination)
    volume.connect(meter)
    this.nodes = { trim, low, mid, high, filter, dry, wet, send, volume, fader, meter }
    this.applyAll()
  }

  private applyAll() {
    this.applyTone()
    this.applyEffect()
    this.element.playbackRate = this.rate
    this.element.preservesPitch = this.state.keylock
  }

  applyTone() {
    const n = this.nodes
    if (!n) return
    const s = this.state
    n.trim.gain.value = s.trim
    n.volume.gain.value = s.volume * s.volume
    n.low.gain.value = eqDb(s.eq.low)
    n.mid.gain.value = eqDb(s.eq.mid)
    n.high.gain.value = eqDb(s.eq.high)
    const f = s.filter
    if (Math.abs(f) < 0.02) { n.filter.type = 'allpass'; n.filter.frequency.value = 1000 }
    else if (f < 0) { n.filter.type = 'lowpass'; n.filter.frequency.value = 20 * 1000 ** (1 + f) }
    else { n.filter.type = 'highpass'; n.filter.frequency.value = 20 * 1000 ** f }
  }

  setCrossfaderGain(gain: number) { if (this.nodes) this.nodes.fader.gain.value = gain }

  /** Rebuilds the effect when its kind changes; only the chosen one exists at all. */
  applyEffect() {
    const n = this.nodes
    const context = this.engine.context
    if (!n || !context) return
    const kind = this.state.effect
    const amount = this.state.effectAmount
    const built = (this.effectNodes[0] as AudioNode & { kind?: EffectKind } | undefined)?.kind
    if (built !== kind) {
      this.effectCleanup?.()
      this.effectCleanup = null
      for (const node of this.effectNodes) node.disconnect()
      n.send.disconnect()
      this.effectNodes = []
      if (kind !== 'none') {
        const nodes = this.buildEffect(context, kind)
        ;(nodes[0] as AudioNode & { kind?: EffectKind }).kind = kind
        n.send.connect(nodes[0])
        nodes[nodes.length - 1].connect(n.wet)
        this.effectNodes = nodes
      }
    }
    if (kind === 'none') { n.wet.gain.value = 0; n.dry.gain.value = 1; return }
    if (kind === 'crush') { n.wet.gain.value = amount; n.dry.gain.value = 1 - amount * 0.95 }
    else { n.wet.gain.value = amount * (kind === 'reverb' ? 1.2 : 0.9); n.dry.gain.value = 1 }
    if (kind === 'echo') {
      const delay = this.effectNodes.find(node => node instanceof DelayNode) as DelayNode | undefined
      if (delay) delay.delayTime.value = Math.min(1.9, this.realBeat * 0.75)
    }
    if (kind === 'crush') {
      const shaper = this.effectNodes[0] as WaveShaperNode
      const steps = Math.round(2 ** (10 - amount * 7))
      const curve = new Float32Array(1024)
      for (let i = 0; i < curve.length; i++) { const x = i / 512 - 1; curve[i] = Math.round(x * steps) / steps }
      shaper.curve = curve
    }
  }

  private buildEffect(context: AudioContext, kind: EffectKind): AudioNode[] {
    switch (kind) {
      case 'echo': {
        const input = context.createGain()
        const delay = context.createDelay(2)
        const feedback = context.createGain(); feedback.gain.value = 0.48
        const tone = context.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 5000
        input.connect(delay).connect(tone).connect(feedback).connect(delay)
        const output = context.createGain()
        tone.connect(output)
        return [input, delay, feedback, tone, output]
      }
      case 'reverb': {
        const convolver = context.createConvolver()
        convolver.buffer = impulse(context)
        return [convolver]
      }
      case 'flanger': {
        const input = context.createGain()
        const delay = context.createDelay(0.05); delay.delayTime.value = 0.004
        const feedback = context.createGain(); feedback.gain.value = 0.6
        const lfo = context.createOscillator(); lfo.frequency.value = 0.22
        const depth = context.createGain(); depth.gain.value = 0.0028
        lfo.connect(depth).connect(delay.delayTime)
        lfo.start()
        input.connect(delay).connect(feedback).connect(delay)
        const output = context.createGain()
        delay.connect(output)
        this.effectCleanup = () => { try { lfo.stop() } catch { /* stopped */ } lfo.disconnect(); depth.disconnect() }
        return [input, delay, feedback, output]
      }
      case 'crush': {
        const shaper = context.createWaveShaper()
        return [shaper]
      }
      default: return []
    }
  }

  get bpm() { return this.state.analysis?.bpm ?? null }
  get rate() { return 1 + this.state.pitch }
  /** Tempo as heard, after the pitch fader. */
  get liveBpm() { return this.bpm ? this.bpm * this.rate : null }
  /** One beat in track seconds. */
  get beat() { return this.bpm ? 60 / this.bpm : 0.5 }
  /** One beat in real seconds. */
  get realBeat() { return this.beat / this.rate }
  get position() { return this.element.currentTime || 0 }
  get duration() { return this.state.analysis?.duration || (Number.isFinite(this.element.duration) ? this.element.duration : 0) || this.state.track?.duration || 0 }

  /** Where in the bar-less beat grid a moment falls, 0–1. */
  phase(at = this.position) {
    const grid = this.state.analysis
    if (!grid?.bpm) return 0
    const beats = (at - grid.firstBeat) / this.beat
    return beats - Math.floor(beats)
  }

  nearestBeat(at: number) {
    const grid = this.state.analysis
    if (!grid?.bpm) return at
    return grid.firstBeat + Math.round((at - grid.firstBeat) / this.beat) * this.beat
  }

  beatBefore(at: number) {
    const grid = this.state.analysis
    if (!grid?.bpm) return at
    return grid.firstBeat + Math.floor((at - grid.firstBeat) / this.beat + 1e-6) * this.beat
  }

  level() {
    const meter = this.nodes?.meter
    if (!meter || !this.state.playing) return 0
    meter.getFloatTimeDomainData(this.meterData)
    let peak = 0
    for (const value of this.meterData) { const magnitude = Math.abs(value); if (magnitude > peak) peak = magnitude }
    return Math.min(1, peak)
  }

  async load(track: DeckTrack) {
    const token = ++this.loadToken
    this.engine.ensureContext()
    this.element.pause()
    this.momentary = null
    let stored: Array<number | null> = [null, null, null, null], cue = 0
    try { const saved = JSON.parse(localStorage.getItem(cuesKey(track.audioPath)) ?? 'null') as { hotcues?: Array<number | null>; cue?: number } | null; if (saved) { stored = saved.hotcues ?? stored; cue = saved.cue ?? 0 } } catch { /* none saved */ }
    this.state = { ...this.state, track, loading: true, error: null, analysis: null, playing: false, synced: false, loop: null, cue, hotcues: stored, pitch: 0 }
    this.element.playbackRate = 1
    this.engine.changed()
    try {
      const url = await window.electronAPI.getMediaUrl(track.audioPath)
      if (token !== this.loadToken) return
      this.element.src = url
      this.element.currentTime = cue
      const bytes = await window.electronAPI.readAudioBytes(track.audioPath)
      if (token !== this.loadToken) return
      if (!bytes) throw new Error('The file could not be read.')
      const analysis = await analyzeAudio(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
      if (token !== this.loadToken) return
      this.state = { ...this.state, analysis, loading: false }
    } catch (error) {
      if (token !== this.loadToken) return
      // Playback does not need the analysis; only sync, loops and the waveform do.
      this.state = { ...this.state, loading: false, error: this.element.src ? null : error instanceof Error ? error.message : String(error) }
    }
    this.applyEffect()
    this.engine.changed()
  }

  async play() {
    if (!this.state.track) return
    await this.engine.resume()
    this.element.playbackRate = this.rate
    await this.element.play().catch(() => undefined)
    this.state.playing = !this.element.paused
    if (this.state.playing) this.engine.onDeckStarted()
    this.engine.changed()
  }

  pause() {
    this.element.pause()
    this.state.playing = false
    this.engine.changed()
  }

  toggle() { return this.state.playing ? (this.pause(), Promise.resolve()) : this.play() }

  seek(seconds: number) {
    this.element.currentTime = Math.max(0, Math.min(this.duration - 0.05, seconds))
    this.engine.changed()
  }

  /** CDJ-style cue: while playing, back to the cue and stop; while stopped, set it here. */
  cueButton() {
    if (this.state.playing) { this.pause(); this.seek(this.state.cue) }
    else { this.state.cue = this.engine.quantize ? this.nearestBeat(this.position) : this.position; this.saveCues(); this.seek(this.state.cue) }
  }

  hotcue(index: number, remove = false) {
    if (remove) { this.state.hotcues[index] = null; this.saveCues(); this.engine.changed(); return }
    const at = this.state.hotcues[index]
    if (at == null) {
      this.state.hotcues[index] = this.engine.quantize ? this.nearestBeat(this.position) : this.position
      this.saveCues()
      this.engine.changed()
    } else {
      this.seek(at)
      if (!this.state.playing) void this.play()
    }
  }

  private saveCues() {
    if (!this.state.track) return
    try { localStorage.setItem(cuesKey(this.state.track.audioPath), JSON.stringify({ hotcues: this.state.hotcues, cue: this.state.cue })) } catch { /* not remembered */ }
  }

  setPitch(pitch: number) {
    const range = this.state.range
    this.state.pitch = Math.max(-range, Math.min(range, pitch))
    this.state.synced = false
    this.element.playbackRate = this.rate
    if (this.state.effect === 'echo') this.applyEffect()
    this.engine.changed()
  }

  setKeylock(on: boolean) { this.state.keylock = on; this.element.preservesPitch = on; this.engine.changed() }

  /** Match the other deck's tempo and line the beats up. */
  sync(master: Deck) {
    if (!this.bpm || !master.liveBpm) return false
    // Half or double time, whichever needs the smaller change.
    const ratios = [0.5, 1, 2].map(multiple => master.liveBpm! * multiple / this.bpm!)
    const ratio = ratios.reduce((best, value) => Math.abs(value - 1) < Math.abs(best - 1) ? value : best)
    const needed = ratio - 1
    const range = TEMPO_RANGES.find(candidate => Math.abs(needed) <= candidate) ?? 0.5
    this.state.range = Math.max(this.state.range, range) as DeckState['range']
    this.state.pitch = Math.max(-0.5, Math.min(0.5, needed))
    this.element.playbackRate = this.rate
    this.alignPhase(master)
    this.state.synced = true
    this.engine.master = master.id
    if (this.state.effect === 'echo') this.applyEffect()
    this.engine.changed()
    return true
  }

  alignPhase(master: Deck) {
    if (!this.bpm || !master.bpm || !master.state.playing) return
    let delta = master.phase() - this.phase()
    if (delta > 0.5) delta -= 1
    if (delta < -0.5) delta += 1
    this.element.currentTime = Math.max(0, this.position + delta * this.beat)
  }

  /** Keeps a synced deck on the beat: small drifts are pulled in by nudging the rate, not by jumping. */
  correctDrift(master: Deck) {
    if (!this.state.synced || !this.state.playing || !master.state.playing || !this.bpm || !master.bpm || this.momentary) return
    let delta = master.phase() - this.phase()
    if (delta > 0.5) delta -= 1
    if (delta < -0.5) delta += 1
    const error = delta * this.realBeat
    if (Math.abs(error) > 0.25) { this.alignPhase(master); return }
    const nudge = Math.abs(error) < 0.006 ? 0 : Math.max(-0.02, Math.min(0.02, error * 0.8))
    this.element.playbackRate = this.rate * (1 + nudge)
  }

  /** A loop of `beats` beats from the beat just gone, or off if one is running. */
  autoLoop(beats: number) {
    if (this.state.loop?.beats === beats) { this.state.loop = null; this.engine.changed(); return }
    const start = this.engine.quantize ? this.beatBefore(this.position) : this.position
    this.state.loop = { start, end: start + beats * this.beat, beats }
    this.engine.changed()
  }

  loopIn() { this.state.loop = { start: this.engine.quantize ? this.nearestBeat(this.position) : this.position, end: Infinity, beats: null }; this.engine.changed() }
  loopOut() {
    const loop = this.state.loop
    if (!loop) return
    const end = this.engine.quantize ? this.nearestBeat(this.position) : this.position
    if (end > loop.start + 0.05) this.state.loop = { ...loop, end }
    this.engine.changed()
  }
  exitLoop() { this.state.loop = null; this.engine.changed() }

  /** Beat roll: a short loop while held, then playback carries on where it would have been. */
  roll(on: boolean, fraction = 0.25) {
    if (on && this.state.playing && !this.momentary) {
      const start = this.beatBefore(this.position)
      this.momentary = { kind: 'roll', resumeAt: this.position, startedAt: performance.now(), rate: this.rate }
      this.state.loop = { start, end: start + this.beat * fraction, beats: fraction }
    } else if (!on && this.momentary?.kind === 'roll') {
      const { resumeAt, startedAt, rate } = this.momentary
      this.momentary = null
      this.state.loop = null
      this.seek(resumeAt + (performance.now() - startedAt) / 1000 * rate)
    }
    this.engine.changed()
  }

  /** Vinyl brake: the platter slows to a stop over about a second and a half. */
  brake() {
    if (!this.state.playing || this.momentary) return
    this.momentary = { kind: 'brake' }
    const started = performance.now(), from = this.rate
    const keylock = this.state.keylock
    this.element.preservesPitch = false
    const step = () => {
      const t = (performance.now() - started) / 1500
      if (t >= 1 || this.momentary?.kind !== 'brake') {
        this.momentary = null
        this.element.pause()
        this.state.playing = false
        this.element.playbackRate = this.rate
        this.element.preservesPitch = keylock
        this.engine.changed()
        return
      }
      this.element.playbackRate = Math.max(0.07, from * (1 - t) ** 1.6)
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  /** Jog wheel: bends the tempo while dragged if playing, scrubs if stopped. */
  jog(deltaSeconds: number) {
    if (this.state.playing) {
      const bend = Math.max(-0.12, Math.min(0.12, deltaSeconds * 2))
      this.element.playbackRate = this.rate * (1 + bend)
      clearTimeout(this.jogTimer)
      this.jogTimer = window.setTimeout(() => { this.element.playbackRate = this.rate }, 120)
    } else {
      this.seek(this.position + deltaSeconds)
    }
  }
  private jogTimer = 0

  /** Loops, run from the engine's clock. */
  tick() {
    const loop = this.state.loop
    if (loop && this.state.playing && Number.isFinite(loop.end) && this.position >= loop.end - 0.004) {
      this.element.currentTime = loop.start + Math.max(0, this.position - loop.end) % Math.max(0.02, loop.end - loop.start)
    }
  }

  patch(changes: Partial<DeckState>) {
    this.state = { ...this.state, ...changes }
    if ('keylock' in changes) this.element.preservesPitch = this.state.keylock
    if ('effect' in changes || 'effectAmount' in changes) this.applyEffect()
    this.applyTone()
    this.engine.changed()
  }

  eject() {
    this.loadToken++
    this.element.pause()
    this.element.removeAttribute('src')
    this.element.load()
    this.state = { ...blankDeck(), volume: this.state.volume, eq: this.state.eq, keylock: this.state.keylock }
    this.engine.changed()
  }
}

export class DjEngine {
  context: AudioContext | null = null
  readonly decks: Record<DeckId, Deck>
  crossfader = 0.5
  masterVolume = 0.85
  quantize = true
  /** The deck others sync to. */
  master: DeckId = 'a'
  automix = { enabled: false, queue: [] as DeckTrack[], transitionBeats: 16, running: null as null | { from: DeckId; to: DeckId; started: number; seconds: number; fromFader: number } }
  recording: { started: number } | null = null
  private masterGain: GainNode | null = null
  private masterMeter: AnalyserNode | null = null
  private samplerGain: GainNode | null = null
  private recorder: MediaRecorder | null = null
  private recordChunks: Blob[] = []
  private recordDestination: MediaStreamAudioDestinationNode | null = null
  private listeners = new Set<Listener>()
  private version = 0
  private timer = 0
  private lastDrift = 0
  private lastGlideRender = 0
  private lastFadeRender = 0
  glide: { deck: DeckId; from: number; started: number; seconds: number } | null = null
  samplerVolume = 0.8

  constructor() {
    this.decks = { a: new Deck('a', this), b: new Deck('b', this) }
    // The DJ decks and the main player never play over each other.
    window.addEventListener('lyrigen:player-playing', () => { for (const deck of Object.values(this.decks)) if (deck.state.playing) deck.pause() })
  }

  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version
  changed() {
    this.version++
    for (const listener of this.listeners) listener()
    this.ensureClock()
  }

  ensureContext() {
    if (this.context) return this.context
    const context = new AudioContext({ latencyHint: 'interactive' })
    const master = context.createGain()
    const limiter = context.createDynamicsCompressor()
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.2
    const meter = context.createAnalyser(); meter.fftSize = 256
    master.connect(limiter).connect(meter).connect(context.destination)
    const sampler = context.createGain()
    sampler.connect(master)
    this.context = context
    this.masterGain = master
    this.masterMeter = meter
    this.samplerGain = sampler
    for (const deck of Object.values(this.decks)) deck.connect(context, master)
    this.applyMix()
    return context
  }

  async resume() {
    const context = this.ensureContext()
    if (context.state === 'suspended') await context.resume()
  }

  get analyser() { return this.masterMeter }

  applyMix() {
    // Equal power: the two sides always add up to the same loudness.
    const x = this.crossfader
    this.decks.a.setCrossfaderGain(Math.cos(x * Math.PI / 2))
    this.decks.b.setCrossfaderGain(Math.cos((1 - x) * Math.PI / 2))
    if (this.masterGain) this.masterGain.gain.value = this.masterVolume
    if (this.samplerGain) this.samplerGain.gain.value = this.samplerVolume
  }

  setCrossfader(value: number) { this.crossfader = Math.max(0, Math.min(1, value)); this.applyMix(); this.changed() }
  setMasterVolume(value: number) { this.masterVolume = value; this.applyMix(); this.changed() }
  setSamplerVolume(value: number) { this.samplerVolume = value; this.applyMix(); this.changed() }

  other(id: DeckId) { return this.decks[id === 'a' ? 'b' : 'a'] }

  sync(id: DeckId) {
    const deck = this.decks[id]
    if (deck.state.synced) { deck.patch({ synced: false }); return true }
    return deck.sync(this.other(id))
  }

  onDeckStarted() {
    window.dispatchEvent(new Event('lyrigen:dj-playing'))
  }

  playPad(id: string) {
    const context = this.ensureContext()
    void this.resume()
    const beat = this.decks[this.master].state.playing ? this.decks[this.master].realBeat : this.decks.a.state.playing ? this.decks.a.realBeat : this.decks.b.realBeat
    playPad(context, this.samplerGain!, id, beat)
  }

  masterLevel() {
    const meter = this.masterMeter
    if (!meter) return 0
    const data = new Uint8Array(meter.frequencyBinCount)
    meter.getByteTimeDomainData(data)
    let peak = 0
    for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128)
    return peak
  }

  // ---- recording -----------------------------------------------------------

  startRecording() {
    const context = this.ensureContext()
    if (this.recorder) return
    this.recordDestination = context.createMediaStreamDestination()
    this.masterMeter!.connect(this.recordDestination)
    this.recordChunks = []
    this.recorder = new MediaRecorder(this.recordDestination.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 256_000 })
    this.recorder.ondataavailable = event => { if (event.data.size) this.recordChunks.push(event.data) }
    this.recorder.start(1000)
    this.recording = { started: Date.now() }
    this.changed()
  }

  async stopRecording(): Promise<{ saved: boolean; path?: string; message?: string }> {
    const recorder = this.recorder
    if (!recorder) return { saved: false }
    const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve() })
    recorder.stop()
    await stopped
    this.masterMeter?.disconnect(this.recordDestination!)
    this.recorder = null
    this.recordDestination = null
    this.recording = null
    this.changed()
    const blob = new Blob(this.recordChunks, { type: 'audio/webm' })
    this.recordChunks = []
    if (!blob.size) return { saved: false, message: 'Nothing was recorded.' }
    return window.electronAPI.saveDjRecording(new Uint8Array(await blob.arrayBuffer()))
  }

  // ---- automix -------------------------------------------------------------

  setAutomix(enabled: boolean) {
    this.automix.enabled = enabled
    if (enabled) void this.startAutomixIfIdle()
    this.changed()
  }

  queueTrack(track: DeckTrack) { this.automix.queue.push(track); this.changed() }
  unqueue(index: number) { this.automix.queue.splice(index, 1); this.changed() }

  private async startAutomixIfIdle() {
    if (this.decks.a.state.playing || this.decks.b.state.playing) return
    const next = this.automix.queue.shift()
    if (!next) return
    await this.decks.a.load(next)
    this.decks.a.seek(this.decks.a.state.analysis?.firstBeat ?? 0)
    this.setCrossfader(0)
    await this.decks.a.play()
  }

  /** Runs every clock tick while automix is on. */
  private automixTick() {
    const mix = this.automix
    if (!mix.enabled) return
    if (mix.running) {
      const { from, to, started, seconds, fromFader } = mix.running
      if (performance.now() < started) return // waiting for the outgoing song's next beat
      const progress = Math.min(1, (performance.now() - started) / 1000 / seconds)
      const target = to === 'b' ? 1 : 0
      // Moved every tick for a smooth fade, but redrawn only ten times a second.
      this.crossfader = fromFader + (target - fromFader) * progress
      this.applyMix()
      const now = performance.now()
      if (now - this.lastFadeRender > 100) { this.lastFadeRender = now; this.changed() }
      if (progress >= 1) {
        this.decks[from].pause()
        this.decks[from].patch({ synced: false })
        this.master = to
        mix.running = null
        // The new song was bent to the old one's tempo for the blend; ease it
        // back to its own over a few bars rather than leave it off-speed.
        const deck = this.decks[to]
        if (deck.state.pitch) { deck.state.synced = false; this.glide = { deck: to, from: deck.state.pitch, started: performance.now(), seconds: 8 } }
        this.changed()
      }
      return
    }
    const playing = (['a', 'b'] as DeckId[]).filter(id => this.decks[id].state.playing)
    if (playing.length !== 1) return
    const from = this.decks[playing[0]]
    const to = this.other(from.id)
    const next = mix.queue[0]
    // Load the next song early, so its beat grid is ready well before the mix.
    if (next && to.state.track?.audioPath !== next.audioPath && !to.state.loading && from.duration - from.position < 90) void to.load(next)
    if (!next || to.state.track?.audioPath !== next.audioPath || to.state.loading) return
    const seconds = from.bpm ? mix.transitionBeats * from.realBeat : 12
    const remaining = (from.duration - from.position) / from.rate
    if (remaining > seconds + 0.3) return
    mix.queue.shift()
    to.seek(to.state.analysis?.firstBeat ?? 0)
    // Close enough in tempo to beatmatch; otherwise just a smooth blend.
    if (to.bpm && from.liveBpm && Math.abs(from.liveBpm / to.bpm - 1) < 0.1) to.sync(from)
    else to.patch({ pitch: 0 })
    // Start on the outgoing song's next beat.
    const wait = from.bpm ? (1 - from.phase()) * from.realBeat * 1000 : 0
    const begin = () => {
      void to.play()
      if (to.state.synced) to.alignPhase(from)
      mix.running = { from: from.id, to: to.id, started: performance.now(), seconds, fromFader: this.crossfader }
      this.changed()
    }
    mix.running = { from: from.id, to: to.id, started: performance.now() + wait + 1e7, seconds, fromFader: this.crossfader }
    window.setTimeout(begin, wait)
  }

  // ---- clock -----------------------------------------------------------------

  private ensureClock() {
    const active = this.decks.a.state.playing || this.decks.b.state.playing || this.automix.running || this.glide
    if (active && !this.timer) this.timer = window.setInterval(() => this.tick(), 15)
    else if (!active && this.timer) { window.clearInterval(this.timer); this.timer = 0 }
  }

  private tick() {
    this.decks.a.tick()
    this.decks.b.tick()
    const now = performance.now()
    if (now - this.lastDrift > 250) {
      this.lastDrift = now
      // Only the follower is corrected; two decks chasing each other would wobble.
      this.other(this.master).correctDrift(this.decks[this.master])
    }
    this.automixTick()
    this.glideTick(now)
  }

  private glideTick(now: number) {
    const glide = this.glide
    if (!glide) return
    const deck = this.decks[glide.deck]
    const progress = Math.min(1, (now - glide.started) / 1000 / glide.seconds)
    deck.state.pitch = glide.from * (1 - progress)
    if (!deck.momentary) deck.element.playbackRate = deck.rate
    if (progress >= 1) this.glide = null
    // The interface only needs a few updates a second for the BPM readout.
    if (progress >= 1 || now - this.lastGlideRender > 200) { this.lastGlideRender = now; this.changed() }
  }
}

let engine: DjEngine | null = null
/** The one engine, created on first use. */
export function getDjEngine() {
  engine ??= new DjEngine()
  return engine
}
