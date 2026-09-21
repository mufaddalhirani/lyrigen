import { useEffect, useState } from 'react'
import { Icon } from '../components/common/Icon'

/**
 * One place for the preferences that are not about a single track.
 *
 * Things that belong to *something* stay with that thing — download options
 * live in Downloads, themes in Sound Lab, EQ on the player — and are linked
 * from here rather than duplicated, so there is never a question of which copy
 * is authoritative.
 *
 * Everything destructive asks first and says exactly what it will remove.
 * Nothing on this screen touches your audio files.
 */

export const DEFAULT_APP_SETTINGS: AppSettings = {
  autoplayOnStartup: false,
  resumePlayback: true,
  rescanOnStartup: true,
  closeToTray: false,
  autoFetchLyrics: true,
  reducedMotion: false,
  confirmDestructive: true,
}

interface Toggle {
  key: keyof AppSettings
  title: string
  detail: string
}

const GROUPS: Array<{ title: string; kicker: string; toggles: Toggle[] }> = [
  {
    kicker: 'PLAYBACK',
    title: 'When Lyrigen opens',
    toggles: [
      { key: 'autoplayOnStartup', title: 'Start playing automatically', detail: 'Picks up the last track you were listening to as soon as the app opens. Off by default — an app that makes noise before you ask it to is rarely welcome.' },
      { key: 'resumePlayback', title: 'Resume where you left off', detail: 'Returns to the exact position you stopped at instead of restarting the track. Positions are remembered per song.' },
      { key: 'rescanOnStartup', title: 'Rescan folders on launch', detail: 'Checks your library folders for changes at startup. Turn this off on a very large library if opening feels slow — new files still appear while the app is running.' },
    ],
  },
  {
    kicker: 'LYRICS',
    title: 'Fetching',
    toggles: [
      { key: 'autoFetchLyrics', title: 'Look up lyrics automatically', detail: 'When a song has no lyric file, check Better Lyrics, Unison, AMLL and LRCLIB. Results are saved beside the song, so each track is only ever fetched once.' },
    ],
  },
  {
    kicker: 'WINDOW',
    title: 'Behaviour',
    toggles: [
      { key: 'closeToTray', title: 'Keep running when closed', detail: 'Closing the window leaves Lyrigen in the system tray with playback going. Use the tray icon to bring it back or quit properly.' },
      { key: 'reducedMotion', title: 'Reduced motion', detail: 'Turns off ambient backgrounds, the spinning vinyl and per-line lyric animation. Worth having on a weaker GPU, or if movement is distracting.' },
    ],
  },
  {
    kicker: 'SAFETY',
    title: 'Before things move',
    toggles: [
      { key: 'confirmDestructive', title: 'Confirm before filing files', detail: 'The Organizer always shows a plan first; this adds a final confirmation before anything is moved. Moves are journalled either way, so Undo puts a batch back.' },
    ],
  },
]

