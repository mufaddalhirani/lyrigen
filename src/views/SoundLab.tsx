// Extracted from the former 45KB single-file App.tsx.

import { useState } from 'react'
import { Icon } from '../components/common/Icon'
import { applyAppearance, loadAppearance, FONTS, LYRIC_MOTIONS, THEMES, type ThemeOption } from '../lib/themes'

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

export function SoundLab({ onOpenConverter }: { onOpenConverter: () => void }) {
  const [appearance, setAppearance] = useState(loadAppearance)
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
        <p>Open a track to access EQ, loudness leveling, karaoke practice, speed, pitch preservation, looping, and lyrics tools.</p>
        <button className="ghost-button" onClick={onOpenConverter}><Icon name="spark" size={15} /> Open lyric converter</button>
      </div>

      <div className="appearance-panel">
        <div className="appearance-head">
          <span className="kicker">APPEARANCE</span>
          <h4>Themes</h4>
          <p>Colour, type and how the lyrics move. Applies everywhere, straight away, and is remembered.</p>
        </div>
        <ChoiceRow title="Theme" hint="Palette and panel treatment" options={THEMES} value={appearance.theme} onChange={theme => update({ theme })} />
        <ChoiceRow title="Typeface" hint="Interface and lyrics" options={FONTS} value={appearance.font} onChange={font => update({ font })} />
        <ChoiceRow title="Lyric motion" hint="How the active line is emphasised" options={LYRIC_MOTIONS} value={appearance.motion} onChange={motion => update({ motion })} />
      </div>

      <div className="sound-cards">
        <div><span>PLAYBACK</span><strong>Persistent audio</strong><p>The player dock stays with you while you browse.</p></div>
        <div><span>LYRICS</span><strong>Synced when possible</strong><p>Local sidecars first, accepted cached results second.</p></div>
        <div><span>SAFETY</span><strong>Undoable edits</strong><p>Metadata writes create recoverable backups before applying.</p></div>
      </div>
    </section>
  )
}
