import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { MaterialIcon } from '../components/common/MaterialIcon'
import { Knob } from '../components/dj/Knob'
import { FluidBackground, DEFAULT_FLUID } from '../components/player/FluidBackground'
import { EFFECTS, TEMPO_RANGES, getDjEngine, type DeckId, type DeckTrack, type EffectKind } from '../lib/dj/engine'
import type { TrackAnalysis } from '../lib/dj/analysis'
import { clearMappings, enableMidi, isLearning, learn, midiStatus, onMidiChange, registerMidiControl } from '../lib/dj/midi'
import { SAMPLER_PADS } from '../lib/dj/sampler'
import { displayArtist } from '../lib/format'

/**
 * DJ: two decks, a mixer, a sampler and automix — in the spirit of you.dj,
 * built on the app's own library.
 *
 * Everything that moves every frame (waveforms, playheads, meters, clocks) is
 * drawn by one animation loop straight from the engine, never through React
 * state, and that loop stops the moment this screen is closed. The engine
 * itself keeps playing across screens.
 */

const engine = getDjEngine()
// Opt-in handle for the automated checks (scripts/dj-check.mjs); off unless the flag is set.
try { if (localStorage.getItem('lyrigen-debug') === '1') (window as unknown as { lyrigenDj: typeof engine }).lyrigenDj = engine } catch { /* storage blocked */ }
const HOTCUE_COLORS = ['#ff5f7e', '#ffb454', '#5fd4ff', '#9dff7a']
const WINDOW_SECONDS = 6

function clock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

const toDeckTrack = (track: LibraryTrack): DeckTrack => ({ audioPath: track.audioPath, title: track.title, artist: displayArtist(track), coverPath: track.coverPath, duration: track.duration })

// ---- waveform drawing -------------------------------------------------------

const overviewCache = new WeakMap<TrackAnalysis, HTMLCanvasElement>()
const SHADES = ['#f3d7ff', '#d7a9f7', '#a978e8', '#7048c9']
const SHADES_B = ['#d8f6ff', '#9fdcf5', '#5aaee0', '#2f73c2']

function overviewImage(analysis: TrackAnalysis, width: number, height: number, deck: DeckId) {
  const cached = overviewCache.get(analysis)
  if (cached && cached.width === width && cached.height === height) return cached
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d')!
  const perPixel = analysis.peaks.length / width
  const shades = deck === 'a' ? SHADES : SHADES_B
  for (let x = 0; x < width; x++) {
    let peak = 0, low = 0
    const from = Math.floor(x * perPixel), to = Math.max(from + 1, Math.floor((x + 1) * perPixel))
    for (let f = from; f < to && f < analysis.peaks.length; f++) { if (analysis.peaks[f] > peak) peak = analysis.peaks[f]; low += analysis.lows[f] }
    low /= (to - from)
    context.fillStyle = shades[Math.min(3, Math.floor(low * 4))]
    const h = Math.max(1, peak * height)
    context.fillRect(x, (height - h) / 2, 1, h)
  }
  overviewCache.set(analysis, canvas)
  return canvas
}

