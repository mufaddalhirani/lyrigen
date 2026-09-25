import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { LyricLine } from '@applemusic-like-lyrics/lyric'
import type { BeatClock } from '../lib/beat/beatClock'
import { InterludeVisualizer } from '../lib/beat/visualizer'

/**
 * Kinetic mode: lyrics as kinetic typography, set by the music itself.
 *
 * - Each word comes up the moment it is sung.
 * - A word the singer holds (long for this line) is set apart: larger, in the
 *   display serif's italic, in the accent colour, with a rule that fills for
 *   as long as the note lasts. Emphasis goes where the voice puts it.
 * - The line kicks on each beat, harder on the downbeat and on harder kicks,
 *   from the song's beat grid (see lib/beat/beatClock).
 * - Background vocals sit under the lead in smaller italic, moving on their
 *   own; duet lines for the second voice set to the right (as Apple Music Sing
 *   does).
 * - Between lines, the interlude visualizer takes the stage with a count-in.
 * - The previous line and the next one stay in view, small, so you can sing
 *   along.
 *
 * Everything that moves each frame is written straight to the DOM (classes and
 * two CSS variables); React only re-renders when the line changes.
 */

type KWord = { text: string; start: number; end: number; emphasis: boolean }
type KLine = { words: KWord[]; start: number; end: number; duet: boolean; text: string }

function joinWords(line: LyricLine): Array<{ text: string; start: number; end: number }> {
  const words: Array<{ text: string; start: number; end: number }> = []
  let joining = false
  for (const piece of line.words) {
    if (!piece.word.trim()) { joining = false; continue }
    const text = piece.word.trim()
    if (!joining || /^\s/.test(piece.word) || !words.length) words.push({ text, start: piece.startTime, end: piece.endTime })
    else { const last = words[words.length - 1]; last.text += text; last.end = piece.endTime }
    joining = !/\s$/.test(piece.word)
  }
  return words
}

function toKinetic(line: LyricLine): KLine {
  const words = joinWords(line)
  const durations = words.map(word => Math.max(0, word.end - word.start)).sort((a, b) => a - b)
  const median = durations[Math.floor(durations.length / 2)] ?? 0
  // Held notes: long in absolute terms and against the rest of the line.
  const threshold = Math.max(850, median * 2.2)
  return {
    words: words.map(word => ({ ...word, emphasis: words.length > 1 && word.end - word.start >= threshold })),
    start: line.startTime, end: line.endTime, duet: Boolean(line.isDuet), text: words.map(word => word.text).join(' '),
  }
}

type Props = {
  lines: LyricLine[]
  audioRef: RefObject<HTMLAudioElement>
  playing: boolean
  offsetMs: number
  reducedMotion: boolean
  beats: BeatClock
  beatPulse: boolean
  title: string
  artist: string
  onSeek: (ms: number) => void
}

