import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MaterialIcon } from './common/MaterialIcon'
import { displayArtist } from '../lib/format'

/**
 * A two-deck mixer.
 *
 * Deliberately separate from the main player: it owns its own AudioContext and
 * two independent `<audio>` elements, so mixing never disturbs what the player
 * is doing (or inherits its EQ, karaoke path and genre chain). Each deck has
 * its own speed and trim; the crossfader rides between them with an
 * equal-power curve, which keeps perceived loudness steady through the middle
 * instead of dipping the way a straight linear blend does.
 *
 * This is a mixer, not a beatmatcher: there is no tempo detection, so matching
 * is done by ear with the speed controls, which is also how it is done on a
 * pair of real decks.
 */

type DeckId = 'a' | 'b'

interface Deck {
  track: LibraryTrack | null
  playing: boolean
  rate: number
  trim: number
  position: number
  duration: number
}

const BLANK: Deck = { track: null, playing: false, rate: 1, trim: 1, position: 0, duration: 0 }

function time(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

export function DjPanel({ library }: { library: LibraryTrack[] }) {
  const [decks, setDecks] = useState<Record<DeckId, Deck>>({ a: { ...BLANK }, b: { ...BLANK } })
  const [crossfade, setCrossfade] = useState(0.5)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState<DeckId | null>(null)

  const audioA = useRef<HTMLAudioElement | null>(null)
  const audioB = useRef<HTMLAudioElement | null>(null)
  const context = useRef<AudioContext | null>(null)
  const gains = useRef<Record<DeckId, GainNode | null>>({ a: null, b: null })

  const elementFor = useCallback((deck: DeckId) => (deck === 'a' ? audioA.current : audioB.current), [])

  // Build the graph once, on first use, so opening the panel costs nothing.
  const ensureGraph = useCallback(() => {
    if (context.current) return context.current
    const ctx = new AudioContext()
    context.current = ctx
    for (const deck of ['a', 'b'] as DeckId[]) {
      const element = elementFor(deck)
      if (!element) continue
      const source = ctx.createMediaElementSource(element)
      const gain = ctx.createGain()
      source.connect(gain).connect(ctx.destination)
      gains.current[deck] = gain
    }
    return ctx
  }, [elementFor])

  // Equal-power crossfade: the two gains sum to roughly constant loudness.
  useEffect(() => {
    const a = Math.cos((crossfade * Math.PI) / 2)
    const b = Math.cos(((1 - crossfade) * Math.PI) / 2)
    if (gains.current.a) gains.current.a.gain.value = a * decks.a.trim
    if (gains.current.b) gains.current.b.gain.value = b * decks.b.trim
  }, [crossfade, decks.a.trim, decks.b.trim])

  useEffect(() => () => { void context.current?.close() }, [])

  const patch = (deck: DeckId, changes: Partial<Deck>) => setDecks(current => ({ ...current, [deck]: { ...current[deck], ...changes } }))

  const load = async (deck: DeckId, track: LibraryTrack) => {
    setLoading(deck)
    try {
      const url = await window.electronAPI.getMediaUrl(track.audioPath)
      const element = elementFor(deck)
      if (!element) return
      element.src = url
      element.load()
      patch(deck, { track, playing: false, position: 0, duration: track.duration ?? 0 })
      ensureGraph()
    } finally {
      setLoading(null)
    }
  }

  const toggle = async (deck: DeckId) => {
    const element = elementFor(deck)
    if (!element || !decks[deck].track) return
    const ctx = ensureGraph()
    if (ctx.state === 'suspended') await ctx.resume()
    if (element.paused) { await element.play().catch(() => undefined); patch(deck, { playing: true }) }
    else { element.pause(); patch(deck, { playing: false }) }
  }

  const setRate = (deck: DeckId, rate: number) => {
    const element = elementFor(deck)
    if (element) { element.playbackRate = rate; element.preservesPitch = false }
    patch(deck, { rate })
  }

  const cue = (deck: DeckId) => {
    const element = elementFor(deck)
    if (!element) return
    element.currentTime = 0
    patch(deck, { position: 0 })
  }

  const results = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    if (!needle) return library.slice(0, 8)
    return library.filter(track => `${track.title} ${track.artist ?? ''}`.toLocaleLowerCase().includes(needle)).slice(0, 8)
  }, [library, search])

  const renderDeck = (id: DeckId) => {
    const deck = decks[id]
    const progress = deck.duration ? (deck.position / deck.duration) * 100 : 0
    return (
      <div className={`dj-deck dj-deck-${id}`}>
        <div className="dj-deck-head">
          <span className="kicker">DECK {id.toUpperCase()}</span>
          <strong>{deck.track?.title ?? 'Nothing loaded'}</strong>
          <small>{deck.track ? displayArtist(deck.track) : 'Pick a track below'}</small>
        </div>
        <div className="dj-transport">
          <button onClick={() => cue(id)} disabled={!deck.track} title="Back to start"><MaterialIcon name="previous" size={20} /></button>
          <button className="dj-play" onClick={() => void toggle(id)} disabled={!deck.track || loading === id}>
            <MaterialIcon name={deck.playing ? 'pause' : 'play'} size={26} />
          </button>
          <span className="dj-time">{time(deck.position)} / {time(deck.duration)}</span>
        </div>
        <div className="dj-meter"><i style={{ width: `${progress}%` }} /></div>
        <label className="dj-control">
          <span>Speed <b>{deck.rate.toFixed(2)}×</b></span>
          <input type="range" min={0.5} max={1.5} step={0.01} value={deck.rate} onChange={event => setRate(id, Number(event.target.value))} style={{ '--progress': `${((deck.rate - 0.5) / 1) * 100}%` } as React.CSSProperties} />
        </label>
        <label className="dj-control">
          <span>Trim <b>{Math.round(deck.trim * 100)}%</b></span>
          <input type="range" min={0} max={1} step={0.01} value={deck.trim} onChange={event => patch(id, { trim: Number(event.target.value) })} style={{ '--progress': `${deck.trim * 100}%` } as React.CSSProperties} />
        </label>
      </div>
    )
  }

  return (
    <section className="dj-panel">
      <audio ref={audioA} onTimeUpdate={event => patch('a', { position: event.currentTarget.currentTime })} onLoadedMetadata={event => patch('a', { duration: event.currentTarget.duration })} onEnded={() => patch('a', { playing: false })} />
      <audio ref={audioB} onTimeUpdate={event => patch('b', { position: event.currentTarget.currentTime })} onLoadedMetadata={event => patch('b', { duration: event.currentTarget.duration })} onEnded={() => patch('b', { playing: false })} />

      <div className="dj-decks">
        {renderDeck('a')}
        <div className="dj-mixer">
          <span className="kicker">CROSSFADE</span>
          <input
            className="dj-crossfader"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={crossfade}
            onChange={event => setCrossfade(Number(event.target.value))}
            aria-label="Crossfade between deck A and deck B"
            style={{ '--progress': `${crossfade * 100}%` } as React.CSSProperties}
          />
          <div className="dj-mixer-ends"><span>A</span><button onClick={() => setCrossfade(0.5)}>Centre</button><span>B</span></div>
        </div>
        {renderDeck('b')}
      </div>

      <div className="dj-browser">
        <label className="search-field"><MaterialIcon name="search" size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a track to load" /></label>
        <div className="dj-results">
          {results.map(track => (
            <div className="dj-result" key={track.id}>
              <span><strong>{track.title}</strong><small>{displayArtist(track)}</small></span>
              <div>
                <button onClick={() => void load('a', track)}>→ A</button>
                <button onClick={() => void load('b', track)}>→ B</button>
              </div>
            </div>
          ))}
          {!results.length && <p className="recap-none">Nothing matches that.</p>}
        </div>
      </div>
      <p className="dj-note">Speed changes pitch here, the way a turntable does. Match two tracks by ear, then ride the crossfader.</p>
    </section>
  )
}
