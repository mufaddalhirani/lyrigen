import { memo, useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { LyricPlayer, type LyricPlayerRef } from '@applemusic-like-lyrics/react'
import type { LyricLine } from '@applemusic-like-lyrics/lyric'
import '@applemusic-like-lyrics/core/style.css'

interface Props { lines: LyricLine[]; audioRef: RefObject<HTMLAudioElement>; playing: boolean; offsetMs: number; visible: boolean; reducedMotion: boolean; onSeek: (time: number) => void; analyser?: RefObject<AnalyserNode | null> }

/**
 * A small live visualizer in place of AMLL's three "interlude" dots.
 *
 * AMLL decides where the gap sits in the lyric flow and fades its dots
 * element in and out; the dots themselves are hidden and this canvas is drawn
 * inside that element instead, so it lands exactly where they did.
 *
 * Whether it shows is also checked against the song's real time. AMLL only
 * switches the dots on or off when it recalculates its layout, and its own
 * clock for them is advanced by frame deltas, so after a seek or a pause they
 * could stay on behind lines that were already being sung. Here the bars only
 * draw while no line is actually active.
 */
class GapVisualizer {
  private canvas = document.createElement('canvas')
  private levels = new Float32Array(18)
  private bins = new Uint8Array(128)
  private phase = 0
  constructor() {
    this.canvas.className = 'lyric-gap-visualizer'
    this.canvas.width = 180
    this.canvas.height = 48
    this.canvas.setAttribute('aria-hidden', 'true')
  }
  /** Puts the canvas inside AMLL's dots element (which AMLL keeps for the player's life). */
  attach(root: HTMLElement | null | undefined) {
    if (!root || this.canvas.isConnected) return
    const dots = root.querySelector<HTMLElement>('[class*="interludeDots"]')
    if (dots) dots.appendChild(this.canvas)
  }
  draw(analyser: AnalyserNode | null | undefined, playing: boolean, still: boolean, delta: number) {
    const context = this.canvas.getContext('2d')
    if (!context) return
    const { width, height } = this.canvas
    const count = this.levels.length
    let live = false
    if (analyser && playing && !still) {
      if (this.bins.length !== analyser.frequencyBinCount) this.bins = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(this.bins)
      live = this.bins.some(value => value > 0)
    }
    this.phase += delta / 1000
    for (let i = 0; i < count; i++) {
      let target: number
      if (live) {
        // Bass in the middle, treble towards both edges, over the useful 60% of
        // the spectrum; higher bands are quieter, so they are lifted to match.
        const band = Math.abs(i - (count - 1) / 2) / ((count - 1) / 2)
        const from = Math.floor(this.bins.length * 0.6 * band ** 2)
        const to = Math.max(from + 1, Math.floor(this.bins.length * 0.6 * Math.min(1, band + 2 / count) ** 2))
        let sum = 0
        for (let b = from; b < to && b < this.bins.length; b++) sum += this.bins[b]
        target = Math.min(1, sum / (to - from) / 255 * (1 + band * 1.6))
      } else {
        // Paused, reduced motion, or no audio graph yet: a slow, quiet breath.
        target = 0.18 + 0.12 * Math.sin(this.phase * (still ? 1 : 2.4) + i * 0.55)
      }
      this.levels[i] += (target - this.levels[i]) * (live ? 0.45 : 0.15)
    }
    context.clearRect(0, 0, width, height)
    context.fillStyle = getComputedStyle(this.canvas).color || '#fff'
    const gap = 4
    const barWidth = (width - gap * (count - 1)) / count
    for (let i = 0; i < count; i++) {
      const h = Math.max(4, Math.min(1, this.levels[i] * 1.25) * height)
      const x = i * (barWidth + gap)
      const y = (height - h) / 2
      context.beginPath()
      context.roundRect(x, y, barWidth, h, barWidth / 2)
      context.fill()
    }
  }
  dispose() { this.canvas.remove() }
}

/** Whether `now` (ms) falls between lines rather than inside one. */
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

export const SyncedLyrics = memo(function SyncedLyrics({ lines, audioRef, playing, offsetMs, visible, reducedMotion, onSeek, analyser }: Props) {
  const gapVisualizer = useRef<GapVisualizer | null>(null)
  const spans = useRef<Array<{ start: number; end: number }>>([])
  spans.current = lines.filter(line => !line.isBG).map(line => ({ start: line.startTime, end: line.endTime })).sort((a, b) => a.start - b.start)
  useEffect(() => { gapVisualizer.current = new GapVisualizer(); return () => { gapVisualizer.current?.dispose(); gapVisualizer.current = null } }, [])
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
    const tick = () => {
      timer = undefined
      if (!visible || document.hidden) return
      const now = performance.now()
      const player = ref.current?.lyricPlayer
      const songTime = Math.max(0, Math.round((audio?.currentTime ?? 0) * 1000 + offsetMs))
      player?.setCurrentTime(songTime)
      player?.update(Math.min(100, now - last))
      const wrapper = ref.current?.wrapperEl
      if (wrapper) {
        const gap = inGap(spans.current, songTime)
        if (wrapper.dataset.gap !== String(gap)) wrapper.dataset.gap = String(gap)
        gapVisualizer.current?.attach(wrapper)
        if (gap) gapVisualizer.current?.draw(analyser?.current, !audio?.paused, reducedMotion, now - last)
      }
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
  }, [analyser, audioRef, lines, offsetMs, playing, reducedMotion, sync, visible])

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
