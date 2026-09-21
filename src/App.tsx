// Extracted from the former 45KB single-file App.tsx.

import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import './styles/genre-modes.css'
import './styles/metadata-studio.css'
import './styles/tools.css'
import './styles/themes.css'
import appIcon from './assets/lyrigen-icon.png'

import { Player } from './components/Player'
import { LrcConverter } from './components/LrcConverter'
import { MetadataStudio } from './components/MetadataStudio'

import { Icon } from './components/common/Icon'
import { WindowControls } from './components/common/WindowControls'

import { Home } from './views/Home'
import { CollectionView } from './views/CollectionView'
import { ListeningView } from './views/ListeningView'
import { PlaylistHome } from './views/PlaylistHome'
import { SmartHome } from './views/SmartHome'
import { Discover } from './views/Discover'
import { SoundLab } from './views/SoundLab'
import { MetadataInspector } from './views/MetadataInspector'
import { Downloads } from './views/Downloads'
import { Organizer } from './views/Organizer'
import { LyricsHub } from './views/LyricsHub'
import { Settings } from './views/Settings'

import { displayArtist, legacyJson } from './lib/format'
import { smartCollection } from './lib/smart'
import { recallLastView, recallView, rememberView } from './lib/navigation'
import type { View, LibraryMode, SortMode } from './types/views'

