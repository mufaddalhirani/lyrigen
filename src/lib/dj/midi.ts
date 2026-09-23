/**
 * MIDI controllers, by learning: press "MIDI learn", click a control on
 * screen, then move a knob or press a pad on the controller. That knob now
 * drives that control. Works with any class-compliant USB controller without
 * a per-model mapping file; mappings are remembered on this computer.
 *
 * Knobs and faders (control change) set a value; pads and buttons (note on)
 * press.
 */

type Control = { set?: (value: number) => void; press?: () => void }

const STORAGE_KEY = 'lyrigen-dj-midi-v1'
const controls = new Map<string, Control>()
let mappings: Record<string, string> = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, string> } catch { return {} } })()
let learning: string | null = null
let access: MIDIAccess | null = null
const listeners = new Set<() => void>()

function notify() { for (const listener of listeners) listener() }

export function onMidiChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export const midiStatus = () => ({ connected: access ? [...access.inputs.values()].map(input => input.name ?? 'MIDI device') : null, learning, mapped: Object.keys(mappings).length })

/** The interface registers each learnable control under a stable id. */
export function registerMidiControl(id: string, control: Control) {
  controls.set(id, control)
  return () => { if (controls.get(id) === control) controls.delete(id) }
}

export function learn(id: string | null) { learning = id; notify() }
export function isLearning() { return learning !== null }
export function clearMappings() {
  mappings = {}
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* nothing to clear */ }
  notify()
}

function handle(event: MIDIMessageEvent) {
  const data = event.data
  if (!data || data.length < 3) return
  const kind = data[0] & 0xf0
  const channel = data[0] & 0x0f
  const isNote = kind === 0x90 && data[2] > 0
  if (kind !== 0xb0 && !isNote) return
  const key = `${isNote ? 'note' : 'cc'}:${channel}:${data[1]}`
  if (learning) {
    for (const [existing, id] of Object.entries(mappings)) if (id === learning) delete mappings[existing]
    mappings[key] = learning
    learning = null
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(mappings)) } catch { /* not remembered */ }
    notify()
    return
  }
  const control = controls.get(mappings[key])
  if (!control) return
  if (isNote) control.press?.()
  else control.set?.(data[2] / 127)
}

/** Asks for MIDI access (once) and starts listening to every connected input. */
export async function enableMidi() {
  if (access) return true
  if (!navigator.requestMIDIAccess) return false
  try {
    access = await navigator.requestMIDIAccess()
  } catch {
    return false
  }
  const attach = () => { for (const input of access!.inputs.values()) input.onmidimessage = handle; notify() }
  access.onstatechange = attach
  attach()
  return true
}