function drawZoom(canvas: HTMLCanvasElement, id: DeckId) {
  const deck = engine.decks[id]
  const context = canvas.getContext('2d')
  if (!context) return
  const width = canvas.width, height = canvas.height
  context.clearRect(0, 0, width, height)
  const analysis = deck.state.analysis
  const position = deck.position
  const secondsPerPixel = WINDOW_SECONDS / width
  const start = position - (width / 2) * secondsPerPixel
  if (analysis) {
    const shades = id === 'a' ? SHADES : SHADES_B
    const loop = deck.state.loop
    if (loop) {
      const x1 = (loop.start - start) / secondsPerPixel, x2 = Number.isFinite(loop.end) ? (loop.end - start) / secondsPerPixel : width
      context.fillStyle = 'rgba(157, 255, 122, .16)'
      context.fillRect(x1, 0, x2 - x1, height)
    }
    for (let x = 0; x < width; x++) {
      const frame = Math.floor((start + x * secondsPerPixel) * analysis.frameRate)
      if (frame < 0 || frame >= analysis.peaks.length) continue
      const next = Math.max(frame + 1, Math.floor((start + (x + 1) * secondsPerPixel) * analysis.frameRate))
      let peak = 0
      for (let f = frame; f < next && f < analysis.peaks.length; f++) if (analysis.peaks[f] > peak) peak = analysis.peaks[f]
      context.fillStyle = shades[Math.min(3, Math.floor(analysis.lows[frame] * 4))]
      const h = Math.max(1, peak * (height - 6))
      context.fillRect(x, (height - h) / 2, 1, h)
    }
    if (analysis.bpm) {
      const beat = 60 / analysis.bpm
      let index = Math.ceil((start - analysis.firstBeat) / beat)
      for (let t = analysis.firstBeat + index * beat; t < start + width * secondsPerPixel; t += beat, index++) {
        const x = (t - start) / secondsPerPixel
        context.fillStyle = index % 4 === 0 ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.18)'
        context.fillRect(Math.round(x), 0, 1, index % 4 === 0 ? height : 8)
        if (index % 4 !== 0) context.fillRect(Math.round(x), height - 8, 1, 8)
      }
    }
    deck.state.hotcues.forEach((cue, i) => {
      if (cue == null) return
      const x = (cue - start) / secondsPerPixel
      if (x < -4 || x > width + 4) return
      context.fillStyle = HOTCUE_COLORS[i]
      context.fillRect(Math.round(x), 0, 2, height)
      context.fillRect(Math.round(x), 0, 9, 9)
    })
  } else if (deck.state.track) {
    context.fillStyle = 'rgba(255,255,255,.35)'
    context.font = '11px sans-serif'
    context.textAlign = 'center'
    context.fillText(deck.state.loading ? 'Finding the beat…' : 'No waveform for this file', width / 2, height / 2 + 4)
  }
  context.fillStyle = '#fff'
  context.fillRect(width / 2 - 1, 0, 2, height)
}

function drawOverview(canvas: HTMLCanvasElement, id: DeckId) {
  const deck = engine.decks[id]
  const context = canvas.getContext('2d')
  if (!context) return
  const width = canvas.width, height = canvas.height
  context.clearRect(0, 0, width, height)
  const analysis = deck.state.analysis
  const duration = deck.duration
  if (analysis) context.drawImage(overviewImage(analysis, width, height, id), 0, 0)
  if (!duration) return
  const x = (deck.position / duration) * width
  context.fillStyle = 'rgba(0,0,0,.45)'
  context.fillRect(0, 0, x, height)
  deck.state.hotcues.forEach((cue, i) => { if (cue != null) { context.fillStyle = HOTCUE_COLORS[i]; context.fillRect((cue / duration) * width, 0, 2, height) } })
  context.fillStyle = '#fff'
  context.fillRect(x - 1, 0, 2, height)
}

// ---- small pieces -----------------------------------------------------------

function useEngine() {
  useSyncExternalStore(engine.subscribe, engine.getVersion)
}

function useMidiButton(id: string, press: () => void) {
  const latest = useRef(press)
  latest.current = press
  useEffect(() => id ? registerMidiControl(id, { press: () => latest.current() }) : undefined, [id])
}

/** A button that MIDI learn can bind. */
function Pad({ midi, onPress, className = '', children, title, disabled, style, onContext }: { midi?: string; onPress: () => void; className?: string; children: ReactNode; title?: string; disabled?: boolean; style?: CSSProperties; onContext?: () => void }) {
  useMidiButton(midi ?? '', midi ? onPress : () => undefined)
  return <button className={`dj-pad ${className}`} title={title} disabled={disabled} style={style} data-midi={midi}
    onClick={() => { if (midi && isLearning()) { learn(midi); return } onPress() }}
    onContextMenu={event => { if (onContext) { event.preventDefault(); onContext() } }}>{children}</button>
}