export default function App() {
  const [view, setView] = useState<View>(() => recallLastView() ?? 'home'); const [library, setLibrary] = useState<LibraryTrack[]>([]); const [stats, setStats] = useState<LibraryStats | null>(null); const [playlists, setPlaylists] = useState<PlaylistRecord[]>([]); const [queueState, setQueueState] = useState<QueueState>({ currentTrackId: null, upcomingTrackIds: [], historyTrackIds: [], shuffle: false, repeat: 'off', autoplay: true }); const [activePlaylistId, setActivePlaylistId] = useState<string | null>(() => recallView(recallLastView() ?? 'home').activePlaylistId); const [roots, setRoots] = useState<string[]>([]); const [query, setQuery] = useState(() => recallView(recallLastView() ?? 'home').query); const [sort, setSort] = useState<SortMode>(() => recallView(recallLastView() ?? 'home').sort); const [mode, setMode] = useState<LibraryMode>(() => recallView(recallLastView() ?? 'home').mode); const [genreFilter, setGenreFilter] = useState(() => recallView(recallLastView() ?? 'home').genreFilter); const [scanProgress, setScanProgress] = useState<{ completed: number; total: number; phase: 'scanning' | 'complete' | 'error' } | null>(null); const [loading, setLoading] = useState(true); const [toast, setToast] = useState(''); const [playerMode, setPlayerMode] = useState<'dock' | 'full'>('dock'); const [inspectorTrackId, setInspectorTrackId] = useState<string | null>(null); const [metadata, setMetadata] = useState<AudioMetadata | null>(null); const [catalogQuery, setCatalogQuery] = useState(''); const [catalogResults, setCatalogResults] = useState<CatalogResult[]>([]); const [catalogBusy, setCatalogBusy] = useState(false); const [isConverterOpen, setIsConverterOpen] = useState(false); const [showRoots, setShowRoots] = useState(false)
  const [playlistDialog, setPlaylistDialog] = useState<{ track?: LibraryTrack; renameId?: string } | null>(null)
  const [activeDownloads, setActiveDownloads] = useState(0)
  useEffect(() => {
    const active = (jobs: DownloadJob[]) => jobs.filter(job => !['done', 'error', 'cancelled'].includes(job.status)).length
    void window.electronAPI.listDownloads().then(jobs => setActiveDownloads(active(jobs))).catch(() => undefined)
    const offJobs = window.electronAPI.onDownloadJobs(jobs => setActiveDownloads(active(jobs)))
    const offJob = window.electronAPI.onDownloadJob(job => { if (job.status === 'done') { flash(`Downloaded ${job.metadata?.title || job.info?.title || 'a song'}${job.lyricPath ? ' with lyrics' : ''}.`); void window.electronAPI.rescanLibrary().then(() => refresh()) } void window.electronAPI.listDownloads().then(jobs => setActiveDownloads(active(jobs))).catch(() => undefined) })
    const offInbox = window.electronAPI.onInboxProgress(progress => { if (progress.status === 'done' || progress.status === 'error') flash(`${progress.file}: ${progress.message}`) })
    return () => { offJobs(); offJob(); offInbox() }
  }, [])
  /** Play a file by path once it shows up in the library (a finished download, for instance). */
  const playFile = async (audioPath: string) => {
    const id = audioPath.toLocaleLowerCase()
    let track = library.find(item => item.id === id)
    if (!track) { const result = await window.electronAPI.rescanLibrary(); setLibrary(result.items); track = result.items.find(item => item.id === id) }
    if (track) void playTrack(track, [track]); else flash('That file is outside your library folders. Add its folder to play it in Lyrigen.')
  }
  const [playlistName, setPlaylistName] = useState('')
  const flash = (message: string) => { setToast(message); window.setTimeout(() => setToast(current => current === message ? '' : current), 3000) }
  const refresh = async () => { setLoading(true); try { const [libraryResult, nextStats, nextPlaylists, nextQueue, nextRoots] = await Promise.all([window.electronAPI.getLibrary(), window.electronAPI.getLibraryStats(), window.electronAPI.getPlaylists(), window.electronAPI.getQueueState(), window.electronAPI.getLibraryRoots()]); setLibrary(libraryResult.items); setStats(nextStats); setPlaylists(nextPlaylists); setQueueState(nextQueue); setRoots(nextRoots); if (libraryResult.progress) setScanProgress(libraryResult.progress) } catch { flash('Lyrigen could not load the local library.') } finally { setLoading(false) } }
  useEffect(() => { void refresh(); void window.electronAPI.importLegacyState({ rootPath: localStorage.getItem('lyrigen-library-root-v1'), playlist: legacyJson('lyrigen-playlist-v1'), genres: legacyJson('lyrigen-genres-v1'), listeningStats: legacyJson('lyrigen-listening-stats-v1'), visualMode: localStorage.getItem('lyrigen-visual-mode-v1') }) }, [])
  useEffect(() => { const cleanupProgress = window.electronAPI.onScanProgress(progress => setScanProgress(progress)); const cleanupLibrary = window.electronAPI.onLibraryUpdated(result => { setLibrary(result.items); void window.electronAPI.getLibraryStats().then(setStats).catch(() => undefined) }); return () => { cleanupProgress(); cleanupLibrary() } }, [])
  useEffect(() => { const handler = (event: globalThis.KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') { event.preventDefault(); document.querySelector<HTMLInputElement>('.global-search input')?.focus() } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler) }, [])
  useEffect(() => { const routes: Array<[string, View]> = [['view-folders', 'folders'], ['view-library', 'library'], ['view-albums', 'albums'], ['view-artists', 'artists'], ['view-genres', 'genres']]; const cleanups = routes.map(([event, next]) => { const handler = () => { setView(next); setActivePlaylistId(null) }; window.addEventListener(event, handler); return () => window.removeEventListener(event, handler) }); return () => cleanups.forEach(cleanup => cleanup()) }, [])

  // Keep the current screen's state on disk as it changes, so closing the app
  // mid-search reopens exactly there.
  useEffect(() => { rememberView(view, { query, sort, mode, genreFilter, activePlaylistId }) }, [view, query, sort, mode, genreFilter, activePlaylistId])

  // App-level preferences. Autoplay is deliberately opt-in: an app that makes
  // noise before you ask it to is rarely welcome, so the default is off and
  // this only fires once, on the first library load.
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current || loading || !library.length) return
    startedRef.current = true
    void window.electronAPI.getSettings().then(stored => {
      const preferences = stored as Partial<AppSettings>
      if (preferences.reducedMotion) document.documentElement.classList.add('reduce-motion')
      if (!preferences.autoplayOnStartup) return
      const last = queueState.currentTrackId && library.find(track => track.id === queueState.currentTrackId)
      if (last) void playTrack(last, library)
    }).catch(() => undefined)
  }, [loading, library, queueState.currentTrackId])

  const updateQueue = async (next: QueueState) => { setQueueState(next); await window.electronAPI.updateQueueState(next) }
  const currentTrack = library.find(track => track.id === queueState.currentTrackId) ?? null; const upcomingTracks = queueState.upcomingTrackIds.map(id => library.find(track => track.id === id)).filter((track): track is LibraryTrack => Boolean(track)); const queueTracks = currentTrack ? [currentTrack, ...upcomingTracks] : upcomingTracks
  const filteredTracks = useMemo(() => {
    let tracks = [...library]
    if (view === 'smart') {
      if (activePlaylistId === 'lyrics') tracks = tracks.filter(track => !track.lyricPath)
      if (activePlaylistId === 'lossless') tracks = tracks.filter(track => track.lossless)
      if (activePlaylistId === 'videos') tracks = tracks.filter(track => track.videoPath)
      if (activePlaylistId === 'duplicates') tracks = tracks.filter(track => track.possibleDuplicate)
      if (activePlaylistId === 'unrated') tracks = tracks.filter(track => !track.rating)
      if (activePlaylistId === 'favorites') tracks = tracks.filter(track => track.favorite)
    }
    if (view === 'playlists' && activePlaylistId) {
      const playlist = playlists.find(item => item.id === activePlaylistId)
      if (playlist) tracks = playlist.trackIds.map(id => library.find(track => track.id === id)).filter((track): track is LibraryTrack => Boolean(track))
    }
    const normalized = query.trim().toLocaleLowerCase()
    if (normalized) tracks = tracks.filter(track => [track.title, track.artist, track.album, track.genre, track.relativePath].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalized))
    if (genreFilter) tracks = tracks.filter(track => track.genre === genreFilter)
    if (view === 'playlists' && activePlaylistId && sort === 'title') return tracks
    return tracks.sort((left, right) => {
      if (sort === 'artist') return displayArtist(left).localeCompare(displayArtist(right))
      if (sort === 'album') return `${left.album}${left.title}`.localeCompare(`${right.album}${right.title}`)
      if (sort === 'recent') return String(right.lastPlayed).localeCompare(String(left.lastPlayed))
      if (sort === 'plays') return (right.playCount ?? 0) - (left.playCount ?? 0)
      return left.title.localeCompare(right.title, undefined, { sensitivity: 'base', numeric: true })
    })
  }, [activePlaylistId, genreFilter, library, playlists, query, sort, view])
  const genres = useMemo(() => Array.from(new Set(library.map(track => track.genre).filter((genre): genre is string => Boolean(genre)))).sort(), [library]); const albums = useMemo(() => Array.from(new Map(library.map(track => [`${track.album}|${track.artist}`, track])).values()).sort((a, b) => a.album.localeCompare(b.album)), [library]); const artists = useMemo(() => Array.from(new Set(library.map(track => track.artist || 'Unknown artist'))).sort(), [library])
  const playTrack = async (track: LibraryTrack, source = filteredTracks) => {
    const index = source.findIndex(item => item.id === track.id)
    const remaining = source.slice(Math.max(0, index + 1)).map(item => item.id)
    await updateQueue({ ...queueState, currentTrackId: track.id, upcomingTrackIds: remaining, historyTrackIds: source.slice(0, Math.max(0, index)).map(item => item.id) })
    setPlayerMode('full')
  }
  const playNext = async (track: LibraryTrack) => { if (!currentTrack) return playTrack(track); await updateQueue({ ...queueState, upcomingTrackIds: [track.id, ...queueState.upcomingTrackIds.filter(id => id !== track.id && id !== currentTrack.id)], manualTrackIds: [...(queueState.manualTrackIds ?? []).filter(id => id !== track.id), track.id] }); flash(`${track.title} will play next.`) }
  const playLast = async (track: LibraryTrack) => { if (!currentTrack) return playTrack(track); await updateQueue({ ...queueState, upcomingTrackIds: [...queueState.upcomingTrackIds.filter(id => id !== track.id), track.id], manualTrackIds: [...(queueState.manualTrackIds ?? []).filter(id => id !== track.id), track.id] }); flash(`${track.title} added to the end of the queue.`) }
  const selectQueueIndex = async (index: number) => { if (index < 0 || index >= queueTracks.length) return; const target = queueTracks[index]; const old = queueState.currentTrackId; await updateQueue({ ...queueState, currentTrackId: target.id, upcomingTrackIds: queueTracks.slice(index + 1).map(track => track.id), historyTrackIds: old && old !== target.id ? [...queueState.historyTrackIds, old].slice(-100) : queueState.historyTrackIds }) }
  const goNext = () => {
    if (queueTracks[1]) {
      // Anything queued by hand plays in the order it was asked for, even on
      // shuffle. Otherwise "Play next" picks a random song instead and the
      // queue drains without ever reaching the one you chose.
      const manual = queueState.manualTrackIds ?? []
      const requested = queueTracks.slice(1).find(track => manual.includes(track.id))
      const index = requested
        ? queueTracks.indexOf(requested)
        : queueState.shuffle ? 1 + Math.floor(Math.random() * (queueTracks.length - 1)) : 1
      const target = queueTracks[index]
      void updateQueue({ ...queueState, currentTrackId: target.id, upcomingTrackIds: queueState.upcomingTrackIds.filter(id => id !== target.id), manualTrackIds: manual.filter(id => id !== target.id), historyTrackIds: [...queueState.historyTrackIds, currentTrack!.id].slice(-1000) })
    } else if (queueState.repeat === 'all' && currentTrack) {
      const ids = [...new Set([...queueState.historyTrackIds, currentTrack.id])].filter(id => library.some(track => track.id === id))
      if (ids.length > 1) void updateQueue({ ...queueState, currentTrackId: ids[0], upcomingTrackIds: ids.slice(1), historyTrackIds: [] })
    }
  }; const goPrevious = () => { const previousId = queueState.historyTrackIds.at(-1); const previous = library.find(track => track.id === previousId); if (previous && currentTrack) void updateQueue({ ...queueState, currentTrackId: previous.id, upcomingTrackIds: [currentTrack.id, ...queueState.upcomingTrackIds], historyTrackIds: queueState.historyTrackIds.slice(0, -1) }) }
  const reorderQueue = (ids: string[]) => void updateQueue({ ...queueState, upcomingTrackIds: ids.filter(id => id !== queueState.currentTrackId) }); const removeFromQueue = (id: string) => void updateQueue({ ...queueState, upcomingTrackIds: queueState.upcomingTrackIds.filter(item => item !== id) })
  const toggleFavorite = async (track: LibraryTrack) => { const next = await window.electronAPI.setFavorite(track.id, !track.favorite); setLibrary(items => items.map(item => item.id === track.id ? { ...item, favorite: !track.favorite } : item)); setStats(next) }; const rateTrack = async (track: LibraryTrack) => { const rating = track.rating === 5 ? 0 : (track.rating ?? 0) + 1; const next = await window.electronAPI.setRating(track.id, rating); setLibrary(items => items.map(item => item.id === track.id ? { ...item, rating } : item)); setStats(next) }
  const addToPlaylist = async (track: LibraryTrack) => { setPlaylistName(''); setPlaylistDialog({ track }) }
  const newPlaylist = async () => { setPlaylistName(''); setPlaylistDialog({}) }
  const savePlaylist = async () => {
    if (!playlistName.trim()) return
    if (playlistDialog?.renameId) setPlaylists(await window.electronAPI.renamePlaylist(playlistDialog.renameId, playlistName))
    else {
      const next = await window.electronAPI.createPlaylist(playlistName)
      const created = next[next.length - 1]
      setPlaylists(playlistDialog?.track ? await window.electronAPI.addTracksToPlaylist(created.id, [playlistDialog.track.id]) : next)
    }
    setPlaylistDialog(null)
    flash('Playlist saved.')
  }
  const inspect = async (track: LibraryTrack) => { setInspectorTrackId(track.id); setMetadata(null); setMetadata(await window.electronAPI.getAudioMetadata(track.audioPath)) }; const addRoot = async () => { const result = await window.electronAPI.addLibraryRoot(); setLibrary(result.items); setRoots(await window.electronAPI.getLibraryRoots()); setStats(await window.electronAPI.getLibraryStats()); flash('Library folder added.') }; const removeRoot = async (root: string) => { const result = await window.electronAPI.removeLibraryRoot(root); setLibrary(result.items); setRoots(await window.electronAPI.getLibraryRoots()); setStats(await window.electronAPI.getLibraryStats()) }; const searchCatalog = async () => { if (!catalogQuery.trim()) return; setCatalogBusy(true); try { setCatalogResults(await window.electronAPI.searchCatalog({ title: catalogQuery })) } catch { setCatalogResults(await window.electronAPI.getCachedCatalogResults()) } finally { setCatalogBusy(false) } }
  const setViewAndReset = (next: View) => {
    // Park what this screen was showing, then restore whatever the next one
    // was showing last time, instead of blanking both.
    rememberView(view, { query, sort, mode, genreFilter, activePlaylistId })
    const restored = recallView(next)
    setPlayerMode('dock')
    setView(next)
    setQuery(restored.query)
    setSort(restored.sort)
    setMode(restored.mode)
    setGenreFilter(restored.genreFilter)
    setActivePlaylistId(restored.activePlaylistId)
    setIsConverterOpen(false)
  }; const title = view === 'metadata' ? 'Metadata Studio' : view === 'folders' ? 'Folders' : view === 'home' ? 'Welcome back' : view === 'library' ? 'Songs' : view === 'albums' ? 'Albums' : view === 'artists' ? 'Artists' : view === 'genres' ? 'Genres' : view === 'playlists' ? 'Playlists' : view === 'smart' ? (smartCollection(activePlaylistId)?.title ?? 'Smart Library') : view === 'listening' ? 'Listening' : view === 'discover' ? 'Discover' : view === 'downloads' ? 'Downloads' : view === 'organizer' ? 'Organizer' : view === 'lyrics' ? 'Lyrics' : view === 'settings' ? 'Settings' : 'Sound Lab'

  return <div className="nocturne-app"><header className="titlebar"><div className="brand"><img src={appIcon} alt="" /><span>Lyrigen</span><small>Balanced v2</small></div><div className="titlebar-center">YOUR MUSIC · CONNECTED</div><WindowControls /></header><div className="workspace"><aside className="sidebar"><div className="sidebar-heading"><span className="kicker">YOUR SPACE</span><h1>Sound,<br /><i>settled.</i></h1><p>Your music, beautifully organized.</p></div><nav className="nav" aria-label="Library"><button className={view === 'home' ? 'active' : ''} onClick={() => setViewAndReset('home')}><Icon name="home" /><span>Home</span></button><button className={['library', 'folders', 'albums', 'artists', 'genres'].includes(view) ? 'active' : ''} onClick={() => setViewAndReset('folders')}><Icon name="library" /><span>Library</span><b>{library.length || ''}</b></button><button className={view === 'playlists' ? 'active' : ''} onClick={() => setViewAndReset('playlists')}><Icon name="playlist" /><span>Playlists</span><b>{playlists.length || ''}</b></button><button className={view === 'smart' ? 'active' : ''} onClick={() => setViewAndReset('smart')}><Icon name="spark" /><span>Smart Library</span></button><button className={view === 'listening' ? 'active' : ''} onClick={() => setViewAndReset('listening')}><Icon name="clock" /><span>Listening</span></button><button className={view === 'discover' ? 'active' : ''} onClick={() => setViewAndReset('discover')}><Icon name="search" /><span>Discover</span><em>optional</em></button></nav><div className="sidebar-section"><span className="kicker">TOOLS</span><button className={view === 'metadata' ? 'active' : ''} onClick={() => setViewAndReset('metadata')}><Icon name="search" /><span>Metadata Studio</span></button><button className={view === 'downloads' ? 'active' : ''} onClick={() => setViewAndReset('downloads')}><Icon name="download" /><span>Downloads</span>{activeDownloads > 0 && <b>{activeDownloads}</b>}</button><button className={view === 'organizer' ? 'active' : ''} onClick={() => setViewAndReset('organizer')}><Icon name="folder" /><span>Organizer</span></button><button className={view === 'lyrics' ? 'active' : ''} onClick={() => setViewAndReset('lyrics')}><Icon name="lyrics" /><span>Lyrics Finder</span><b>{library.filter(track => !track.lyricPath).length || ''}</b></button><button className={view === 'sound' ? 'active' : ''} onClick={() => setViewAndReset('sound')}><Icon name="sliders" /><span>Sound Lab</span></button><button className={view === 'settings' ? 'active' : ''} onClick={() => setViewAndReset('settings')}><Icon name="more" /><span>Settings</span></button></div><div className="sidebar-bottom"><button className="root-status" onClick={() => setShowRoots(value => !value)}><span className="status-orb" /><span><strong>{loading ? 'Loading your library…' : scanProgress?.phase === 'scanning' ? 'Scanning library…' : roots.length ? `${roots.length} library ${roots.length === 1 ? 'folder' : 'folders'}` : 'Add a library folder'}</strong><small>{scanProgress?.phase === 'scanning' ? `${scanProgress.completed} / ${scanProgress.total} tracks` : 'Local files only'}</small></span></button>{showRoots && <div className="root-popover">{roots.map(root => <div key={root}><span title={root}>{root}</span><button aria-label={`Remove ${root}`} onClick={() => void removeRoot(root)}>×</button></div>)}<button onClick={() => void addRoot()}><Icon name="plus" size={14} /> Add folder</button></div>}<div className="sidebar-foot"><span>NOCTURNE BLOOM</span><span>v2</span></div></div></aside><main className="main-content"><div className="main-topline"><div><span className="kicker">{view === 'home' ? 'WELCOME BACK' : view === 'discover' ? 'CONNECTED, OPTIONAL' : view === 'sound' ? 'TOOLS FOR LISTENING' : view === 'downloads' ? 'YT-DLP · FFMPEG · OPTIONAL' : view === 'organizer' ? 'AUTO FILE SORT' : view === 'lyrics' ? 'CONNECTED, OPTIONAL' : view === 'settings' ? 'HOW THE APP BEHAVES' : 'YOUR COLLECTION'}</span><h2>{title}</h2><p>{view === 'home' ? 'Pick up where you left off, or let the room choose.' : view === 'library' ? 'Everything in one clear, searchable place.' : view === 'discover' ? 'Find lyrics, credits and new music from open catalogs.' : view === 'sound' ? 'Small adjustments, gently applied.' : view === 'downloads' ? 'Fetch, tag, find lyrics and file — one pass.' : view === 'organizer' ? 'Turn loose downloads into a tidy library.' : view === 'lyrics' ? 'Word-synced lyrics from Unison, AMLL and LRCLIB.' : ''}</p></div><div className="top-actions">{!['home', 'discover', 'downloads', 'organizer', 'lyrics', 'settings'].includes(view) && !isConverterOpen && <label className="search-field global-search"><Icon name="search" size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search your library" /><kbd>⌘ K</kbd></label>}{view === 'library' && <button className="icon-button" onClick={() => void window.electronAPI.rescanLibrary().then(() => refresh())} aria-label="Refresh library"><Icon name="refresh" size={17} /></button>}{view === 'playlists' && <button className="accent-button" onClick={() => void newPlaylist()}><Icon name="plus" size={16} /> New playlist</button>}</div></div>{view === 'metadata' ? <MetadataStudio library={library} onApplied={() => { void window.electronAPI.rescanLibrary().then(() => refresh()) }} /> : isConverterOpen ? <div className="converter-wrap"><button className="back-link" onClick={() => setIsConverterOpen(false)}><Icon name="back" size={15} /> Back to Sound Lab</button><LrcConverter /></div> : view === 'home' ? <Home stats={stats} library={library} onPlayRun={tracks => { if (tracks.length) void playTrack(tracks[0], tracks) }} onPlay={track => void playTrack(track, library)} onOpenLibrary={() => library.length ? setViewAndReset('folders') : void addRoot()} onInspect={inspect} onFavorite={toggleFavorite} onPlayNext={playNext} onPlayLast={playLast} onRating={rateTrack} onPlaylist={addToPlaylist} /> : view === 'discover' ? <Discover query={catalogQuery} setQuery={setCatalogQuery} results={catalogResults} busy={catalogBusy} search={() => void searchCatalog()} /> : view === 'sound' ? <SoundLab library={library} /> : view === 'downloads' ? <Downloads flash={flash} onPlayFile={playFile} /> : view === 'organizer' ? <Organizer libraryRoots={roots} flash={flash} /> : view === 'settings' ? <Settings roots={roots} onAddRoot={() => void addRoot()} onRemoveRoot={root => void removeRoot(root)} flash={flash} /> : view === 'lyrics' ? <LyricsHub library={library} flash={flash} onRefresh={() => void window.electronAPI.rescanLibrary().then(() => refresh())} /> : view === 'listening' ? <ListeningView stats={stats} tracks={library} onPlay={track => void playTrack(track, library)} /> : view === 'playlists' && !activePlaylistId ? <PlaylistHome playlists={playlists} onCreate={() => void newPlaylist()} onOpen={id => setActivePlaylistId(id)} onDelete={async id => setPlaylists(await window.electronAPI.deletePlaylist(id))} onRename={id => { setPlaylistName(playlists.find(item => item.id === id)?.name || ''); setPlaylistDialog({ renameId: id }) }} /> : view === 'smart' && !activePlaylistId ? <SmartHome onOpen={id => setActivePlaylistId(id)} stats={stats} /> : <CollectionView smart={view === 'smart' ? smartCollection(activePlaylistId) : null} onLeaveSmart={() => setActivePlaylistId(null)} view={view} tracks={filteredTracks} albums={albums} artists={artists} genres={genres} mode={mode} setMode={setMode} sort={sort} setSort={sort => setSort(sort)} genreFilter={genreFilter} setGenreFilter={setGenreFilter} onPlay={(track, source) => void playTrack(track, source)} onPlayNext={playNext} onPlayLast={playLast} onFavorite={toggleFavorite} onRating={rateTrack} onInspect={inspect} onPlaylist={addToPlaylist} onOpenPlaylist={id => setActivePlaylistId(id)} playlists={playlists} />}</main></div>{inspectorTrackId && <MetadataInspector track={library.find(item => item.id === inspectorTrackId) ?? null} metadata={metadata} onClose={() => setInspectorTrackId(null)} onUndo={() => void window.electronAPI.undoLastFileEdit().then(result => flash(result.message || 'Undo complete.'))} onSaved={() => { void refresh(); flash('Library refreshed after the edit.') }} />}{currentTrack && <Player {...currentTrack} playlist={queueTracks} currentIndex={0} onSelectTrack={index => void selectQueueIndex(index)} onNextTrack={goNext} onPreviousTrack={goPrevious} onQueueReorder={reorderQueue} onQueueRemove={removeFromQueue} onClearQueue={() => void updateQueue({ ...queueState, upcomingTrackIds: [] })} onBack={() => { setPlayerMode('dock'); setView('folders') }} queueShuffle={queueState.shuffle} queueRepeat={queueState.repeat} onPlaybackModes={(shuffle, repeat) => void updateQueue({ ...queueState, shuffle, repeat })} inAppMini={playerMode !== 'full'} onMiniModeChange={enabled => setPlayerMode(enabled ? 'dock' : 'full')} />}{playlistDialog && <div className="dialog-backdrop"><section className="playlist-dialog" role="dialog" aria-modal="true" aria-label="Save playlist"><button className="dialog-close" onClick={() => setPlaylistDialog(null)} aria-label="Close playlist dialog">×</button><h3>{playlistDialog.renameId ? 'Rename playlist' : playlistDialog.track ? 'Add to a playlist' : 'Create a playlist'}</h3>{playlistDialog.track && playlists.map(item => <button className="playlist-choice" key={item.id} onClick={async () => { setPlaylists(await window.electronAPI.addTracksToPlaylist(item.id, [playlistDialog.track!.id])); setPlaylistDialog(null); flash(`Added to ${item.name}.`) }}>{item.name}<small>{item.trackIds.length} tracks</small></button>)}<label>Playlist name<input autoFocus value={playlistName} onChange={event => setPlaylistName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void savePlaylist() }} placeholder="e.g. Night drive" /></label><button className="accent-button" disabled={!playlistName.trim()} onClick={() => void savePlaylist()}>Save</button></section></div>}{toast && <div className="toast"><span className="toast-orb" />{toast}</div>}</div>
}
