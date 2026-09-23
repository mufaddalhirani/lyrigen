/**
 * The sampler pads. Every sound is synthesised on the spot from oscillators
 * and noise — no sample files to ship, and nothing borrowed from anyone.
 */

export interface SamplerPad { id: string; label: string }

export const SAMPLER_PADS: SamplerPad[] = [
  { id: 'horn', label: 'Air horn' },
  { id: 'siren', label: 'Siren' },
  { id: 'kick', label: 'Kick' },
  { id: 'clap', label: 'Clap' },
  { id: 'laser', label: 'Laser' },
  { id: 'riser', label: 'Riser' },
  { id: 'drop', label: 'Bass drop' },
  { id: 'rewind', label: 'Rewind' },
]

let noiseBuffer: AudioBuffer | null = null
function noise(context: BaseAudioContext) {
  if (noiseBuffer && noiseBuffer.sampleRate === context.sampleRate) return noiseBuffer
  noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate)
  const data = noiseBuffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  return noiseBuffer
}

function envelope(context: BaseAudioContext, output: AudioNode, at: number, attack: number, hold: number, release: number, level = 1) {
  const gain = context.createGain()
  gain.gain.setValueAtTime(0, at)
  gain.gain.linearRampToValueAtTime(level, at + attack)
  gain.gain.setValueAtTime(level, at + attack + hold)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release)
  gain.connect(output)
  return gain
}

/** Plays a pad into `output`. `beat` is the master tempo's beat length in seconds, for sounds that follow it. */
export function playPad(context: AudioContext, output: AudioNode, id: string, beat = 0.5) {
  const now = context.currentTime + 0.005
  const stopAll: Array<AudioScheduledSourceNode> = []
  const osc = (type: OscillatorType, frequency: number, into: AudioNode, start = now, stop = now + 1) => {
    const node = context.createOscillator()
    node.type = type
    node.frequency.setValueAtTime(frequency, start)
    node.connect(into)
    node.start(start)
    node.stop(stop)
    stopAll.push(node)
    return node
  }
  const burst = (into: AudioNode, start: number, length: number) => {
    const node = context.createBufferSource()
    node.buffer = noise(context)
    node.connect(into)
    node.start(start, Math.random(), length)
    stopAll.push(node)
    return node
  }

  switch (id) {
    case 'horn': {
      // Three detuned saws a fifth apart with a wobble, blasted in pulses.
      for (const [offset, length] of [[0, 0.16], [0.2, 0.16], [0.4, 0.7]] as const) {
        const env = envelope(context, output, now + offset, 0.01, length, 0.12, 0.22)
        const tone = context.createBiquadFilter()
        tone.type = 'lowpass'; tone.frequency.value = 2600
        tone.connect(env)
        for (const frequency of [415, 622, 830]) {
          const node = osc('sawtooth', frequency, tone, now + offset, now + offset + length + 0.2)
          node.frequency.linearRampToValueAtTime(frequency * 0.97, now + offset + length)
        }
      }
      break
    }
    case 'siren': {
      const env = envelope(context, output, now, 0.05, 1.6, 0.3, 0.2)
      const node = osc('square', 900, env, now, now + 2)
      const lfo = osc('sine', 3.2, context.createGain(), now, now + 2)
      const depth = context.createGain(); depth.gain.value = 320
      lfo.disconnect(); lfo.connect(depth).connect(node.frequency)
      break
    }
    case 'kick': {
      const env = envelope(context, output, now, 0.002, 0.03, 0.35, 0.9)
      const node = osc('sine', 150, env, now, now + 0.5)
      node.frequency.exponentialRampToValueAtTime(42, now + 0.25)
      break
    }
    case 'clap': {
      const band = context.createBiquadFilter()
      band.type = 'bandpass'; band.frequency.value = 1400; band.Q.value = 0.8
      const env = context.createGain()
      band.connect(env).connect(output)
      env.gain.setValueAtTime(0, now)
      for (const offset of [0, 0.012, 0.024]) {
        env.gain.setValueAtTime(0.8, now + offset)
        env.gain.exponentialRampToValueAtTime(0.1, now + offset + 0.01)
      }
      env.gain.setValueAtTime(0.7, now + 0.036)
      env.gain.exponentialRampToValueAtTime(0.0001, now + 0.3)
      burst(band, now, 0.35)
      break
    }
    case 'laser': {
      const env = envelope(context, output, now, 0.005, 0.05, 0.3, 0.2)
      const node = osc('square', 2400, env, now, now + 0.4)
      node.frequency.exponentialRampToValueAtTime(120, now + 0.35)
      break
    }
    case 'riser': {
      // White noise sweeping up over four beats of the master tempo.
      const length = beat * 4
      const filter = context.createBiquadFilter()
      filter.type = 'bandpass'; filter.Q.value = 3
      filter.frequency.setValueAtTime(300, now)
      filter.frequency.exponentialRampToValueAtTime(9000, now + length)
      const env = context.createGain()
      env.gain.setValueAtTime(0.001, now)
      env.gain.exponentialRampToValueAtTime(0.6, now + length)
      env.gain.linearRampToValueAtTime(0, now + length + 0.03)
      filter.connect(env).connect(output)
      const source = context.createBufferSource()
      source.buffer = noise(context); source.loop = true
      source.connect(filter); source.start(now); source.stop(now + length + 0.05)
      stopAll.push(source)
      break
    }
    case 'drop': {
      const shaper = context.createWaveShaper()
      const curve = new Float32Array(256)
      for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 3) }
      shaper.curve = curve
      const env = envelope(context, output, now, 0.01, 0.4, 1.2, 0.8)
      shaper.connect(env)
      const node = osc('sine', 110, shaper, now, now + 1.8)
      node.frequency.exponentialRampToValueAtTime(30, now + 1.5)
      break
    }
    case 'rewind': {
      const filter = context.createBiquadFilter()
      filter.type = 'bandpass'; filter.Q.value = 6
      filter.frequency.setValueAtTime(3000, now)
      filter.frequency.exponentialRampToValueAtTime(400, now + 0.25)
      filter.frequency.exponentialRampToValueAtTime(4000, now + 0.7)
      const env = envelope(context, output, now, 0.01, 0.6, 0.15, 0.5)
      filter.connect(env)
      burst(filter, now, 0.9)
      const tone = osc('sawtooth', 300, env, now, now + 0.8)
      tone.frequency.exponentialRampToValueAtTime(1800, now + 0.75)
      break
    }
  }
  return () => { for (const node of stopAll) { try { node.stop() } catch { /* already stopped */ } } }
}
