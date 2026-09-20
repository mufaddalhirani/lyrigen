// Extracted from the former 45KB single-file App.tsx.

import { Icon } from '../components/common/Icon'
import { smartCollections } from '../lib/smart'

export function SmartHome({ onOpen, stats }: { onOpen: (id: string) => void; stats: LibraryStats | null }) {
  const cards = smartCollections({ favorites: stats?.favorites ?? 0 })
  return (
    <section className="smart-page">
      <div className="page-intro">
        <span className="kicker">AUTOMATICALLY UPDATED</span>
        <h3>Useful corners of your library.</h3>
        <p>Smart collections are views, not copies. They stay lightweight and local.</p>
      </div>
      <div className="smart-grid">
        {cards.map(card => (
          <button key={card.id} className="smart-card" onClick={() => onOpen(card.id)}>
            <span className="smart-icon"><Icon name={card.icon} size={21} /></span>
            <strong>{card.title}</strong>
            <span>{card.detail}</span>
            <em><Icon name="chevron" size={16} /></em>
          </button>
        ))}
      </div>
    </section>
  )
}
