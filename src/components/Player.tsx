import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { type LyricLine } from '@applemusic-like-lyrics/lyric'
import { SyncedLyrics } from './SyncedLyrics'
import { LyricsFinder } from './LyricsFinder'
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
}

type RepeatMode = 'off' | 'all' | 'one'
type VisualMode = 'balanced' | 'lyrics' | 'cover' | 'vinyl' | 'visualizer'

const VISUAL_MODE_OPTIONS: Array<{ value: VisualMode; label: string; description: string }> = [
  { value: 'balanced', label: 'Balanced', description: 'Cover, details, and lyrics together' },
  { value: 'lyrics', label: 'Lyrics only', description: 'A calm, focused lyric view' },
  { value: 'cover', label: 'Cover only', description: 'Large album artwork and details' },
  { value: 'vinyl', label: 'Spinning vinyl', description: 'Album art as a gentle record' },
  { value: 'visualizer', label: 'Reactive visualizer', description: 'Lightweight bars that follow the music' },
]

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
}: PlayerProps) {
  const {
    audioRef,
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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const isShuffle = queueShuffle
  const repeatMode = queueRepeat
  const setIsShuffle = (value: boolean | ((current: boolean) => boolean)) => onPlaybackModes?.(typeof value === 'function' ? value(isShuffle) : value, repeatMode)
  const setRepeatMode = (value: RepeatMode | ((current: RepeatMode) => RepeatMode)) => onPlaybackModes?.(isShuffle, typeof value === 'function' ? value(repeatMode) : value)
  const [lyricOffsetMs, setLyricOffsetMs] = useState(0)
  const [lookupBusy, setLookupBusy] = useState(false)
  const [actionMessage, setActionMessage] = useState('')
  const [isMini, setIsMini] = useState(false)
  const lyricDocument = useRef<LyricDocument>({ lines: [], timing: 'word', metadata: [] })
  const resumeMsRef = useRef<number | null>(null)
  const [timing, setTiming] = useState<LyricDocument['timing']>('word')
  const [reducedMotion, setReducedMotion] = useState(() => localStorage.getItem('lyrigen-reduced-motion') === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches)
  const lookupGeneration = useRef(0)
  const [visualMode, setVisualMode] = useState<VisualMode>(() => {
    const saved = localStorage.getItem('lyrigen-visual-mode-v1') as VisualMode | null
    return VISUAL_MODE_OPTIONS.some(option => option.value === saved) ? saved! : 'balanced'
  })

  useEffect(() => {
    localStorage.setItem('lyrigen-visual-mode-v1', visualMode)
  }, [visualMode])

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
    const result = await window.electronAPI.findOnlineLyrics({
      trackName: meta?.title || title,
      artistName: meta?.artist,
      albumName: meta?.album,
      duration: totalDuration ? totalDuration / 1000 : meta?.duration,
      audioPath,
    })
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
    setCoverUrl('')
    setVideoUrl('')
    setLyricLines([])
    setLyricSource('')
    setRawSyncedLyrics('')
    setActionMessage('')
    resumeMsRef.current = null
    setLyricOffsetMs(Number(localStorage.getItem(`lyrigen-offset:${audioPath}`) || 0))
    // Video is available on demand, but never starts automatically because it
    // can be expensive on lower-powered PCs.
    setVideoEnabled(false)
    setLyricStatus(lyricPath ? 'Reading synced lyrics…' : 'Looking online for synced lyrics…')

    async function loadTrack() {
      const [meta, resolvedAudioUrl, resolvedCoverUrl, resolvedVideoUrl, resumeMs] = await Promise.all([
        window.electronAPI.getAudioMetadata(audioPath),
        window.electronAPI.getMediaUrl(audioPath),
        coverPath ? window.electronAPI.getMediaUrl(coverPath) : Promise.resolve(''),
        videoPath ? window.electronAPI.getMediaUrl(videoPath) : Promise.resolve(''),
        window.electronAPI.getResumePosition(audioPath.toLocaleLowerCase()).catch(() => null),
      ])
      if (!active) return
      resumeMsRef.current = resumeMs
      setMetadata(meta)
      setAudioUrl(resolvedAudioUrl)
      setCoverUrl(resolvedCoverUrl || meta?.cover || '')
      setVideoUrl(resolvedVideoUrl)

      if (!lyricPath) {
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
  const handleEnded = useCallback(() => {
    if (repeatMode === 'one') { seek(0); play() }
    else if (currentIndex < playlist.length - 1 || repeatMode === 'all' || isShuffle) handleNext()
  }, [currentIndex, handleNext, isShuffle, play, repeatMode, seek, playlist.length])

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

  useEffect(() => {
    const displayTitle = metadata?.title || title
    window.electronAPI.updatePlayerState({ playing: isPlaying, title: displayTitle })
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: displayTitle,
        artist: metadata?.artist || 'Unknown Artist',
        album: metadata?.album || playlist[currentIndex]?.album,
        artwork: coverUrl ? [{ src: coverUrl }] : [],
      })
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
    }
  }, [coverUrl, currentIndex, isPlaying, metadata, playlist, title])

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return
      if (event.code === 'Space') { event.preventDefault(); togglePlay() }
      else if (event.code === 'ArrowRight') { event.preventDefault(); skip(10000) }
      else if (event.code === 'ArrowLeft') { event.preventDefault(); skip(-10000) }
      else if (event.key.toLocaleLowerCase() === 'm') toggleMute()
      else if (event.key.toLocaleLowerCase() === 's') setIsShuffle(value => !value)
      else if (event.key.toLocaleLowerCase() === 'r') setRepeatMode(value => value === 'off' ? 'all' : value === 'all' ? 'one' : 'off')
      else if (event.code === 'Escape') isQueueOpen ? setIsQueueOpen(false) : isSettingsOpen ? setIsSettingsOpen(false) : onBack()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isQueueOpen, isSettingsOpen, onBack, skip, toggleMute, togglePlay])

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

  // Session restoration: pick up mid-song where the track was last paused,
  // saved via a dedicated resume-only IPC call so it never inflates the
  // recently-played/most-played stats that recordPlay() feeds instead.
  const handleLoadedMetadataForTrack = useCallback(() => {
    handleLoadedMetadata()
    const resumeMs = resumeMsRef.current
    resumeMsRef.current = null
    const audio = audioRef.current
    if (resumeMs && resumeMs > 4000 && audio?.duration && resumeMs < audio.duration * 1000 * 0.97) seek(resumeMs)
  }, [audioRef, handleLoadedMetadata, seek])

  const handlePauseAndSaveResume = useCallback(() => {
    handlePause()
    const audio = audioRef.current
    if (audio) void window.electronAPI.saveResumePosition(audioPath.toLocaleLowerCase(), audio.currentTime * 1000).catch(() => undefined)
  }, [audioPath, audioRef, handlePause])

  useEffect(() => {
    if (!isPlaying) return
    const id = window.setInterval(() => {
      const audio = audioRef.current
      if (audio) void window.electronAPI.saveResumePosition(audioPath.toLocaleLowerCase(), audio.currentTime * 1000).catch(() => undefined)
    }, 15_000)
    return () => window.clearInterval(id)
  }, [audioPath, audioRef, isPlaying])

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
  const [finderOpen, setFinderOpen] = useState(false)
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
  const displayArtist = metadata?.artist || 'Unknown Artist'
  const displayAlbum = metadata?.album || playlist[currentIndex]?.album || 'Local Music'
  useEffect(() => { localStorage.setItem('lyrigen-reduced-motion', String(reducedMotion)) }, [reducedMotion])
  const audioElement = <audio key="playback-audio" ref={audioRef} src={audioUrl} autoPlay preload="auto" onLoadedMetadata={handleLoadedMetadataForTrack} onPlay={recordPlay} onPause={handlePauseAndSaveResume} onEnded={handleEnded} />

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
          {coverUrl ? <img src={coverUrl} className="mini-cover" alt="" /> : <div className="mini-cover mini-placeholder"><MaterialIcon name="music" size={20} /></div>}
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
    <div className={`app-shell player-shell visual-mode-${visualMode} ${isPlaying ? 'is-playing' : 'is-paused'} ${reducedMotion ? 'reduce-motion' : ''}`} ref={setVisualTarget}>
      <div className="player-background">
        {videoEnabled && videoUrl && <video ref={videoRef} className="matched-video" src={videoUrl} muted playsInline />}
        {coverUrl && <img src={coverUrl} className="cover-bloom" alt="" />}
        <div className="reactive-wave wave-a" /><div className="reactive-wave wave-b" />
        <div className="background-veil" />
      </div>

      <header className="player-titlebar">
        <button className="glass-pill back-button" onClick={onBack}><ControlIcon><path d="m15.5 5-7 7 7 7 1.4-1.4-5.6-5.6 5.6-5.6L15.5 5Z" /></ControlIcon><span>Library</span></button>
        <div className="now-playing-label"><span className={isPlaying ? 'playing-dot active' : 'playing-dot'} />NOW PLAYING</div>
        <div className="window-controls">
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
          <div className={`hero-artwork ${isPlaying ? 'is-playing' : ''}`}>{visualMode === 'vinyl' && <div className="vinyl-rim" aria-hidden="true" />}{coverUrl ? <img src={coverUrl} alt={`${displayAlbum} cover`} /> : <div className="hero-placeholder">♫</div>}<div className="hero-glass-highlight" /></div>
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
              <SyncedLyrics lines={lyricLines} audioRef={audioRef} playing={isPlaying} offsetMs={lyricOffsetMs} visible={visualMode !== 'cover' && visualMode !== 'vinyl'} reducedMotion={reducedMotion} onSeek={seek} />
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