export function Settings({ roots, onAddRoot, onRemoveRoot, flash }: {
  roots: string[]
  onAddRoot: () => void
  onRemoveRoot: (root: string) => void
  flash: (message: string) => void
}) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    let active = true
    void window.electronAPI.getSettings().then(stored => {
      if (active) setSettings({ ...DEFAULT_APP_SETTINGS, ...(stored as Partial<AppSettings>) })
    })
    void window.electronAPI.getAppInfo().then(result => { if (active) setInfo(result) }).catch(() => undefined)
    return () => { active = false }
  }, [])

  const toggle = (key: keyof AppSettings) => {
    const next = { ...settings, [key]: !settings[key] }
    setSettings(next)
    void window.electronAPI.updateSettings({ [key]: next[key] })
    // Reduced motion is read straight off the document by the lyric renderer.
    if (key === 'reducedMotion') document.documentElement.classList.toggle('reduce-motion', next.reducedMotion)
  }

  const run = async (label: string, action: () => Promise<string>) => {
    setBusy(label)
    try { flash(await action()) } finally { setBusy('') }
  }

  const confirmThen = (question: string, action: () => Promise<string>) => () => {
    if (!window.confirm(question)) return
    void run(question, action)
  }

  return (
    <section className="settings-page">
      <div className="tool-hero">
        <span className="hero-kicker">SETTINGS</span>
        <h3>How Lyrigen<br /><i>behaves.</i></h3>
        <p>Preferences that apply to the whole app. Everything is stored on this computer, and nothing here touches your audio files.</p>
      </div>

      <div className="settings-grid">
        {GROUPS.map(group => (
          <div className="settings-card" key={group.kicker}>
            <div className="settings-card-head"><span className="kicker">{group.kicker}</span><h4>{group.title}</h4></div>
            <div className="toggle-stack">
              {group.toggles.map(item => (
                <button
                  key={item.key}
                  className={`setting-toggle ${settings[item.key] ? 'on' : ''}`}
                  onClick={() => toggle(item.key)}
                  aria-pressed={settings[item.key]}
                >
                  <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                  <i aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="settings-card">
          <div className="settings-card-head"><span className="kicker">LIBRARY</span><h4>Music folders</h4></div>
          <p className="settings-note">Lyrigen scans every folder beneath these. Removing one only stops it being scanned — no files are deleted.</p>
          <div className="settings-roots">
            {roots.map(root => (
              <div key={root}><span title={root}>{root}</span><button onClick={() => onRemoveRoot(root)} aria-label={`Stop scanning ${root}`}>Remove</button></div>
            ))}
            {!roots.length && <p className="recap-none">No folders yet. Add one to build your library.</p>}
          </div>
          <button className="ghost-button" onClick={onAddRoot}><Icon name="plus" size={15} /> Add folder</button>
        </div>

        <div className="settings-card">
          <div className="settings-card-head"><span className="kicker">ELSEWHERE</span><h4>Settings that live with their feature</h4></div>
          <p className="settings-note">Kept where they are used rather than copied here, so there is only ever one of each.</p>
          <ul className="settings-links">
            <li><b>Downloads</b> — format, quality, folder layout, cookies, duplicates, parallel downloads</li>
            <li><b>Sound Lab → Appearance</b> — theme, typeface, lyric motion</li>
            <li><b>Player → sliders</b> — EQ, bass and treble, pitch, speed, leveling, A–B loop</li>
          </ul>
        </div>

        <div className="settings-card">
          <div className="settings-card-head"><span className="kicker">DATA</span><h4>Stored on this computer</h4></div>
          <p className="settings-note">Play history, resume positions, playlists and settings. Clearing any of it is immediate and cannot be undone.</p>
          <div className="settings-actions">
            <button className="ghost-button" disabled={Boolean(busy)} onClick={confirmThen('Clear all play history? Listening recaps and play counts will reset to zero.', async () => {
              const result = await window.electronAPI.clearPlayHistory()
              return `Cleared ${result.cleared} play${result.cleared === 1 ? '' : 's'} from history.`
            })}>Clear play history</button>
            <button className="ghost-button" disabled={Boolean(busy)} onClick={confirmThen('Forget where you stopped in every track?', async () => {
              const result = await window.electronAPI.clearResumePositions()
              return `Cleared ${result.cleared} saved position${result.cleared === 1 ? '' : 's'}.`
            })}>Clear resume positions</button>
            <button className="ghost-button" disabled={Boolean(busy)} onClick={() => void run('window', async () => {
              await window.electronAPI.resetWindowBounds()
              return 'Window size and position reset.'
            })}>Reset window size</button>
            <button className="ghost-button" onClick={() => void window.electronAPI.openDataFolder()}>Open data folder</button>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-head"><span className="kicker">ABOUT</span><h4>Lyrigen {info?.version ?? ''}</h4></div>
          <p className="settings-note">A local-first music player. No account, no telemetry, and your audio never leaves this machine.</p>
          <dl className="settings-facts">
            <div><dt>Version</dt><dd>{info?.version ?? '—'}</dd></div>
            <div><dt>Electron</dt><dd>{info?.electron ?? '—'}</dd></div>
            <div><dt>Data folder</dt><dd title={info?.dataFolder}>{info?.dataFolder ?? '—'}</dd></div>
          </dl>
          <button className="ghost-button" onClick={() => void window.electronAPI.openExternal('https://github.com/mufaddalhirani/lyrigen')}><Icon name="external" size={14} /> Source on GitHub</button>
        </div>
      </div>
    </section>
  )
}
