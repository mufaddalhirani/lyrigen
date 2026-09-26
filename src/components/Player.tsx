import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { type LyricLine } from '@applemusic-like-lyrics/lyric'
import { BratLyrics } from './BratLyrics'
import { KineticLyrics } from './KineticLyrics'
import { BeatClock, loadMixInfo, type MixInfo } from '../lib/beat/beatClock'
import { MIX_STYLES, chooseStyle, overlaps, planMixStart, splitBend, type MixStyle } from '../lib/transitions/djMix'
import { VISUAL_MODES, VISUAL_MODE_EVENT, loadVisualMode, saveVisualMode, type VisualMode } from '../lib/visualModes'
import { CoverSwap } from './player/CoverSwap'
import { SETTINGS_EVENT, loadAppSettings, setAppSetting } from '../lib/appSettings'
import { FluidBackground, loadFluidSettings, saveFluidSettings, type FluidSettings } from './player/FluidBackground'
import { SyncedLyrics } from './SyncedLyrics'
import { LyricsFinder } from './LyricsFinder'
import type { SyncTarget } from './AiLyricSync'
import { useSyncJob } from '../lib/lyricSyncJob'
import { MaterialIcon } from './common/MaterialIcon'
import { QualityBadge } from './common/QualityBadge'
import { parseLyricDocument, exportLyricDocument, fromAlignmentJson, hasSyllableTiming, type LyricDocument } from '../lib/lyrics'
import { EQ_FREQUENCIES, EQ_PRESETS, useAudioPlayer } from '../hooks/useAudioPlayer'
import '@applemusic-like-lyrics/core/style.css'

interface PlayerProps extends LibraryTrack {
  playlist: LibraryTrack[]
  currentIndex: number
  onSelectTrack: (index: number) => void
  onNextTrack?: () => void
  onPreviousTrack?: () => void
  onQueueReorder?: (trackIds: string[]) => void
  onQueueRemove?: (trackId: string) => void
  onClearQueue?: () => void
  onBack: () => void
  inAppMini?: boolean
  onMiniModeChange?: (enabled: boolean) => void
  queueShuffle?: boolean
  queueRepeat?: RepeatMode
  onPlaybackModes?: (shuffle: boolean, repeat: RepeatMode) => void
  /** Opens this song in Sync with AI (Lyric Studio) for syllable timing. */
  onOpenAiSync?: (target: SyncTarget) => void
}

type RepeatMode = 'off' | 'all' | 'one'
const VISUAL_MODE_OPTIONS = VISUAL_MODES.map(mode => ({ value: mode.id, label: mode.label, description: mode.description }))

const VISUALIZER_BARS = Array.from({ length: 18 }, (_, index) => index)


/**
 * Let the mini bar be dragged anywhere, and remember where it was left.
 *
 * The bar is centred with `left:50%` + a translate, so the first drag has to
 * switch it to explicit pixels or it would jump by half its width. Position is
 * kept as a fraction of the viewport, so it stays sensibly placed when the
 * window is resized, and is clamped back inside on load. Double-click returns
 * it to the centre.
 */
function useDraggableBar(enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [placed, setPlaced] = useState<{ x: number; y: number } | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('lyrigen-mini-position') || 'null')
      return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null
    } catch { return null }
  })

  const reset = useCallback(() => {
    setPlaced(null)
    try { localStorage.removeItem('lyrigen-mini-position') } catch { /* storage blocked */ }
  }, [])

  useEffect(() => {
    const element = ref.current
    if (!element || !enabled) return
    const onPointerDown = (event: PointerEvent) => {
      // The scrubber owns its own drag; everything else on the bar can move it.
      // Buttons still work, because a press that never moves stays a click —
      // only a real drag suppresses the click that would follow it.
      if ((event.target as HTMLElement).closest('input, select')) return
      if (event.button !== 0) return
      const rect = element.getBoundingClientRect()
      const grabX = event.clientX - rect.left
      const grabY = event.clientY - rect.top
      let moved = false
      const onMove = (move: PointerEvent) => {
        if (!moved && Math.hypot(move.clientX - event.clientX, move.clientY - event.clientY) < 4) return
        moved = true
        element.classList.add('dragging')
        const x = Math.min(Math.max(move.clientX - grabX, 8), window.innerWidth - rect.width - 8)
        const y = Math.min(Math.max(move.clientY - grabY, 8), window.innerHeight - rect.height - 8)
        setPlaced({ x: x / window.innerWidth, y: y / window.innerHeight })
      }
      const onUp = () => {
        element.classList.remove('dragging')
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        if (!moved) return
        // Swallow the click this drag would otherwise fire on whatever was grabbed.
        const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault() }
        window.addEventListener('click', swallow, { capture: true, once: true })
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
        setPlaced(current => { try { localStorage.setItem('lyrigen-mini-position', JSON.stringify(current)) } catch { /* storage blocked */ } return current })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }
    element.addEventListener('pointerdown', onPointerDown)
    return () => element.removeEventListener('pointerdown', onPointerDown)
  }, [enabled])

  const style = placed
    ? ({ left: `${Math.min(Math.max(placed.x, 0), 0.98) * 100}%`, top: `${Math.min(Math.max(placed.y, 0), 0.96) * 100}%`, bottom: 'auto', transform: 'none' } as CSSProperties)
    : undefined

  return { ref, style, placed: Boolean(placed), reset }
}

