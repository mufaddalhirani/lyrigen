import pitchShifterSource from '../worklets/pitch-shifter.js?raw'
import { createImpulseResponse } from './impulse'
import { bitCrush, grittyDrive, softSaturation, transientSquash } from './curves'
import {
  GENRE_MODES,
  pitchCorrectionFor,
  type GenreMode,
  type GenreModeId,
} from '../modes/genreModes'

/**
 * The genre-mode signal chain.
 *
 * Sits between the EQ tail and the analyser. Built once, then reconfigured in
 * place when the mode changes -- tearing down and rebuilding Web Audio nodes
 * mid-playback causes audible gaps, so every node here is permanent and modes
 * are expressed by changing parameters and wet/dry balances.
 *
 * Signal flow:
 *
 *   in -> pitchShifter -> drive -> tone(HP,LP) -> wobble -> stutter -> panner
 *           |                                                            |
 *           +------------------------- dry --------------------------+   |
 *                                                                    v   v
 *                                              reverb send -> convolver -> wet
 *                                                                    \   /
 *                                                                     out
 */

/**
 * The worklet is inlined as a string and loaded from a Blob URL rather than
 * fetched from disk. A packaged Electron app serves the renderer over file://,
 * and Chromium refuses to load worklet modules across file:// origins -- so
 * shipping it as a separate asset works in `vite dev` and then silently fails
 * in the built app, which is exactly the kind of bug that only shows up after
 * release. A Blob URL has none of those origin problems.
 */
let workletObjectUrl: string | null = null

function workletUrl() {
  if (!workletObjectUrl) {
    const blob = new Blob([pitchShifterSource], { type: 'application/javascript' })
    workletObjectUrl = URL.createObjectURL(blob)
  }
  return workletObjectUrl
}

export interface GenreChainNodes {
  input: AudioNode
  output: AudioNode
}

export class GenreChain {
  private context: BaseAudioContext
  private modeId: GenreModeId = 'off'

  readonly input: GainNode
  readonly output: GainNode

  private pitchShifter: AudioWorkletNode | null = null
  private pitchBypass: GainNode
  private pitchWet: GainNode
  private drive: WaveShaperNode
  private highPass: BiquadFilterNode
  private lowPass: BiquadFilterNode

  private wobbleDelay: DelayNode
  private wobbleLfo: OscillatorNode
  private wobbleDepth: GainNode
  private wobbleWet: GainNode
  private wobbleDry: GainNode

  private stutterGain: GainNode
  private stutterTimer: ReturnType<typeof setTimeout> | null = null

  private panner: StereoPannerNode
  private panLfo: OscillatorNode
  private panDepth: GainNode

  private reverbSend: GainNode
  private convolver: ConvolverNode
  private reverbWet: GainNode
  private dry: GainNode
  private makeUp: GainNode
  private limiter: DynamicsCompressorNode

  private manualSemitones = 0
  private impulseCache = new Map<string, AudioBuffer>()
  private workletReady: Promise<void> | null = null
  private disposed = false

  constructor(context: BaseAudioContext) {
    this.context = context

    this.input = context.createGain()
    this.output = context.createGain()

    // --- pitch correction (worklet attaches later, async) -------------------
    this.pitchBypass = context.createGain()
    this.pitchWet = context.createGain()
    this.pitchBypass.gain.value = 1
    this.pitchWet.gain.value = 0

    // --- drive --------------------------------------------------------------
    this.drive = context.createWaveShaper()
    this.drive.curve = null
    this.drive.oversample = 'none'

    // --- tone ---------------------------------------------------------------
    this.highPass = context.createBiquadFilter()
    this.highPass.type = 'highpass'
    this.highPass.frequency.value = 20
    this.highPass.Q.value = 0.7

    this.lowPass = context.createBiquadFilter()
    this.lowPass.type = 'lowpass'
    this.lowPass.frequency.value = 20000
    this.lowPass.Q.value = 0.7

    // --- wobble / chorus ----------------------------------------------------
    this.wobbleDelay = context.createDelay(0.2)
    this.wobbleDelay.delayTime.value = 0.014
    this.wobbleLfo = context.createOscillator()
    this.wobbleLfo.type = 'sine'
    this.wobbleLfo.frequency.value = 0.5
    this.wobbleDepth = context.createGain()
    this.wobbleDepth.gain.value = 0
    this.wobbleLfo.connect(this.wobbleDepth).connect(this.wobbleDelay.delayTime)
    this.wobbleWet = context.createGain()
    this.wobbleWet.gain.value = 0
    this.wobbleDry = context.createGain()
    this.wobbleDry.gain.value = 1

    // --- stutter ------------------------------------------------------------
    this.stutterGain = context.createGain()
    this.stutterGain.gain.value = 1

    // --- spatial ------------------------------------------------------------
    this.panner = context.createStereoPanner()
    this.panLfo = context.createOscillator()
    this.panLfo.type = 'sine'
    this.panLfo.frequency.value = 0.0667
    this.panDepth = context.createGain()
    this.panDepth.gain.value = 0
    this.panLfo.connect(this.panDepth).connect(this.panner.pan)

    // --- reverb -------------------------------------------------------------
    this.reverbSend = context.createGain()
    this.reverbSend.gain.value = 0
    this.convolver = context.createConvolver()
    this.convolver.normalize = true
    this.reverbWet = context.createGain()
    this.reverbWet.gain.value = 1
    this.dry = context.createGain()
    this.dry.gain.value = 1
    this.makeUp = context.createGain()
    this.makeUp.gain.value = 1

    // Safety limiter. Reverb tails, saturation and make-up gain can each be
    // reasonable on their own and still sum past full scale on a dense mix --
    // offline rendering caught lofi, phonk and synthwave peaking above 1.0.
    // This catches whatever slips through without colouring normal material.
    this.limiter = context.createDynamicsCompressor()
    this.limiter.threshold.value = -1.5
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.002
    this.limiter.release.value = 0.12

    this.wire()

    try {
      this.wobbleLfo.start()
      this.panLfo.start()
    } catch {
      /* already started */
    }

    void this.attachWorklet()
  }

