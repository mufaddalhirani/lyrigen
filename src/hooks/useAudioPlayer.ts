import { useCallback, useEffect, useRef, useState } from 'react'
import { GenreChain } from '../audio/engine/genreChain'
import { GENRE_MODES, type GenreModeId } from '../audio/modes/genreModes'

export const EQ_FREQUENCIES = [60, 170, 350, 1000, 3500, 10000] as const

export const EQ_PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0],
  Warm: [3, 2, 1, 0, -1, -1],
  'Bass lift': [5, 4, 2, 0, -1, -1],
  'Vocal focus': [-2, -1, 0, 3, 4, 2],
  'Late night': [2, 1, 0, -1, -2, -3],
  Bright: [-1, -1, 0, 1, 3, 4],
  Hyperpop: [5, 2, 1, 3, 5, 5],
  'Lo-fi': [3, 3, 0, -2, -5, -8],
  'Dream pop': [2, 1, 0, 2, 3, 4],
  'Night drive': [4, 2, 1, 0, -2, -4],
  'Vinyl warmth': [4, 3, 1, -1, -3, -6],
  Arena: [3, 1, -2, -3, 1, 3],
}

// These are intentionally gentle tone-shaping presets, not AI genre
// conversion. Hyperpop and Vinyl warmth get a small waveshaper lift; the
// other modes stay clean and inexpensive enough for integrated/software-
// rendered playback.
const DRIVE_PRESETS: Record<string, number> = { Hyperpop: 12, 'Vinyl warmth': 4 }

function makeDriveCurve(amount: number) {
  const samples = 2048
  const curve = new Float32Array(samples)
  const drive = Math.max(0, amount) / 100
  for (let index = 0; index < samples; index += 1) {
    const x = (index * 2) / samples - 1
    curve[index] = Math.tanh(x * (1 + drive * 8)) / Math.tanh(1 + drive * 8)
  }
  return curve
}

