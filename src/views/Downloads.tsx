import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/common/Icon'
import { prettyTime } from '../lib/format'

/**
 * Downloads: paste links → inspect (yt-dlp reads title/uploader/duration and
 * the app parses it into artist/title/variant) → review and correct → queue.
 * Each job then downloads, converts, tags (ffmpeg), fetches lyrics (Unison
 * first) and files itself into the destination using the folder template.
 */

const VARIANTS: Array<SongVariant | ''> = ['', 'Sped Up', 'Nightcore', 'Slowed', 'Slowed + Reverb', 'Reverb', 'Lo-Fi', 'Daycore', '8D', 'Bass Boosted', 'Remix', 'Acoustic', 'Live', 'Instrumental', 'Karaoke', 'Cover', 'Mashup']
const FORMATS: Array<{ value: AudioFormat; label: string; hint: string }> = [
  { value: 'mp3', label: 'MP3', hint: 'Plays everywhere; tags + cover embedded' },
  { value: 'm4a', label: 'M4A / AAC', hint: 'Best quality per MB, what YouTube streams' },
  { value: 'opus', label: 'Opus', hint: 'Smallest files, no re-encode from YouTube' },
  { value: 'flac', label: 'FLAC', hint: 'Lossless container (source is still lossy)' },
  { value: 'best', label: 'Original stream', hint: 'No conversion at all' },
]

const ACTIVE: DownloadJobStatus[] = ['queued', 'inspecting', 'downloading', 'converting', 'tagging', 'lyrics', 'organizing', 'waiting', 'paused']