function Fader({ value, onChange, midi, label, vertical = false }: { value: number; onChange: (value: number) => void; midi: string; label: string; vertical?: boolean }) {
  const latest = useRef(onChange)
  latest.current = onChange
  useEffect(() => registerMidiControl(midi, { set: v => latest.current(v) }), [midi])
  return <input className={`dj-fader ${vertical ? 'vertical' : ''}`} type="range" min={0} max={1} step={0.001} value={value} aria-label={label} data-midi={midi}
    onPointerDown={event => { if (isLearning()) { learn(midi); event.preventDefault() } }}
    onChange={event => onChange(Number(event.target.value))} onDoubleClick={() => onChange(midi === 'crossfader' ? 0.5 : 0.9)}
    style={{ '--fill': `${value * 100}%` } as CSSProperties} />
}

// ---- a deck -----------------------------------------------------------------

const Deck = memo(function Deck({ id, registerCanvas }: { id: DeckId; registerCanvas: (key: string, node: HTMLElement | null) => void }) {
  useEngine()
  const deck = engine.decks[id]
  const s = deck.state
  const other = engine.other(id)
  const drag = useRef<number | null>(null)
  const bendTimer = useRef(0)
  const bend = (direction: number) => { window.clearInterval(bendTimer.current); if (direction) bendTimer.current = window.setInterval(() => deck.jog(direction * 0.03), 90) }
  useEffect(() => () => window.clearInterval(bendTimer.current), [])

  const onJog = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drag.current == null) return
    const dx = event.clientX - drag.current
    drag.current = event.clientX
    deck.jog(-dx * WINDOW_SECONDS / event.currentTarget.clientWidth)
  }

  const tempoLatest = useRef((v: number) => deck.setPitch((v * 2 - 1) * s.range))
  tempoLatest.current = (v: number) => deck.setPitch((v * 2 - 1) * s.range)
  useEffect(() => registerMidiControl(`tempo-${id}`, { set: v => tempoLatest.current(v) }), [id])

  return <section className={`dj-deck deck-${id} ${s.playing ? 'playing' : ''}`}>
    <header className="dj-deck-head">
      <span className="dj-deck-letter">{id.toUpperCase()}</span>
      <div className="dj-deck-title">
        <strong>{s.track?.title ?? 'Empty deck'}</strong>
        <small>{s.track ? s.track.artist ?? 'Unknown artist' : 'Load a song from the list below'}{s.error ? ` · ${s.error}` : ''}</small>
      </div>
      <div className="dj-deck-bpm">
        <strong>{deck.liveBpm ? deck.liveBpm.toFixed(1) : s.loading ? '…' : '—'}</strong>
        <small>BPM{s.pitch ? ` · ${s.pitch > 0 ? '+' : ''}${(s.pitch * 100).toFixed(1)}%` : ''}{engine.master === id && other.state.synced ? ' · master' : ''}</small>
      </div>
      <div className="dj-deck-time"><strong ref={node => registerCanvas(`time-${id}`, node)}>0:00</strong><small ref={node => registerCanvas(`remain-${id}`, node)}>-0:00</small></div>
    </header>

    <canvas className="dj-zoom" ref={node => registerCanvas(`zoom-${id}`, node)} height={86}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = event.clientX }}
      onPointerMove={onJog} onPointerUp={() => { drag.current = null }} title="Drag to nudge (playing) or scrub (stopped)" />
    <canvas className="dj-overview" ref={node => registerCanvas(`overview-${id}`, node)} height={30}
      onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); deck.seek((event.clientX - rect.left) / rect.width * deck.duration) }} title="Click to jump" />

    <div className="dj-transport">
      <Pad midi={`cue-${id}`} className="cue" onPress={() => deck.cueButton()} disabled={!s.track} title="Cue: stopped — set the cue here; playing — back to it">CUE</Pad>
      <Pad midi={`play-${id}`} className={`play ${s.playing ? 'on' : ''}`} onPress={() => void deck.toggle()} disabled={!s.track}><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-label={s.playing ? 'Pause' : 'Play'}><path d={s.playing ? 'M6.5 5h4v14h-4zM13.5 5h4v14h-4z' : 'M8 5.2v13.6L19 12z'} /></svg></Pad>
      <Pad midi={`sync-${id}`} className={`sync ${s.synced ? 'on' : ''}`} onPress={() => engine.sync(id)} disabled={!deck.bpm || !other.bpm} title="Match the other deck's tempo and line up the beats">SYNC</Pad>
      <Pad className={`small ${s.keylock ? 'on' : ''}`} onPress={() => deck.setKeylock(!s.keylock)} title="Keylock: change tempo without changing key">KEY</Pad>
      <div className="dj-bend">
        <button onPointerDown={() => bend(-1)} onPointerUp={() => bend(0)} onPointerLeave={() => bend(0)} title="Nudge back">‹</button>
        <button onPointerDown={() => bend(1)} onPointerUp={() => bend(0)} onPointerLeave={() => bend(0)} title="Nudge ahead">›</button>
      </div>
    </div>

    <div className="dj-tempo">
      <button className="dj-range" onClick={() => deck.patch({ range: TEMPO_RANGES[(TEMPO_RANGES.indexOf(s.range) + 1) % TEMPO_RANGES.length] })} title="Tempo range">±{Math.round(s.range * 100)}%</button>
      <input type="range" min={-1} max={1} step={0.001} value={s.pitch / s.range} aria-label={`Deck ${id} tempo`} data-midi={`tempo-${id}`}
        onPointerDown={event => { if (isLearning()) { learn(`tempo-${id}`); event.preventDefault() } }}
        onChange={event => deck.setPitch(Number(event.target.value) * s.range)} onDoubleClick={() => deck.setPitch(0)} />
      <button className="dj-range" onClick={() => deck.setPitch(0)} title="Back to the original tempo">0</button>
    </div>

    <div className="dj-grid">
      <div className="dj-hotcues">
        {s.hotcues.map((cue, i) => <Pad key={i} midi={`hotcue-${id}-${i}`} className={cue != null ? 'set' : ''} style={{ '--cue': HOTCUE_COLORS[i] } as CSSProperties} disabled={!s.track}
          onPress={() => deck.hotcue(i)} onContext={() => deck.hotcue(i, true)} title={cue != null ? `Hot cue ${i + 1} at ${clock(cue)} — right-click to clear` : `Set hot cue ${i + 1}`}>{i + 1}</Pad>)}
      </div>
      <div className="dj-loops">
        {[0.5, 1, 2, 4, 8, 16].map(beats => <Pad key={beats} midi={`loop-${id}-${beats}`} className={s.loop?.beats === beats ? 'on' : ''} disabled={!s.track} onPress={() => deck.autoLoop(beats)} title={`Loop ${beats} beat${beats === 1 ? '' : 's'}`}>{beats === 0.5 ? '½' : beats}</Pad>)}
        <Pad className="small" onPress={() => deck.loopIn()} disabled={!s.track}>IN</Pad>
        <Pad className="small" onPress={() => deck.loopOut()} disabled={!s.loop}>OUT</Pad>
        <Pad className="small" onPress={() => deck.exitLoop()} disabled={!s.loop}>EXIT</Pad>
      </div>
      <div className="dj-fx">
        <select value={s.effect} onChange={event => deck.patch({ effect: event.target.value as EffectKind })} aria-label={`Deck ${id} effect`}>{EFFECTS.map(effect => <option key={effect.id} value={effect.id}>{effect.label}</option>)}</select>
        <Knob label="FX" value={s.effectAmount} reset={0.5} onChange={value => deck.patch({ effectAmount: value })} midiId={`fx-${id}`} />
        <button className="dj-momentary" disabled={!s.playing} onPointerDown={() => deck.roll(true)} onPointerUp={() => deck.roll(false)} onPointerLeave={() => deck.roll(false)} title="Hold for a ¼-beat roll; playback carries on where it would have been">ROLL</button>
        <button className="dj-momentary" disabled={!s.playing} onClick={() => deck.brake()} title="Stop like a turntable losing power">BRAKE</button>
      </div>
    </div>
  </section>
})

