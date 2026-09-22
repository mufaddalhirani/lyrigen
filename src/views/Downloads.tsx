import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/common/Icon'
import { prettyTime } from '../lib/format'
import { QualityPanel } from '../components/QualityPanel'

/**
 * Downloads: paste links → inspect (yt-dlp reads title/uploader/duration and
 * the app parses it into artist/title/variant) → review and correct → queue.
 * Each job then downloads, converts, tags (ffmpeg), fetches lyrics (Unison
 * first) and files itself into the destination using the folder template.
 */

const VARIANTS: Array<SongVariant | ''> = ['', 'Sped Up', 'Nightcore', 'Slowed', 'Slowed + Reverb', 'Reverb', 'Lo-Fi', 'Daycore', '8D', 'Bass Boosted', 'Remix', 'Acoustic', 'Live', 'Instrumental', 'Karaoke', 'Cover', 'Mashup']
const FORMATS: Array<{ value: AudioFormat; label: string; hint: string }> = [
  { value: 'm4a', label: 'M4A / AAC', hint: 'Recommended — kept exactly as YouTube sent it' },
  { value: 'opus', label: 'Opus', hint: 'Also untouched; smaller files, fewer players' },
  { value: 'best', label: 'Original stream', hint: 'Whatever YouTube offers, no conversion' },
  { value: 'mp3', label: 'MP3', hint: 'Plays on anything, but re-encodes and loses a little' },
  { value: 'flac', label: 'FLAC', hint: 'Lossless wrapper around a lossy source; large files' },
]

/** Formats YouTube already serves, so no re-encoding happens on the way in. */
const LOSSLESS_PATH: AudioFormat[] = ['m4a', 'opus', 'best']

/** How many rows to draw at once. A 5,000-song playlist must not try to paint 5,000 cards. */
const PAGE = 80

const ACTIVE: DownloadJobStatus[] = ['queued', 'inspecting', 'downloading', 'converting', 'tagging', 'lyrics', 'organizing', 'waiting', 'paused']

function statusLabel(job: DownloadJob) {
  if (job.status === 'done' && job.upgradeOf) return job.upgradeOf.kept ? 'Kept' : 'Upgraded'
  if (job.status === 'done') return 'Done'
  if (job.status === 'error') return 'Failed'
  if (job.status === 'cancelled') return 'Cancelled'
  if (job.status === 'queued') return 'Queued'
  if (job.status === 'paused') return 'Paused'
  if (job.status === 'waiting') return 'Will retry'
  return job.stage
}

/** Browsers yt-dlp can borrow a signed-in YouTube session from. */
const COOKIE_SOURCES: Array<{ value: DownloadSettings['cookieSource']; label: string }> = [
  { value: 'none', label: 'Do not use cookies' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'edge', label: 'Edge' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'brave', label: 'Brave' },
  { value: 'opera', label: 'Opera' },
  { value: 'vivaldi', label: 'Vivaldi' },
  { value: 'chromium', label: 'Chromium' },
]

