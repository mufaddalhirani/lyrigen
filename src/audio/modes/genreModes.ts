import type { ReverbCharacter } from '../engine/impulse'

/**
 * Genre modes.
 *
 * Each mode is a declarative description of a signal chain. The engine reads
 * these and drives the nodes; nothing here touches the Web Audio API directly,
 * which means a mode can be tweaked or a new one added without going near the
 * graph code.
 *
 * On tempo and pitch: `tempo` is applied via HTMLMediaElement.playbackRate,
 * which drags pitch with it. `pitch` is the *final* pitch ratio you want, and
 * the engine works out the correction the WSOLA worklet has to apply
 * (pitch / tempo). Setting both to the same value is the classic
 * "just change the speed" sound and costs no CPU, because the worklet detects
 * a correction of 1.0 and bypasses itself.
 */

export type GenreModeId =
  | 'off'
  | 'lofi'
  | 'nightcore'
  | 'phonk'
  | 'synthwave'
  | 'spatial'
  | 'glitchcore'

export interface WobbleSpec {
  /** Modulation rate in Hz. Sub-1Hz reads as tape drift; 4-8Hz as vibrato. */
  rateHz: number
  /** Peak delay deviation in seconds. Tiny values (~2ms) give chorus. */
  depthMs: number
  /** Base delay in milliseconds. */
  baseMs: number
  /** 0..1 wet mix. */
  mix: number
}

export interface SpatialSpec {
  /** Full left-right-left cycles per minute. */
  cyclesPerMinute: number
  /** 0..1, how far toward each speaker the image travels. */
  width: number
}

export interface StutterSpec {
  /** Average gate events per second. */
  rateHz: number
  /** Probability 0..1 that any given opportunity actually fires. */
  probability: number
  /** Length of a single stutter gate in milliseconds. */
  lengthMs: number
}

export interface GenreMode {
  id: GenreModeId
  label: string
  emoji: string
  /** One line shown under the picker. */
  description: string

  /** Playback speed multiplier. 1 = unchanged. */
  tempo: number
  /** Final pitch ratio. 1 = unchanged. 2 = one octave up. */
  pitch: number

  /** Six-band EQ trim in dB, matching EQ_FREQUENCIES. */
  eq: number[]

  /** Waveshaper character and intensity. */
  drive?: { type: 'soft' | 'gritty' | 'crush' | 'squash'; amount: number }

  /** Convolution reverb. */
  reverb?: { character: ReverbCharacter; mix: number }

  /** Low-pass in Hz. Omit for none. */
  lowPassHz?: number
  /** High-pass in Hz. Omit for none. */
  highPassHz?: number

  wobble?: WobbleSpec
  spatial?: SpatialSpec
  stutter?: StutterSpec

  /** Output trim in dB, to keep perceived loudness even across modes. */
  makeUpDb: number
}

export const GENRE_MODES: Record<GenreModeId, GenreMode> = {
  off: {
    id: 'off',
    label: 'Off',
    emoji: '',
    description: 'The track as recorded.',
    tempo: 1,
    pitch: 1,
    eq: [0, 0, 0, 0, 0, 0],
    makeUpDb: 0,
  },

  lofi: {
    id: 'lofi',
    label: 'Lofi · Slowed & Reverb',
    emoji: '☕',
    description: 'Slowed to a crawl, pitched down, drowned in room. Late-night driving.',
    // Slowed-and-reverb is conventionally a straight speed drop, but taking
    // pitch down only to 0.86 while tempo goes to 0.80 keeps vocals
    // intelligible instead of muddy -- the worklet earns its keep here.
    tempo: 0.8,
    pitch: 0.86,
    eq: [4, 3, 0, -2, -5, -8],
    drive: { type: 'soft', amount: 0.18 },
    reverb: { character: 'hall', mix: 0.42 },
    lowPassHz: 7200,
    wobble: { rateHz: 0.4, depthMs: 3.2, baseMs: 22, mix: 0.22 },
    makeUpDb: 1,
  },

  nightcore: {
    id: 'nightcore',
    label: 'Hyperpop · Nightcore',
    emoji: '⚡',
    description: 'Sped up hard, pitched up bright, transients squashed flat.',
    tempo: 1.3,
    pitch: 1.34,
    eq: [2, 0, -1, 2, 5, 6],
    drive: { type: 'squash', amount: 0.5 },
    reverb: { character: 'room', mix: 0.12 },
    highPassHz: 60,
    makeUpDb: -1.5,
  },

  phonk: {
    id: 'phonk',
    label: 'Phonk · Drift',
    emoji: '🎸',
    description: 'Cranked low end, gritty tape crunch, muddied highs. Memphis drift.',
    // Tempo held near normal while pitch drops -- the sound of a track
    // sitting lower without dragging. Not reachable with playbackRate alone.
    tempo: 0.96,
    pitch: 0.88,
    eq: [8, 6, 1, -1, -4, -7],
    drive: { type: 'gritty', amount: 0.45 },
    reverb: { character: 'room', mix: 0.16 },
    lowPassHz: 6200,
    makeUpDb: -2.5,
  },

  synthwave: {
    id: 'synthwave',
    label: 'Synthwave · 80s Neon',
    emoji: '🔮',
    description: 'Tape wobble, thick chorus, a slight stretch. Retro-futurist pulse.',
    tempo: 0.94,
    pitch: 0.97,
    eq: [3, 2, -1, 1, 4, 3],
    drive: { type: 'soft', amount: 0.12 },
    reverb: { character: 'plate', mix: 0.3 },
    // Slow drift plus audible chorus depth: the detuned, swimming quality of
    // instruments recorded to tape that never quite ran at constant speed.
    wobble: { rateHz: 0.6, depthMs: 4.5, baseMs: 14, mix: 0.45 },
    makeUpDb: 0,
  },

  spatial: {
    id: 'spatial',
    label: '8D Audio · Spatial Spin',
    emoji: '🌀',
    description: 'Rotates around your head, buried in stadium reverb. Headphones.',
    tempo: 1,
    pitch: 1,
    eq: [1, 0, 0, 1, 1, 1],
    reverb: { character: 'stadium', mix: 0.4 },
    spatial: { cyclesPerMinute: 4, width: 0.95 },
    makeUpDb: 1,
  },

  glitchcore: {
    id: 'glitchcore',
    label: 'Glitchcore · Stutter',
    emoji: '⚠️',
    description: 'Random micro-repeats and digital freezes. Fragmented and chaotic.',
    tempo: 1.06,
    pitch: 1.06,
    eq: [3, 0, 1, 3, 4, 2],
    drive: { type: 'crush', amount: 6 },
    reverb: { character: 'room', mix: 0.1 },
    stutter: { rateHz: 2.6, probability: 0.55, lengthMs: 95 },
    makeUpDb: -1,
  },
}

export const GENRE_MODE_ORDER: GenreModeId[] = [
  'off',
  'lofi',
  'nightcore',
  'phonk',
  'synthwave',
  'spatial',
  'glitchcore',
]

export const GENRE_MODE_LIST = GENRE_MODE_ORDER.map(id => GENRE_MODES[id])

/**
 * The correction the pitch worklet must apply. Because `tempo` already moved
 * pitch by the same factor, the worklet only has to make up the difference.
 */
export function pitchCorrectionFor(mode: GenreMode) {
  return mode.pitch / mode.tempo
}