// ---- the mixer --------------------------------------------------------------

const Channel = memo(function Channel({ id, registerCanvas }: { id: DeckId; registerCanvas: (key: string, node: HTMLElement | null) => void }) {
  useEngine()
  const deck = engine.decks[id]
  const s = deck.state
  return <div className={`dj-channel deck-${id}`}>
    <Knob label="Trim" value={s.trim} max={2} reset={1} onChange={value => deck.patch({ trim: value })} midiId={`trim-${id}`} />
    <Knob label="High" value={s.eq.high} reset={0.5} bipolar onChange={value => deck.patch({ eq: { ...s.eq, high: value } })} midiId={`high-${id}`} />
    <Knob label="Mid" value={s.eq.mid} reset={0.5} bipolar onChange={value => deck.patch({ eq: { ...s.eq, mid: value } })} midiId={`mid-${id}`} />
    <Knob label="Low" value={s.eq.low} reset={0.5} bipolar onChange={value => deck.patch({ eq: { ...s.eq, low: value } })} midiId={`low-${id}`} />
    <Knob label="Filter" value={s.filter} min={-1} max={1} reset={0} bipolar onChange={value => deck.patch({ filter: value })} midiId={`filter-${id}`} />
    <div className="dj-channel-fader">
      <span className="dj-meter"><i ref={node => registerCanvas(`meter-${id}`, node)} /></span>
      <Fader vertical value={s.volume} onChange={value => deck.patch({ volume: value })} midi={`volume-${id}`} label={`Deck ${id} volume`} />
    </div>
  </div>
})

