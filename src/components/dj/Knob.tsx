import { memo, useEffect, useRef, type PointerEvent } from 'react'
import { isLearning, learn, registerMidiControl } from '../../lib/dj/midi'

/**
 * A rotary knob: drag up or down, scroll, or use the arrow keys; double-click
 * puts it back. Bipolar knobs (EQ, filter) draw their arc from the centre.
 * With MIDI learn on, clicking it binds it to the next controller knob moved.
 */
export const Knob = memo(function Knob({ label, value, min = 0, max = 1, reset, onChange, midiId, bipolar = false, format }: {
  label: string
  value: number
  min?: number
  max?: number
  reset: number
  onChange: (value: number) => void
  midiId?: string
  bipolar?: boolean
  format?: (value: number) => string
}) {
  const latest = useRef(onChange)
  latest.current = onChange
  const drag = useRef<{ y: number; value: number } | null>(null)
  const clamp = (next: number) => Math.max(min, Math.min(max, next))

  useEffect(() => midiId ? registerMidiControl(midiId, { set: v => latest.current(min + v * (max - min)) }) : undefined, [midiId, min, max])

  const fraction = (value - min) / (max - min)
  const angle = -135 + fraction * 270
  const arc = (from: number, to: number) => {
    const point = (degrees: number) => { const r = (degrees - 90) * Math.PI / 180; return `${20 + 15 * Math.cos(r)} ${20 + 15 * Math.sin(r)}` }
    const [a, b] = from < to ? [from, to] : [to, from]
    return `M ${point(a)} A 15 15 0 ${b - a > 180 ? 1 : 0} 1 ${point(b)}`
  }

  const down = (event: PointerEvent) => {
    if (isLearning() && midiId) { learn(midiId); event.preventDefault(); return }
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { y: event.clientY, value }
  }
  const move = (event: PointerEvent) => {
    if (!drag.current) return
    const delta = (drag.current.y - event.clientY) / (event.shiftKey ? 600 : 150)
    latest.current(clamp(drag.current.value + delta * (max - min)))
  }

  return <div className="dj-knob" title={`${label}: ${format ? format(value) : value.toFixed(2)} — drag, scroll, or double-click to reset`} data-midi={midiId}>
    <svg viewBox="0 0 40 40" role="slider" tabIndex={0} aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Number(value.toFixed(3))}
      onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null }} onDoubleClick={() => onChange(reset)}
      onWheel={event => onChange(clamp(value - Math.sign(event.deltaY) * (max - min) / 40))}
      onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowRight') onChange(clamp(value + (max - min) / 40)); if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') onChange(clamp(value - (max - min) / 40)) }}>
      <path d={arc(-135, 135)} className="dj-knob-track" />
      <path d={arc(bipolar ? 0 : -135, angle)} className="dj-knob-fill" />
      <line x1="20" y1="20" x2={20 + 11 * Math.sin(angle * Math.PI / 180)} y2={20 - 11 * Math.cos(angle * Math.PI / 180)} className="dj-knob-needle" />
    </svg>
    <span>{label}</span>
  </div>
})
