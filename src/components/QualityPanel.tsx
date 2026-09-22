import { useEffect, useState } from 'react'
import { Icon } from './common/Icon'

/**
 * Sound quality: what the next download will be, and what the library is.
 *
 * The first card answers the question an audio analyzer used to be needed
 * for. It walks every link a download depends on and then asks yt-dlp to pick
 * a stream exactly as a real download would, so the number shown is the one
 * that will arrive — not a guess from the settings.
 *
 * The second card measures the library and offers to upgrade whatever has a
 * better stream waiting on YouTube Music.
 */

// A test makes a few requests to YouTube, so it runs once per session unless asked.
let lastCheck: { result: QualityCheckResult; key: string } | null = null

const STEP_PLACEHOLDERS: QualityCheckStep[] = [
  { id: 'tools', label: 'yt-dlp and ffmpeg', state: 'skip', detail: '' },
  { id: 'engine', label: 'JavaScript engine', state: 'skip', detail: '' },
  { id: 'signin', label: 'YouTube sign-in', state: 'skip', detail: '' },
  { id: 'token', label: 'Premium token server', state: 'skip', detail: '' },
  { id: 'stream', label: 'Test download', state: 'skip', detail: '' },
]
const STEP_ICON: Record<QualityCheckStep['state'], string> = { ok: '✓', warn: '!', fail: '✕', skip: '–' }