function Mixer({ registerCanvas, onParty, flash }: { registerCanvas: (key: string, node: HTMLElement | null) => void; onParty: () => void; flash: (message: string) => void }) {
  useEngine()
  const [midi, setMidi] = useState(midiStatus)
  useEffect(() => onMidiChange(() => setMidi(midiStatus())), [])
  const record = async () => {
    if (!engine.recording) { engine.startRecording(); return }
    const result = await engine.stopRecording()
    if (result.saved) flash(`Mix saved: ${result.path}`)
    else if (result.message) flash(result.message)
  }
  const midiButton = async () => {
    if (!midi.connected) { const ok = await enableMidi(); if (!ok) flash('MIDI is not available.'); else flash('MIDI is on. Press "Learn", click a control, then move a knob on your controller.'); setMidi(midiStatus()); return }
    learn(midi.learning ? null : '')
  }
  return <section className="dj-mixer">
    <div className="dj-channels">
      <Channel id="a" registerCanvas={registerCanvas} />
      <div className="dj-master">
        <Knob label="Master" value={engine.masterVolume} reset={0.85} onChange={value => engine.setMasterVolume(value)} midiId="master" />
        <span className="dj-meter master"><i ref={node => registerCanvas('meter-master', node)} /></span>
        <button className={`dj-toggle ${engine.quantize ? 'on' : ''}`} onClick={() => { engine.quantize = !engine.quantize; engine.changed() }} title="Snap cues and loops to the beat">Quantize</button>
        <button className={`dj-toggle rec ${engine.recording ? 'on' : ''}`} onClick={() => void record()} title="Record the mix to a file">{engine.recording ? <span ref={node => registerCanvas('rec-time', node)}>● 0:00</span> : '● Rec'}</button>
        <button className={`dj-toggle ${midi.learning !== null ? 'on' : ''}`} onClick={() => void midiButton()} title={midi.connected ? `MIDI: ${midi.connected.join(', ') || 'no device yet'} · ${midi.mapped} mapped. Click to learn.` : 'Use a MIDI controller'}>{midi.connected ? (midi.learning !== null ? 'Learning…' : 'Learn') : 'MIDI'}</button>
        {midi.connected && midi.mapped > 0 && <button className="dj-link" onClick={clearMappings}>clear MIDI</button>}
        <button className="dj-toggle" onClick={onParty} title="Full-screen visuals for a party">Party</button>
      </div>
      <Channel id="b" registerCanvas={registerCanvas} />
    </div>
    <div className="dj-crossfader"><span>A</span><Fader value={engine.crossfader} onChange={value => engine.setCrossfader(value)} midi="crossfader" label="Crossfader" /><span>B</span></div>
    {midi.learning === '' && <p className="dj-hint">Click the control you want, then move a knob or press a pad on your controller.</p>}
    {midi.learning && <p className="dj-hint">Now move a knob or press a pad on your controller…</p>}
  </section>
}