export const KineticLyrics = memo(function KineticLyrics({ lines, audioRef, playing, offsetMs, reducedMotion, beats, beatPulse, title, artist, onSeek }: Props) {
  const main = useMemo(() => lines.filter(line => !line.isBG).map(toKinetic).filter(line => line.words.length), [lines])
  const backing = useMemo(() => lines.filter(line => line.isBG).map(line => ({ start: line.startTime, end: line.endTime, text: joinWords(line).map(word => word.text).join(' ') })), [lines])
  const [index, setIndex] = useState(-1)
  const root = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLParagraphElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const beatsRow = useRef<HTMLSpanElement>(null)
  const bpmLabel = useRef<HTMLSpanElement>(null)
  const visualizer = useMemo(() => new InterludeVisualizer('kinetic-viz', 520, 150), [])
  const [box, setBox] = useState({ width: 0, height: 0 })
  const current = main[index]

  useEffect(() => {
    const host = stage.current
    if (!host) return
    host.appendChild(visualizer.canvas)
    const observer = new ResizeObserver(() => setBox({ width: host.clientWidth, height: host.clientHeight }))
    observer.observe(host)
    return () => { observer.disconnect(); visualizer.canvas.remove() }
  }, [visualizer])

  // The line fills its stage: the largest size that fits, like a poster.
  useLayoutEffect(() => {
    const line = lineRef.current
    if (!line || !box.width) return
    let low = 28, high = 118
    while (high - low > 1) {
      const middle = (low + high) >> 1
      line.style.fontSize = `${middle}px`
      if (line.scrollHeight <= box.height * 0.8 && line.scrollWidth <= line.clientWidth + 1) low = middle
      else high = middle
    }
    line.style.fontSize = `${low}px`
  }, [index, box])

  useEffect(() => {
    const audio = audioRef.current
    let frame = 0
    let last = performance.now()
    let shownIndex = -2
    let lastBar = -1
    let lastBpm = ''
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop)
      const delta = now - last
      last = now
      if (document.hidden) return
      const time = (audio?.currentTime ?? 0) * 1000 + offsetMs
      let found = -1
      for (let i = 0; i < main.length && main[i].start <= time; i++) found = i
      if (found !== shownIndex) { shownIndex = found; setIndex(found) }
      const line = main[found]
      const next = main[found + 1]
      const inGap = !line ? true : time > line.end + 300 && (!next || next.start - time > 1500)
      const host = root.current
      if (!host) return
      host.classList.toggle('gap', inGap)

      // Words: up as they are sung; held notes fill their rule.
      const spans = lineRef.current?.querySelectorAll<HTMLElement>('.kw')
      if (line && spans) {
        spans.forEach((span, i) => {
          const word = line.words[i]
          if (!word) return
          const on = time >= word.start
          if (span.classList.contains('on') !== on) span.classList.toggle('on', on)
          if (word.emphasis) span.style.setProperty('--p', Math.max(0, Math.min(1, (time - word.start) / Math.max(1, word.end - word.start))).toFixed(3))
        })
      }

      const sample = beats.sample()
      host.style.setProperty('--kick', beatPulse && !reducedMotion ? sample.pulse.toFixed(3) : '0')
      if (sample.barBeat !== lastBar && beatsRow.current) {
        lastBar = sample.barBeat
        beatsRow.current.querySelectorAll('i').forEach((cell, i) => cell.classList.toggle('on', i === sample.barBeat))
      }
      const bpm = sample.bpm ? `${Math.round(sample.bpm)} BPM` : 'Listening…'
      if (bpm !== lastBpm && bpmLabel.current) { lastBpm = bpm; bpmLabel.current.textContent = bpm }
      if (inGap) visualizer.draw(sample, { nextLineIn: next ? (next.start - time) / 1000 / (audio?.playbackRate || 1) : null }, delta, reducedMotion)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [audioRef, beatPulse, beats, main, offsetMs, reducedMotion, visualizer])

  const previous = main[index - 1]
  const upcoming = main[index + 1]
  const bg = current ? backing.find(line => line.start < current.end + 400 && line.end > current.start - 200) : undefined

  return <div className={`kinetic ${reducedMotion ? 'still' : ''} ${playing ? '' : 'paused'}`} ref={root} aria-label="Lyrics">
    <header className="kinetic-head">
      <strong>{title}</strong><span>{artist}</span>
      <span className="kinetic-tempo"><span ref={bpmLabel}>Listening…</span><span className="kinetic-beats" ref={beatsRow} aria-hidden="true"><i /><i /><i /><i /></span></span>
    </header>
    <p className="kinetic-prev" onClick={() => { if (previous) onSeek(Math.max(0, previous.start - offsetMs)) }}>{previous?.text ?? ''}</p>
    <div className="kinetic-stage" ref={stage}>
      <p ref={lineRef} key={index} className={`kinetic-line ${current?.duet ? 'duet' : ''}`}>
        {current?.words.map((word, i) => <span key={i}><span className={`kw ${word.emphasis ? 'em' : ''}`} style={word.emphasis ? { '--p': 0 } as CSSProperties : undefined}>{word.text}{word.emphasis && <i className="kbar" />}</span>{i < current.words.length - 1 ? ' ' : ''}</span>)}
        {bg && <span className="kinetic-bg">({bg.text})</span>}
      </p>
    </div>
    <p className="kinetic-next" onClick={() => { if (upcoming) onSeek(Math.max(0, upcoming.start - offsetMs)) }}>{upcoming?.text ?? ''}</p>
  </div>
})
