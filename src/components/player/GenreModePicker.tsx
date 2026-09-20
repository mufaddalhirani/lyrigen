import { memo } from 'react'
import { GENRE_MODE_LIST, type GenreModeId } from '../../audio/modes/genreModes'

interface Props {
  value: GenreModeId
  onChange: (mode: GenreModeId) => void
}

/**
 * Genre mode picker.
 *
 * Presented as a grid of cards rather than a dropdown because these are not
 * subtle EQ tilts -- each one noticeably changes the tempo, pitch and space of
 * the track, and that deserves to be visible before you click it.
 */
export const GenreModePicker = memo(function GenreModePicker({ value, onChange }: Props) {
  const active = GENRE_MODE_LIST.find(mode => mode.id === value)

  return (
    <div className="setting-section genre-mode-setting">
      <span className="genre-mode-title">Genre mode</span>

      <div className="genre-mode-grid" role="radiogroup" aria-label="Genre mode">
        {GENRE_MODE_LIST.map(mode => (
          <button
            key={mode.id}
            role="radio"
            aria-checked={mode.id === value}
            className={`genre-mode-card ${mode.id === value ? 'active' : ''} genre-${mode.id}`}
            onClick={() => onChange(mode.id)}
            title={mode.description}
          >
            <span className="genre-mode-emoji" aria-hidden="true">{mode.emoji || '○'}</span>
            <strong>{mode.label.split(' · ')[0]}</strong>
            <small>{mode.label.split(' · ')[1] ?? 'No processing'}</small>
          </button>
        ))}
      </div>

      <small className="setting-hint">{active?.description}</small>

      {active && active.id !== 'off' && (
        <div className="genre-mode-readout" aria-live="polite">
          <span><em>Tempo</em>{Math.round(active.tempo * 100)}%</span>
          <span><em>Pitch</em>{formatSemitones(active.pitch)}</span>
          {active.reverb && <span><em>Reverb</em>{active.reverb.character}</span>}
          {active.spatial && <span><em>Spin</em>{active.spatial.cyclesPerMinute}/min</span>}
          {active.stutter && <span><em>Stutter</em>{active.stutter.rateHz.toFixed(1)}Hz</span>}
        </div>
      )}
    </div>
  )
})

function formatSemitones(ratio: number) {
  const semitones = 12 * Math.log2(ratio)
  if (Math.abs(semitones) < 0.05) return 'unchanged'
  const rounded = Math.round(semitones * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded} st`
}