// ---- library, automix, sampler -------------------------------------------------

function Browser({ library }: { library: LibraryTrack[] }) {
  useEngine()
  const [search, setSearch] = useState('')
  const results = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    const matches = needle ? library.filter(track => `${track.title} ${displayArtist(track)} ${track.album ?? ''}`.toLocaleLowerCase().includes(needle)) : library
    return matches.slice(0, 80)
  }, [library, search])
  return <section className="dj-browser">
    <label className="search-field"><MaterialIcon name="search" size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={`Search ${library.length} songs`} /></label>
    <div className="dj-results" role="list">
      {results.map(track => <div className="dj-result" role="listitem" key={track.id}>
        <span><strong>{track.title}</strong><small>{displayArtist(track)} · {clock(track.duration ?? 0)}</small></span>
        <button onClick={() => void engine.decks.a.load(toDeckTrack(track))} title="Load on deck A">A</button>
        <button onClick={() => void engine.decks.b.load(toDeckTrack(track))} title="Load on deck B">B</button>
        <button onClick={() => engine.queueTrack(toDeckTrack(track))} title="Add to the automix queue"><MaterialIcon name="plus" size={14} /></button>
      </div>)}
      {!results.length && <p className="dj-empty">Nothing matches that.</p>}
    </div>
  </section>
}

function Automix() {
  useEngine()
  const mix = engine.automix
  return <section className="dj-automix">
    <header>
      <strong>Automix</strong>
      <select value={mix.transitionBeats} onChange={event => { mix.transitionBeats = Number(event.target.value); engine.changed() }} aria-label="Transition length">{[8, 16, 32, 64].map(beats => <option key={beats} value={beats}>{beats}-beat blends</option>)}</select>
      <button className={`dj-toggle ${mix.enabled ? 'on' : ''}`} onClick={() => engine.setAutomix(!mix.enabled)} disabled={!mix.enabled && !mix.queue.length && !engine.decks.a.state.playing && !engine.decks.b.state.playing}>{mix.enabled ? 'On' : 'Off'}</button>
    </header>
    <p className="dj-hint">{mix.running ? 'Mixing into the next song…' : mix.enabled ? 'Beat-matched blends into each queued song as the last one ends.' : 'Queue songs with +, then switch it on.'}</p>
    <ol>{mix.queue.map((track, index) => <li key={`${track.audioPath}-${index}`}><span>{track.title}<small>{track.artist}</small></span><button onClick={() => engine.unqueue(index)} aria-label="Remove">×</button></li>)}</ol>
  </section>
}

function Sampler() {
  useEngine()
  return <section className="dj-sampler">
    <header><strong>Sampler</strong><Knob label="Level" value={engine.samplerVolume} reset={0.8} onChange={value => engine.setSamplerVolume(value)} midiId="sampler-volume" /></header>
    <div className="dj-sampler-pads">{SAMPLER_PADS.map((pad, i) => <Pad key={pad.id} midi={`sample-${i}`} onPress={() => engine.playPad(pad.id)}>{pad.label}</Pad>)}</div>
  </section>
}

// ---- party mode -------------------------------------------------------------

