import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { LyricLine } from '@applemusic-like-lyrics/lyric'

/**
 * brat mode: the lyric-video trend, as a lyric view.
 *
 * Each word appears the moment it is sung, flying in from alternate edges —
 * left, right, left — and snapping into place, the "slide in word by word"
 * edit people make in CapCut. Unlike those edits the words land in a lyric
 * column at the side rather than centre screen, and the line before stays
 * above, dimmed, so it still reads as lyrics.
 *
 * The type follows the Brat Generator: Arial Narrow, lowercase, justified,
 * blurred a little, and sized so each line fills its box. Arial Narrow comes
 * with Office rather than Windows; without it, Arial is squashed to the same
 * width.
 *
 * Syllable-timed files arrive as one piece per syllable; pieces are joined
 * back into words, since a word flying in half at a time reads as a glitch.
 */

type BratWord = { text: string; start: number }
type BratLine = { words: BratWord[]; start: number; end: number }

function toBratLines(lines: LyricLine[]): BratLine[] {
  return lines.filter(line => !line.isBG).map(line => {
    const words: BratWord[] = []
    let joining = false
    for (const piece of line.words) {
      if (!piece.word.trim()) { joining = false; continue }
      const text = piece.word.trim().toLocaleLowerCase()
      if (!joining || /^\s/.test(piece.word) || !words.length) words.push({ text, start: piece.startTime })
      else words[words.length - 1].text += text
      joining = !/\s$/.test(piece.word)
    }
    return { words, start: line.startTime, end: line.endTime }
  }).filter(line => line.words.length > 0)
}

/** Whether a font is really installed: text set in it measures differently from the fallback. */
function hasFont(family: string) {
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return false
  const sample = 'the moment brat 0123'
  return ['monospace', 'serif'].some(fallback => {
    context.font = `72px ${fallback}`
    const plain = context.measureText(sample).width
    context.font = `72px "${family}", ${fallback}`
    return context.measureText(sample).width !== plain
  })
}

/** How much to squash Arial when no narrow face is installed. */
const SQUASH = 0.82
/** Words further back than this stop animating, so a seek into a line does not replay it. */
const ANIMATED_WORDS = 3

type Props = {
  lines: LyricLine[]
  audioRef: RefObject<HTMLAudioElement>
  playing: boolean
  offsetMs: number
  reducedMotion: boolean
  title: string
  onSeek: (ms: number) => void
}

export const BratLyrics = memo(function BratLyrics({ lines, audioRef, playing, offsetMs, reducedMotion, title, onSeek }: Props) {
  const bratLines = useMemo(() => toBratLines(lines), [lines])
  const [position, setPosition] = useState({ index: -1, shown: 0, resting: false })
  const narrow = useMemo(() => hasFont('Arial Narrow') || hasFont('Liberation Sans Narrow'), [])
  const box = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLParagraphElement>(null)
  const [boxSize, setBoxSize] = useState({ width: 0, height: 0 })

  // Where the song is: which line, how many of its words are out, and
  // whether we are in a long instrumental gap after it.
  useEffect(() => {
    const audio = audioRef.current
    let frame = 0
    const tick = () => {
      const now = (audio?.currentTime ?? 0) * 1000 + offsetMs
      let index = -1
      for (let i = 0; i < bratLines.length && bratLines[i].start <= now; i++) index = i
      const line = bratLines[index]
      const shown = line ? line.words.filter(word => word.start <= now).length : 0
      const next = bratLines[index + 1]?.start ?? Infinity
      const resting = Boolean(line && now > line.end + 1500 && next - now > 2000)
      setPosition(current => current.index === index && current.shown === shown && current.resting === resting ? current : { index, shown, resting })
    }
    const loop = () => { tick(); frame = requestAnimationFrame(loop) }
    if (playing) loop()
    else tick()
    audio?.addEventListener('seeked', tick)
    audio?.addEventListener('timeupdate', tick)
    return () => {
      cancelAnimationFrame(frame)
      audio?.removeEventListener('seeked', tick)
      audio?.removeEventListener('timeupdate', tick)
    }
  }, [audioRef, bratLines, offsetMs, playing])

  useEffect(() => {
    const element = box.current
    if (!element) return
    const observer = new ResizeObserver(() => setBoxSize({ width: element.clientWidth, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Fit the line to its box, like the generator: the largest size at which it
  // still fits. Unsung words are laid out (just invisible), so the size is
  // settled before the first word flies in and nothing reflows mid-line.
  const current = bratLines[position.index]
  useLayoutEffect(() => {
    const paragraph = lineRef.current
    if (!paragraph || !boxSize.width) return
    const maxHeight = boxSize.height * 0.62
    // Measured with every word at rest: a word still flying in sits up to 70vw
    // off to one side, which counts as overflow, so every size "failed" and the
    // line was stuck at the minimum after a seek or whenever the first word was
    // already in flight.
    paragraph.classList.add('measuring')
    let low = 22, high = 150
    while (high - low > 1) {
      const middle = (low + high) >> 1
      paragraph.style.fontSize = `${middle}px`
      if (paragraph.scrollHeight <= maxHeight && paragraph.scrollWidth <= paragraph.clientWidth + 1) low = middle
      else high = middle
    }
    paragraph.style.fontSize = `${low}px`
    paragraph.classList.remove('measuring')
  }, [position.index, boxSize, narrow, bratLines])

  const previous = bratLines[position.index - 1]
  const squash: CSSProperties = narrow ? {} : { width: `${100 / SQUASH}%`, transform: `scaleX(${SQUASH})`, transformOrigin: 'left top' }
  const words = current?.words ?? title.toLocaleLowerCase().split(/\s+/).filter(Boolean).map(text => ({ text, start: 0 }))
  const shown = current ? position.shown : words.length

  return <div className={`brat-lyrics ${narrow ? 'has-narrow' : ''} ${reducedMotion ? 'still' : ''}`} ref={box} aria-label="Lyrics">
    <p className="brat-previous" style={squash} onClick={() => { if (previous) onSeek(Math.max(0, previous.start - offsetMs)) }}>
      {previous?.words.map(word => word.text).join(' ') ?? ''}
    </p>
    <p ref={lineRef} key={position.index} className={`brat-line ${position.resting ? 'resting' : ''} ${current ? '' : 'brat-title'}`} style={squash}>
      {words.map((word, index) => {
        const out = index < shown
        const settled = out && index < shown - ANIMATED_WORDS
        return <span key={index}>
          <span className={`brat-word ${out ? 'out' : ''} ${settled ? 'settled' : ''}`} style={{ '--from': index % 2 === 0 ? -1 : 1 } as CSSProperties}>{word.text}</span>{index < words.length - 1 ? ' ' : ''}
        </span>
      })}
    </p>
  </div>
})
