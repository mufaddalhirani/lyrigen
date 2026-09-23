// Extracted from the former 45KB single-file App.tsx.

import { VISUAL_MODES, loadVisualMode, saveVisualMode, type VisualMode } from '../lib/visualModes'
import { useState } from 'react'
import { Icon } from '../components/common/Icon'
import { LrcConverter } from '../components/LrcConverter'
import { applyAppearance, loadAppearance, FONTS, LYRIC_MOTIONS, THEMES, type ThemeOption } from '../lib/themes'

type Section = 'appearance' | 'sound' | 'lyrics'

const SECTIONS: Array<{ id: Section; label: string; blurb: string }> = [
  { id: 'appearance', label: 'Appearance', blurb: 'Theme, type and how the lyrics move' },
  { id: 'sound', label: 'Sound', blurb: 'What each control in the player actually does' },
  { id: 'lyrics', label: 'Lyric tools', blurb: 'Convert and align lyric files' },
]

/** One row of mutually exclusive appearance choices. */
function ChoiceRow({ title, hint, options, value, onChange }: { title: string; hint: string; options: ThemeOption[]; value: string; onChange: (id: string) => void }) {
  const active = options.find(option => option.id === value)
  return (
    <div className="appearance-row">
      <div className="appearance-label"><strong>{title}</strong><small>{hint}</small></div>
      <div className="appearance-options">
        {options.map(option => (
          <button
            key={option.id}
            className={`appearance-chip theme-${option.id} ${option.id === value ? 'on' : ''}`}
            onClick={() => onChange(option.id)}
            aria-pressed={option.id === value}
            title={option.description}
          >
            <i aria-hidden="true" />
            {option.label}
          </button>
        ))}
      </div>
      {active && <p className="appearance-hint">{active.description}</p>}
    </div>
  )
}

/** The sound controls all live on the now-playing screen; this explains them. */
const SOUND_GUIDE: Array<{ title: string; detail: string }> = [
  { title: 'Bass and treble', detail: 'Two shortcuts over the six-band EQ — bass moves 60 Hz and 170 Hz together, treble 3.5 kHz and 10 kHz. The EQ below shows exactly what they did, so you can start with a shortcut and fine-tune from there.' },
  { title: 'Pitch', detail: 'Shifts the key by up to a tone either way without changing speed, through a WSOLA time-stretcher. Centred, it bypasses the processing entirely and costs nothing.' },
  { title: 'Speed', detail: 'Independent of pitch, in 0.05× steps. "Preserve pitch" is what keeps a sped-up track from sounding like a chipmunk.' },
  { title: 'Dynamic leveling', detail: 'Evens out loudness jumps between recordings. Useful across a mixed library, unnecessary within one well-mastered album.' },
  { title: 'Center vocal reduction', detail: 'Cancels what is identical in both channels, which is usually the lead vocal. Results vary by mix, and it does nothing at all on a mono file.' },
  { title: 'A–B loop', detail: 'Mark two points and the section repeats — for learning a part, or sitting inside a passage you like.' },
]

export function SoundLab() {
  const [section, setSection] = useState<Section>('appearance')
  const [appearance, setAppearance] = useState(loadAppearance)
  const [visualMode, setVisualMode] = useState<VisualMode>(loadVisualMode)
  const update = (patch: Partial<typeof appearance>) => {
    const next = { ...appearance, ...patch }
    setAppearance(next)
    applyAppearance(next)
  }

  return (
    <section className="sound-page">
      <div className="sound-hero">
        <span className="hero-kicker">SOUND LAB</span>
        <h3>Make the room<br /><i>feel right.</i></h3>
        <p>Everything that shapes how Lyrigen looks and sounds, in one place.</p>
      </div>

      <div className="lab-tabs" role="tablist">
        {SECTIONS.map(item => (
          <button key={item.id} role="tab" aria-selected={section === item.id} className={section === item.id ? 'on' : ''} onClick={() => setSection(item.id)}>
            <strong>{item.label}</strong>
            <small>{item.blurb}</small>
          </button>
        ))}
      </div>

      {section === 'appearance' && (
        <div className="appearance-panel">
          <div className="appearance-head">
            <span className="kicker">APPEARANCE</span>
            <h4>Themes</h4>
            <p>Colour, type and how the lyrics move. Applies everywhere, straight away, and is remembered.</p>
          </div>
          <ChoiceRow title="Theme" hint="Palette and panel treatment" options={THEMES} value={appearance.theme} onChange={theme => update({ theme })} />
          <ChoiceRow title="Typeface" hint="Interface and lyrics" options={FONTS} value={appearance.font} onChange={font => update({ font })} />
          <ChoiceRow title="Lyric motion" hint="How the active line is emphasised" options={LYRIC_MOTIONS} value={appearance.motion} onChange={motion => update({ motion })} />
          <ChoiceRow title="Now-playing view" hint="Also in the player's top bar" options={VISUAL_MODES} value={visualMode} onChange={mode => { setVisualMode(mode as VisualMode); saveVisualMode(mode as VisualMode) }} />
        </div>
      )}

      {section === 'sound' && (
        <div className="appearance-panel">
          <div className="appearance-head">
            <span className="kicker">SOUND</span>
            <h4>What each control does</h4>
            <p>These live on the now-playing screen, under the sliders button. Play something and open it to use them.</p>
          </div>
          <div className="lab-guide">
            {SOUND_GUIDE.map(entry => (
              <div key={entry.title}><strong>{entry.title}</strong><p>{entry.detail}</p></div>
            ))}
          </div>
        </div>
      )}

      {section === 'lyrics' && (
        <div className="appearance-panel">
          <div className="appearance-head">
            <span className="kicker">LYRIC TOOLS</span>
            <h4>LRC → TTML</h4>
            <p>Turn a line-synced LRC into an Apple-style TTML with estimated word spans. Useful when a song only has line timing and you want the word-by-word view.</p>
          </div>
          <LrcConverter />
        </div>
      )}

      <div className="sound-cards">
        <div><span>PLAYBACK</span><strong>Persistent audio</strong><p>The player dock stays with you while you browse.</p></div>
        <div><span>LYRICS</span><strong>Synced when possible</strong><p>Local sidecars first, accepted cached results second.</p></div>
        <div><span>SAFETY</span><strong>Undoable edits</strong><p>Metadata writes create recoverable backups before applying.</p></div>
      </div>

      <p className="lab-foot"><Icon name="spark" size={13} /> Themes and lyric motion are remembered per machine; sound settings apply to the current track.</p>
    </section>
  )
}