function Party({ onClose }: { onClose: () => void }) {
  useEngine()
  const loud = engine.crossfader < 0.5 ? engine.decks.a : engine.decks.b
  const lead = loud.state.track ? loud : engine.other(loud.id)
  const [cover, setCover] = useState('')
  useEffect(() => {
    let active = true
    const path = lead.state.track?.coverPath
    if (path) void window.electronAPI.getMediaUrl(path).then(url => { if (active) setCover(url) })
    else setCover('')
    return () => { active = false }
  }, [lead.state.track?.coverPath])
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const analyser = useMemo(() => ({ get current() { return engine.analyser } }), [])
  return <div className="dj-party" onDoubleClick={onClose}>
    {cover ? <FluidBackground coverUrl={cover} settings={{ ...DEFAULT_FLUID, opacity: 1, warp: 1.6, speed: 1.4, saturation: 1.8 }} playing={lead.state.playing} reducedMotion={false} analyser={analyser} /> : <div className="dj-party-plain" />}
    <div className="dj-party-text"><strong>{lead.state.track?.title ?? 'Lyrigen'}</strong><span>{lead.state.track?.artist ?? ''}{lead.liveBpm ? ` · ${lead.liveBpm.toFixed(0)} BPM` : ''}</span></div>
    <button className="dj-party-close" onClick={onClose}>Exit party mode</button>
  </div>
}

// ---- the screen -------------------------------------------------------------

export function DjView({ library, flash }: { library: LibraryTrack[]; flash: (message: string) => void }) {
  const nodes = useRef(new Map<string, HTMLElement>())
  const [party, setParty] = useState(false)
  const registerCanvas = useCallback((key: string, node: HTMLElement | null) => {
    if (node) nodes.current.set(key, node)
    else nodes.current.delete(key)
  }, [])

  // One loop draws everything that moves, only while this screen is open.
  useEffect(() => {
    let frame = 0
    const sizes = new WeakMap<HTMLCanvasElement, number>()
    const fit = (canvas: HTMLCanvasElement) => {
      const width = Math.round(canvas.clientWidth * Math.min(2, window.devicePixelRatio || 1))
      if (sizes.get(canvas) !== width) { canvas.width = width; canvas.height = Math.round(canvas.clientHeight * Math.min(2, window.devicePixelRatio || 1)); sizes.set(canvas, width) }
    }
    const draw = () => {
      frame = requestAnimationFrame(draw)
      if (document.hidden) return
      for (const id of ['a', 'b'] as DeckId[]) {
        const deck = engine.decks[id]
        const zoom = nodes.current.get(`zoom-${id}`) as HTMLCanvasElement | undefined
        const overview = nodes.current.get(`overview-${id}`) as HTMLCanvasElement | undefined
        if (zoom) { fit(zoom); drawZoom(zoom, id) }
        if (overview) { fit(overview); drawOverview(overview, id) }
        const time = nodes.current.get(`time-${id}`), remain = nodes.current.get(`remain-${id}`)
        if (time) time.textContent = clock(deck.position)
        if (remain) remain.textContent = `-${clock((deck.duration - deck.position) / deck.rate)}`
        const meter = nodes.current.get(`meter-${id}`)
        if (meter) meter.style.transform = `scaleY(${deck.level().toFixed(3)})`
      }
      const master = nodes.current.get('meter-master')
      if (master) master.style.transform = `scaleY(${engine.masterLevel().toFixed(3)})`
      const rec = nodes.current.get('rec-time')
      if (rec && engine.recording) rec.textContent = `● ${clock((Date.now() - engine.recording.started) / 1000)}`
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  // Space plays the louder deck; nothing else is bound, so typing in search is safe.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return
      if (event.code === 'Space') { event.preventDefault(); void engine.decks[engine.crossfader <= 0.5 ? 'a' : 'b'].toggle() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  return <div className="dj-view">
    <div className="dj-top">
      <Deck id="a" registerCanvas={registerCanvas} />
      <Mixer registerCanvas={registerCanvas} onParty={() => setParty(true)} flash={flash} />
      <Deck id="b" registerCanvas={registerCanvas} />
    </div>
    <div className="dj-bottom">
      <Browser library={library} />
      <Automix />
      <Sampler />
    </div>
    {party && <Party onClose={() => setParty(false)} />}
  </div>
}