function formatTime(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function ControlIcon({ children, size = 21 }: { children: React.ReactNode; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">{children}</svg>
}

/** Sends the song to Sync with AI; while a sync runs, its label shows the progress. */
function AiSyncButton({ onClick }: { onClick: () => void }) {
  const job = useSyncJob()
  const running = job.phase === 'running'
  const label = running ? `Syncing ${job.target?.title ?? 'a song'}${job.percent != null ? ` · ${Math.round(job.percent)}%` : '…'}` : 'Sync syllables with AI'
  return <button className={`glass-icon-button ai-sync-button ${running ? 'is-syncing' : ''}`} onClick={onClick} aria-label={label}>
    <ControlIcon><path d="M3 6h10v2H3V6Zm0 5h8v2H3v-2Zm0 5h10v2H3v-2ZM18 7l1.2 3.3 3.3 1.2-3.3 1.2L18 16l-1.2-3.3-3.3-1.2 3.3-1.2L18 7Z" /></ControlIcon>
  </button>
}

function qualityLabel(metadata: AudioMetadata | null, format: string) {
  if (!metadata) return format
  if (metadata.lossless && metadata.sampleRate && metadata.bitsPerSample) {
    return `${format} · ${Math.round(metadata.sampleRate / 1000)} kHz / ${metadata.bitsPerSample}-bit`
  }
  if (metadata.bitrate) return `${format} · ${Math.round(metadata.bitrate / 1000)} kbps`
  return metadata.codec ? `${format} · ${metadata.codec}` : format
}

export function Player({
  title,
  artist: artistTag,
  audioPath,
  lyricPath,
  coverPath,
  videoPath,
  format,
  playlist,
  currentIndex,
  onSelectTrack,
  onNextTrack,
  onPreviousTrack,
  onQueueReorder,
  onQueueRemove,
  onClearQueue,
  onBack,
  inAppMini = false,
  onMiniModeChange,
  queueShuffle = false,
  queueRepeat = 'off',
  onPlaybackModes,
  onOpenAiSync,
}: PlayerProps) {
  const {
    audioRef,
    analyserRef,
    vizAnalyserRef,
    isPlaying,
    currentTimeMs,
    durationMs,
    volume,
    isMuted,
    playbackRate,
    preservePitch,
    setVisualTarget,
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
    handOff,
    startDjMix,
    mixPending,
    setMixIncoming,
    beforeSwitch,
    handlePlaying,
  } = useAudioPlayer(!inAppMini)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const countedTrackRef = useRef('')
  const [lyricLines, setLyricLines] = useState<LyricLine[]>([])
  const [lyricStatus, setLyricStatus] = useState('Looking for synced lyrics…')
  const [lyricSource, setLyricSource] = useState('')
  const [rawSyncedLyrics, setRawSyncedLyrics] = useState('')
  const [metadata, setMetadata] = useState<AudioMetadata | null>(null)
  const [coverUrl, setCoverUrl] = useState('')
  const [audioUrl, setAudioUrl] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const [nextAudioUrl, setNextAudioUrl] = useState('')
  const [videoEnabled, setVideoEnabled] = useState(false)
  const [isQueueOpen, setIsQueueOpen] = useState(false)
  const [finderOpen, setFinderOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const isShuffle = queueShuffle
  const repeatMode = queueRepeat
  const onPlaybackModesRef = useRef(onPlaybackModes)
  onPlaybackModesRef.current = onPlaybackModes
  const setIsShuffle = (value: boolean | ((current: boolean) => boolean)) => onPlaybackModes?.(typeof value === 'function' ? value(isShuffle) : value, repeatMode)
  const setRepeatMode = (value: RepeatMode | ((current: RepeatMode) => RepeatMode)) => onPlaybackModes?.(isShuffle, typeof value === 'function' ? value(repeatMode) : value)
  const [lyricOffsetMs, setLyricOffsetMs] = useState(0)
  const [lookupBusy, setLookupBusy] = useState(false)
  const [actionMessage, setActionMessage] = useState('')
  const [isMini, setIsMini] = useState(false)
  const lyricDocument = useRef<LyricDocument>({ lines: [], timing: 'word', metadata: [] })
  const [timing, setTiming] = useState<LyricDocument['timing']>('word')
  // One setting with Settings → Reduced motion (either switch flips both), or the system's.
  const systemReducedMotion = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const [reducedMotionSetting, setReducedMotionSetting] = useState(() => { try { return localStorage.getItem('lyrigen-reduced-motion') === 'true' } catch { return false } })
  const reducedMotion = reducedMotionSetting || systemReducedMotion
  const setReducedMotion = (update: (value: boolean) => boolean) => setAppSetting('reducedMotion', update(reducedMotionSetting))
  useEffect(() => {
    void loadAppSettings().then(settings => setReducedMotionSetting(settings.reducedMotion))
    const follow = (event: Event) => setReducedMotionSetting((event as CustomEvent<AppSettings>).detail.reducedMotion)
    window.addEventListener(SETTINGS_EVENT, follow)
    return () => window.removeEventListener(SETTINGS_EVENT, follow)
  }, [])
  const lookupGeneration = useRef(0)
  const [fluid, setFluid] = useState<FluidSettings>(loadFluidSettings)
  // The song's beats, for everything that moves with the music.
  const beatClock = useMemo(() => new BeatClock(() => audioRef.current, () => vizAnalyserRef.current), [audioRef, vizAnalyserRef])
  useEffect(() => { try { if (localStorage.getItem('lyrigen-debug') === '1') (window as unknown as { lyrigenBeats: BeatClock }).lyrigenBeats = beatClock } catch { /* storage blocked */ } }, [beatClock])
  const [beatPulse, setBeatPulse] = useState(() => { try { return localStorage.getItem('lyrigen-beat-pulse') !== 'off' } catch { return true } })
  // Song transitions: 'off' cuts, 'fade' only smooths skips, a number also
  // crossfades songs that end on their own over that many seconds.
  const [transition, setTransition] = useState<string>(() => { try { return localStorage.getItem('lyrigen-transition') ?? 'dj:auto' } catch { return 'dj:auto' } })
  const changeTransition = (value: string) => { setTransition(value); try { localStorage.setItem('lyrigen-transition', value) } catch { /* not remembered */ } }
  const transitionRef = useRef(transition)
  transitionRef.current = transition
  const crossfadedRef = useRef('')
  const outMix = useRef<{ path: string; info: MixInfo | null } | null>(null)
  const nextMix = useRef<{ path: string; info: MixInfo | null }>({ path: '', info: null })
  const toggleBeatPulse = () => setBeatPulse(on => { try { localStorage.setItem('lyrigen-beat-pulse', on ? 'off' : 'on') } catch { /* not remembered */ } return !on })
  useEffect(() => {
    beatClock.grid = null
    let active = true
    // A moment after the song starts, so the analysis never competes with it.
    // The same analysis gives the DJ transitions this song's grid and audible span.
    const timer = window.setTimeout(() => { void loadMixInfo(audioPath).then(info => { if (!active) return; beatClock.grid = info?.grid ?? null; outMix.current = { path: audioPath, info } }) }, 1500)
    return () => { active = false; window.clearTimeout(timer) }
  }, [audioPath, beatClock])
  const changeFluid = (patch: Partial<FluidSettings>) => setFluid(current => { const next = { ...current, ...patch }; saveFluidSettings(next); return next })
  const [visualMode, setVisualModeState] = useState<VisualMode>(loadVisualMode)
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false)
  const setVisualMode = (mode: VisualMode) => { setVisualModeState(mode); saveVisualMode(mode) }
  // Sound Lab can change the view too; follow it.
  useEffect(() => {
    const follow = (event: Event) => setVisualModeState((event as CustomEvent<VisualMode>).detail)
    window.addEventListener(VISUAL_MODE_EVENT, follow)
    return () => window.removeEventListener(VISUAL_MODE_EVENT, follow)
  }, [])
  useEffect(() => {
    if (!isModeMenuOpen) return
    const close = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest('.view-mode-picker')) setIsModeMenuOpen(false) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [isModeMenuOpen])

  const parseLyrics = useCallback((content: string, extension: string, source: string, totalDuration: number) => {
    const document = parseLyricDocument(content, extension, totalDuration)
    lyricDocument.current = document
    setLyricLines(document.lines)
    setTiming(document.timing)
    setLyricSource(source)
    setRawSyncedLyrics(extension === 'lrc' ? content : '')
    setLyricStatus(`${document.lines.length} lines · ${document.timing === 'word' ? (hasSyllableTiming(document.lines) ? 'syllable timing' : 'word timing') : document.timing === 'estimated' ? 'estimated word flow' : 'untimed text'}`)
  }, [])

  const findOnlineLyrics = useCallback(async (meta = metadata, totalDuration = durationMs) => {
    if (lookupBusy) return
    const generation = ++lookupGeneration.current
    setLookupBusy(true)
    setActionMessage('')
    setLyricStatus('Searching for word-synced lyrics…')
    let result: Awaited<ReturnType<typeof window.electronAPI.findOnlineLyrics>>
    try {
      result = await window.electronAPI.findOnlineLyrics({
        trackName: meta?.title || title,
        artistName: meta?.artist,
        albumName: meta?.album,
        duration: totalDuration ? totalDuration / 1000 : meta?.duration,
        audioPath,
      })
    } catch {
      if (generation === lookupGeneration.current) { setLyricStatus('The lyric services could not be reached'); setLookupBusy(false) }
      return
    }
    if (generation !== lookupGeneration.current) return
    if (result.found) {
      if (result.ttmlLyrics) {
        parseLyrics(result.ttmlLyrics, 'ttml', result.source || 'AMLL TTML DB', totalDuration || (meta?.duration ?? 0) * 1000)
        setRawSyncedLyrics('')
      } else {
        const content = result.syncedLyrics || result.plainLyrics || ''
        parseLyrics(content, result.syncedLyrics ? 'lrc' : 'txt', result.source || 'LRCLIB', totalDuration || (meta?.duration ?? 0) * 1000)
        setRawSyncedLyrics(result.syncedLyrics || '')
      }
    } else {
      setLyricStatus(result.instrumental ? 'This track is marked instrumental' : (result.message || 'No synced lyrics found'))
    }
    setLookupBusy(false)
  }, [durationMs, lookupBusy, metadata, parseLyrics, title])

  useEffect(() => {
    let active = true
    lookupGeneration.current += 1
    setLookupBusy(false)
    setMetadata(null)
    // The old cover stays up until the new one is ready, then hands over (CoverSwap).
    setVideoUrl('')
    setLyricLines([])
    setLyricSource('')
    setRawSyncedLyrics('')
    setActionMessage('')
    setLyricOffsetMs(Number(localStorage.getItem(`lyrigen-offset:${audioPath}`) || 0))
    // Video is available on demand, but never starts automatically because it
    // can be expensive on lower-powered PCs.
    setVideoEnabled(false)
    setLyricStatus(lyricPath ? 'Reading synced lyrics…' : 'Looking online for synced lyrics…')

    async function loadTrack() {
      const [meta, resolvedAudioUrl, resolvedCoverUrl, resolvedVideoUrl] = await Promise.all([
        window.electronAPI.getAudioMetadata(audioPath),
        window.electronAPI.getMediaUrl(audioPath),
        coverPath ? window.electronAPI.getMediaUrl(coverPath) : Promise.resolve(''),
        videoPath ? window.electronAPI.getMediaUrl(videoPath) : Promise.resolve(''),
      ])
      if (!active) return
      // The playing song dips out (or, after a crossfade, is already fading
      // in the background) before the new one takes the player.
      // After a DJ hand-over, the mix needs this song's grid (usually analysed already).
      if (mixPending()) setMixIncoming(await loadMixInfo(audioPath))
      await beforeSwitch(transitionRef.current !== 'off')
      if (!active) return
      setMetadata(meta)
      setAudioUrl(resolvedAudioUrl)
      setCoverUrl(resolvedCoverUrl || meta?.cover || '')
      setVideoUrl(resolvedVideoUrl)

      if (!lyricPath) {
        // Settings → Look up lyrics automatically; off means only when asked.
        if (!(await loadAppSettings()).autoFetchLyrics) { if (active) setLyricStatus('No lyric file · automatic lookup is off in Settings'); return }
        if (!active) return
        const result = await window.electronAPI.findOnlineLyrics({
          trackName: meta?.title || title,
          artistName: meta?.artist,
          albumName: meta?.album,
          duration: meta?.duration,
          audioPath,
        })
        if (!active) return
        if (result.found) {
          if (result.ttmlLyrics) {
            parseLyrics(result.ttmlLyrics, 'ttml', result.source || 'AMLL TTML DB', (meta?.duration ?? 0) * 1000)
            setRawSyncedLyrics('')
          } else {
            const content = result.syncedLyrics || result.plainLyrics || ''
            parseLyrics(content, result.syncedLyrics ? 'lrc' : 'txt', result.source || 'LRCLIB', (meta?.duration ?? 0) * 1000)
            setRawSyncedLyrics(result.syncedLyrics || '')
          }
        } else setLyricStatus(result.instrumental ? 'This track is marked instrumental' : (result.message || 'No synced lyrics found'))
        return
      }

      try {
        const content = await window.electronAPI.readFile(lyricPath)
        if (!active || !content) {
          if (active) setLyricStatus('The lyric file could not be read')
          return
        }
        const extension = lyricPath.split('.').pop()?.toLocaleLowerCase() || 'lrc'
        parseLyrics(content, extension, extension.toUpperCase(), (meta?.duration ?? 0) * 1000)
      } catch (error) {
        console.error('Failed to parse lyrics', error)
        if (active) setLyricStatus('This lyric file could not be parsed')
      }
    }

    loadTrack().catch(error => {
      console.error('Failed to load track', error)
      if (active) setLyricStatus('Track details could not be loaded')
    })
    return () => { active = false }
  }, [audioPath, coverPath, lyricPath, parseLyrics, title, videoPath])

  useEffect(() => {
    let active = true
    const nextTrack = playlist[(currentIndex + 1) % playlist.length]
    if (!nextTrack || nextTrack.audioPath === audioPath) { setNextAudioUrl(''); return }
    window.electronAPI.getMediaUrl(nextTrack.audioPath).then(url => active && setNextAudioUrl(url)).catch(() => active && setNextAudioUrl(''))
    return () => { active = false }
  }, [audioPath, currentIndex, playlist])

  const chooseNextIndex = useCallback((direction: 1 | -1) => {
    if (playlist.length < 2) return currentIndex
    if (isShuffle && direction === 1) {
      let randomIndex = currentIndex
      while (randomIndex === currentIndex) randomIndex = Math.floor(Math.random() * playlist.length)
      return randomIndex
    }
    return (currentIndex + direction + playlist.length) % playlist.length
  }, [currentIndex, isShuffle, playlist.length])

  const handleNext = useCallback(() => onNextTrack ? onNextTrack() : onSelectTrack(chooseNextIndex(1)), [chooseNextIndex, onNextTrack, onSelectTrack])
  const handlePrevious = useCallback(() => {
    if (currentTimeMs > 3500) seek(0)
    else if (onPreviousTrack) onPreviousTrack()
    else onSelectTrack(chooseNextIndex(-1))
  }, [chooseNextIndex, currentTimeMs, onPreviousTrack, onSelectTrack, seek])
  const willAdvance = repeatMode !== 'one' && (currentIndex < playlist.length - 1 || repeatMode === 'all' || isShuffle)
  // Which song the element has really loaded. Right after the next song is
  // asked for, the element still plays the old file (silently, after a
  // hand-over) until the new one loads; its time read then as the new song's
  // made every check below think that song was ending too, and skip again,
  // through dozens of songs. Nothing acts until this matches audioPath.
  const loadedPathRef = useRef('')
  const audioPathRef = useRef(audioPath)
  audioPathRef.current = audioPath
  // After an automatic advance, where the next song's sound starts (its
  // leading silence is skipped). DJ mixes place the new song themselves.
  const skipIntroRef = useRef<{ path: string; at: number } | null>(null)
  // The outgoing song easing toward a tempo both songs meet at.
  const preBendRef = useRef<{ path: string; timer: number } | null>(null)
  useEffect(() => () => { if (preBendRef.current) window.clearInterval(preBendRef.current.timer); preBendRef.current = null }, [audioPath])

  const handleLoadedMetadataForTrack = useCallback(() => {
    handleLoadedMetadata()
    loadedPathRef.current = audioPathRef.current
    const skip = skipIntroRef.current
    skipIntroRef.current = null
    const audio = audioRef.current
    if (skip && audio && skip.path === audioPathRef.current && skip.at > 0.3 && skip.at < (audio.duration || 0) * 0.3) audio.currentTime = skip.at
  }, [audioRef, handleLoadedMetadata])

  const nextSkip = useCallback(() => {
    const next = playlist[(currentIndex + 1) % playlist.length]
    return next && nextMix.current.path === next.audioPath && nextMix.current.info ? { path: next.audioPath, at: nextMix.current.info.soundStart } : null
  }, [currentIndex, playlist])

  // Transitions for a song ending on its own. DJ mode starts the mix on a
  // phrase that leaves room for the chosen style before the song's audible
  // end; the plain crossfade (and DJ mode's fallback, when a song has no beat
  // grid or the plan was missed) hands over a few seconds before that end.
  // Silence at the end of a song is never waited through.
  useEffect(() => {
    const mode = transitionRef.current
    const audio = audioRef.current
    if (!isPlaying || !willAdvance || !audio || loadedPathRef.current !== audioPath || crossfadedRef.current === audioPath || loopEndMs != null) return
    const length = audio.duration
    if (!Number.isFinite(length)) return
    const rate = audio.playbackRate || 1
    const next = playlist[(currentIndex + 1) % playlist.length]
    // The next song is analysed a while ahead (once; then it is cached).
    if ((length - audio.currentTime) / rate < 90 && next && nextMix.current.path !== next.audioPath) {
      const path = next.audioPath
      nextMix.current = { path, info: null }
      void loadMixInfo(path).then(info => { if (nextMix.current.path === path) nextMix.current.info = info })
    }
    const out = outMix.current?.path === audioPath ? outMix.current.info : null
    const incoming = next && nextMix.current.path === next.audioPath ? nextMix.current.info : null
    const end = out && out.soundEnd > length * 0.5 ? Math.min(length, out.soundEnd) : length
    const left = (end - audio.currentTime) / rate
    const advance = () => { skipIntroRef.current = nextSkip(); handleNext() }

    if (mode.startsWith('dj:')) {
      const chosen = out && incoming ? chooseStyle(mode.slice(3) as MixStyle | 'auto', out, incoming) : null
      // Past the chosen style's start (a seek near the end)? Echo out needs
      // only a bar, so it usually still fits.
      const options = chosen ? (chosen === 'echo' ? ['echo' as const] : [chosen, 'echo' as const]) : []
      const planned = options.map(option => ({ style: option, start: out ? planMixStart(out, option) : null })).find(plan => plan.start != null && (plan.start - audio.currentTime) / rate > 0.3)
      if (out?.grid && incoming?.grid && planned?.start != null) {
        const { style, start } = planned
        const lead = (start - audio.currentTime) / rate
        // Tempos too far apart for the new song alone: over the eight bars
        // before the mix, this song eases half the way toward the other.
        const split = splitBend(out.grid.bpm, incoming.grid.bpm)
        const approach = 3 + 32 * 60 / out.grid.bpm / rate
        if (split && split.out !== 1 && overlaps(style) && lead < approach && !preBendRef.current) {
          const from = audio.playbackRate
          const to = from * split.out
          const began = performance.now()
          const seconds = Math.max(1, lead - 3)
          const timer = window.setInterval(() => {
            const progress = Math.min(1, (performance.now() - began) / 1000 / seconds)
            audio.playbackRate = from + (to - from) * progress
            if (progress >= 1) window.clearInterval(timer)
          }, 50)
          preBendRef.current = { path: audioPath, timer }
        }
        if (lead > 2.5) return
        if (lead > 0.3) {
          crossfadedRef.current = audioPath
          void startDjMix({ style, out, incoming, target: start }).then(ok => { if (ok) handleNext(); else crossfadedRef.current = '' })
          return
        }
      } else if (left > 7) return // no plan (yet): wait for the fallback crossfade
    }
    const seconds = mode.startsWith('dj:') ? 6 : Number(mode) || 0
    if (seconds && length >= seconds * 2 + 20 && left <= seconds + 0.4 && left >= 1.5) {
      crossfadedRef.current = audioPath
      void handOff(Math.min(seconds, left - 0.3)).then(ok => { if (ok) advance(); else crossfadedRef.current = '' })
      return
    }
    // No crossfade (or too late for one): a silent tail is skipped, not played.
    if (end < length - 1 && audio.currentTime >= end + 0.2) { crossfadedRef.current = audioPath; advance() }
  }, [currentTimeMs, audioPath, audioRef, currentIndex, handOff, handleNext, isPlaying, loopEndMs, nextSkip, playlist, startDjMix, willAdvance])

  const handleEnded = useCallback(() => {
    // An old file ending after the next song was asked for is not this song ending.
    if (loadedPathRef.current !== audioPath || crossfadedRef.current === audioPath) return
    if (repeatMode === 'one') { seek(0); play() }
    else if (currentIndex < playlist.length - 1 || repeatMode === 'all' || isShuffle) { skipIntroRef.current = nextSkip(); handleNext() }
  }, [audioPath, currentIndex, handleNext, isShuffle, nextSkip, play, repeatMode, seek, playlist.length])

  useEffect(() => {
    const cleanupCommands = window.electronAPI.onPlayerCommand(command => {
      if (command === 'play-pause') togglePlay()
      else if (command === 'next') handleNext()
      else if (command === 'previous') handlePrevious()
      else if (command === 'mute') toggleMute()
    })
    const cleanupMini = window.electronAPI.onMiniModeChanged(setIsMini)
    return () => { cleanupCommands(); cleanupMini() }
  }, [handleNext, handlePrevious, toggleMute, togglePlay])

  // Windows' media overlay only takes http, data or blob artwork; a file://
  // cover was rejected (with a console error) on every track.
  const [sessionArtwork, setSessionArtwork] = useState('')
  useEffect(() => {
    let active = true
    setSessionArtwork(coverUrl.startsWith('data:') ? coverUrl : '')
    if (coverUrl && !coverUrl.startsWith('data:')) void window.electronAPI.getArtworkData(coverUrl, 256).then(data => { if (active) setSessionArtwork(data ?? '') })
    return () => { active = false }
  }, [coverUrl])

  useEffect(() => {
    const displayTitle = metadata?.title || title
    window.electronAPI.updatePlayerState({ playing: isPlaying, title: displayTitle })
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: displayTitle,
        artist: metadata?.artist || artistTag || 'Unknown Artist',
        album: metadata?.album || playlist[currentIndex]?.album,
        artwork: sessionArtwork ? [{ src: sessionArtwork }] : [],
      })
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
    }
  }, [artistTag, sessionArtwork, currentIndex, isPlaying, metadata, playlist, title])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', play], ['pause', () => audioRef.current?.pause()], ['nexttrack', handleNext],
      ['previoustrack', handlePrevious], ['seekbackward', () => skip(-10000)], ['seekforward', () => skip(10000)],
    ]
    handlers.forEach(([action, handler]) => { try { navigator.mediaSession.setActionHandler(action, handler) } catch { /* unsupported action */ } })
    return () => handlers.forEach(([action]) => { try { navigator.mediaSession.setActionHandler(action, null) } catch { /* unsupported action */ } })
  }, [audioRef, handleNext, handlePrevious, play, skip])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoEnabled) return
    const seconds = currentTimeMs / 1000
    if (Math.abs(video.currentTime - seconds) > 0.45) video.currentTime = seconds
    if (isPlaying && video.paused) void video.play().catch(() => undefined)
    if (!isPlaying && !video.paused) video.pause()
  }, [Math.floor(currentTimeMs / 500), isPlaying, videoEnabled])

  // Shortcuts. The small player bar is on screen over every page, so there
  // only Space works — arrows, letters and Esc belong to whatever page is
  // open. Keys a focused control handles itself (a button, a song row, a
  // field) are left to it, so nothing fires twice.
  const keyState = useRef({ isShuffle, repeatMode, full: !(isMini || inAppMini), overlay: false })
  keyState.current = { isShuffle, repeatMode, full: !(isMini || inAppMini), overlay: false }
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return
      if (target?.closest('button, a, [role="button"], [role="menuitemradio"], [role="dialog"]')) return
      const { full } = keyState.current
      if (event.code === 'Space') { event.preventDefault(); togglePlay(); return }
      if (!full) return
      if (event.code === 'ArrowRight') { event.preventDefault(); skip(10000) }
      else if (event.code === 'ArrowLeft') { event.preventDefault(); skip(-10000) }
      else if (event.key.toLocaleLowerCase() === 'm') toggleMute()
      else if (event.key.toLocaleLowerCase() === 's') onPlaybackModesRef.current?.(!keyState.current.isShuffle, keyState.current.repeatMode)
      else if (event.key.toLocaleLowerCase() === 'r') { const mode = keyState.current.repeatMode; onPlaybackModesRef.current?.(keyState.current.isShuffle, mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off') }
      else if (event.code === 'Escape') {
        if (isModeMenuOpen) setIsModeMenuOpen(false)
        else if (finderOpen) setFinderOpen(false)
        else if (isQueueOpen) setIsQueueOpen(false)
        else if (isSettingsOpen) setIsSettingsOpen(false)
        else onBack()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [finderOpen, isModeMenuOpen, isQueueOpen, isSettingsOpen, onBack, skip, toggleMute, togglePlay])

  const recordPlay = useCallback(() => {
    handlePlay()
    if (countedTrackRef.current === audioPath) return
    countedTrackRef.current = audioPath
    // Pass the length so listening totals can be summed without storing a tick per second.
    void window.electronAPI.recordPlay(audioPath.toLocaleLowerCase(), durationMs ? durationMs / 1000 : metadata?.duration ?? undefined).catch(() => undefined)
    try {
      const key = 'lyrigen-listening-stats-v1'
      const stats = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, { plays: number; lastPlayed: string; title: string }>
      const previous = stats[audioPath]
      stats[audioPath] = { plays: (previous?.plays ?? 0) + 1, lastPlayed: new Date().toISOString(), title: metadata?.title || title }
      localStorage.setItem(key, JSON.stringify(stats))
    } catch { /* Stats should never interrupt playback. */ }
  }, [audioPath, handlePlay, metadata?.title, title])

  const saveOnlineLyrics = async () => {
    if (!rawSyncedLyrics) { setActionMessage('Only synced results can be saved as LRC.'); return }
    const result = await window.electronAPI.saveLyrics(audioPath, rawSyncedLyrics)
    setActionMessage(result.saved ? 'LRC saved beside the song.' : (result.message || 'Could not save LRC.'))
  }

  const exportTtml = async () => {
    if (!lyricLines.length) return
    const result = await window.electronAPI.saveTtml(audioPath, exportLyricDocument(lyricDocument.current))
    setActionMessage(result.saved ? 'Apple-style TTML created beside the song.' : (result.message || 'Could not create TTML.'))
  }

  const [alignmentBusy, setAlignmentBusy] = useState(false)
  const importAlignmentJson = async () => {
    setAlignmentBusy(true)
    setActionMessage('')
    try {
      const file = await window.electronAPI.chooseAlignmentJson()
      if (!file) { setAlignmentBusy(false); return }
      const document = fromAlignmentJson(file.content)
      lyricDocument.current = document
      setLyricLines(document.lines)
      setTiming(document.timing)
      setLyricSource('Whisper / stable-ts alignment')
      setRawSyncedLyrics('')
      setLyricStatus(`${document.lines.length} lines · machine-aligned word timing`)
      setActionMessage(`Loaded ${file.name}. Review the timing, then Create TTML to save it beside the song.`)
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Could not read that alignment JSON.')
    } finally {
      setAlignmentBusy(false)
    }
  }

  const cycleRate = () => {
    const rates = [1, 1.25, 1.5, 2, 0.75]
    changePlaybackRate(rates[(rates.indexOf(playbackRate) + 1) % rates.length])
  }
  const cycleRepeat = () => setRepeatMode(value => value === 'off' ? 'all' : value === 'all' ? 'one' : 'off')

  const displayTitle = metadata?.title || title
  const displayArtist = metadata?.artist || artistTag || 'Unknown Artist'
  const displayAlbum = metadata?.album || playlist[currentIndex]?.album || 'Local Music'
  // The bar and the full player both render this one element. Both layouts
  // must keep a <div> as their outer element: React then keeps the keyed
  // <audio> (and the sound path wired to it) when switching between them.
  const audioElement = <audio key="playback-audio" ref={audioRef} src={audioUrl} autoPlay preload="auto" onLoadedMetadata={handleLoadedMetadataForTrack} onPlay={recordPlay} onPause={handlePause} onEnded={handleEnded} onPlaying={handlePlaying} />

  const drag = useDraggableBar(isMini || inAppMini)

  if (isMini || inAppMini) {
    return (
      <div
        className={`mini-player ${inAppMini ? 'in-app-mini' : ''} ${drag.placed ? 'is-placed' : ''}`}
        ref={node => { setVisualTarget(node); drag.ref.current = node }}
        style={drag.style}
        onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button, input')) drag.reset() }}
        title="Drag to move · double-click to recentre"
      >
        <div className="mini-seek">
          <input
            type="range"
            min={0}
            max={durationMs || 0}
            value={Math.min(currentTimeMs, durationMs || 0)}
            onChange={event => seek(Number(event.target.value))}
            aria-label="Seek"
            style={{ '--progress': `${durationMs ? currentTimeMs / durationMs * 100 : 0}%` } as CSSProperties}
          />
        </div>
        <button className="mini-identity" onClick={() => inAppMini ? onMiniModeChange?.(false) : window.electronAPI.setMiniMode(false)} aria-label="Open the full player">
          {coverUrl ? <span className="mini-cover-stack"><CoverSwap src={coverUrl} className="mini-cover" alt="" /></span> : <div className="mini-cover mini-placeholder"><MaterialIcon name="music" size={20} /></div>}
          <span className="mini-track"><strong>{displayTitle}</strong><small>{displayArtist}</small></span>
        </button>
        <div className="mini-transport">
          <button className="mini-control" onClick={handlePrevious} aria-label="Previous"><MaterialIcon name="previous" size={22} /></button>
          <button className="mini-play" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}><MaterialIcon name={isPlaying ? 'pause' : 'play'} size={26} /></button>
          <button className="mini-control" onClick={handleNext} aria-label="Next"><MaterialIcon name="next" size={22} /></button>
        </div>
        <div className="mini-meta">
          <span className="mini-time">{formatTime(currentTimeMs)} <i>/</i> {formatTime(durationMs)}</span>
          <button className="mini-exit" onClick={() => inAppMini ? onMiniModeChange?.(false) : window.electronAPI.setMiniMode(false)} aria-label={inAppMini ? 'Expand player' : 'Exit mini player'}><MaterialIcon name="expand" size={16} /></button>
        </div>
        {audioElement}
      </div>
    )
  }

  return (
    <div className={`app-shell player-shell visual-mode-${visualMode} ${fluid.enabled && coverUrl && visualMode !== 'brat' ? 'has-fluid' : ''} ${isPlaying ? 'is-playing' : 'is-paused'} ${reducedMotion ? 'reduce-motion' : ''}`} ref={setVisualTarget}>
      <div className="player-background">
        {videoEnabled && videoUrl && <video ref={videoRef} className="matched-video" src={videoUrl} muted playsInline />}
        {coverUrl && fluid.enabled && visualMode !== 'brat' ? <FluidBackground coverUrl={coverUrl} settings={fluid} playing={isPlaying} reducedMotion={reducedMotion} analyser={analyserRef} beats={beatClock} />
          : coverUrl && <img src={coverUrl} className="cover-bloom" alt="" />}
        <div className="reactive-wave wave-a" /><div className="reactive-wave wave-b" />
        <div className="background-veil" />
      </div>

      <header className="player-titlebar">
        <button className="glass-pill back-button" onClick={onBack}><ControlIcon><path d="m15.5 5-7 7 7 7 1.4-1.4-5.6-5.6 5.6-5.6L15.5 5Z" /></ControlIcon><span>Library</span></button>
        <div className="now-playing-label"><span className={isPlaying ? 'playing-dot active' : 'playing-dot'} />NOW PLAYING</div>
        <div className="window-controls">
          <div className="view-mode-picker">
            <button className={`glass-pill view-mode-button ${isModeMenuOpen ? 'active' : ''}`} onClick={() => setIsModeMenuOpen(open => !open)} aria-haspopup="menu" aria-expanded={isModeMenuOpen} title="Change the now-playing view">
              <ControlIcon><path d="M4 5h16v14H4V5Zm2 2v10h5V7H6Zm7 0v4h5V7h-5Zm0 6v4h5v-4h-5Z" /></ControlIcon>
              <span>{VISUAL_MODES.find(mode => mode.id === visualMode)?.label ?? 'View'}</span>
            </button>
            {isModeMenuOpen && <div className="view-mode-menu" role="menu">
              {VISUAL_MODES.map(mode => <button key={mode.id} role="menuitemradio" aria-checked={mode.id === visualMode} className={`view-mode-option mode-${mode.id} ${mode.id === visualMode ? 'on' : ''}`} onClick={() => { setVisualMode(mode.id); setIsModeMenuOpen(false) }}>
                <strong>{mode.label}</strong><small>{mode.description}</small>
              </button>)}
            </div>}
          </div>
          {onOpenAiSync && <AiSyncButton onClick={() => onOpenAiSync({ audioPath, title: displayTitle, artist: metadata?.artist ?? null, duration: metadata?.duration ?? null, lyricPath: lyricPath ?? null, level: 'syllable' })} />}
          <button className={`glass-icon-button ${isSettingsOpen ? 'active' : ''}`} onClick={() => { setIsSettingsOpen(value => !value); setIsQueueOpen(false) }} aria-label="Sound and lyrics settings"><ControlIcon><path d="M4 7h10v2H4V7Zm0 8h6v2H4v-2Zm14-9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm-4 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" /></ControlIcon></button>
          <button className={`glass-icon-button ${isQueueOpen ? 'active' : ''}`} onClick={() => { setIsQueueOpen(value => !value); setIsSettingsOpen(false) }} aria-label="Queue"><ControlIcon><path d="M4 6h12v2H4V6Zm0 5h12v2H4v-2Zm0 5h8v2H4v-2Zm11-1 5 3-5 3v-6Z" /></ControlIcon></button>
          <button className="glass-icon-button" onClick={() => onMiniModeChange ? onMiniModeChange(true) : window.electronAPI.setMiniMode(true)} aria-label="Mini player"><ControlIcon><path d="M5 6h14v12H5V6Zm9 7h3v3h-3v-3Z" /></ControlIcon></button>
          <button className="glass-icon-button" onClick={() => window.electronAPI.toggleFullscreen()} aria-label="Toggle fullscreen"><ControlIcon><path d="M7 14H5v5h5v-2H7v-3Zm-2-4h2V7h3V5H5v5Zm12 7h-3v2h5v-5h-2v3ZM14 5v2h3v3h2V5h-5Z" /></ControlIcon></button>
          <button className="glass-icon-button" onClick={() => window.electronAPI.minimizeWindow()} aria-label="Minimize"><ControlIcon><path d="M5 11h14v2H5z" /></ControlIcon></button>
          <button className="glass-icon-button close-button" onClick={() => window.electronAPI.closeWindow()} aria-label="Close"><ControlIcon><path d="m6.7 5.3 5.3 5.3 5.3-5.3 1.4 1.4-5.3 5.3 5.3 5.3-1.4 1.4-5.3-5.3-5.3 5.3-1.4-1.4 5.3-5.3-5.3-5.3 1.4-1.4Z" /></ControlIcon></button>
        </div>
      </header>

      <main className="now-playing-layout">
        <section className="artwork-column">
          <div className="visualizer-stage" aria-label="Reactive audio visualizer">{VISUALIZER_BARS.map(index => <i key={index} style={{ '--bar-phase': `${index * 0.13}s`, '--bar-height': `${34 + (index % 5) * 12}%` } as CSSProperties} />)}</div>
          <div className={`hero-artwork ${isPlaying ? 'is-playing' : ''}`}>{visualMode === 'vinyl' && <div className="vinyl-rim" aria-hidden="true" />}{coverUrl ? <CoverSwap src={coverUrl} alt={`${displayAlbum} cover`} /> : <div className="hero-placeholder">♫</div>}<div className="hero-glass-highlight" /></div>
          <div className="track-details"><h1>{displayTitle}</h1><h2>{displayArtist}</h2><p>{displayAlbum}</p><span className="quality-chip">{qualityLabel(metadata, format)}<QualityBadge source={{ lossless: metadata?.lossless, kbps: metadata?.bitrate ? Math.round(metadata.bitrate / 1000) : null, sampleRate: metadata?.sampleRate, bitDepth: metadata?.bitsPerSample, codec: metadata?.codec, format }} /></span></div>
        </section>

        <section className="lyrics-column liquid-panel">
          <div className="lyrics-heading">
            <div><span>LIVE LYRICS</span><p>{lyricStatus}{lyricLines.length > 1 ? ' · scroll or drag to browse' : ''}</p></div>
            <div className="lyric-heading-actions">{lyricSource && <span className="source-chip">{lyricSource}</span>}<span className="offset-chip">{lyricOffsetMs > 0 ? '+' : ''}{lyricOffsetMs} ms</span></div>
          </div>
          <div className="lyrics-viewport">
            {lyricLines.length > 0 ? (
              timing === 'unsynced' ? <div className="plain-lyrics">{lyricLines.map((line, index) => <p key={index}>{line.words.map(word => word.word).join('')}</p>)}</div> :
              visualMode === 'kinetic' ? <KineticLyrics lines={lyricLines} audioRef={audioRef} playing={isPlaying} offsetMs={lyricOffsetMs} reducedMotion={reducedMotion} beats={beatClock} beatPulse={beatPulse} title={metadata?.title || title} artist={displayArtist} onSeek={seek} /> :
              visualMode === 'brat' ? <BratLyrics lines={lyricLines} audioRef={audioRef} playing={isPlaying} offsetMs={lyricOffsetMs} reducedMotion={reducedMotion} title={displayTitle} onSeek={seek} /> :
              <SyncedLyrics lines={lyricLines} audioRef={audioRef} playing={isPlaying} offsetMs={lyricOffsetMs} visible={visualMode !== 'cover' && visualMode !== 'vinyl'} reducedMotion={reducedMotion} onSeek={seek} beats={beatClock} beatPulse={beatPulse} />
            ) : (
              <div className="lyrics-empty"><div className="empty-quote">“</div><h3>{lookupBusy ? 'Searching for lyrics…' : 'No synced lyrics yet'}</h3><p>Lyrigen checks matching local files first, then Unison (exact match for YouTube downloads), the AMLL TTML DB and LRCLIB.</p><button className="inline-glass-button" disabled={lookupBusy} onClick={() => void findOnlineLyrics()}>{lookupBusy ? 'Searching…' : 'Try online again'}</button><button className="inline-glass-button" onClick={() => setFinderOpen(true)}>Browse lyrics…</button></div>
            )}
          </div>
        </section>
      </main>

      {isQueueOpen && <aside className="queue-drawer liquid-panel"><div className="queue-header"><div><span>UP NEXT</span><h3>Playing queue</h3></div><div className="queue-header-actions"><button className="text-link" onClick={onClearQueue}>Clear</button><button className="glass-icon-button" onClick={() => setIsQueueOpen(false)} aria-label="Close queue">×</button></div></div><div className="queue-list">{playlist.map((track, index) => <div key={track.audioPath} draggable={index !== currentIndex} onDragStart={event => event.dataTransfer.setData('text/plain', track.id)} onDragOver={event => event.preventDefault()} onDrop={event => { const fromId = event.dataTransfer.getData('text/plain'); const ids = playlist.map(item => item.id).filter(id => id !== playlist[currentIndex]?.id); const fromIndex = ids.indexOf(fromId); const targetIndex = ids.indexOf(track.id); if (fromIndex >= 0 && targetIndex >= 0) { const next = [...ids]; const moved = next.splice(fromIndex, 1)[0]; next.splice(targetIndex, 0, moved); onQueueReorder?.(next) } }} className={`queue-row ${index === currentIndex ? 'active' : ''}`}><button onClick={() => onSelectTrack(index)}><span>{index === currentIndex && isPlaying ? '▮▮' : index + 1}</span><div><strong>{track.title}</strong><small>{track.artist || track.album}</small></div><em>{track.format}</em></button>{index !== currentIndex && <button className="queue-remove" onClick={() => onQueueRemove?.(track.id)} aria-label={`Remove ${track.title}`}><span>×</span></button>}</div>)}</div></aside>}

      {isSettingsOpen && (
        <aside className="settings-drawer liquid-panel">
          <div className="settings-header"><div><span>SOUND LAB</span><h3>Playback & lyrics</h3></div><button className="glass-icon-button" onClick={() => setIsSettingsOpen(false)} aria-label="Close settings">×</button></div>
          <div className="setting-section"><label>Sound mode<select aria-label="Sound mode" value={eqPreset} onChange={event => applyEqPreset(event.target.value)}>{Object.keys(EQ_PRESETS).map(name => <option key={name}>{name}</option>)}{eqPreset === 'Custom' && <option>Custom</option>}</select></label><small className="setting-hint">Hyperpop and Vinyl warmth add a light edge; Lo-fi and Arena soften or scoop the mix. These are local tone presets, not AI remixing.</small><div className="tone-row"><label><span>Bass <b>{eqBands[0] > 0 ? '+' : ''}{eqBands[0]} dB</b></span><input type="range" min={-9} max={9} step={0.5} value={eqBands[0]} onChange={event => changeTone('bass', Number(event.target.value))} /></label><label><span>Treble <b>{eqBands[5] > 0 ? '+' : ''}{eqBands[5]} dB</b></span><input type="range" min={-9} max={9} step={0.5} value={eqBands[5]} onChange={event => changeTone('treble', Number(event.target.value))} /></label><label><span>Pitch <b>{pitchSemitones > 0 ? '+' : ''}{pitchSemitones} st</b></span><input type="range" min={-12} max={12} step={0.5} value={pitchSemitones} onChange={event => changePitch(Number(event.target.value))} /></label></div><small className="setting-hint">Bass and treble move the EQ bands below. Pitch shifts the key without changing speed; centred, it is bypassed.</small><div className="eq-grid">{EQ_FREQUENCIES.map((frequency, index) => <label key={frequency}><span>{frequency >= 1000 ? `${frequency / 1000}k` : frequency}</span><input type="range" min={-9} max={9} step={0.5} value={eqBands[index]} onChange={event => changeEqBand(index, Number(event.target.value))} /><small>{eqBands[index] > 0 ? '+' : ''}{eqBands[index]} dB</small></label>)}</div></div>
          <div className="setting-section visual-mode-setting"><label>Visual mode<select aria-label="Visual mode" value={visualMode} onChange={event => setVisualMode(event.target.value as VisualMode)}>{VISUAL_MODE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><small className="setting-hint">{VISUAL_MODE_OPTIONS.find(option => option.value === visualMode)?.description}</small></div>
          <div className="setting-section toggle-stack"><button className={reducedMotion ? 'setting-toggle on' : 'setting-toggle'} onClick={() => setReducedMotion(value => !value)}><span><strong>Reduced motion</strong><small>Keep word highlighting with quieter movement</small></span><i /></button>
            <button className={leveling ? 'setting-toggle on' : 'setting-toggle'} onClick={toggleLeveling}><span><strong>Dynamic leveling</strong><small>Smooth loudness jumps between recordings</small></span><i /></button>
            <button className={karaokeMode ? 'setting-toggle on' : 'setting-toggle'} onClick={toggleKaraokeMode}><span><strong>Center vocal reduction</strong><small>Local stereo cancellation; results vary by mix</small></span><i /></button>
            <button className={preservePitch ? 'setting-toggle on' : 'setting-toggle'} onClick={() => changePreservePitch(!preservePitch)}><span><strong>Preserve pitch</strong><small>Keep voices natural when speed changes</small></span><i /></button>
            {videoPath && <button className={videoEnabled ? 'setting-toggle on' : 'setting-toggle'} onClick={() => setVideoEnabled(value => !value)}><span><strong>Matched local video</strong><small>Use the same-name video as the backdrop</small></span><i /></button>}
          </div>
          <div className="setting-section">
            <label>Song transitions<select value={transition} onChange={event => changeTransition(event.target.value)}>
              <option value="off">Hard cut</option>
              <option value="fade">Smooth skips only</option>
              <option value="3">Crossfade 3 s</option>
              <option value="6">Crossfade 6 s</option>
              <option value="10">Crossfade 10 s</option>
              <optgroup label="DJ mix — beat-matched">
                <option value="dj:auto">DJ: Auto (picks per pair of songs)</option>
                {MIX_STYLES.map(style => <option key={style.id} value={`dj:${style.id}`}>DJ: {style.label}</option>)}
              </optgroup>
            </select></label>
            <small className="setting-hint">{transition.startsWith('dj:') ? `${MIX_STYLES.find(style => `dj:${style.id}` === transition)?.hint ?? 'Chooses a beat-matched blend or bass swap when the tempos are close, echo out or a drop when they are not'}. Skips still fade in a blink; songs without a steady beat get a plain crossfade.` : 'Skips and clicks fade out in a blink instead of cutting. With a crossfade, a song that ends on its own blends into the next.'}</small>
          </div>
          <div className="setting-section fluid-settings">
            <button className={fluid.enabled ? 'setting-toggle on' : 'setting-toggle'} onClick={() => changeFluid({ enabled: !fluid.enabled })}><span><strong>Fluid background</strong><small>The cover, blurred and slowly warped — like Apple Music</small></span><i /></button>
            {fluid.enabled && <>
              <button className={beatPulse ? 'setting-toggle on' : 'setting-toggle'} onClick={toggleBeatPulse}><span><strong>Lyrics move with the beat</strong><small>The sung line kicks on each beat, from the song's beat grid</small></span><i /></button>
              <button className={fluid.reactive ? 'setting-toggle on' : 'setting-toggle'} onClick={() => changeFluid({ reactive: !fluid.reactive })}><span><strong>Pulse with the beat</strong><small>Flows faster and swells a little on each kick</small></span><i /></button>
              {([['opacity', 'Strength', 0.2, 1, 0.05], ['warp', 'Warp', 0, 3, 0.1], ['speed', 'Flow speed', 0, 3, 0.1], ['saturation', 'Colour', 0.5, 3, 0.1]] as const).map(([key, label, min, max, step]) =>
                <label key={key} className="fluid-slider"><span>{label}<b>{fluid[key].toFixed(key === 'opacity' ? 2 : 1)}</b></span><input type="range" min={min} max={max} step={step} value={fluid[key]} onChange={event => changeFluid({ [key]: Number(event.target.value) })} /></label>)}
            </>}
          </div>
          <div className="setting-section compact-settings"><div><span>Lyric timing</span><div className="segmented"><button onClick={() => setLyricOffsetMs(value => { localStorage.setItem(`lyrigen-offset:${audioPath}`, String(value - 50)); return value - 50 })}>−50</button><strong>{lyricOffsetMs} ms</strong><button onClick={() => setLyricOffsetMs(value => { localStorage.setItem(`lyrigen-offset:${audioPath}`, String(value + 50)); return value + 50 })}>+50</button></div></div><div><span>A–B loop</span><div className="segmented"><button onClick={markLoopStart}>A {loopStartMs === null ? '—' : formatTime(loopStartMs)}</button><button onClick={markLoopEnd} disabled={loopStartMs === null}>B {loopEndMs === null ? '—' : formatTime(loopEndMs)}</button><button onClick={clearLoop}>Clear</button></div></div></div>
          <div className="setting-section speed-dial"><div className="speed-dial-head"><span>Speed dial</span><strong>{playbackRate.toFixed(2)}×</strong></div><input type="range" min={0.5} max={2} step={0.05} value={playbackRate} onChange={event => changePlaybackRate(Number(event.target.value))} /><div className="speed-dial-labels"><small>0.5×</small><small>Natural</small><small>2×</small></div></div>
          <div className="setting-section lyric-tools"><span>Lyric tools</span><div><button disabled={lookupBusy} onClick={() => void findOnlineLyrics()}>{lookupBusy ? 'Searching…' : 'Find online'}</button><button onClick={() => setFinderOpen(true)} title="Search Unison, AMLL and LRCLIB and pick the match yourself">Browse lyrics…</button>{rawSyncedLyrics && !lyricPath && <button onClick={() => void saveOnlineLyrics()}>Save LRC</button>}<button disabled={!lyricLines.length || timing === 'unsynced'} onClick={() => void exportTtml()}>Create TTML</button><button disabled={alignmentBusy} onClick={() => void importAlignmentJson()} title="Import word timings produced by faster-whisper + stable-ts, or Meta's MMS forced aligner">{alignmentBusy ? 'Importing…' : 'Import alignment JSON'}</button><button onClick={() => void window.electronAPI.openExternal('https://amll-ttml-tool.stevexmh.net/')}>AMLL Tool ↗</button></div><small className="lyric-tool-hint">For a downloaded TTML, keep the same filename as the song and place it beside the audio. Alignment JSON comes from a free local forced-aligner run outside Lyrigen (see docs/ARCHITECTURE.md).</small>{actionMessage && <p>{actionMessage}</p>}</div>
        </aside>
      )}

      <footer className="control-dock liquid-panel">
        <div className="progress-row"><span>{formatTime(currentTimeMs)}</span><input className="progress-slider" type="range" min={0} max={durationMs || 100} value={Math.min(currentTimeMs, durationMs || 100)} onChange={event => seek(Number(event.target.value))} style={{ '--progress': `${durationMs ? (currentTimeMs / durationMs) * 100 : 0}%` } as CSSProperties} /><span>{formatTime(durationMs)}</span></div>
        <div className="dock-row">
          <div className="dock-side volume-control"><button className="control-button small" onClick={toggleMute} aria-label="Mute"><ControlIcon><path d={isMuted ? 'M4 9v6h4l5 4V5L8 9H4Zm11.5.1L14.1 10.5 15.6 12l-1.5 1.5 1.4 1.4 1.5-1.5 1.5 1.5 1.4-1.4-1.5-1.5 1.5-1.5-1.4-1.4-1.5 1.5-1.5-1.5Z' : 'M4 9v6h4l5 4V5L8 9H4Zm11-1.5v2a3 3 0 0 1 0 5v2a5 5 0 0 0 0-9Z'} /></ControlIcon></button><input className="volume-slider" type="range" min={0} max={1} step={0.01} value={isMuted ? 0 : volume} onChange={event => changeVolume(Number(event.target.value))} /></div>
          <div className="transport-controls">
            <button className={`control-button ${isShuffle ? 'active' : ''}`} onClick={() => setIsShuffle(value => !value)} aria-label="Shuffle"><ControlIcon><path d="M16 3h5v5h-2V6.4l-3.7 3.7-1.4-1.4L17.6 5H16V3ZM3 6h3.4l11.2 11H16v2h5v-5h-2v1.6L7.2 4H3v2Zm0 12h4.2l3.2-3.2-1.4-1.4L6.4 16H3v2Z" /></ControlIcon></button>
            <button className="control-button skip-button" onClick={() => skip(-10000)} aria-label="Back 10 seconds">−10</button>
            <button className="control-button" onClick={handlePrevious} aria-label="Previous track"><ControlIcon><path d="M6 5h2v14H6V5Zm3.5 7 9 6V6l-9 6Z" /></ControlIcon></button>
            <button className={`play-button ${isPlaying ? 'is-playing' : ''}`} onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? <ControlIcon><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z" /></ControlIcon> : <ControlIcon><path d="m8 5 11 7-11 7V5Z" /></ControlIcon>}</button>
            <button className="control-button" onClick={handleNext} aria-label="Next track"><ControlIcon><path d="m5.5 6 9 6-9 6V6ZM16 5h2v14h-2V5Z" /></ControlIcon></button>
            <button className="control-button skip-button" onClick={() => skip(10000)} aria-label="Forward 10 seconds">+10</button>
            <button className={`control-button repeat-button ${repeatMode !== 'off' ? 'active' : ''}`} onClick={cycleRepeat} aria-label={`Repeat ${repeatMode}`}><ControlIcon><path d="M7 7h9v3l4-4-4-4v3H7a5 5 0 0 0-5 5v2h2v-2a3 3 0 0 1 3-3Zm10 10H8v-3l-4 4 4 4v-3h9a5 5 0 0 0 5-5v-2h-2v2a3 3 0 0 1-3 3Z" /></ControlIcon>{repeatMode === 'one' && <span>1</span>}</button>
          </div>
          <div className="dock-side dock-right"><button className="rate-button" onClick={cycleRate} title="Playback speed">{playbackRate}×</button><span className="track-counter">{currentIndex + 1} of {playlist.length}</span></div>
        </div>
      </footer>

      {nextAudioUrl && <audio className="track-preloader" src={nextAudioUrl} preload="auto" aria-hidden="true" />}
      {audioElement}
      {finderOpen && <LyricsFinder
        track={{ audioPath, title: metadata?.title || title, artist: metadata?.artist ?? null, album: metadata?.album ?? null, duration: durationMs ? durationMs / 1000 : metadata?.duration ?? null, hasLyricFile: Boolean(lyricPath) }}
        onClose={() => setFinderOpen(false)}
        onApply={(content, format, sourceLabel) => {
          // parseLyrics throws on malformed TTML. Without this catch the click
          // handler dies silently and "Use now" looks like a dead button.
          lookupGeneration.current += 1
          setLookupBusy(false)
          try {
            parseLyrics(content, format === 'plain' ? 'txt' : format, sourceLabel, durationMs || (metadata?.duration ?? 0) * 1000)
            setRawSyncedLyrics(format === 'lrc' ? content : '')
            setActionMessage(`Lyrics from ${sourceLabel}.`)
          } catch (error) {
            console.error('Could not apply the chosen lyrics', error)
            setLyricStatus('Those lyrics could not be read')
            setActionMessage(`${sourceLabel} lyrics could not be read: ${error instanceof Error ? error.message : String(error)}`)
          }
        }}
        onSaved={path => setActionMessage(`Saved ${path.split(/[\\/]/).pop()} beside the song.`)}
      />}
    </div>
  )
}
