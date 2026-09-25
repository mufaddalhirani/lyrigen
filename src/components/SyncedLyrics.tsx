import { memo, useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { LyricPlayer, type LyricPlayerRef } from '@applemusic-like-lyrics/react'
import type { LyricLine } from '@applemusic-like-lyrics/lyric'
import '@applemusic-like-lyrics/core/style.css'
import type { BeatClock } from '../lib/beat/beatClock'
import { InterludeVisualizer } from '../lib/beat/visualizer'

interface Props { lines: LyricLine[]; audioRef: RefObject<HTMLAudioElement>; playing: boolean; offsetMs: number; visible: boolean; reducedMotion: boolean; onSeek: (time: number) => void; beats?: BeatClock; beatPulse?: boolean }

/**
 * Between sung lines, AMLL leaves a gap in the lyric flow for its three
 * "interlude" dots. The dots are hidden; the interlude visualizer (bars, the
 * beat of the bar, and a count-in to the next line) is drawn in that gap.
 *
 * It shows only when both of these hold:
 *  - AMLL has placed the gap for *this* interlude (its dots element carries
 *    the `enabled` class). Otherwise the element sits wherever the last
 *    interlude was — often over lines being sung now.
 *  - The song's real time is between two lines. AMLL fades its dots on its own
 *    frame-counted clock, which drifts after a seek or a pause.
 * The gap is given a fixed size in CSS, so AMLL reserves exactly the room the
 * visualizer needs from the first layout and nothing can spill onto a line.
 */
function attachVisualizer(root: HTMLElement | null | undefined, visualizer: InterludeVisualizer) {
  if (!root || visualizer.canvas.isConnected) return
  root.querySelector<HTMLElement>('[class*="interludeDots"]')?.appendChild(visualizer.canvas)
}

function inGap(lines: Array<{ start: number; end: number }>, now: number) {
  if (!lines.length) return false
  if (now < lines[0].start - 250) return true
  for (let i = 0; i < lines.length; i++) {
    if (now >= lines[i].start && now < lines[i].end) return false
  }
  const next = lines.find(line => line.start > now)
  return !next || next.start - now > 250
}

/**
 * Where in the song a click on a lyric landed, to the word.
 *
 * AMLL reports which *line* was clicked, not which word, so the word is
 * recovered from the DOM: find the word element under the pointer, then take
 * its position among that line's word elements. The renderer emits one element
 * per entry in `line.words`, but drops whitespace-only entries, so the
 * non-blank words are used whenever the counts disagree. The renderer wraps
 * each word in `emphasizeWrapper` (the inner span carries the mask gradient
 * that does the sung-word wipe); its class names are content-hashed, hence the
 * substring match. Anything unexpected
 * falls back to the start of the line, which is the old behaviour.
 */
function wordTimeAt(event: MouseEvent, line: LyricLine) {
  try {
    const point = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
    const wordEl = point?.closest<HTMLElement>('[class*="emphasizeWrapper"]')
    const lineEl = wordEl?.closest<HTMLElement>('[class*="lyricMainLine"], [class*="lyricLine"]')
    if (!wordEl || !lineEl) return line.startTime
    const wordEls = Array.from(lineEl.querySelectorAll<HTMLElement>('[class*="emphasizeWrapper"]'))
    const index = wordEls.indexOf(wordEl)
    if (index < 0) return line.startTime
    const words = wordEls.length === line.words.length ? line.words : line.words.filter(word => word.word.trim())
    const word = words[index]
    return word && Number.isFinite(word.startTime) && word.startTime > 0 ? word.startTime : line.startTime
  } catch {
    return line.startTime
  }
}


/**
 * The lyric motion chosen in Sound Lab, read from `<html data-lyric-motion>`.
 *
 * Blur and scale are handled by the renderer itself rather than by CSS: its
 * class names are content-hashed and nest (`lyricLineWrapper` inside
 * `lyricLine` inside `lyricMainLine`), so a `[class*="lyricLine"]` blur rule
 * applies several times over and turns the whole stage to soup. These props
 * are the supported way in.
 */
function useLyricMotion() {
  const [motion, setMotion] = useState(() => document.documentElement.dataset.lyricMotion || 'glow')
  useEffect(() => {
    const observer = new MutationObserver(() => setMotion(document.documentElement.dataset.lyricMotion || 'glow'))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-lyric-motion'] })
    return () => observer.disconnect()
  }, [])
  return motion
}

export const SyncedLyrics = memo(function SyncedLyrics({ lines, audioRef, playing, offsetMs, visible, reducedMotion, onSeek, beats, beatPulse = true }: Props) {
  const gapVisualizer = useRef<InterludeVisualizer | null>(null)
  const spans = useRef<Array<{ start: number; end: number }>>([])
  spans.current = lines.filter(line => !line.isBG).map(line => ({ start: line.startTime, end: line.endTime })).sort((a, b) => a.start - b.start)
  useEffect(() => { gapVisualizer.current = new InterludeVisualizer('lyric-gap-visualizer'); return () => { gapVisualizer.current?.canvas.remove(); gapVisualizer.current = null } }, [])
  const ref = useRef<LyricPlayerRef>(null)
  const motion = useLyricMotion()
  const still = motion === 'none' || reducedMotion
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
    // The visualizer waits until AMLL's lines have finished moving into place:
    // a moment into each gap, and a moment after any seek.
    let gapSince = Infinity
    let seekedAt = 0
    const tick = () => {
      timer = undefined
      if (!visible || document.hidden) return
      const now = performance.now()
      const player = ref.current?.lyricPlayer
      const songTime = Math.max(0, Math.round((audio?.currentTime ?? 0) * 1000 + offsetMs))
      player?.setCurrentTime(songTime)
      player?.update(Math.min(100, now - last))
      const wrapper = ref.current?.wrapperEl
      const visualizer = gapVisualizer.current
      if (wrapper && visualizer) {
        const inside = inGap(spans.current, songTime)
        if (!inside) gapSince = Infinity
        else if (gapSince === Infinity) gapSince = now
        const gap = inside && now - gapSince > 450 && now - seekedAt > 700
        if (wrapper.dataset.gap !== String(gap)) wrapper.dataset.gap = String(gap)
        attachVisualizer(wrapper, visualizer)
        const sample = beats?.sample()
        // The sung line moves a little with each beat (transform only, in CSS).
        const pulse = sample && beatPulse && !still ? sample.pulse : 0
        wrapper.style.setProperty('--beat', pulse.toFixed(3))
        if (gap && sample) {
          const next = spans.current.find(line => line.start > songTime)
          visualizer.draw(sample, { nextLineIn: next ? (next.start - songTime) / 1000 / (audio?.playbackRate || 1) : null }, now - last, still)
        }
      }
      last = now
      if (!audio?.paused || now < settleUntil) timer = setTimeout(tick, reducedMotion ? 100 : 33)
    }
    const start = () => { settleUntil = performance.now() + 5500; if (!timer) tick() }
    const seeked = () => { seekedAt = performance.now(); gapSince = Infinity; sync(true); start() }
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
  }, [audioRef, beatPulse, beats, lines, offsetMs, playing, reducedMotion, still, sync, visible])

  return <div className="synced-lyrics" aria-label="Synced lyrics" hidden={!visible}>
    <LyricPlayer ref={ref} className="synced-lyrics-stage" lyricLines={lines} disabled playing={playing} alignAnchor="center" alignPosition={0.5} enableSpring={!still} enableBlur={motion === 'blur' && !reducedMotion} enableScale={!still} wordFadeWidth={still ? 1 : 0.45} onLyricLineClick={event => {
      const line = lines[event.lineIndex]
      if (!line) return
      onSeek(Math.max(0, wordTimeAt(event, line) - offsetMs))
      sync(true)
      wake.current()
    }} />
    {browsing && <button className="lyrics-resume" onClick={() => { sync(true); wake.current() }}>Return to current line</button>}
  </div>
})