  private wire() {
    // Pitch stage: dry bypass and worklet path run in parallel so swapping
    // between them is a gain change rather than a reconnect.
    this.input.connect(this.pitchBypass)

    const afterPitch = this.drive
    this.pitchBypass.connect(afterPitch)
    this.pitchWet.connect(afterPitch)

    this.drive.connect(this.highPass)
    this.highPass.connect(this.lowPass)

    // Wobble: parallel dry + modulated delay.
    this.lowPass.connect(this.wobbleDry)
    this.lowPass.connect(this.wobbleDelay)
    this.wobbleDelay.connect(this.wobbleWet)

    this.wobbleDry.connect(this.stutterGain)
    this.wobbleWet.connect(this.stutterGain)

    this.stutterGain.connect(this.panner)

    // Dry/wet split into the convolver.
    this.panner.connect(this.dry)
    this.panner.connect(this.reverbSend)
    this.reverbSend.connect(this.convolver)
    this.convolver.connect(this.reverbWet)

    this.dry.connect(this.makeUp)
    this.reverbWet.connect(this.makeUp)
    this.makeUp.connect(this.limiter)
    this.limiter.connect(this.output)
  }

  /**
   * Loads the WSOLA worklet and splices it into the pitch stage. Until this
   * resolves the chain runs on the bypass path, so playback never waits on it.
   */
  private async attachWorklet() {
    if (this.workletReady) return this.workletReady
    this.workletReady = (async () => {
      try {
        await this.context.audioWorklet.addModule(workletUrl())
        if (this.disposed) return
        const node = new AudioWorkletNode(this.context, 'lyrigen-pitch-shifter', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        })
        this.input.connect(node)
        node.connect(this.pitchWet)
        this.pitchShifter = node
        // Apply whatever mode is already selected.
        this.applyPitch(GENRE_MODES[this.modeId])
      } catch (error) {
        console.warn('[audio] pitch shifter unavailable, modes will use speed only', error)
      }
    })()
    return this.workletReady
  }

  private impulseFor(character: string) {
    const cached = this.impulseCache.get(character)
    if (cached) return cached
    const buffer = createImpulseResponse(this.context, character as never)
    this.impulseCache.set(character, buffer)
    return buffer
  }

  /**
   * Shift pitch by hand, in semitones, independent of speed.
   *
   * The genre modes drive the same WSOLA worklet from a preset; this is the
   * manual equivalent, so you can drop a track a tone without slowing it down.
   * Zero routes back through the bypass path so there is no processing cost
   * when the control is centred.
   */
  setPitchSemitones(semitones: number) {
    this.manualSemitones = Math.max(-12, Math.min(12, semitones))
    void this.attachWorklet().then(() => {
      if (this.disposed) return
      const ratio = Math.pow(2, this.manualSemitones / 12)
      const active = Math.abs(this.manualSemitones) > 0.01 && this.pitchShifter !== null
      if (this.pitchShifter) {
        const param = this.pitchShifter.parameters.get('pitch')
        if (param) param.value = ratio
        this.pitchShifter.port.postMessage({ type: 'reset' })
      }
      const now = this.context.currentTime
      this.pitchWet.gain.setTargetAtTime(active ? 1 : 0, now, 0.02)
      this.pitchBypass.gain.setTargetAtTime(active ? 0 : 1, now, 0.02)
    })
  }

  private applyPitch(mode: GenreMode) {
    const correction = pitchCorrectionFor(mode)
    const usesWorklet = Math.abs(correction - 1) > 0.001 && this.pitchShifter !== null

    if (this.pitchShifter) {
      const param = this.pitchShifter.parameters.get('pitch')
      if (param) param.value = correction
      this.pitchShifter.port.postMessage({ type: 'reset' })
    }

    const now = this.context.currentTime
    // Short ramp rather than a jump, so switching modes does not click.
    this.pitchWet.gain.setTargetAtTime(usesWorklet ? 1 : 0, now, 0.02)
    this.pitchBypass.gain.setTargetAtTime(usesWorklet ? 0 : 1, now, 0.02)
  }

  private applyDrive(mode: GenreMode) {
    if (!mode.drive) {
      this.drive.curve = null
      this.drive.oversample = 'none'
      return
    }
    const { type, amount } = mode.drive
    this.drive.curve =
      type === 'soft' ? softSaturation(amount)
      : type === 'gritty' ? grittyDrive(amount)
      : type === 'crush' ? bitCrush(amount)
      : transientSquash(amount)
    // Oversampling only matters where we are generating real harmonics.
    this.drive.oversample = type === 'gritty' ? '4x' : type === 'soft' ? '2x' : 'none'
  }

  private applyStutter(mode: GenreMode) {
    if (this.stutterTimer) {
      clearTimeout(this.stutterTimer)
      this.stutterTimer = null
    }
    this.stutterGain.gain.cancelScheduledValues(this.context.currentTime)
    this.stutterGain.gain.setValueAtTime(1, this.context.currentTime)

    const spec = mode.stutter
    if (!spec) return

    /**
     * Schedules gates on the audio clock rather than toggling gain from a
     * timer. setTimeout jitter would make the stutter feel sloppy; scheduling
     * ahead on the AudioContext timeline makes each freeze land exactly.
     */
    const schedule = () => {
      if (this.disposed) return
      const interval = 1 / spec.rateHz
      if (Math.random() < spec.probability) {
        const start = this.context.currentTime + 0.02
        const length = (spec.lengthMs / 1000) * (0.5 + Math.random())
        const gain = this.stutterGain.gain
        // Fast enough to read as a digital cut, slow enough not to click.
        gain.setValueAtTime(1, start)
        gain.linearRampToValueAtTime(0, start + 0.004)
        gain.setValueAtTime(0, start + length)
        gain.linearRampToValueAtTime(1, start + length + 0.004)
      }
      this.stutterTimer = setTimeout(schedule, interval * 1000 * (0.6 + Math.random() * 0.8))
    }
    schedule()
  }

  /**
   * Resolves once the pitch worklet is loaded and connected. Playback never
   * needs to await this -- the chain works on the bypass path meanwhile -- but
   * offline rendering and tests do, because an OfflineAudioContext will
   * otherwise render before the worklet exists.
   */
  async ready() {
    await this.attachWorklet()
  }

  /** Switches the chain to a mode. Safe to call repeatedly. */
  setMode(modeId: GenreModeId) {
    const mode = GENRE_MODES[modeId] ?? GENRE_MODES.off
    this.modeId = modeId
    const now = this.context.currentTime
    const ramp = 0.04

    this.applyPitch(mode)
    this.applyDrive(mode)
    this.applyStutter(mode)

    this.highPass.frequency.setTargetAtTime(mode.highPassHz ?? 20, now, ramp)
    this.lowPass.frequency.setTargetAtTime(mode.lowPassHz ?? 20000, now, ramp)

    // Wobble
    const wobble = mode.wobble
    this.wobbleLfo.frequency.setTargetAtTime(wobble?.rateHz ?? 0.5, now, ramp)
    this.wobbleDepth.gain.setTargetAtTime((wobble?.depthMs ?? 0) / 1000, now, ramp)
    this.wobbleDelay.delayTime.setTargetAtTime((wobble?.baseMs ?? 14) / 1000, now, ramp)
    this.wobbleWet.gain.setTargetAtTime(wobble?.mix ?? 0, now, ramp)
    this.wobbleDry.gain.setTargetAtTime(wobble ? 1 - wobble.mix * 0.4 : 1, now, ramp)

    // Spatial
    const spatial = mode.spatial
    this.panLfo.frequency.setTargetAtTime(
      spatial ? spatial.cyclesPerMinute / 60 : 0.0667,
      now,
      ramp,
    )
    this.panDepth.gain.setTargetAtTime(spatial?.width ?? 0, now, ramp)
    if (!spatial) this.panner.pan.setTargetAtTime(0, now, ramp)

    // Reverb
    if (mode.reverb) {
      const impulse = this.impulseFor(mode.reverb.character)
      if (this.convolver.buffer !== impulse) this.convolver.buffer = impulse
      // Crossfade rather than add: the old `1 - mix * 0.35` left the dry path
      // near full while the wet path ran at full too, so the two summed well
      // past unity on high-mix modes.
      this.reverbSend.gain.setTargetAtTime(mode.reverb.mix, now, ramp)
      this.dry.gain.setTargetAtTime(1 - mode.reverb.mix, now, ramp)
    } else {
      this.reverbSend.gain.setTargetAtTime(0, now, ramp)
      this.dry.gain.setTargetAtTime(1, now, ramp)
    }

    this.makeUp.gain.setTargetAtTime(Math.pow(10, mode.makeUpDb / 20), now, ramp)
  }

  dispose() {
    this.disposed = true
    if (this.stutterTimer) clearTimeout(this.stutterTimer)
    try {
      this.wobbleLfo.stop()
      this.panLfo.stop()
    } catch {
      /* already stopped */
    }
    try {
      this.input.disconnect()
      this.output.disconnect()
      this.pitchShifter?.disconnect()
    } catch {
      /* already disconnected */
    }
  }
}
