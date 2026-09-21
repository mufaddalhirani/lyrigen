import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  selectLibrary: () => ipcRenderer.invoke('select-library'),
  getLibrary: () => ipcRenderer.invoke('get-library'),
  rescanLibrary: () => ipcRenderer.invoke('rescan-library'),
  queryLibrary: (query: unknown) => ipcRenderer.invoke('query-library', query),
  getLibraryStats: () => ipcRenderer.invoke('get-library-stats'),
  getLibraryRoots: () => ipcRenderer.invoke('get-library-roots'),
  addLibraryRoot: () => ipcRenderer.invoke('add-library-root'),
  removeLibraryRoot: (rootPath: string) => ipcRenderer.invoke('remove-library-root', rootPath),
  getPlaylists: () => ipcRenderer.invoke('get-playlists'),
  createPlaylist: (name: string) => ipcRenderer.invoke('create-playlist', name),
  renamePlaylist: (id: string, name: string) => ipcRenderer.invoke('rename-playlist', id, name),
  deletePlaylist: (id: string) => ipcRenderer.invoke('delete-playlist', id),
  addTracksToPlaylist: (id: string, trackIds: string[]) => ipcRenderer.invoke('add-tracks-to-playlist', id, trackIds),
  removeTracksFromPlaylist: (id: string, trackIds: string[]) => ipcRenderer.invoke('remove-tracks-from-playlist', id, trackIds),
  reorderPlaylist: (id: string, trackIds: string[]) => ipcRenderer.invoke('reorder-playlist', id, trackIds),
  getQueueState: () => ipcRenderer.invoke('get-queue-state'),
  updateQueueState: (queue: unknown) => ipcRenderer.invoke('update-queue-state', queue),
  setFavorite: (trackId: string, favorite: boolean) => ipcRenderer.invoke('set-favorite', trackId, favorite),
  setRating: (trackId: string, rating: number) => ipcRenderer.invoke('set-rating', trackId, rating),
  recordPlay: (trackId: string, seconds?: number) => ipcRenderer.invoke('record-play', trackId, seconds),
  getListeningRecap: (range: string) => ipcRenderer.invoke('get-listening-recap', range),
  saveResumePosition: (trackId: string, positionMs: number) => ipcRenderer.invoke('save-resume-position', trackId, positionMs),
  getResumePosition: (trackId: string) => ipcRenderer.invoke('get-resume-position', trackId),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings: unknown) => ipcRenderer.invoke('update-settings', settings),
  clearPlayHistory: () => ipcRenderer.invoke('clear-play-history'),
  clearResumePositions: () => ipcRenderer.invoke('clear-resume-positions'),
  resetWindowBounds: () => ipcRenderer.invoke('reset-window-bounds'),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  importLegacyState: (legacy: unknown) => ipcRenderer.invoke('import-legacy-state', legacy),
  searchCatalog: (query: unknown) => ipcRenderer.invoke('search-catalog', query),
  getCachedCatalogResults: (key?: string) => ipcRenderer.invoke('get-cached-catalog-results', key),
  readFile: (filePath: string) => ipcRenderer.invoke('read-file', filePath),
  getMediaUrl: (filePath: string) => ipcRenderer.invoke('get-media-url', filePath),
  getArtworkUrl: (filePath: string, size: number) => ipcRenderer.invoke('get-artwork-url', filePath, size),
  getAudioMetadata: (filePath: string) => ipcRenderer.invoke('get-audio-metadata', filePath),
  selectAudioFiles: () => ipcRenderer.invoke('select-audio-files'),
  selectAudioFolder: () => ipcRenderer.invoke('select-audio-folder'),
  inspectAudioFiles: (filePaths: string[]) => ipcRenderer.invoke('inspect-audio-files', filePaths),
  lookupTrackMetadata: (request: unknown) => ipcRenderer.invoke('lookup-track-metadata', request),
  writeTrackMetadata: (request: unknown) => ipcRenderer.invoke('write-track-metadata', request),
  findOnlineLyrics: (request: unknown) => ipcRenderer.invoke('find-online-lyrics', request),
  saveLyrics: (audioPath: string, lyricText: string, options?: unknown) => ipcRenderer.invoke('save-lyrics', audioPath, lyricText, options),
  saveTtml: (audioPath: string, ttmlText: string, options?: unknown) => ipcRenderer.invoke('save-ttml', audioPath, ttmlText, options),
  undoLastFileEdit: () => ipcRenderer.invoke('undo-last-file-edit'),
  updateTrackMetadata: (request: unknown) => ipcRenderer.invoke('update-track-metadata', request),
  updateArtwork: (request: unknown) => ipcRenderer.invoke('update-artwork', request),
  chooseLrcFiles: () => ipcRenderer.invoke('choose-lrc-files'),
  saveTtmlFile: (lrcPath: string, ttmlText: string) => ipcRenderer.invoke('save-ttml-file', lrcPath, ttmlText),
  chooseAlignmentJson: () => ipcRenderer.invoke('choose-alignment-json'),
  lookupMusicBrainz: (title: string, artist?: string | null) => ipcRenderer.invoke('lookup-musicbrainz', title, artist),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('show-item-in-folder', filePath),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  updatePlayerState: (state: unknown) => ipcRenderer.send('player-state', state),
  onPlayerCommand: (callback: (command: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: string) => callback(command)
    ipcRenderer.on('player-command', listener)
    return () => ipcRenderer.removeListener('player-command', listener)
  },
  onMiniModeChanged: (callback: (enabled: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, enabled: boolean) => callback(enabled)
    ipcRenderer.on('mini-mode-changed', listener)
    return () => ipcRenderer.removeListener('mini-mode-changed', listener)
  },
  onLibraryUpdated: (callback: (result: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: unknown) => callback(result)
    ipcRenderer.on('library-updated', listener)
    return () => ipcRenderer.removeListener('library-updated', listener)
  },
  onScanProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress)
    ipcRenderer.on('scan-progress', listener)
    return () => ipcRenderer.removeListener('scan-progress', listener)
  },
  // Downloads (yt-dlp + ffmpeg), organiser, Lyrics Finder
  getToolsStatus: () => ipcRenderer.invoke('tools-status'),
  chooseToolsFolder: () => ipcRenderer.invoke('choose-tools-folder'),
  updateYtDlp: () => ipcRenderer.invoke('update-yt-dlp'),
  getDownloadSettings: () => ipcRenderer.invoke('get-download-settings'),
  updateDownloadSettings: (patch: unknown) => ipcRenderer.invoke('update-download-settings', patch),
  chooseDownloadFolder: (current?: string) => ipcRenderer.invoke('choose-download-folder', current),
  inspectDownloadUrl: (url: string, options?: unknown) => ipcRenderer.invoke('inspect-download-url', url, options),
  enqueueDownloads: (items: unknown, options?: unknown) => ipcRenderer.invoke('enqueue-downloads', items, options),
  listDownloads: () => ipcRenderer.invoke('list-downloads'),
  cancelDownload: (id: string) => ipcRenderer.invoke('cancel-download', id),
  retryDownload: (id: string) => ipcRenderer.invoke('retry-download', id),
  removeDownload: (id: string) => ipcRenderer.invoke('remove-download', id),
  clearFinishedDownloads: () => ipcRenderer.invoke('clear-finished-downloads'),
  setDownloadsPaused: (paused: boolean) => ipcRenderer.invoke('set-downloads-paused', paused),
  areDownloadsPaused: () => ipcRenderer.invoke('downloads-paused'),
  updateDownloadMetadata: (id: string, metadata: unknown) => ipcRenderer.invoke('update-download-metadata', id, metadata),
  previewDownloadUrl: (url: string) => ipcRenderer.invoke('preview-download-url', url),
  stopPreview: () => ipcRenderer.invoke('stop-preview'),
  chooseOrganizeSources: () => ipcRenderer.invoke('choose-organize-sources'),
  planOrganize: (inputs: string[], options: unknown) => ipcRenderer.invoke('plan-organize', inputs, options),
  replanOrganizeItem: (item: unknown, options: unknown) => ipcRenderer.invoke('replan-organize-item', item, options),
  applyOrganize: (items: unknown, options: unknown) => ipcRenderer.invoke('apply-organize', items, options),
  undoOrganize: () => ipcRenderer.invoke('undo-organize'),
  canUndoOrganize: () => ipcRenderer.invoke('can-undo-organize'),
  searchLyricCandidates: (request: unknown) => ipcRenderer.invoke('search-lyric-candidates', request),
  fetchLyricCandidate: (candidate: unknown, options?: unknown) => ipcRenderer.invoke('fetch-lyric-candidate', candidate, options),
  saveLyricFile: (audioPath: string, content: string, format: string, options?: unknown) => ipcRenderer.invoke('save-lyric-file', audioPath, content, format, options),
  fetchLyricsForTracks: (tracks: unknown, options?: unknown) => ipcRenderer.invoke('fetch-lyrics-for-tracks', tracks, options),
  onDownloadJob: (callback: (job: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, job: unknown) => callback(job)
    ipcRenderer.on('download-job', listener)
    return () => ipcRenderer.removeListener('download-job', listener)
  },
  onDownloadJobs: (callback: (jobs: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, jobs: unknown) => callback(jobs)
    ipcRenderer.on('download-jobs', listener)
    return () => ipcRenderer.removeListener('download-jobs', listener)
  },
  onOrganizeProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress)
    ipcRenderer.on('organize-progress', listener)
    return () => ipcRenderer.removeListener('organize-progress', listener)
  },
  onInboxProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress)
    ipcRenderer.on('inbox-progress', listener)
    return () => ipcRenderer.removeListener('inbox-progress', listener)
  },
  onLyricsBatchProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress)
    ipcRenderer.on('lyrics-batch-progress', listener)
    return () => ipcRenderer.removeListener('lyrics-batch-progress', listener)
  },
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  toggleFullscreen: () => ipcRenderer.send('window-toggle-fullscreen'),
  setMiniMode: (enabled: boolean) => ipcRenderer.send('window-set-mini', enabled),
  closeWindow: () => ipcRenderer.send('window-close')
})
