import { memo, useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { LyricPlayer, type LyricPlayerRef } from '@applemusic-like-lyrics/react'
import type { LyricLine } from '@applemusic-like-lyrics/lyric'
import '@applemusic-like-lyrics/core/style.css'

interface Props { lines: LyricLine[]; audioRef: RefObject<HTMLAudioElement>; playing: boolean; offsetMs: number; visible: boolean; reducedMotion: boolean; onSeek: (time: number) => void }

/**
 * Where in the song a click on a lyric landed, to the word.
 *
 * AMLL reports which *line* was clicked, not which word, so the word is
 * recovered from the DOM: find the word element under the pointer, then take
 * its position among that line's word elements. The renderer emits one element
 * per entry in `line.words`, but drops whitespace-only entries, so the
 * non-blank words are used whenever the counts disagree. Anything unexpected
 * falls back to the start of the line, which is the old behaviour.
 */
function wordTimeAt(event: MouseEvent, line: LyricLine) {
  try {
    const point = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
    const wordEl = point?.closest<HTMLElement>('[class*="wordBody"]')
    const lineEl = wordEl?.closest<HTMLElement>('[class*="lyricMainLine"], [class*="lyricLine"]')
    if (!wordEl || !lineEl) return line.startTime
    const wordEls = Array.from(lineEl.querySelectorAll<HTMLElement>('[class*="wordBody"]'))
    const index = wordEls.indexOf(wordEl)
    if (index < 0) return line.startTime
    const words = wordEls.length === line.words.length ? line.words : line.words.filter(word => word.word.trim())
    const word = words[index]
    return word && Number.isFinite(word.startTime) && word.startTime > 0 ? word.startTime : line.startTime
  } catch {
    return line.startTime
  }
}

export const SyncedLyrics = memo(function SyncedLyrics({ lines, audioRef, playing, offsetMs, visible, reducedMotion, onSeek }: Props) {
  const ref = useRef<LyricPlayerRef>(null)
  const wake = useRef<() => void>(() => undefined)
  const [browsing, setBrowsing] = useState(false)
  const sync = useCallback((seek = false) => {
    const player = ref.current?.lyricPlayer
    if (!player) return
    if (seek) player.resetScroll()
    player.setCurrentTime(Math.max(0, Math.round((audioRef.current?.currentTime ?? 0) * 1000 + offsetMs)), seek)
    if (seek) { void player.calcLayout(false, true); setBrowsing(false) }
    player.update(33)
  }, [audioRef, offsetMs])

  useEffect(() => {
    const audio = audioRef.current
    const element = ref.current?.wrapperEl
    let timer: ReturnType<typeof setTimeout> | undefined
    let settleUntil = 0
    let last = performance.now()
    const tick = () => {
      timer = undefined
      if (!visible || document.hidden) return
      const now = performance.now()
      const player = ref.current?.lyricPlayer
      player?.setCurrentTime(Math.max(0, Math.round((audio?.currentTime ?? 0) * 1000 + offsetMs)))
      player?.update(Math.min(100, now - last))
      last = now
      if (!audio?.paused || now < settleUntil) timer = setTimeout(tick, reducedMotion ? 100 : 33)
    }
    const start = () => { settleUntil = performance.now() + 5500; if (!timer) tick() }
    const seeked = () => { sync(true); start() }
    const scrolled = () => { setBrowsing(true); start() }
    wake.current = start
    sync(true)
    start()
    audio?.addEventListener('seeked', seeked)
    audio?.addEventListener('ratechange', start)
    document.addEventListener('visibilitychange', start)
    element?.addEventListener('wheel', scrolled, { passive: true })
    element?.addEventListener('pointerdown', scrolled, { passive: true })
    return () => {
      clearTimeout(timer)
      wake.current = () => undefined
      audio?.removeEventListener('seeked', seeked)
      audio?.removeEventListener('ratechange', start)
      document.removeEventListener('visibilitychange', start)
      element?.removeEventListener('wheel', scrolled)
      element?.removeEventListener('pointerdown', scrolled)
    }
  }, [audioRef, lines, offsetMs, playing, reducedMotion, sync, visible])

  return <div className="synced-lyrics" aria-label="Synced lyrics" hidden={!visible}>
    <LyricPlayer ref={ref} className="synced-lyrics-stage" lyricLines={lines} disabled playing={playing} alignAnchor="center" alignPosition={0.5} enableSpring={false} enableBlur={false} enableScale={!reducedMotion} wordFadeWidth={0.5} onLyricLineClick={event => {
      const line = lines[event.lineIndex]
      if (!line) return
      onSeek(Math.max(0, wordTimeAt(event, line) - offsetMs))
      sync(true)
      wake.current()
    }} />
    {browsing && <button className="lyrics-resume" onClick={() => { sync(true); wake.current() }}>Return to current line</button>}
  </div>
})