export function useAudioPlayer(visualsEnabled = true) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const animationRef = useRef<ReturnType<typeof setTimeout>>()
  const visualsEnabledRef = useRef(visualsEnabled)
  visualsEnabledRef.current = visualsEnabled
  const analysisDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const waveShaperRef = useRef<WaveShaperNode | null>(null)
  const driveAmountRef = useRef(0)
  const filtersRef = useRef<BiquadFilterNode[]>([])
  const normalPathRef = useRef<GainNode | null>(null)
  const karaokePathRef = useRef<GainNode | null>(null)
  const compressorRef = useRef<DynamicsCompressorNode | null>(null)
  const lastTimeRenderRef = useRef(0)
  const lastVisualRenderRef = useRef(0)
  const loopRef = useRef<{ start: number | null; end: number | null }>({ start: null, end: null })
  const karaokeRef = useRef(false)
  const levelingRef = useRef(false)
  const eqRef = useRef([...EQ_PRESETS.Flat])
  const genreChainRef = useRef<GenreChain | null>(null)
  // The user's own speed dial and the mode's tempo multiply together, so both
  // are tracked separately and the product is what reaches the element.
  const userRateRef = useRef(1)
  const genreModeRef = useRef<GenreModeId>('off')
  const preservePitchRef = useRef(true)

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const [durationMs, setDurationMs] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [preservePitch, setPreservePitch] = useState(true)
  // Audio energy drives CSS custom properties only. Holding it in React state
  // re-rendered the whole player tree ~7x a second to change two numbers that
  // nothing in React actually reads, so it is written straight to the DOM.
  const visualNodeRef = useRef<HTMLElement | null>(null)
  const [eqBands, setEqBands] = useState<number[]>([...EQ_PRESETS.Flat])
  const [eqPreset, setEqPreset] = useState('Flat')
  const [karaokeMode, setKaraokeMode] = useState(false)
  const [leveling, setLeveling] = useState(false)
  const [loopStartMs, setLoopStartMs] = useState<number | null>(null)
  const [loopEndMs, setLoopEndMs] = useState<number | null>(null)
  const [genreMode, setGenreMode] = useState<GenreModeId>('off')

  const syncSignalPath = useCallback(() => {
    if (normalPathRef.current) normalPathRef.current.gain.value = karaokeRef.current ? 0 : 1
    if (karaokePathRef.current) karaokePathRef.current.gain.value = karaokeRef.current ? 1 : 0
    const compressor = compressorRef.current
    if (compressor) {
      compressor.threshold.value = levelingRef.current ? -18 : 0
      compressor.knee.value = levelingRef.current ? 16 : 0
      compressor.ratio.value = levelingRef.current ? 3.5 : 1
      compressor.attack.value = 0.012
      compressor.release.value = 0.3
    }
    filtersRef.current.forEach((filter, index) => { filter.gain.value = eqRef.current[index] ?? 0 })
    if (waveShaperRef.current) {
      waveShaperRef.current.oversample = driveAmountRef.current ? '2x' : 'none'
      waveShaperRef.current.curve = driveAmountRef.current ? makeDriveCurve(driveAmountRef.current) : null
    }
  }, [])

  const ensureAudioAnalysis = useCallback(async () => {
    const audio = audioRef.current
    if (!audio) return

    if (!audioContextRef.current) {
      const context = new AudioContext()
      const analyser = context.createAnalyser()
      // Keep the reactive layer light on software-rendered machines. 64 bins
      // is plenty for a calm pulse while avoiding a large analyser buffer.
      analyser.fftSize = 256
      analysisDataRef.current = new Uint8Array(analyser.frequencyBinCount)
      analyser.smoothingTimeConstant = 0.86
      const source = context.createMediaElementSource(audio)
      const filters = EQ_FREQUENCIES.map((frequency, index) => {
        const filter = context.createBiquadFilter()
        filter.type = index === 0 ? 'lowshelf' : index === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking'
        filter.frequency.value = frequency
        filter.Q.value = 1.05
        return filter
      })

      let tail: AudioNode = source
      for (const filter of filters) {
        tail.connect(filter)
        tail = filter
      }

      const waveShaper = context.createWaveShaper()
      waveShaper.oversample = driveAmountRef.current ? '2x' : 'none'
      tail.connect(waveShaper)
      tail = waveShaper

      // Genre modes live between the EQ/drive stage and the analyser, so the
      // visualiser reacts to what you actually hear.
      const genreChain = new GenreChain(context)
      tail.connect(genreChain.input)
      tail = genreChain.output
      genreChainRef.current = genreChain
      genreChain.setMode(genreModeRef.current)

      const normalPath = context.createGain()
      tail.connect(normalPath)
      normalPath.connect(analyser)

      // A free, local center-cancel path for karaoke practice. It works best on
      // stereo masters where lead vocals are mixed in the center.
      const splitter = context.createChannelSplitter(2)
      const left = context.createGain()
      const right = context.createGain()
      const merger = context.createChannelMerger(2)
      const karaokePath = context.createGain()
      right.gain.value = -1
      tail.connect(splitter)
      splitter.connect(left, 0)
      splitter.connect(right, 1)
      left.connect(merger, 0, 0)
      right.connect(merger, 0, 0)
      left.connect(merger, 0, 1)
      right.connect(merger, 0, 1)
      merger.connect(karaokePath)
      karaokePath.connect(analyser)

      const compressor = context.createDynamicsCompressor()
      analyser.connect(compressor)
      compressor.connect(context.destination)

      audioContextRef.current = context
      analyserRef.current = analyser
      sourceRef.current = source
      waveShaperRef.current = waveShaper
      filtersRef.current = filters
      normalPathRef.current = normalPath
      karaokePathRef.current = karaokePath
      compressorRef.current = compressor
      syncSignalPath()
    }

    if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume()
  }, [syncSignalPath])

  const updateFrame = useCallback(() => {
    const clock = performance.now()
    const audio = audioRef.current
    if (audio) {
      const now = audio.currentTime * 1000
      const loop = loopRef.current
      if (loop.start !== null && loop.end !== null && loop.end > loop.start + 250 && now >= loop.end) {
        audio.currentTime = loop.start / 1000
        setCurrentTimeMs(loop.start)
        lastTimeRenderRef.current = clock
      } else if (!document.hidden && clock - lastTimeRenderRef.current >= 200) {
        // Lyrics remain responsive at ~6fps without forcing a full React/
        // lyric-tree render on every display frame.
        setCurrentTimeMs(now)
        lastTimeRenderRef.current = clock
      }
    }

    const analyser = analyserRef.current
    if (analyser && visualsEnabledRef.current && !document.hidden && clock - lastVisualRenderRef.current >= 150) {
      const data = analysisDataRef.current!
      analyser.getByteFrequencyData(data)
      const overall = data.reduce((sum, value) => sum + value, 0) / Math.max(1, data.length) / 255
      const bassBins = data.slice(0, Math.max(5, Math.floor(data.length * 0.1)))
      const bass = bassBins.reduce((sum, value) => sum + value, 0) / bassBins.length / 255
      const node = visualNodeRef.current
      if (node) {
        node.style.setProperty('--audio-energy', overall.toFixed(3))
        node.style.setProperty('--bass-energy', bass.toFixed(3))
      }
      lastVisualRenderRef.current = clock
    }

    if (!audio?.paused) animationRef.current = setTimeout(updateFrame, 100)
  }, [])

  useEffect(() => () => {
    if (animationRef.current) clearTimeout(animationRef.current)
    genreChainRef.current?.dispose()
    genreChainRef.current = null
    audioContextRef.current?.close().catch(() => undefined)
  }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) ensureAudioAnalysis().then(() => audio.play()).catch(console.error)
    else audio.pause()
  }, [ensureAudioAnalysis])

  const play = useCallback(() => {
    const audio = audioRef.current
    if (audio) ensureAudioAnalysis().then(() => audio.play()).catch(console.error)
  }, [ensureAudioAnalysis])

  const pause = useCallback(() => audioRef.current?.pause(), [])

  const seek = useCallback((timeMs: number) => {
    const audio = audioRef.current
    if (!audio) return
    const maximum = Number.isFinite(audio.duration) ? audio.duration * 1000 : timeMs
    const nextTime = Math.max(0, Math.min(timeMs, maximum))
    audio.currentTime = nextTime / 1000
    setCurrentTimeMs(nextTime)
  }, [])

  const skip = useCallback((deltaMs: number) => {
    const audio = audioRef.current
    if (audio) seek(audio.currentTime * 1000 + deltaMs)
  }, [seek])

  const changeVolume = useCallback((newVolume: number) => {
    const clamped = Math.max(0, Math.min(1, newVolume))
    // A square curve gives the slider a more natural, logarithmic-feeling range.
    const perceptualVolume = clamped * clamped
    setVolume(clamped)
    if (!audioRef.current) return
    audioRef.current.volume = perceptualVolume
    if (clamped > 0) {
      setIsMuted(false)
      audioRef.current.muted = false
    }
  }, [])

  const toggleMute = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    const nextMuted = !audio.muted
    audio.muted = nextMuted
    setIsMuted(nextMuted)
  }, [])

  /** Pushes userRate x modeTempo to the element, clamped to what it accepts. */
  const syncPlaybackRate = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    const mode = GENRE_MODES[genreModeRef.current]
    const effective = userRateRef.current * mode.tempo
    audio.playbackRate = Math.max(0.25, Math.min(4, effective))
    // A genre mode's pitch maths assumes pitch tracks speed, so the browser's
    // pitch correction has to be off while one is active.
    audio.preservesPitch = mode.id === 'off' ? preservePitchRef.current : false
  }, [])

  const changePlaybackRate = useCallback((rate: number) => {
    const nextRate = Math.max(0.5, Math.min(2, rate))
    userRateRef.current = nextRate
    setPlaybackRate(nextRate)
    syncPlaybackRate()
  }, [syncPlaybackRate])

  /** Switches genre mode: retunes the chain and re-applies the speed. */
  const applyGenreMode = useCallback((modeId: GenreModeId) => {
    genreModeRef.current = modeId
    setGenreMode(modeId)
    genreChainRef.current?.setMode(modeId)
    syncPlaybackRate()
  }, [syncPlaybackRate])

  const changePreservePitch = useCallback((enabled: boolean) => {
    preservePitchRef.current = enabled
    setPreservePitch(enabled)
    syncPlaybackRate()
  }, [syncPlaybackRate])

  const [pitchSemitones, setPitchSemitones] = useState(0)
  /** Shift pitch without touching speed. 0 bypasses the shifter entirely. */
  const changePitch = useCallback((semitones: number) => {
    const clamped = Math.max(-12, Math.min(12, Math.round(semitones * 2) / 2))
    setPitchSemitones(clamped)
    genreChainRef.current?.setPitchSemitones(clamped)
  }, [])

  /**
   * Bass and treble are shortcuts over the existing EQ rather than new
   * filters: bass moves the 60 Hz and 170 Hz bands together, treble the
   * 3.5 kHz and 10 kHz pair. Same DSP, far less to think about than six
   * sliders — and the EQ view still shows exactly what they did.
   */
  const changeTone = useCallback((which: 'bass' | 'treble', gain: number) => {
    const clamped = Math.max(-9, Math.min(9, gain))
    const indexes = which === 'bass' ? [0, 1] : [4, 5]
    setEqBands(current => {
      const next = [...current]
      for (const index of indexes) {
        next[index] = clamped
        if (filtersRef.current[index]) filtersRef.current[index].gain.value = clamped
      }
      eqRef.current = next
      return next
    })
    setEqPreset('Custom')
  }, [])

  const changeEqBand = useCallback((index: number, gain: number) => {
    setEqBands(current => {
      const next = [...current]
      next[index] = Math.max(-9, Math.min(9, gain))
      eqRef.current = next
      if (filtersRef.current[index]) filtersRef.current[index].gain.value = next[index]
      return next
    })
    setEqPreset('Custom')
  }, [])

  const applyEqPreset = useCallback((name: string) => {
    const preset = EQ_PRESETS[name]
    if (!preset) return
    const next = [...preset]
    eqRef.current = next
    setEqBands(next)
    setEqPreset(name)
    driveAmountRef.current = DRIVE_PRESETS[name] ?? 0
    if (waveShaperRef.current) {
      waveShaperRef.current.oversample = driveAmountRef.current ? '2x' : 'none'
      waveShaperRef.current.curve = driveAmountRef.current ? makeDriveCurve(driveAmountRef.current) : null
    }
    filtersRef.current.forEach((filter, index) => { filter.gain.value = next[index] ?? 0 })
  }, [])

  const toggleKaraokeMode = useCallback(() => {
    setKaraokeMode(current => {
      const next = !current
      karaokeRef.current = next
      if (normalPathRef.current) normalPathRef.current.gain.value = next ? 0 : 1
      if (karaokePathRef.current) karaokePathRef.current.gain.value = next ? 1 : 0
      return next
    })
  }, [])

  const toggleLeveling = useCallback(() => {
    setLeveling(current => {
      const next = !current
      levelingRef.current = next
      const compressor = compressorRef.current
      if (compressor) {
        compressor.threshold.value = next ? -18 : 0
        compressor.knee.value = next ? 16 : 0
        compressor.ratio.value = next ? 3.5 : 1
      }
      return next
    })
  }, [])

  const markLoopStart = useCallback(() => {
    const time = audioRef.current ? audioRef.current.currentTime * 1000 : currentTimeMs
    loopRef.current = { start: time, end: null }
    setLoopStartMs(time)
    setLoopEndMs(null)
  }, [currentTimeMs])

  const markLoopEnd = useCallback(() => {
    const time = audioRef.current ? audioRef.current.currentTime * 1000 : currentTimeMs
    const start = loopRef.current.start
    if (start === null || time <= start + 250) return
    loopRef.current = { start, end: time }
    setLoopEndMs(time)
  }, [currentTimeMs])

  const clearLoop = useCallback(() => {
    loopRef.current = { start: null, end: null }
    setLoopStartMs(null)
    setLoopEndMs(null)
  }, [])

  const handleLoadedMetadata = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    setDurationMs(audio.duration * 1000)
    setCurrentTimeMs(0)
    audio.volume = volume * volume
    syncPlaybackRate()
    clearLoop()
  }, [clearLoop, syncPlaybackRate, volume])

  const handlePlay = useCallback(() => {
    setIsPlaying(true)
    ensureAudioAnalysis().catch(console.error)
    if (animationRef.current) clearTimeout(animationRef.current)
    animationRef.current = setTimeout(updateFrame, 100)
  }, [ensureAudioAnalysis, updateFrame])

  const handlePause = useCallback(() => {
    setIsPlaying(false)
    const node = visualNodeRef.current
    if (node) {
      node.style.setProperty('--audio-energy', '0')
      node.style.setProperty('--bass-energy', '0')
    }
    if (animationRef.current) clearTimeout(animationRef.current)
  }, [])

  /**
   * Attach to whichever element carries the reactive CSS variables. A callback
   * ref rather than a plain one, because the dock and the full player are
   * different elements and either may be the mounted one.
   */
  const setVisualTarget = useCallback((node: HTMLElement | null) => {
    visualNodeRef.current = node
  }, [])

  return {
    audioRef,
    /** The analyser after EQ and genre mode, for visuals that react to the music. */
    analyserRef,
    isPlaying,
    currentTimeMs,
    durationMs,
    volume,
    isMuted,
    playbackRate,
    preservePitch,
    setVisualTarget,
    genreMode,
    applyGenreMode,
    eqBands,
    pitchSemitones,
    changePitch,
    changeTone,
    eqPreset,
    karaokeMode,
    leveling,
    loopStartMs,
    loopEndMs,
    togglePlay,
    play,
    pause,
    seek,
    skip,
    changeVolume,
    toggleMute,
    changePlaybackRate,
    changePreservePitch,
    changeEqBand,
    applyEqPreset,
    toggleKaraokeMode,
    toggleLeveling,
    markLoopStart,
    markLoopEnd,
    clearLoop,
    handleLoadedMetadata,
    handlePlay,
    handlePause,
  }
}