export function Downloads({ onPlayFile, flash }: { onPlayFile: (audioPath: string) => void; flash: (message: string) => void }) {
  const [settings, setSettings] = useState<DownloadSettings | null>(null)
  const [presets, setPresets] = useState<PathPreset[]>([])
  const [tools, setTools] = useState<ToolsStatus | null>(null)
  const [urls, setUrls] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [inspectError, setInspectError] = useState('')
  const [items, setItems] = useState<InspectItem[]>([])
  const [playlistTitle, setPlaylistTitle] = useState<string | null>(null)
  const [jobs, setJobs] = useState<DownloadJob[]>([])
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [paused, setPaused] = useState(false)
  const [cookieCheck, setCookieCheck] = useState<{ ok: boolean; message: string } | null>(null)
  const [queueing, setQueueing] = useState(false)
  const [skipReport, setSkipReport] = useState<SkippedDownload[] | null>(null)
  const [shownItems, setShownItems] = useState(PAGE)
  const [shownJobs, setShownJobs] = useState(PAGE)
  const [missingPaths, setMissingPaths] = useState<Array<{ kind: 'destination' | 'library' | 'cookies'; path: string }>>([])
  const [pot, setPot] = useState<PotStatus | null>(null)
  const [startingPot, setStartingPot] = useState(false)
  const settingsTimer = useRef<number | null>(null)
  const pendingJobs = useRef(new Map<string, DownloadJob>())
  const flushTimer = useRef<number | null>(null)

  useEffect(() => {
    let active = true
    void Promise.all([window.electronAPI.getDownloadSettings(), window.electronAPI.getToolsStatus(), window.electronAPI.listDownloads()]).then(([downloadSettings, toolsStatus, existing]) => {
      if (!active) return
      setSettings(downloadSettings.settings); setPresets(downloadSettings.presets); setTools(toolsStatus); setJobs(existing)
    })
    void window.electronAPI.areDownloadsPaused().then(value => { if (active) setPaused(value) }).catch(() => undefined)
    void window.electronAPI.checkDownloadPaths().then(value => { if (active) setMissingPaths(value) }).catch(() => undefined)
    void window.electronAPI.getPotStatus().then(value => { if (active) setPot(value) }).catch(() => undefined)
    // Two dozen parallel downloads emit progress far faster than anything needs
    // to be drawn, and each event used to walk the whole job list. Collect them
    // and apply the batch a few times a second instead.
    const offJob = window.electronAPI.onDownloadJob(job => {
      pendingJobs.current.set(job.id, job)
      if (flushTimer.current) return
      flushTimer.current = window.setTimeout(() => {
        flushTimer.current = null
        const batch = pendingJobs.current
        pendingJobs.current = new Map()
        setJobs(current => {
          const known = new Set(current.map(item => item.id))
          const next = current.map(item => batch.get(item.id) ?? item)
          for (const [id, job] of batch) if (!known.has(id)) next.push(job)
          return next
        })
      }, 300)
    })
    const offJobs = window.electronAPI.onDownloadJobs(list => { setJobs(list); void window.electronAPI.areDownloadsPaused().then(setPaused).catch(() => undefined) })
    return () => {
      active = false; offJob(); offJobs()
      if (flushTimer.current) { window.clearTimeout(flushTimer.current); flushTimer.current = null }
    }
  }, [])

  // Check the cookies file as soon as there is a path, so a bad export is
  // caught here rather than as a "not a bot" failure three downloads later.
  useEffect(() => {
    const file = settings?.cookieFile?.trim()
    if (!file) { setCookieCheck(null); return }
    let active = true
    void window.electronAPI.inspectCookiesFile(file)
      .then(result => { if (active) setCookieCheck(result) })
      .catch(() => { if (active) setCookieCheck(null) })
    return () => { active = false }
  }, [settings?.cookieFile])

  const patchSettings = (patch: Partial<DownloadSettings>) => {
    setSettings(current => current ? { ...current, ...patch } : current)
    if (settingsTimer.current) window.clearTimeout(settingsTimer.current)
    settingsTimer.current = window.setTimeout(() => {
      void window.electronAPI.updateDownloadSettings(patch).then(setSettings)
      if ('destination' in patch || 'cookieFile' in patch) void window.electronAPI.checkDownloadPaths().then(setMissingPaths).catch(() => undefined)
    }, 250)
  }

  const inspect = async () => {
    const list = urls.split(/\s+/).map(line => line.trim()).filter(line => /^https?:\/\//i.test(line))
    if (!list.length) { setInspectError('Paste at least one link starting with https://'); return }
    setInspecting(true); setInspectError(''); setPlaylistTitle(null)
    const found: InspectItem[] = []
    for (const url of list) {
      const result = await window.electronAPI.inspectDownloadUrl(url, settings ?? undefined)
      if (!result.ok) { setInspectError(result.error || `Could not read ${url}`); continue }
      if (result.playlistTitle) setPlaylistTitle(result.playlistTitle)
      for (const item of result.items) if (!found.some(existing => existing.videoId === item.videoId)) found.push(item)
    }
    const foundIds = new Set(found.map(item => item.videoId))
    setItems(current => [...current.filter(existing => !foundIds.has(existing.videoId)), ...found])
    setShownItems(PAGE)
    setInspecting(false)
    if (found.length) setUrls('')
  }

  const editItem = (videoId: string, patch: Partial<SongMetadata>) => setItems(current => current.map(item => item.videoId === videoId ? { ...item, metadata: { ...item.metadata, ...patch, origin: 'manual', confidence: 'high' } } : item))

  const enqueueAll = async () => {
    if (!items.length || queueing) return
    setQueueing(true)
    try {
      const { created, skipped } = await window.electronAPI.enqueueDownloads(items.map(item => ({ url: item.url, videoId: item.videoId, metadata: item.metadata, info: { title: item.info.title, uploader: item.info.uploader, thumbnail: item.info.thumbnail, duration: item.info.duration, extractor: item.info.extractor } })), settings ?? undefined)
      setItems([]); setPlaylistTitle(null); setShownItems(PAGE)
      setSkipReport(skipped.length ? skipped : null)
      flash(`${created.length} song${created.length === 1 ? '' : 's'} added to the queue.${skipped.length ? ` ${skipped.length} you already have ${skipped.length === 1 ? 'was' : 'were'} skipped.` : ''}`)
    } finally { setQueueing(false) }
  }

  const preview = async (item: InspectItem) => {
    if (previewing === item.videoId) { await window.electronAPI.stopPreview(); setPreviewing(null); return }
    setPreviewing(item.videoId)
    const result = await window.electronAPI.previewDownloadUrl(item.url)
    if (!result.playing) { setPreviewing(null); flash(result.message || 'Preview is unavailable.') }
  }

  const locateTools = async () => setTools(await window.electronAPI.chooseToolsFolder())
  const updateYtDlp = async () => { setUpdating(true); const result = await window.electronAPI.updateYtDlp(); setUpdating(false); flash(result.message); setTools(await window.electronAPI.getToolsStatus()) }

  const activeJobs = useMemo(() => jobs.filter(job => ACTIVE.includes(job.status)), [jobs])
  const failedJobs = useMemo(() => jobs.filter(job => job.status === 'error'), [jobs])
  const finishedJobs = useMemo(() => jobs.filter(job => !ACTIVE.includes(job.status)).sort((left, right) => String(right.finishedAt).localeCompare(String(left.finishedAt))), [jobs])
  const templateExample = useMemo(() => {
    if (!settings) return ''
    const sample: Record<string, string> = { artist: 'Kendrick Lamar & SZA', albumartist: 'Kendrick Lamar', album: 'Sped Up', title: 'All The Stars', year: '2018', variant: 'Sped Up', genre: 'Hip-Hop', uploader: 'poopchi', id: 'g7eBUcivTE0', track: '01' }
    const rendered = settings.pathTemplate.replace(/\{(\w+)(?:\|([^}]*))?\}/g, (_match, key: string, fallback?: string) => sample[key.toLocaleLowerCase()] ?? fallback ?? '')
    return `${rendered.replace(/\//g, '\\')}${/all the stars/i.test(rendered) && !/sped up\)?$/i.test(rendered) ? ' (Sped Up)' : ''}.${settings.format === 'best' ? 'm4a' : settings.format}`
  }, [settings])

  const ready = tools?.ready ?? false

  return <section className="tool-page">
    <div className="tool-hero">
      <span className="hero-kicker">YT-DLP · FFMPEG · UNISON</span>
      <h3>Bring a song<br /><i>home.</i></h3>
      <p>Paste YouTube, SoundCloud or Bandcamp links. Lyrigen reads what the upload is, works out the real artist and title (even from "song - artist (sped up) | lyrics"), fetches word-synced lyrics from Unison, and files everything into your library folders.</p>
      <div className="paste-box">
        <textarea value={urls} onChange={event => setUrls(event.target.value)} placeholder={'https://www.youtube.com/watch?v=…\nOne link per line · playlists are expanded'} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void inspect() }} />
        <button className="accent-button" disabled={inspecting || !ready} onClick={() => void inspect()}><Icon name="search" size={15} /> {inspecting ? 'Reading…' : 'Inspect'}</button>
      </div>
      <small>{inspectError ? inspectError : ready ? 'Ctrl+Enter to inspect · nothing downloads until you add it to the queue' : 'yt-dlp and ffmpeg are needed before anything can be downloaded'}</small>
    </div>

    {missingPaths.length > 0 && <div className="tool-panel" style={{ borderColor: 'var(--warning, #c9793a)' }}>
      <div className="tool-panel-head"><strong>Some folders Lyrigen was told about are gone</strong><span>downloads and duplicate checks are working from the wrong place</span></div>
      <div className="tool-panel-body">
        {missingPaths.map(item => <p key={`${item.kind}:${item.path}`} className="cookie-status bad" style={{ marginBottom: 8 }}>
          {item.kind === 'destination' ? 'Downloads are set to land in' : item.kind === 'library' ? 'Your library is set to' : 'Your cookies file is set to'} <b>{item.path}</b>, which no longer exists.
          {item.kind === 'library' && ' Until this points at your music, every song will look like one you have never downloaded.'}
          {item.kind === 'cookies' && ' Signed-in downloads are running anonymously instead.'}
        </p>)}
        <p className="settings-note">Fix the destination and cookies file under <b>Download options</b> below; music folders live in <b>Settings → Library</b>.</p>
        <button className="mini-button" onClick={() => { setShowSettings(true); void window.electronAPI.checkDownloadPaths().then(setMissingPaths).catch(() => undefined) }}>Open download options</button>
      </div>
    </div>}

    {settings && ready && <QualityPanel settings={settings} testUrl={urls.split(/\s+/).find(line => /^https?:\/\//i.test(line)) ?? null} flash={flash} onOpenOptions={() => setShowSettings(true)} />}

    <div className="tools-strip">
      {(tools?.tools ?? []).map(tool => <span key={tool.name} className={`tool-chip ${tool.ok ? 'ok' : ''}`} title={tool.path || 'Not found'}><i />{tool.name}{tool.version && <small>{tool.version.length > 14 ? tool.version.slice(0, 14) : tool.version}</small>}</span>)}
      <button className="mini-button" onClick={() => void locateTools()}>Locate tools…</button>
      <span className={`tool-chip ${tools?.jsRuntime.available ? 'ok' : ''}`} title={tools?.jsRuntime.available ? `${tools.jsRuntime.kind} — solves YouTube's player challenges` : 'No JavaScript engine found. Signed-in downloads will fail with "The page needs to be reloaded."'}><i />JS engine{tools?.jsRuntime.kind && <small>{tools.jsRuntime.kind}</small>}</span>
      <button className="mini-button" disabled={updating || !tools?.tools.find(tool => tool.name === 'yt-dlp')?.ok} onClick={() => void updateYtDlp()}>{updating ? 'Updating…' : 'Update yt-dlp'}</button>
      <span className="spacer" />
      <button className="text-link" onClick={() => setShowSettings(value => !value)}><Icon name="sliders" size={14} /> {showSettings ? 'Hide options' : 'Download options'}</button>
    </div>

    <div className="tool-columns" style={showSettings ? undefined : { gridTemplateColumns: '1fr' }}>
      <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
        {items.length > 0 && <div className="tool-panel">
          <div className="tool-panel-head"><strong>{playlistTitle ? `Playlist · ${playlistTitle}` : 'Ready to download'}</strong><span>{items.length} song{items.length === 1 ? '' : 's'} · check artist and title before queueing</span></div>
          <div className="inspect-footer">
          {items.some(item => item.alreadyDownloaded) && <p className="dupe-note">{items.filter(item => item.alreadyDownloaded).length} of these {items.length} are already in your library. They are skipped on queueing unless you turn off "Skip songs already downloaded" in settings. <button className="text-link" onClick={() => setItems(current => current.filter(item => !item.alreadyDownloaded))}>Remove them from this list</button></p>}
            <p>{settings?.organize ? `Files go to ${settings.destination} using the "${presets.find(preset => preset.template === settings.pathTemplate)?.label ?? 'custom'}" layout.` : `Files go straight into ${settings?.destination}.`}{settings?.fetchLyrics ? ' Lyrics are fetched from Better Lyrics, BiniLyrics, Unison, AMLL and LRCLIB.' : ''}</p>
            <button className="accent-button" disabled={!ready || queueing} onClick={() => void enqueueAll()}><Icon name="plus" size={15} /> {queueing ? `Checking ${items.length} against your library…` : `Add ${items.length} to queue`}</button>
          </div>
          <div className="inspect-list">
            {items.slice(0, shownItems).map(item => <div className="inspect-card" key={item.videoId}>
              {item.info.thumbnail ? <img className="thumb" src={item.info.thumbnail} alt="" /> : <div className="thumb" />}
              <div className="inspect-fields">
                <label><span>Artist</span><input value={item.metadata.artist || ''} onChange={event => editItem(item.videoId, { artist: event.target.value || null, albumArtist: event.target.value.split(/\s*(?:,|&|\+|\bx\b|\bft\.?\b|\bfeat\.?\b)\s*/i)[0] || null })} placeholder="Unknown artist" /></label>
                <label><span>Title</span><input value={item.metadata.title} onChange={event => editItem(item.videoId, { title: event.target.value })} /></label>
                <label><span>Album</span><input value={item.metadata.album || ''} onChange={event => editItem(item.videoId, { album: event.target.value || null })} placeholder={item.metadata.variant || 'Singles'} /></label>
                <label><span>Variant</span><select value={item.metadata.variant || ''} onChange={event => editItem(item.videoId, { variant: (event.target.value || null) as SongVariant | null })}>{VARIANTS.map(variant => <option key={variant} value={variant}>{variant || 'Original'}</option>)}</select></label>
                <div className="inspect-source">
                  <span className={`chip ${item.metadata.confidence}`}>{item.metadata.origin === 'music-metadata' ? 'YouTube Music metadata' : item.metadata.origin === 'musicbrainz' ? 'Verified on MusicBrainz' : item.metadata.origin === 'manual' ? 'Edited' : `${item.metadata.confidence} confidence guess`}</span>
                  {item.metadata.featuring && <span className="chip">feat. {item.metadata.featuring}</span>}
                  {item.info.duration && <span className="chip">{prettyTime(item.info.duration)}</span>}
                  <em title={item.info.title}>“{item.info.title}” · {item.info.uploader || item.info.extractor}</em>
                </div>
                <div className="inspect-path">{item.alreadyDownloaded ? <><span className="chip dupe">Already downloaded</span> <b>{item.alreadyDownloaded}</b></> : <>→ <b>{settings ? `${settings.destination}\\…\\` : ''}{item.proposedPath.split(/[\\/]/).slice(-3).join('\\')}</b></>}</div>
              </div>
              <div className="inspect-actions">
                <button className={previewing === item.videoId ? 'active' : ''} title={previewing === item.videoId ? 'Stop preview' : 'Preview the audio stream (ffplay)'} onClick={() => void preview(item)}><Icon name="play" size={16} /></button>
                <button title="Open on the web" onClick={() => void window.electronAPI.openExternal(item.url)}><Icon name="external" size={15} /></button>
                <button title="Remove" onClick={() => setItems(current => current.filter(existing => existing.videoId !== item.videoId))}><Icon name="close" size={15} /></button>
              </div>
            </div>)}
            {items.length > shownItems && <div className="tool-panel-empty">Showing {shownItems} of {items.length}. Queueing adds all of them. <button className="text-link" onClick={() => setShownItems(count => count + PAGE * 4)}>Show more</button></div>}
          </div>
        </div>}

        {skipReport && <div className="tool-panel">
          <div className="tool-panel-head"><strong>Already in your library</strong><div className="row"><span>{skipReport.length} skipped</span><button className="mini-button" onClick={() => setSkipReport(null)}>Dismiss</button></div></div>
          <div className="dupe-groups">
            {skipReport.slice(0, 200).map(item => <div className="dupe-file keep" key={`${item.videoId ?? item.url}`} title={item.existingPath}>
              <Icon name="check" size={14} />
              <span>{item.artist ? `${item.artist} — ` : ''}{item.title}</span>
              <em>{item.reason} · {item.existingPath}</em>
            </div>)}
            {skipReport.length > 200 && <div className="tool-panel-empty">…and {skipReport.length - 200} more.</div>}
          </div>
        </div>}

        <div className="tool-panel">
          <div className="tool-panel-head"><strong>Queue</strong><div className="row"><span>{activeJobs.length} active · {finishedJobs.length} finished</span>{activeJobs.length > 0 && <button className="mini-button" onClick={() => void window.electronAPI.setDownloadsPaused(!paused).then(setPaused)}>{paused ? 'Resume' : 'Pause'}</button>}{failedJobs.length > 0 && <button className="mini-button" onClick={() => void Promise.all(failedJobs.map(job => window.electronAPI.retryDownload(job.id)))}>Retry all failed ({failedJobs.length})</button>}{finishedJobs.length > 0 && <button className="mini-button" onClick={() => void window.electronAPI.clearFinishedDownloads()}>Clear finished</button>}</div></div>
          <div className="queue-list">
            {[...activeJobs, ...finishedJobs].slice(0, shownJobs).map(job => {
              const indeterminate = ['inspecting', 'tagging', 'lyrics', 'organizing', 'converting'].includes(job.status)
              return <div className="queue-row" key={job.id}>
                {job.info?.thumbnail ? <img className="thumb" src={job.info.thumbnail} alt="" /> : <div className="thumb" />}
                <div className="queue-main">
                  <strong>{job.metadata ? job.metadata.title : job.info?.title || job.url}</strong>
                  <span>{job.metadata?.artist || job.info?.uploader || 'Reading link…'}{job.metadata?.variant ? ` · ${job.metadata.variant}` : ''}{job.metadata?.album ? ` · ${job.metadata.album}` : ''}</span>
                  {job.status === 'error' ? <small className="error">{job.error}</small> : job.outputPath ? <small title={job.outputPath}>{job.outputPath}{job.lyricPath ? ` · lyrics ${job.lyricRetimed ? 're-timed ' : ''}from ${job.lyricSource}` : ''}</small> : <small>{job.url}</small>}
                </div>
                <div className={`queue-status ${job.status}`}>
                  <div className={`bar ${indeterminate ? 'indeterminate' : ''}`} style={{ '--progress': `${job.status === 'done' ? 100 : job.progress}%` } as React.CSSProperties}><i /></div>
                  <div className="meta"><b>{statusLabel(job)}</b><span>{job.status === 'downloading' ? `${Math.round(job.progress)}%${job.speed ? ` · ${job.speed}` : ''}${job.eta ? ` · ${job.eta}` : ''}` : job.status === 'done' && job.audio?.kbps ? <span style={job.options.premiumAudio && job.audio.kbps < 200 ? { color: 'var(--warning, #c9793a)' } : undefined} title={job.options.premiumAudio && job.audio.kbps < 200 ? 'Premium was on, but YouTube served the ordinary stream — either this upload has no Premium version, or the sign-in has gone stale.' : 'Measured from the downloaded file'}>{(job.audio.codec ?? '').toUpperCase()} {job.audio.kbps} kbps</span> : job.totalSize && job.status !== 'done' ? job.totalSize : ''}</span></div>
                </div>
                <div className="queue-actions">
                  {job.status === 'done' && job.outputPath && <button title="Play in Lyrigen" onClick={() => onPlayFile(job.outputPath!)}><Icon name="play" size={15} /></button>}
                  {job.status === 'done' && job.outputPath && <button title="Show in folder" onClick={() => void window.electronAPI.showItemInFolder(job.outputPath!)}><Icon name="folder" size={15} /></button>}
                  {(job.status === 'error' || job.status === 'cancelled') && <button title="Retry" onClick={() => void window.electronAPI.retryDownload(job.id)}><Icon name="refresh" size={15} /></button>}
                  {ACTIVE.includes(job.status) && <button title="Cancel" onClick={() => void window.electronAPI.cancelDownload(job.id)}><Icon name="close" size={15} /></button>}
                  {!ACTIVE.includes(job.status) && <button title="Remove from list" onClick={() => void window.electronAPI.removeDownload(job.id)}><Icon name="close" size={15} /></button>}
                </div>
              </div>
            })}
            {jobs.length > shownJobs && <div className="tool-panel-empty">Showing {shownJobs} of {jobs.length} — the rest are working away in the background. <button className="text-link" onClick={() => setShownJobs(count => count + PAGE * 4)}>Show more</button></div>}
            {!jobs.length && <div className="tool-panel-empty">Nothing queued yet.<br />Inspect a link above, check the artist and title, and add it.</div>}
          </div>
        </div>
      </div>

      {showSettings && settings && <aside className="tool-panel">
        <div className="tool-panel-head"><strong>Download options</strong><span>saved automatically</span></div>
        <div className="tool-panel-body settings-grid">
          <label><span>Format</span><select value={settings.format} onChange={event => patchSettings({ format: event.target.value as AudioFormat })}>{FORMATS.map(format => <option key={format.value} value={format.value}>{format.label} — {format.hint}</option>)}</select></label>
          {LOSSLESS_PATH.includes(settings.format)
            ? <div className="field"><span>Quality</span><p className="settings-note" style={{ margin: 0 }}><strong>Best available, untouched.</strong> YouTube's own audio stream is saved exactly as it arrives — no re-encoding, so nothing is lost and there is no conversion step to wait for. Re-encoding is the only thing a quality setting could change, so there is nothing to choose here.</p></div>
            : <label><span>Re-encode quality</span><select value={settings.quality} onChange={event => patchSettings({ quality: event.target.value as AudioQuality })}><option value="best">Best (320k MP3)</option><option value="high">High (~192k)</option><option value="medium">Medium (~128k)</option></select><small className="settings-note">{settings.format.toUpperCase()} is not a format YouTube serves, so every song is decoded and re-encoded on the way in. That always costs a little quality and a lot of time. M4A keeps the original stream instead.</small></label>}
          <div className="field"><span>Destination</span><div className="path-field"><input type="text" value={settings.destination} onChange={event => patchSettings({ destination: event.target.value })} /><button onClick={() => void window.electronAPI.chooseDownloadFolder(settings.destination).then(folder => { if (folder) patchSettings({ destination: folder }) })}>Browse</button></div></div>
          <label><span>Folder layout</span><select value={presets.some(preset => preset.template === settings.pathTemplate) ? settings.pathTemplate : 'custom'} onChange={event => { if (event.target.value !== 'custom') patchSettings({ pathTemplate: event.target.value }) }}>{presets.map(preset => <option key={preset.id} value={preset.template}>{preset.label}</option>)}<option value="custom">Custom template</option></select></label>
          <label><span>Template</span><input type="text" value={settings.pathTemplate} onChange={event => patchSettings({ pathTemplate: event.target.value })} spellCheck={false} /></label>
          <div className="template-preview">{settings.destination}\<b>{templateExample}</b></div>
          <p className="settings-note">Fields: {'{artist} {albumartist} {album} {title} {year} {variant} {genre} {uploader} {id} {track}'}. Add a fallback with a pipe, e.g. {'{album|Singles}'}. Sped-up / Nightcore edits get the variant as their album when there is none.</p>
          <div className="toggle-list">
            <label className="toggle"><input type="checkbox" checked={settings.organize} onChange={event => patchSettings({ organize: event.target.checked })} /><span><strong>Sort into folders</strong><small>Use the layout above. Off = "Artist - Title.ext" straight into the destination.</small></span></label>
            <label className="toggle"><input type="checkbox" checked={settings.fetchLyrics} onChange={event => patchSettings({ fetchLyrics: event.target.checked })} /><span><strong>Fetch lyrics</strong><small>Unison by video id first (exact), then AMLL TTML DB and LRCLIB. Saved as .ttml / .lrc beside the song.</small></span></label>
            <label className="toggle"><input type="checkbox" checked={settings.retimeLyrics} onChange={event => patchSettings({ retimeLyrics: event.target.checked })} /><span><strong>Re-time lyrics for speed edits</strong><small>When a Sped Up / Slowed variant is detected and the lyric source is a different length, timestamps are stretched to fit.</small></span></label>
            <label className="toggle"><input type="checkbox" checked={settings.embedLyrics} disabled={!settings.fetchLyrics} onChange={event => patchSettings({ embedLyrics: event.target.checked })} /><span><strong>Embed lyrics in the song file</strong><small>Writes the words into the file's own tags (ID3 USLT + SYLT for MP3, a lyrics tag elsewhere) so any player shows them. The synced sidecar stays for Lyrigen's word-by-word view.</small></span></label>
            <label className="toggle"><input type="checkbox" checked={settings.embedThumbnail} onChange={event => patchSettings({ embedThumbnail: event.target.checked })} /><span><strong>Embed thumbnail as cover art</strong></span></label>
            <label className="toggle"><input type="checkbox" checked={settings.writeCoverFile} onChange={event => patchSettings({ writeCoverFile: event.target.checked })} /><span><strong>Also save cover.jpg in the folder</strong></span></label>
            <label className="toggle"><input type="checkbox" checked={settings.skipDuplicates} onChange={event => patchSettings({ skipDuplicates: event.target.checked })} /><span><strong>Skip songs you already have</strong><small>Checked against every folder in your library, not just this app's downloads — by YouTube video id first, then artist + song + edit, then song name and length when the uploader is posing as the artist. A playlist that lists the same song twice only downloads it once either way.</small></span></label>
            <label className="toggle"><input type="checkbox" checked={settings.autoRetry} onChange={event => patchSettings({ autoRetry: event.target.checked })} /><span><strong>Retry failures automatically</strong><small>403s, throttling and dropped connections are retried after 15s, 60s then 180s. With no network the queue simply waits instead of failing every song.</small></span></label>
            <label className="toggle"><input type="checkbox" checked={settings.premiumAudio} onChange={event => { patchSettings({ premiumAudio: event.target.checked }); if (event.target.checked) { setStartingPot(true); void window.electronAPI.startPotProvider().then(setPot).finally(() => setStartingPot(false)) } }} /><span><strong>Use YouTube Music's 256 kbps audio</strong><small>Asks YouTube Music for the Premium streams — format 141 (AAC 256k) where it exists, otherwise 774 (Opus ~256k). Everything else falls back to the ordinary 130 kbps stream rather than failing, so turning this on can never cost you a download.</small></span></label>
            {settings.premiumAudio && <div className="field" style={{ marginTop: -4 }}>
              <p className={`cookie-status ${pot?.running && pot.plugin ? 'ok' : 'bad'}`}>
                {startingPot ? 'Starting the token server…' : pot?.running && pot.plugin ? '✓ Token provider running — 256 kbps streams can be requested.' : '! 256 kbps needs a proof-of-origin token provider, and it is not ready.'}
              </p>
              <small className="settings-note">
                Three things have to be true, and YouTube tells you about none of them: a live <b>Premium</b> subscription, a <b>signed-in cookies.txt</b>, and the <b>token provider</b> below. Miss any one and you silently get 130 kbps.<br /><br />
                Provider found: <b>{pot?.folder ?? 'no'}</b> · yt-dlp plugin: <b>{pot?.plugin ? 'installed' : 'missing'}</b> · server: <b>{pot?.running ? 'running' : 'stopped'}</b>.<br /><br />
                To install it: clone <b>github.com/Brainicism/bgutil-ytdlp-pot-provider</b> into <b>%APPDATA%\Lyrigen\pot-provider</b>, run <b>npm ci &amp;&amp; npx tsc</b> in its <b>server</b> folder, and copy its <b>plugin\yt_dlp_plugins</b> folder into <b>%APPDATA%\yt-dlp\plugins\bgutil-pot\</b>. Lyrigen starts the server itself whenever a download needs it. It is third-party software and Lyrigen neither ships nor installs it.
              </small>
              {!pot?.running && pot?.folder && <button className="mini-button" disabled={startingPot} onClick={() => { setStartingPot(true); void window.electronAPI.startPotProvider().then(setPot).finally(() => setStartingPot(false)) }}>Start the token server</button>}
            </div>}
            <label className="toggle"><input type="checkbox" checked={settings.useMusicBrainz} onChange={event => patchSettings({ useMusicBrainz: event.target.checked })} /><span><strong>Verify with MusicBrainz</strong><small>One extra request per song (≈1 s) to confirm artist/title and pick up album, year and genre.</small></span></label>
          </div>
          <label><span>Parallel downloads</span><select value={settings.concurrency} onChange={event => patchSettings({ concurrency: Number(event.target.value) })}>{[1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24].map(value => <option key={value} value={value}>{value}</option>)}</select><small className="settings-note">Each one is a separate yt-dlp process, so the ceiling is your CPU and RAM rather than bandwidth — 24 downloads means 24 processes, then an ffmpeg pass each. Worth knowing: hammering YouTube with many parallel requests from one IP is itself a way to trigger the "confirm you're not a bot" check, so if downloads start failing after raising this, drop it back before blaming cookies.</small></label>
          <div className="field"><span>Auto-sort inbox folder</span><div className="path-field"><input type="text" value={settings.inboxFolder || ''} onChange={event => patchSettings({ inboxFolder: event.target.value || null })} placeholder="e.g. your browser's download folder" /><button onClick={() => void window.electronAPI.chooseDownloadFolder(settings.inboxFolder || undefined).then(folder => { if (folder) patchSettings({ inboxFolder: folder }) })}>Browse</button></div></div>
          <label className="toggle"><input type="checkbox" checked={settings.inboxEnabled} disabled={!settings.inboxFolder} onChange={event => patchSettings({ inboxEnabled: event.target.checked })} /><span><strong>Watch the inbox</strong><small>Any audio file that lands there is tagged, given lyrics and filed into the destination automatically once it stops changing.</small></span></label>
          <label><span>Use cookies from</span><select value={settings.cookieSource} onChange={event => patchSettings({ cookieSource: event.target.value as DownloadSettings['cookieSource'] })}>{COOKIE_SOURCES.map(source => <option key={source.value} value={source.value}>{source.label}</option>)}</select><small className="settings-note">Age-restricted and "Please sign in" videos only download when yt-dlp can use a signed-in session. Cookies are read locally and never leave this PC. Close the browser first — it locks its own cookie database.</small></label>
          {settings.cookieSource !== 'none' && <div className="field"><span>Browser profile folder <em>(optional)</em></span><input type="text" placeholder="e.g. C:\Users\you\AppData\Roaming\Opera Software\Opera GX Stable" value={settings.cookieProfile} onChange={event => patchSettings({ cookieProfile: event.target.value })} /><small className="settings-note">Only needed for browsers yt-dlp cannot find by name — Opera GX, portable installs, or a non-default profile. Leave empty otherwise.</small></div>}
          <div className="field"><span>Or a cookies.txt file</span><div className="path-field"><input type="text" placeholder="C:\Users\you\Downloads\cookies.txt" value={settings.cookieFile} onChange={event => patchSettings({ cookieFile: event.target.value })} /><button onClick={() => void window.electronAPI.chooseCookiesFile().then(result => { if (result) { patchSettings({ cookieFile: result.path }); setCookieCheck({ ok: result.ok, message: result.message }) } })}>Browse</button></div>{cookieCheck && <p className={`cookie-status ${cookieCheck.ok ? 'ok' : 'bad'}`}>{cookieCheck.ok ? '✓ ' : '! '}{cookieCheck.message}</p>}<small className="settings-note"><strong>Prefer Firefox above if you can.</strong> A cookies.txt is a snapshot, and YouTube rotates signed-in cookies within hours — an export that works in the evening can be dead by night, and a long playlist outlives it. Firefox is read live on every download, so it stays signed in as long as the browser does. If you do use a file: export from a <b>private window</b>, visit youtube.com/robots.txt, export, then close the window without signing out. Leave this empty to use the browser instead — a file here always takes priority.</small></div>
          <div className="field"><span>Tools folder</span><div className="path-field"><input type="text" value={settings.toolsFolder || (tools?.tools.find(tool => tool.ok)?.path?.replace(/[\\/][^\\/]+$/, '') ?? '')} readOnly /><button onClick={() => void locateTools()}>Change</button></div></div>
          <div className="field"><span>Better Lyrics API key</span><input type="password" placeholder="Optional — leave empty unless you have one" value={settings.betterLyricsApiKey ?? ''} onChange={event => patchSettings({ betterLyricsApiKey: event.target.value.trim() || null })} /><small>Better Lyrics answers for any song already in its cache without a key, and Lyrigen falls back to Unison, AMLL and LRCLIB when it doesn't. Keys are not currently being issued, so leave this empty. To add a song to the cache, play it once on YouTube Music with the Better Lyrics extension — it then becomes available here too.</small></div>
        </div>
      </aside>}
    </div>
  </section>
}
