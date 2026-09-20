/**
 * Procedural impulse responses for the ConvolverNode.
 *
 * Shipping real .wav impulse files would add megabytes to the bundle for
 * something that is, for these purposes, a shaped noise decay. Generating them
 * at runtime costs a few milliseconds once per reverb character and keeps
 * Lyrigen's install small and fully offline.
 */

export type ReverbCharacter = 'room' | 'hall' | 'cathedral' | 'stadium' | 'plate'

interface ReverbShape {
  /** Decay time in seconds. */
  seconds: number
  /** Exponential decay steepness -- higher is a faster, tighter tail. */
  decay: number
  /** Pre-delay in seconds, which is most of what makes a space feel large. */
  preDelay: number
  /** Low-pass applied across the tail, as a 0..1 fraction of Nyquist. */
  damping: number
}

const SHAPES: Record<ReverbCharacter, ReverbShape> = {
  room: { seconds: 0.9, decay: 3.2, preDelay: 0.005, damping: 0.55 },
  plate: { seconds: 1.7, decay: 2.4, preDelay: 0.008, damping: 0.75 },
  hall: { seconds: 3.0, decay: 1.9, preDelay: 0.022, damping: 0.42 },
  cathedral: { seconds: 5.2, decay: 1.4, preDelay: 0.035, damping: 0.3 },
  stadium: { seconds: 4.2, decay: 1.6, preDelay: 0.045, damping: 0.36 },
}

/**
 * Builds a stereo impulse response. The two channels use independent noise so
 * the tail decorrelates, which is what makes a reverb sound wide rather than
 * like a mono echo sitting in the middle of the image.
 */
export function createImpulseResponse(
  context: BaseAudioContext,
  character: ReverbCharacter,
): AudioBuffer {
  const shape = SHAPES[character]
  const rate = context.sampleRate
  const length = Math.max(1, Math.floor(rate * shape.seconds))
  const preDelaySamples = Math.floor(rate * shape.preDelay)
  const buffer = context.createBuffer(2, length, rate)

  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel)
    // One-pole low-pass state, carried across the tail so damping accumulates
    // the way absorption does in a real space.
    let lowpass = 0
    const coefficient = shape.damping

    for (let i = 0; i < length; i += 1) {
      if (i < preDelaySamples) {
        data[i] = 0
        continue
      }
      const progress = (i - preDelaySamples) / (length - preDelaySamples)
      const envelope = Math.pow(1 - progress, shape.decay)
      const noise = Math.random() * 2 - 1
      lowpass += coefficient * (noise - lowpass)
      data[i] = lowpass * envelope
    }
  }

  return buffer
}