function statusLabel(job: DownloadJob) {
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
  const settingsTimer = useRef<number | null>(null)

  useEffect(() => {
    let active = true
    void Promise.all([window.electronAPI.getDownloadSettings(), window.electronAPI.getToolsStatus(), window.electronAPI.listDownloads()]).then(([downloadSettings, toolsStatus, existing]) => {
      if (!active) return
      setSettings(downloadSettings.settings); setPresets(downloadSettings.presets); setTools(toolsStatus); setJobs(existing)
    })
    void window.electronAPI.areDownloadsPaused().then(value => { if (active) setPaused(value) }).catch(() => undefined)
    const offJob = window.electronAPI.onDownloadJob(job => setJobs(current => current.some(item => item.id === job.id) ? current.map(item => item.id === job.id ? job : item) : [...current, job]))
    const offJobs = window.electronAPI.onDownloadJobs(setJobs)
    return () => { active = false; offJob(); offJobs() }
  }, [])

  const patchSettings = (patch: Partial<DownloadSettings>) => {
    setSettings(current => current ? { ...current, ...patch } : current)
    if (settingsTimer.current) window.clearTimeout(settingsTimer.current)
    settingsTimer.current = window.setTimeout(() => { void window.electronAPI.updateDownloadSettings(patch).then(setSettings) }, 250)
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
    setItems(current => [...current.filter(existing => !found.some(item => item.videoId === existing.videoId)), ...found])
    setInspecting(false)
    if (found.length) setUrls('')
  }

  const editItem = (videoId: string, patch: Partial<SongMetadata>) => setItems(current => current.map(item => item.videoId === videoId ? { ...item, metadata: { ...item.metadata, ...patch, origin: 'manual', confidence: 'high' } } : item))

  const enqueueAll = async () => {
    if (!items.length) return
    const created = await window.electronAPI.enqueueDownloads(items.map(item => ({ url: item.url, videoId: item.videoId, metadata: item.metadata, info: { title: item.info.title, uploader: item.info.uploader, thumbnail: item.info.thumbnail, duration: item.info.duration, extractor: item.info.extractor } })), settings ?? undefined)
    const skipped = items.length - created.length
    setItems([]); setPlaylistTitle(null)
    flash(`${created.length} song${created.length === 1 ? '' : 's'} added to the queue.${skipped > 0 ? ` ${skipped} skipped — already downloaded.` : ''}`)
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

    <div className="tools-strip">
      {(tools?.tools ?? []).map(tool => <span key={tool.name} className={`tool-chip ${tool.ok ? 'ok' : ''}`} title={tool.path || 'Not found'}><i />{tool.name}{tool.version && <small>{tool.version.length > 14 ? tool.version.slice(0, 14) : tool.version}</small>}</span>)}
      <button className="mini-button" onClick={() => void locateTools()}>Locate tools…</button>
      <button className="mini-button" disabled={updating || !tools?.tools.find(tool => tool.name === 'yt-dlp')?.ok} onClick={() => void updateYtDlp()}>{updating ? 'Updating…' : 'Update yt-dlp'}</button>
      <span className="spacer" />
      <button className="text-link" onClick={() => setShowSettings(value => !value)}><Icon name="sliders" size={14} /> {showSettings ? 'Hide options' : 'Download options'}</button>
    </div>

    <div className="tool-columns" style={showSettings ? undefined : { gridTemplateColumns: '1fr' }}>
      <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
        {items.length > 0 && <div className="tool-panel">
          <div className="tool-panel-head"><strong>{playlistTitle ? `Playlist · ${playlistTitle}` : 'Ready to download'}</strong><span>{items.length} song{items.length === 1 ? '' : 's'} · check artist and title before queueing</span></div>
          <div className="inspect-list">
            {items.map(item => <div className="inspect-card" key={item.videoId}>
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
                <div className="inspect-path">{item.alreadyDownloaded ? <>Already downloaded → <b>{item.alreadyDownloaded}</b></> : <>→ <b>{settings ? `${settings.destination}\\…\\` : ''}{item.proposedPath.split(/[\\/]/).slice(-3).join('\\')}</b></>}</div>
              </div>
              <div className="inspect-actions">
                <button className={previewing === item.videoId ? 'active' : ''} title={previewing === item.videoId ? 'Stop preview' : 'Preview the audio stream (ffplay)'} onClick={() => void preview(item)}><Icon name="play" size={16} /></button>
                <button title="Open on the web" onClick={() => void window.electronAPI.openExternal(item.url)}><Icon name="external" size={15} /></button>
                <button title="Remove" onClick={() => setItems(current => current.filter(existing => existing.videoId !== item.videoId))}><Icon name="close" size={15} /></button>
              </div>
            </div>)}
          </div>
          <div className="inspect-footer">
            <p>{settings?.organize ? `Files go to ${settings.destination} using the "${presets.find(preset => preset.template === settings.pathTemplate)?.label ?? 'custom'}" layout.` : `Files go straight into ${settings?.destination}.`}{settings?.fetchLyrics ? ' Lyrics are fetched from Unison, then AMLL and LRCLIB.' : ''}</p>
            <button className="accent-button" disabled={!ready} onClick={() => void enqueueAll()}><Icon name="plus" size={15} /> Add {items.length} to queue</button>
          </div>
        </div>}

        <div className="tool-panel">
          <div className="tool-panel-head"><strong>Queue</strong><div className="row"><span>{activeJobs.length} active · {finishedJobs.length} finished</span>{activeJobs.length > 0 && <button className="mini-button" onClick={() => void window.electronAPI.setDownloadsPaused(!paused).then(setPaused)}>{paused ? 'Resume' : 'Pause'}</button>}{failedJobs.length > 0 && <button className="mini-button" onClick={() => void Promise.all(failedJobs.map(job => window.electronAPI.retryDownload(job.id)))}>Retry all failed ({failedJobs.length})</button>}{finishedJobs.length > 0 && <button className="mini-button" onClick={() => void window.electronAPI.clearFinishedDownloads()}>Clear finished</button>}</div></div>
          <div className="queue-list">
            {[...activeJobs, ...finishedJobs].map(job => {
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
                  <div className="meta"><b>{statusLabel(job)}</b><span>{job.status === 'downloading' ? `${Math.round(job.progress)}%${job.speed ? ` · ${job.speed}` : ''}${job.eta ? ` · ${job.eta}` : ''}` : job.totalSize && job.status !== 'done' ? job.totalSize : ''}</span></div>
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
            {!jobs.length && <div className="tool-panel-empty">Nothing queued yet.<br />Inspect a link above, check the artist and title, and add it.</div>}
          </div>
        </div>
      </div>

      {showSettings && settings && <aside className="tool-panel">
        <div className="tool-panel-head"><strong>Download options</strong><span>saved automatically</span></div>
        <div className="tool-panel-body settings-grid">
          <label><span>Format</span><select value={settings.format} onChange={event => patchSettings({ format: event.target.value as AudioFormat })}>{FORMATS.map(format => <option key={format.value} value={format.value}>{format.label} — {format.hint}</option>)}</select></label>
          <label><span>Quality</span><select value={settings.quality} onChange={event => patchSettings({ quality: event.target.value as AudioQuality })}><option value="best">Best (320k MP3 / 256k AAC)</option><option value="high">High (~192k)</option><option value="medium">Medium (~128k)</option></select></label>
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
            <label className="toggle"><input type="checkbox" checked={settings.skipDuplicates} onChange={event => patchSettings({ skipDuplicates: event.target.checked })} /><span><strong>Skip songs already downloaded</strong><small>Matched by YouTube video id against finished downloads whose file still exists. A playlist that lists the same song twice only downloads it once either way.</small></span></label>
            <label className="toggle"><input type="checkbox" checked={settings.autoRetry} onChange={event => patchSettings({ autoRetry: event.target.checked })} /><span><strong>Retry failures automatically</strong><small>403s, throttling and dropped connections are retried after 15s, 60s then 180s. With no network the queue simply waits instead of failing every song.</small></span></label>
            <label className="toggle"><input type="checkbox" checked={settings.useMusicBrainz} onChange={event => patchSettings({ useMusicBrainz: event.target.checked })} /><span><strong>Verify with MusicBrainz</strong><small>One extra request per song (≈1 s) to confirm artist/title and pick up album, year and genre.</small></span></label>
          </div>
          <label><span>Parallel downloads</span><select value={settings.concurrency} onChange={event => patchSettings({ concurrency: Number(event.target.value) })}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <div className="field"><span>Auto-sort inbox folder</span><div className="path-field"><input type="text" value={settings.inboxFolder || ''} onChange={event => patchSettings({ inboxFolder: event.target.value || null })} placeholder="e.g. your browser's download folder" /><button onClick={() => void window.electronAPI.chooseDownloadFolder(settings.inboxFolder || undefined).then(folder => { if (folder) patchSettings({ inboxFolder: folder }) })}>Browse</button></div></div>
          <label className="toggle"><input type="checkbox" checked={settings.inboxEnabled} disabled={!settings.inboxFolder} onChange={event => patchSettings({ inboxEnabled: event.target.checked })} /><span><strong>Watch the inbox</strong><small>Any audio file that lands there is tagged, given lyrics and filed into the destination automatically once it stops changing.</small></span></label>
          <label><span>Use cookies from</span><select value={settings.cookieSource} onChange={event => patchSettings({ cookieSource: event.target.value as DownloadSettings['cookieSource'] })}>{COOKIE_SOURCES.map(source => <option key={source.value} value={source.value}>{source.label}</option>)}</select><small className="settings-note">Age-restricted and "Please sign in" videos only download when yt-dlp can use a signed-in session. Pick a browser you are already logged into YouTube on — the cookies are read locally by yt-dlp and never leave this PC. Close that browser first; it locks its own cookie database.</small></label>
          <div className="field"><span>Tools folder</span><div className="path-field"><input type="text" value={settings.toolsFolder || (tools?.tools.find(tool => tool.ok)?.path?.replace(/[\\/][^\\/]+$/, '') ?? '')} readOnly /><button onClick={() => void locateTools()}>Change</button></div></div>
          <div className="field"><span>Better Lyrics API key</span><input type="password" placeholder="Optional — leave empty unless you have one" value={settings.betterLyricsApiKey ?? ''} onChange={event => patchSettings({ betterLyricsApiKey: event.target.value.trim() || null })} /><small>Better Lyrics answers for any song already in its cache without a key, and Lyrigen falls back to Unison, AMLL and LRCLIB when it doesn't. Keys are not currently being issued, so leave this empty. To add a song to the cache, play it once on YouTube Music with the Better Lyrics extension — it then becomes available here too.</small></div>
        </div>
      </aside>}
    </div>
  </section>
}