export function QualityPanel({ settings, testUrl, flash, onOpenOptions }: { settings: DownloadSettings; testUrl: string | null; flash: (message: string) => void; onOpenOptions: () => void }) {
  // Anything that changes which stream would be chosen makes an old answer stale.
  const settingsKey = `${settings.format}|${settings.premiumAudio}|${settings.cookieSource}|${settings.cookieFile}`
  const [check, setCheck] = useState(lastCheck)
  const [checking, setChecking] = useState(false)
  const [report, setReport] = useState<LibraryQualityReport | null>(null)
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null)
  const [queueing, setQueueing] = useState(false)

  const runCheck = async () => {
    setChecking(true)
    try {
      const result = await window.electronAPI.checkDownloadQuality(testUrl)
      lastCheck = { result, key: settingsKey }
      setCheck(lastCheck)
    } catch (error) {
      flash(`The quality test could not run: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => { if (!lastCheck) void runCheck() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const stale = Boolean(check && check.key !== settingsKey)
  const result = check?.result ?? null
  const expected = result?.expected ?? null
  const premiumReady = Boolean(expected?.premium) && !stale

  const measure = async () => {
    setScan({ done: 0, total: 0 })
    const off = window.electronAPI.onLibraryQualityProgress(setScan)
    try { setReport(await window.electronAPI.scanLibraryQuality()) } finally { off(); setScan(null) }
  }

  const upgrade = async () => {
    if (!report?.upgradable.length) return
    const count = report.upgradable.length
    if (!window.confirm(`Try to upgrade ${count.toLocaleString()} song${count === 1 ? '' : 's'} to YouTube Music's 256 kbps stream?\n\nA song is only replaced when the new stream is clearly better, and it keeps its name, tags and lyrics. The old file goes to the Recycle Bin. Songs with nothing better — fan uploads, sped-up edits — are left alone and remembered, so they are never checked twice.`)) return
    setQueueing(true)
    try {
      const created = await window.electronAPI.enqueueUpgrades(report.upgradable)
      flash(`${created.toLocaleString()} song${created === 1 ? '' : 's'} queued for upgrade. Each one shows its before and after in the queue.`)
      setReport(current => current ? { ...current, upgradable: [] } : current)
    } finally {
      setQueueing(false)
    }
  }

  const steps = checking && !result ? STEP_PLACEHOLDERS : result?.steps ?? STEP_PLACEHOLDERS
  const bands = report ? [
    { key: 'low', label: 'Under 96 kbps', count: report.bands.under96 },
    { key: 'standard', label: '96–160 kbps (standard)', count: report.bands.to160 },
    { key: 'mid', label: '160–200 kbps', count: report.bands.to200 },
    { key: 'high', label: '256 kbps and up', count: report.bands.over200 },
    { key: 'lossless', label: 'Lossless', count: report.lossless },
  ] : []
  const bandTotal = bands.reduce((sum, band) => sum + band.count, 0) || 1

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="quality-panel">
        <div className={`quality-hero ${expected?.premium && !stale ? 'is-premium' : ''}`}>
          <span className="kicker">NEXT DOWNLOAD WILL BE</span>
          <div className="quality-figure">
            <strong>{expected?.kbps ?? '—'}</strong>
            <span>
              {expected ? <>kbps · {expected.codec}{expected.sampleRate ? ` · ${(expected.sampleRate / 1000).toFixed(1)} kHz` : ''}<br />{expected.premium ? 'YouTube Music Premium stream' : 'Standard stream'}{expected.converted ? `, re-encoded to ${expected.converted}` : ', saved untouched'}</> : checking ? 'Testing…' : 'Not tested yet'}
            </span>
          </div>
          <p className="quality-headline">{checking ? 'Asking YouTube which stream it would send — nothing is downloaded.' : stale ? 'Your download settings changed since this test. Run it again to see the new answer.' : result?.headline ?? 'Run the test to see exactly what your downloads will be.'}</p>
          <div className="quality-actions">
            <button className="accent-button" disabled={checking} onClick={() => void runCheck()}><Icon name="refresh" size={14} /> {checking ? 'Testing…' : result ? 'Test again' : 'Run quality test'}</button>
            {!settings.premiumAudio && <button className="ghost-button" onClick={onOpenOptions}>Turn on 256 kbps</button>}
          </div>
          <small style={{ color: '#7e7786', fontSize: 10 }}>{testUrl ? 'Testing with the first link in the box above.' : 'Testing with a catalogue song that has a Premium stream. Paste a link above to test that one instead.'}</small>
        </div>
        <div className="quality-steps">
          {steps.map(step => (
            <div key={step.id} className={`quality-step ${checking ? 'pending' : step.state}`}>
              <i>{checking ? '•' : STEP_ICON[step.state]}</i>
              <div><strong>{step.label}</strong><span>{checking ? 'Checking…' : step.detail || '—'}</span></div>
            </div>
          ))}
        </div>
      </div>

      <div className="library-quality">
        <header>
          <div>
            <span className="kicker">YOUR LIBRARY</span>
            <h4>{report ? `${report.scanned.toLocaleString()} songs measured` : 'How good is what you already have?'}</h4>
          </div>
          <div className="quality-actions">
            <button className="ghost-button" disabled={Boolean(scan)} onClick={() => void measure()}>{scan ? `Measuring ${scan.done.toLocaleString()} of ${scan.total ? scan.total.toLocaleString() : '…'}` : report ? 'Measure again' : 'Measure my library'}</button>
            {report && report.upgradable.length > 0 && (
              <button className="accent-button" disabled={!premiumReady || queueing} title={premiumReady ? undefined : 'The test above has to show a 256 kbps stream first.'} onClick={() => void upgrade()}>
                <Icon name="download" size={14} /> {queueing ? 'Queueing…' : `Upgrade ${report.upgradable.length.toLocaleString()} to 256 kbps`}
              </button>
            )}
          </div>
        </header>
        {scan && <div className="scan-progress"><b style={{ width: `${scan.total ? (scan.done / scan.total) * 100 : 3}%` }} /></div>}
        {report && <>
          <div className="quality-bar">{bands.map(band => band.count > 0 && <b key={band.key} className={`band-${band.key}`} style={{ width: `${(band.count / bandTotal) * 100}%` }} title={`${band.label}: ${band.count.toLocaleString()}`} />)}</div>
          <div className="quality-legend">{bands.map(band => <span key={band.key}><i className={`band-${band.key}`} />{band.label} <b>{band.count.toLocaleString()}</b></span>)}</div>
          <p className="settings-note" style={{ margin: 0 }}>
            {report.upgradable.length > 0 ? <><b>{report.upgradable.length.toLocaleString()}</b> can be tried for an upgrade. </> : 'Nothing left to try. '}
            {report.noBetterStream > 0 && <>{report.noBetterStream.toLocaleString()} were already checked and YouTube has nothing better. </>}
            {report.unknownSource > 0 && <>{report.unknownSource.toLocaleString()} have no YouTube link to go back to. </>}
            {report.upgradable.length > 0 && !premiumReady && <b>Upgrades unlock once the test above shows a 256 kbps stream.</b>}
          </p>
        </>}
      </div>
    </div>
  )
}
