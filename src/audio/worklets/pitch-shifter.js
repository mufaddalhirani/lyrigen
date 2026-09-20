/**
 * Lyrigen WSOLA pitch shifter
 * ---------------------------
 * A time-domain pitch shifter built on Waveform Similarity Overlap-Add.
 *
 * Why this exists: the Web Audio API can only change pitch and tempo
 * together (HTMLMediaElement.playbackRate). The genre modes need them
 * decoupled -- lofi wants a big tempo drop with a smaller pitch drop so
 * vocals stay intelligible, phonk wants pitch down at unchanged tempo.
 *
 * How it works: the player sets playbackRate to the target TEMPO, which
 * drags pitch along with it. This node then corrects pitch back to the
 * target by the ratio (targetPitch / tempo), leaving tempo untouched.
 *
 * Grains are read from the input ring at a resampled rate, Hann-windowed,
 * and overlap-added at the output hop. Before each grain is laid down, a
 * normalised cross-correlation search picks the read offset whose waveform
 * best matches what has already been written, which is what keeps the
 * splices from clicking. Pitch ratios within a cent of 1.0 bypass the whole
 * thing so the common case costs nothing.
 */

const WINDOW = 1024        // grain length in samples (~21ms at 48k)
const HOP = WINDOW >> 1    // 50% overlap; Hann at 50% sums to unity
const SEARCH = 256         // WSOLA correlation search radius, in samples
const CORR_LEN = 256       // samples compared when scoring a candidate
const CORR_STRIDE = 2      // subsample the comparison to halve the cost
const RING = 1 << 15       // 32768, power of two so we can mask instead of modulo
const RING_MASK = RING - 1
const BYPASS_TOLERANCE = 0.0006 // ~1 cent

// Precomputed Hann window -- the same curve for every grain and channel.
const HANN = new Float32Array(WINDOW)
for (let i = 0; i < WINDOW; i += 1) {
  HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW)
}

class ChannelState {
  constructor() {
    this.input = new Float32Array(RING)
    this.output = new Float32Array(RING)
    this.inputWritten = 0   // absolute count of samples written to the input ring
    this.outputRead = 0     // absolute read cursor handed to the destination
    this.synthPos = 0       // absolute output position where the next grain lands
    this.analysisPos = 0    // fractional read cursor into the input ring
    this.primed = false
  }

  reset() {
    this.input.fill(0)
    this.output.fill(0)
    this.inputWritten = 0
    this.outputRead = 0
    this.synthPos = 0
    this.analysisPos = 0
    this.primed = false
  }
}

class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'pitch',
        defaultValue: 1,
        minValue: 0.25,
        maxValue: 4,
        automationRate: 'k-rate',
      },
    ]
  }

  constructor() {
    super()
    this.channels = []
    this.lastPitch = 1
    this.port.onmessage = event => {
      if (event.data && event.data.type === 'reset') {
        this.channels.forEach(channel => channel.reset())
      }
    }
  }

  ensureChannels(count) {
    while (this.channels.length < count) this.channels.push(new ChannelState())
  }

  /** Linear interpolation read from a ring buffer at a fractional absolute index. */
  static sample(ring, position) {
    const base = Math.floor(position)
    const frac = position - base
    const a = ring[base & RING_MASK]
    const b = ring[(base + 1) & RING_MASK]
    return a + (b - a) * frac
  }

  /**
   * WSOLA: find the offset within +/-SEARCH whose resampled grain head best
   * matches the output tail we are about to overlap onto. Normalised so that
   * a loud candidate cannot win on energy alone.
   */
  static findBestOffset(state, nominalRead, pitch) {
    const { output, input } = state
    const target = state.synthPos
    let bestOffset = 0
    let bestScore = -Infinity

    for (let offset = -SEARCH; offset <= SEARCH; offset += 4) {
      const start = nominalRead + offset
      if (start < 0) continue
      let dot = 0
      let energy = 1e-9
      for (let i = 0; i < CORR_LEN; i += CORR_STRIDE) {
        const candidate = PitchShifterProcessor.sample(input, start + i * pitch)
        const existing = output[(target + i) & RING_MASK]
        dot += candidate * existing
        energy += candidate * candidate
      }
      const score = dot / Math.sqrt(energy)
      if (score > bestScore) {
        bestScore = score
        bestOffset = offset
      }
    }
    return bestOffset
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || output.length === 0) return true

    const pitch = parameters.pitch[0]
    const channelCount = output.length
    this.ensureChannels(channelCount)

    // Flush state when the ratio changes materially so we don't blend grains
    // resampled at two different rates.
    if (Math.abs(pitch - this.lastPitch) > 0.01) {
      this.channels.forEach(channel => channel.reset())
      this.lastPitch = pitch
    }

    const quantum = output[0].length

    // Unity pitch: straight passthrough, no grains, no latency, no cost.
    if (Math.abs(pitch - 1) < BYPASS_TOLERANCE) {
      for (let c = 0; c < channelCount; c += 1) {
        const src = input && input[c]
        if (src) output[c].set(src)
        else output[c].fill(0)
        const state = this.channels[c]
        if (state.primed) state.reset()
      }
      return true
    }

    for (let c = 0; c < channelCount; c += 1) {
      const state = this.channels[c]
      const src = (input && input[c]) || null
      const dst = output[c]

      // 1. Take in this quantum.
      for (let i = 0; i < quantum; i += 1) {
        state.input[(state.inputWritten + i) & RING_MASK] = src ? src[i] : 0
      }
      state.inputWritten += quantum

      if (!state.primed) {
        // Wait until there is enough history to read a full grain plus the
        // search radius before emitting anything.
        if (state.inputWritten < WINDOW * Math.max(1, pitch) + SEARCH + HOP) {
          dst.fill(0)
          continue
        }
        state.primed = true
        state.analysisPos = 0
        state.synthPos = 0
        state.outputRead = 0
      }

      // 2. Lay down grains until the output ring is far enough ahead.
      let guard = 0
      while (state.synthPos < state.outputRead + quantum + HOP && guard < 16) {
        guard += 1
        const span = WINDOW * pitch
        const nominalRead = state.analysisPos

        // Not enough input has arrived to build this grain yet.
        if (nominalRead + span + SEARCH >= state.inputWritten) break

        const offset =
          state.synthPos === 0
            ? 0
            : PitchShifterProcessor.findBestOffset(state, nominalRead, pitch)
        const readStart = Math.max(0, nominalRead + offset)

        // Overlap-add the windowed, resampled grain.
        for (let i = 0; i < WINDOW; i += 1) {
          const value = PitchShifterProcessor.sample(state.input, readStart + i * pitch)
          state.output[(state.synthPos + i) & RING_MASK] += value * HANN[i]
        }

        state.synthPos += HOP
        state.analysisPos += HOP
      }

      // 3. Hand the destination its quantum and clear what we consumed so the
      //    ring is zeroed and ready for the next overlap-add pass.
      for (let i = 0; i < quantum; i += 1) {
        const index = (state.outputRead + i) & RING_MASK
        dst[i] = state.output[index]
        state.output[index] = 0
      }
      state.outputRead += quantum
    }

    return true
  }
}

registerProcessor('lyrigen-pitch-shifter', PitchShifterProcessor)
