import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { app } from 'electron'

/**
 * Thin, careful wrappers around the four command-line tools Lyrigen can use
 * when they are present: yt-dlp (fetch audio from a URL), ffmpeg (convert /
 * write tags), ffprobe (read duration + tags for any container) and ffplay
 * (quick stream preview without downloading).
 *
 * None of them ship inside the repo — ffmpeg alone is 200 MB. Instead the app
 * looks in a few places, in order: a folder chosen in Settings, a `bin`
 * folder next to the packaged app, the well-known `C:\seng` folder this
 * machine already keeps them in, and finally PATH. Everything degrades: with
 * no yt-dlp the Downloads tool explains what is missing instead of failing.
 */

export type ToolName = 'yt-dlp' | 'ffmpeg' | 'ffprobe' | 'ffplay'

export interface ToolStatus {
  name: ToolName
  path: string | null
  version: string | null
  ok: boolean
}

export interface ToolsStatus {
  tools: ToolStatus[]
  searchedFolders: string[]
  ready: boolean
  /** The JavaScript engine yt-dlp will solve YouTube's player challenges with. */
  jsRuntime: JsRuntimeStatus
}

let configuredFolder: string | null = null
const resolvedPaths = new Map<ToolName, string | null>()
const versions = new Map<ToolName, string | null>()

export function setToolsFolder(folder: string | null) {
  configuredFolder = folder && fs.existsSync(folder) ? folder : null
  resolvedPaths.clear()
  versions.clear()
}

function executableName(tool: ToolName) {
  return process.platform === 'win32' ? `${tool}.exe` : tool
}

export function candidateFolders() {
  const folders: string[] = []
  if (configuredFolder) folders.push(configuredFolder)
  try { folders.push(path.join(process.resourcesPath || '', 'bin')) } catch { /* not packaged */ }
  folders.push(path.join(app.getAppPath(), 'bin'))
  folders.push(path.join(app.getPath('userData'), 'bin'))
  if (process.platform === 'win32') {
    folders.push('C:\\seng', 'C:\\ffmpeg\\bin', 'C:\\tools', path.join(app.getPath('home'), 'scoop', 'shims'))
    const winget = path.join(app.getPath('home'), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links')
    folders.push(winget)
  }
  return Array.from(new Set(folders.filter(folder => folder && fs.existsSync(folder))))
}

export function resolveTool(tool: ToolName): string | null {
  if (resolvedPaths.has(tool)) return resolvedPaths.get(tool) ?? null
  const file = executableName(tool)
  let found: string | null = null
  for (const folder of candidateFolders()) {
    const candidate = path.join(folder, file)
    if (fs.existsSync(candidate)) { found = candidate; break }
  }
  if (!found) {
    for (const folder of (process.env.PATH || '').split(path.delimiter)) {
      if (!folder) continue
      const candidate = path.join(folder, file)
      if (fs.existsSync(candidate)) { found = candidate; break }
    }
  }
  resolvedPaths.set(tool, found)
  return found
}

export interface RunResult { code: number | null; stdout: string; stderr: string }

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  /** Called for every stdout/stderr line as it arrives; used for progress parsing. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  /** Receives the child so callers can cancel. */
  onSpawn?: (child: ChildProcess) => void
  /** Cap on captured output so a chatty ffmpeg run cannot balloon memory. */
  maxCapture?: number
  /** Extra environment for the child, merged over the current process env. */
  env?: NodeJS.ProcessEnv
}

/** Run a tool to completion, streaming lines to `onLine`. Never throws for a non-zero exit; inspect `code`. */
export function run(executable: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: options.env ? { ...process.env, ...options.env } : undefined })
    options.onSpawn?.(child)
    const cap = options.maxCapture ?? 400_000
    let stdout = '', stderr = ''
    let settled = false
    const finish = (code: number | null) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }) }
    const timer = options.timeoutMs ? setTimeout(() => { try { child.kill() } catch { /* already gone */ } finish(null) }, options.timeoutMs) : null
    const attach = (stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr') => {
      if (!stream) return
      let buffer = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        if (name === 'stdout') { if (stdout.length < cap) stdout += chunk } else if (stderr.length < cap) stderr += chunk
        if (!options.onLine) return
        buffer += chunk
        // ffmpeg and yt-dlp both redraw progress with \r; treat either terminator as a line end.
        const parts = buffer.split(/\r\n|\r|\n/)
        buffer = parts.pop() ?? ''
        for (const line of parts) if (line.trim()) options.onLine(line, name)
      })
      stream.on('end', () => { if (buffer.trim() && options.onLine) options.onLine(buffer, name) })
    }
    attach(child.stdout, 'stdout')
    attach(child.stderr, 'stderr')
    child.on('error', error => { stderr += `\n${error.message}`; finish(null) })
    child.on('close', code => finish(code))
  })
}

async function readVersion(tool: ToolName, executable: string) {
  if (versions.has(tool)) return versions.get(tool) ?? null
  const args = tool === 'yt-dlp' ? ['--version'] : ['-version']
  const result = await run(executable, args, { timeoutMs: 15_000, maxCapture: 4000 })
  const text = `${result.stdout}\n${result.stderr}`.trim()
  let version: string | null = null
  if (tool === 'yt-dlp') version = text.split(/\r?\n/)[0]?.trim() || null
  else version = text.match(/version\s+(\S+)/i)?.[1] ?? null
  versions.set(tool, version)
  return version
}

export async function toolsStatus(): Promise<ToolsStatus> {
  const names: ToolName[] = ['yt-dlp', 'ffmpeg', 'ffprobe', 'ffplay']
  const tools = await Promise.all(names.map(async name => {
    const resolved = resolveTool(name)
    const version = resolved ? await readVersion(name, resolved).catch(() => null) : null
    return { name, path: resolved, version, ok: Boolean(resolved) }
  }))
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool.ok])) as Record<ToolName, boolean>
  return { tools, searchedFolders: candidateFolders(), ready: byName['yt-dlp'] && byName.ffmpeg, jsRuntime: jsRuntimeStatus() }
}

/** Folder ffmpeg + ffprobe live in, for `yt-dlp --ffmpeg-location`. */
export function ffmpegLocation() {
  const ffmpeg = resolveTool('ffmpeg')
  return ffmpeg ? path.dirname(ffmpeg) : null
}

// ---------------------------------------------------------------------------
// ffprobe
// ---------------------------------------------------------------------------

export interface ProbeResult {
  duration: number | null
  bitrate: number | null
  codec: string | null
  sampleRate: number | null
  tags: Record<string, string>
  hasCover: boolean
}

export async function probe(filePath: string): Promise<ProbeResult | null> {
  const ffprobe = resolveTool('ffprobe')
  if (!ffprobe) return null
  const result = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,bit_rate:format_tags:stream=codec_type,codec_name,sample_rate,disposition', '-of', 'json', filePath], { timeoutMs: 30_000 })
  if (result.code !== 0) return null
  try {
    const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, '')) as {
      format?: { duration?: string; bit_rate?: string; tags?: Record<string, string> }
      streams?: Array<{ codec_type?: string; codec_name?: string; sample_rate?: string; disposition?: { attached_pic?: number } }>
    }
    const audio = parsed.streams?.find(stream => stream.codec_type === 'audio')
    const tags: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed.format?.tags ?? {})) tags[key.toLocaleLowerCase()] = String(value)
    return {
      duration: parsed.format?.duration ? Number(parsed.format.duration) : null,
      bitrate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : null,
      codec: audio?.codec_name ?? null,
      sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
      tags,
      hasCover: Boolean(parsed.streams?.some(stream => stream.codec_type === 'video' || stream.disposition?.attached_pic)),
    }
  } catch { return null }
}

// ---------------------------------------------------------------------------
// ffmpeg tag writing
// ---------------------------------------------------------------------------

export interface TagSet {
  title?: string | null
  artist?: string | null
  album?: string | null
  albumArtist?: string | null
  genre?: string | null
  date?: string | null
  track?: string | number | null
  comment?: string | null
  /** Free-form provenance, e.g. the source URL. Stored in `comment` + `purl`. */
  sourceUrl?: string | null
}

/**
 * Rewrite a file's tags in place with a stream copy — no re-encode, so it
 * takes a fraction of a second and loses no quality. Embedded artwork from
 * yt-dlp `--embed-thumbnail` is carried over. yt-dlp's noisy `description`,
 * `synopsis` and `purl` fields are blanked because a two-paragraph YouTube
 * description is not a useful tag on a song.
 */
export async function writeTags(filePath: string, tags: TagSet, options: { coverPath?: string | null } = {}) {
  const ffmpeg = resolveTool('ffmpeg')
  if (!ffmpeg) throw new Error('ffmpeg was not found, so tags could not be written.')
  const ext = path.extname(filePath).toLocaleLowerCase()
  const temporary = path.join(path.dirname(filePath), `${path.parse(filePath).name}.lyrigen-writing${ext}`)
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', filePath]
  const attachCover = options.coverPath && fs.existsSync(options.coverPath) && (ext === '.mp3' || ext === '.m4a' || ext === '.flac')
  if (attachCover) args.push('-i', options.coverPath!)
  args.push('-map_metadata', '0')
  if (attachCover) args.push('-map', '0:a', '-map', '1:v', '-c:v', ext === '.mp3' ? 'mjpeg' : 'copy', '-disposition:v', 'attached_pic')
  else args.push('-map', '0')
  args.push('-c:a', 'copy')
  if (!attachCover) args.push('-c:v', 'copy')
  if (ext === '.mp3') args.push('-id3v2_version', '3', '-write_id3v1', '1')
  // ffmpeg picks the `ipod` muxer for .m4a, which only accepts AAC and ALAC.
  // yt-dlp happily produces other codecs in an .m4a container, and those fail
  // with "Could not write header (incorrect codec parameters?)". The plain mp4
  // muxer takes them.
  if (ext === '.m4a' || ext === '.mp4') args.push('-f', 'mp4')
  const set = (key: string, value: string | number | null | undefined) => { args.push('-metadata', `${key}=${value === null || value === undefined ? '' : String(value)}`) }
  if (tags.title !== undefined) set('title', tags.title)
  if (tags.artist !== undefined) set('artist', tags.artist)
  if (tags.album !== undefined) set('album', tags.album)
  if (tags.albumArtist !== undefined) set('album_artist', tags.albumArtist)
  if (tags.genre !== undefined) set('genre', tags.genre)
  if (tags.date !== undefined) set('date', tags.date)
  if (tags.track !== undefined) set('track', tags.track)
  set('comment', tags.comment ?? tags.sourceUrl ?? '')
  set('description', '')
  set('synopsis', '')
  set('purl', tags.sourceUrl ?? '')
  args.push(temporary)
  const result = await run(ffmpeg, args, { timeoutMs: 120_000 })
  if (result.code !== 0 || !fs.existsSync(temporary)) {
    try { fs.unlinkSync(temporary) } catch { /* nothing to clean */ }
    throw new Error(result.stderr.trim().split(/\r?\n/).pop() || 'ffmpeg could not write the tags.')
  }
  await fs.promises.rename(temporary, filePath)
}

/** Re-encode / remux into another container. Used when the Organizer is asked to convert. */
export async function convertAudio(input: string, output: string, format: 'mp3' | 'm4a' | 'opus' | 'flac', quality: 'best' | 'high' | 'medium', onLine?: RunOptions['onLine']) {
  const ffmpeg = resolveTool('ffmpeg')
  if (!ffmpeg) throw new Error('ffmpeg was not found.')
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-stats', '-i', input, '-map_metadata', '0', '-map', '0:a:0']
  if (format === 'mp3') args.push('-c:a', 'libmp3lame', ...(quality === 'best' ? ['-b:a', '320k'] : quality === 'high' ? ['-q:a', '0'] : ['-q:a', '3']), '-id3v2_version', '3')
  if (format === 'm4a') args.push('-c:a', 'aac', '-b:a', quality === 'best' ? '256k' : quality === 'high' ? '192k' : '128k', '-movflags', '+faststart')
  if (format === 'opus') args.push('-c:a', 'libopus', '-b:a', quality === 'best' ? '192k' : quality === 'high' ? '128k' : '96k')
  if (format === 'flac') args.push('-c:a', 'flac')
  args.push(output)
  const result = await run(ffmpeg, args, { timeoutMs: 20 * 60_000, onLine })
  if (result.code !== 0) throw new Error(result.stderr.trim().split(/\r?\n/).pop() || 'ffmpeg conversion failed.')
}

// ---------------------------------------------------------------------------
// yt-dlp
// ---------------------------------------------------------------------------

export interface VideoInfo {
  id: string
  title: string
  webpageUrl: string
  uploader: string | null
  channel: string | null
  /** YouTube Music uploads carry real music metadata; fan uploads leave these null. */
  artist: string | null
  track: string | null
  album: string | null
  releaseYear: number | null
  uploadDate: string | null
  duration: number | null
  thumbnail: string | null
  extractor: string
  isPlaylist: boolean
  /** Flat entries when the URL was a playlist. */
  entries?: Array<{ id: string; title: string; url: string; duration: number | null; uploader: string | null }>
  playlistTitle?: string | null
}

const ytDlpCommon = ['--no-warnings', '--no-call-home', '--no-check-certificates', '--ignore-config', '--encoding', 'utf-8']

export type CookieSource = 'none' | 'chrome' | 'edge' | 'firefox' | 'brave' | 'opera' | 'vivaldi' | 'chromium'

/**
 * Browser to borrow YouTube cookies from.
 *
 * Age-restricted and "Please sign in" videos only download when yt-dlp can
 * present a logged-in session. `--cookies-from-browser` reads the cookie jar of
 * a browser you are already signed into, on this machine — nothing leaves the
 * PC and Lyrigen never sees the cookies itself.
 */
let cookieSource: CookieSource = 'none'
let cookieProfile = ''
let cookieFile = ''
export function setCookieSource(source: CookieSource, profile = '', file = '') {
  cookieSource = source
  cookieProfile = profile.trim()
  cookieFile = file.trim()
}
export function getCookieSource() { return cookieSource }

/**
 * A JavaScript engine for yt-dlp to solve YouTube's player challenges with.
 *
 * YouTube signs its media URLs with a challenge that only a real JS engine can
 * answer. yt-dlp ships the solver script but no engine, and enables Deno alone
 * by default, so on a machine without Deno every *signed-in* request comes back
 * as "The page needs to be reloaded." — which looks exactly like a broken
 * cookies.txt and sends people hunting in the wrong place. (Anonymous requests
 * dodge it by falling back to a client that needs no signature, which is why
 * downloads work until you add cookies.)
 *
 * Node is what we look for, because Lyrigen is an Electron app: worst case the
 * bundled Electron binary is itself a Node build, and setting
 * ELECTRON_RUN_AS_NODE on the yt-dlp process makes it behave as one when
 * yt-dlp invokes it.
 */
export interface JsRuntimeStatus { available: boolean; kind: 'deno' | 'node' | 'bun' | 'electron' | null; path: string | null }

let jsRuntime: JsRuntimeStatus | null = null

function locateExecutable(names: string[]) {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const name of names) {
    for (const folder of (process.env.PATH || '').split(path.delimiter)) {
      if (!folder) continue
      for (const suffix of suffixes) {
        const candidate = path.join(folder, `${name}${suffix}`)
        try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate } catch { /* unreadable PATH entry */ }
      }
    }
  }
  return null
}

export function jsRuntimeStatus(): JsRuntimeStatus {
  if (jsRuntime) return jsRuntime
  const deno = locateExecutable(['deno'])
  if (deno) return (jsRuntime = { available: true, kind: 'deno', path: deno })
  const node = locateExecutable(['node'])
  if (node) return (jsRuntime = { available: true, kind: 'node', path: node })
  const bun = locateExecutable(['bun'])
  if (bun) return (jsRuntime = { available: true, kind: 'bun', path: bun })
  // Electron is a Node build wearing a different name; ELECTRON_RUN_AS_NODE (set
  // on the yt-dlp process, inherited by whatever it spawns) uncovers it.
  try {
    if (process.execPath && fs.existsSync(process.execPath)) return (jsRuntime = { available: true, kind: 'electron', path: process.execPath })
  } catch { /* fall through */ }
  return (jsRuntime = { available: false, kind: null, path: null })
}

/** Tell yt-dlp which engine to use. Deno is already its default, so it needs no flag. */
function jsRuntimeArgs() {
  const runtime = jsRuntimeStatus()
  if (!runtime.available || runtime.kind === 'deno') return []
  const name = runtime.kind === 'electron' ? 'node' : runtime.kind
  return ['--js-runtimes', `${name}:${runtime.path}`]
}

/** The environment yt-dlp runs in, so an Electron binary used as the JS engine behaves as Node. */
function ytDlpEnv(): NodeJS.ProcessEnv | undefined {
  return jsRuntimeStatus().kind === 'electron' ? { ELECTRON_RUN_AS_NODE: '1' } : undefined
}

/**
 * How yt-dlp is told to authenticate.
 *
 * A cookies.txt file wins when one is set, because it is the only method that
 * always works: Chromium 127+ encrypts its cookie store with App-Bound
 * Encryption, and yt-dlp then fails with "Failed to decrypt with DPAPI"
 * (yt-dlp#10927). Chromium forks like Opera GX also live outside the default
 * search paths, so `--cookies-from-browser opera:<path>` takes an explicit
 * profile directory.
 */
function authArgs(enabled = true) {
  if (!enabled) return []
  // A cookies.txt that has been moved, renamed or cleared out of Downloads is
  // worse than none at all: yt-dlp takes the path, fails to open it, and the
  // error says nothing about cookies. Fall through to anonymous instead.
  if (cookieFile && fs.existsSync(cookieFile)) return ['--cookies', cookieFile]
  if (cookieSource === 'none') return []
  return ['--cookies-from-browser', cookieProfile ? `${cookieSource}:${cookieProfile}` : cookieSource]
}

/** Is Lyrigen configured to send a signed-in session at all? */
function hasCookies() { return Boolean(cookieFile) || cookieSource !== 'none' }

/**
 * Failures where dropping the cookies is worth a second try.
 *
 * A signed-in request goes down a stricter path than an anonymous one: it needs
 * the player challenge solved, and a stale or partial cookie export makes
 * YouTube answer with an extraction error rather than "please sign in". Most
 * music is public, so falling back to no cookies turns those into a download
 * instead of a red row. The reverse case — genuinely needing a login — is
 * caught by needsCookies() and never reaches here.
 */
function worthRetryingWithoutCookies(message: string) {
  return /page needs to be reloaded|failed to extract|player response|unable to extract|nsig|signature|precondition check failed|content isn.t available|this video is unavailable|no video formats|only images are available/i.test(message)
}

/**
 * Does this cookies.txt actually carry a YouTube login?
 *
 * A "Get cookies.txt" export made while signed out, or one that skips
 * HttpOnly cookies, yields a file holding only `PREF` and `SOCS`. yt-dlp
 * accepts it happily and then fails with "Sign in to confirm you're not a
 * bot", which sends people hunting in the wrong place. Checking for the
 * session cookies up front turns that into a sentence that says what to do.
 */
export function inspectCookiesFile(filePath: string): { ok: boolean; message: string } {
  if (!filePath) return { ok: false, message: 'No cookies file set.' }
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { ok: false, message: 'That file could not be read. Check the path.' }
  }
  const rows = text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))
  if (!rows.length) return { ok: false, message: 'That file has no cookies in it.' }
  const youtube = rows.filter(row => /(^|\.)youtube\.com/i.test(row.split('\t')[0] ?? ''))
  if (!youtube.length) return { ok: false, message: 'No youtube.com cookies in that file. Export it from a YouTube tab while signed in.' }
  const names = new Set(youtube.map(row => (row.split('\t')[5] ?? '').trim()))
  // These are the ones YouTube actually authenticates with, and they are all
  // HttpOnly — an export that misses them still looks plausible, because the
  // third-party `__Secure-3P*` pair does come through. That is the trap: the
  // file has a dozen YouTube cookies, passes a casual look, and every download
  // still fails as though you were signed out.
  const core = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO', '__Secure-1PSID']
  const found = core.filter(name => names.has(name))
  if (!found.length) {
    const thirdParty = ['__Secure-3PSID', '__Secure-3PAPISID', '__Secure-3PSIDTS'].filter(name => names.has(name))
    return {
      ok: false,
      message: thirdParty.length
        ? `This file has ${youtube.length} YouTube cookies, but the ones that sign you in (SID, HSID, SAPISID, LOGIN_INFO) are missing — only the third-party ${thirdParty.join(' / ')} came through. Either the extension skipped HttpOnly cookies, or it filed them under google.com instead of youtube.com. Export again from a youtube.com tab, with HttpOnly cookies included.`
        : `Found ${youtube.length} YouTube cookie${youtube.length === 1 ? '' : 's'}, but none of them is a login. Sign in to YouTube, then export again with an extension that includes HttpOnly cookies.`,
    }
  }
  // A session that is present but past its date fails in a way that reads like
  // a bot check, so it is worth telling apart.
  const now = Date.now() / 1000
  const live = youtube.some(row => {
    const fields = row.split('\t')
    if (!core.includes((fields[5] ?? '').trim())) return false
    const expires = Number(fields[4] ?? 0)
    return expires === 0 || expires > now
  })
  if (!live) return { ok: false, message: 'The login cookies in this file have expired. Sign in to YouTube again and export a fresh one.' }
  return { ok: true, message: `Signed-in session found (${found.join(', ')}).` }
}

/**
 * yt-dlp could not copy the cookie database because the browser has it open
 * (yt-dlp#7271).
 *
 * Worth separating from the decryption failure, because the advice differs —
 * though for a Chromium browser both roads end in the same place: closing it
 * gets past the lock, and the copy then fails to decrypt anyway.
 */
export function isCookieLockedError(message: string) {
  return /could not copy .*cookie database|7271|database is locked|being used by another process/i.test(message)
}

/** Chromium forks all share the cookie store that Chromium 127+ locked down. */
export function isChromiumBrowser(source: CookieSource) {
  return ['chrome', 'edge', 'brave', 'opera', 'vivaldi', 'chromium'].includes(source)
}

// ---------------------------------------------------------------------------
// Proof-of-origin tokens, for YouTube Music's 256 kbps streams
// ---------------------------------------------------------------------------

/**
 * YouTube's `web_music` client is the only one that serves the Premium audio
 * streams (format 774, Opus ~256 kbps, and 141, AAC 256 kbps). It will not hand
 * out media URLs without a proof-of-origin token — an attestation the real site
 * produces in the browser — so yt-dlp skips those formats and leaves you on the
 * 130 kbps stream everyone else gets, with only a warning to say why.
 *
 * yt-dlp's own PO Token Guide points at Brainicism's bgutil provider for this:
 * a small local server that mints the token on request, plus a yt-dlp plugin
 * that asks it. Neither ships with Lyrigen and neither is installed by it —
 * this code only looks for them, and offers to start the server once you have
 * turned Premium audio on yourself. With neither present, nothing changes.
 */
export interface PotStatus {
  /** The provider's folder, if one was found. */
  folder: string | null
  /** Whether the yt-dlp plugin that talks to it is installed. */
  plugin: boolean
  /** Whether the token server is answering right now. */
  running: boolean
}

const POT_PORT = 4416
let potFolder: string | null = null
let potProcess: ChildProcess | null = null

export function setPotProviderFolder(folder: string | null) {
  potFolder = folder && fs.existsSync(folder) ? folder : null
}

/** Where the provider might be, in the order worth trying. */
function potCandidates() {
  const folders: string[] = []
  if (potFolder) folders.push(potFolder)
  for (const base of candidateFolders()) folders.push(path.join(base, 'pot-provider'), path.join(base, 'bgutil-ytdlp-pot-provider'))
  try { folders.push(path.join(app.getPath('home'), 'bgutil-ytdlp-pot-provider')) } catch { /* no home folder */ }
  return folders.filter(folder => fs.existsSync(path.join(folder, 'server', 'build', 'main.js')))
}

/** Is the yt-dlp plugin that asks the server for tokens installed? */
function potPluginInstalled() {
  const roots: string[] = []
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'yt-dlp', 'plugins'))
  try { roots.push(path.join(app.getPath('home'), '.yt-dlp', 'plugins')) } catch { /* no home folder */ }
  const ytDlp = resolveTool('yt-dlp')
  if (ytDlp) roots.push(path.join(path.dirname(ytDlp), 'yt-dlp-plugins'))
  for (const root of roots) {
    let entries: string[] = []
    try { entries = fs.readdirSync(root) } catch { continue }
    for (const entry of entries) {
      try { if (fs.readdirSync(path.join(root, entry, 'yt_dlp_plugins', 'extractor')).some(file => file.startsWith('getpot_'))) return true } catch { /* not this one */ }
    }
  }
  return false
}

/** Is something answering on the token server's port? */
function potServerListening(timeoutMs = 1200) {
  return new Promise<boolean>(resolve => {
    const socket = new net.Socket()
    const done = (result: boolean) => { socket.destroy(); resolve(result) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(POT_PORT, '127.0.0.1')
  })
}

export async function potStatus(): Promise<PotStatus> {
  return { folder: potCandidates()[0] ?? null, plugin: potPluginInstalled(), running: await potServerListening() }
}

/**
 * Start the token server, if it is not already up.
 *
 * Only ever called because Premium audio was switched on, and it needs a real
 * Node or Deno on PATH — the provider is a Node service, and running it through
 * Lyrigen's own Electron binary would mean changing how that binary behaves,
 * which is not a trade worth making for an audio download. One server serves
 * the whole queue: the token is cached and reused across a playlist.
 */
export async function startPotProvider(): Promise<PotStatus> {
  const status = await potStatus()
  if (status.running || !status.folder || potProcess) return status
  const runtime = jsRuntimeStatus()
  if (!runtime.available || !runtime.path || runtime.kind === 'electron') return status
  try {
    potProcess = spawn(runtime.path, [path.join(status.folder, 'server', 'build', 'main.js')], {
      cwd: path.join(status.folder, 'server'), windowsHide: true, stdio: 'ignore',
    })
    potProcess.once('exit', () => { potProcess = null })
  } catch (error) {
    console.warn('Could not start the proof-of-origin token server', error)
    potProcess = null
    return status
  }
  // It binds its port in well under a second; poll rather than guess.
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (await potServerListening(500)) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return potStatus()
}

export function stopPotProvider() {
  if (!potProcess) return
  try { potProcess.kill() } catch { /* already gone */ }
  potProcess = null
}

/**
 * Point a watch link at YouTube Music.
 *
 * The `web_music` client answers for any video id, but the Premium streams are
 * only offered for tracks in the music catalogue, and asking via
 * music.youtube.com is how you say that is what you are after.
 */
export function asMusicUrl(url: string) {
  return url.replace(/^https?:\/\/(?:www\.|m\.)?youtube\.com\//i, 'https://music.youtube.com/')
}

/** The DPAPI failure is specific enough to explain properly rather than pass through raw. */
export function isCookieDecryptError(message: string) {
  return /failed to decrypt with dpapi|dpapi|could not decrypt|app-?bound/i.test(message)
}

/**
 * Errors worth trying again rather than surfacing. YouTube hands out 403s and
 * throttling under load that clear on a retry, and a dropped connection should
 * never look like a broken video.
 */
export function isRetryableYtDlpError(message: string) {
  // The YouTube extractor also throws a handful of its own transient errors —
  // "The page needs to be reloaded" and "try again later" are server-side
  // hiccups that clear on a second attempt, and treating them as fatal makes
  // a job fail that would have worked fifteen seconds later.
  return /403|429|forbidden|timed? out|timeout|connection|network|temporar|unable to download|fragment|read error|getaddrinfo|econnreset|handshake|ssl|page needs to be reloaded|try again later|content isn.t available|failed to extract|player response/i.test(message)
}

/** True when the machine looks offline, so the queue can wait instead of failing every job. */
export function isOfflineError(message: string) {
  return /getaddrinfo|enotfound|econnrefused|network is unreachable|no address associated|temporary failure in name resolution|unable to resolve/i.test(message)
}

/** Sign-in walls need cookies; tell the person that specifically. */
export function needsCookies(message: string) {
  return /sign in|cookies|confirm your age|age-restricted|private video|members-only|not a bot/i.test(message)
}

export async function inspectUrl(url: string, options: { allowPlaylist?: boolean } = {}): Promise<VideoInfo> {
  const ytDlp = resolveTool('yt-dlp')
  if (!ytDlp) throw new Error('yt-dlp was not found. Point Lyrigen at the folder that contains yt-dlp.exe in Downloads → Tools.')
  const build = (withCookies: boolean) => {
    const args = [...ytDlpCommon, ...jsRuntimeArgs(), ...authArgs(withCookies), '--dump-single-json', '--skip-download', '--extractor-retries', '3', '--socket-timeout', '30']
    if (options.allowPlaylist) args.push('--flat-playlist', '--yes-playlist')
    else args.push('--no-playlist')
    args.push(url)
    return args
  }
  // A 5,000-track playlist is several megabytes of JSON and takes minutes to
  // walk, so the budget here is sized for the largest thing someone might
  // paste rather than for a single song.
  const runOptions = { timeoutMs: options.allowPlaylist ? 20 * 60_000 : 120_000, maxCapture: 256_000_000, env: ytDlpEnv() }
  let result = await run(ytDlp, build(true), runOptions)
  if (result.code !== 0 && hasCookies() && worthRetryingWithoutCookies(String(result.stderr))) result = await run(ytDlp, build(false), runOptions)
  if (result.code !== 0) throw new Error(cleanYtDlpError(result.stderr) || 'yt-dlp could not read that link.')
  const info = JSON.parse(result.stdout.replace(/^\uFEFF/, '')) as Record<string, unknown>
  const type = String(info._type ?? 'video')
  if (type === 'playlist') {
    const rawEntries = Array.isArray(info.entries) ? info.entries as Array<Record<string, unknown>> : []
    return {
      id: String(info.id ?? ''),
      title: String(info.title ?? 'Playlist'),
      webpageUrl: String(info.webpage_url ?? url),
      uploader: (info.uploader as string) ?? null,
      channel: (info.channel as string) ?? null,
      artist: null, track: null, album: null, releaseYear: null, uploadDate: null,
      duration: null,
      thumbnail: Array.isArray(info.thumbnails) && (info.thumbnails as Array<{ url?: string }>).length ? String((info.thumbnails as Array<{ url?: string }>).at(-1)?.url ?? '') : null,
      extractor: String(info.extractor ?? ''),
      isPlaylist: true,
      playlistTitle: String(info.title ?? ''),
      entries: rawEntries.filter(entry => entry && entry.id).map(entry => ({
        id: String(entry.id),
        title: String(entry.title ?? entry.id),
        url: String(entry.url ?? entry.webpage_url ?? `https://www.youtube.com/watch?v=${String(entry.id)}`),
        duration: typeof entry.duration === 'number' ? entry.duration : null,
        uploader: (entry.uploader as string) ?? (entry.channel as string) ?? null,
      })),
    }
  }
  const artists = Array.isArray(info.artists) ? (info.artists as string[]).join(', ') : null
  return {
    id: String(info.id ?? ''),
    title: String(info.title ?? info.fulltitle ?? 'Untitled'),
    webpageUrl: String(info.webpage_url ?? url),
    uploader: (info.uploader as string) ?? null,
    channel: (info.channel as string) ?? null,
    artist: (info.artist as string) || artists || (info.creator as string) || null,
    track: (info.track as string) ?? null,
    album: (info.album as string) ?? null,
    releaseYear: typeof info.release_year === 'number' ? info.release_year : (typeof info.release_date === 'string' ? Number(info.release_date.slice(0, 4)) || null : null),
    uploadDate: (info.upload_date as string) ?? null,
    duration: typeof info.duration === 'number' ? info.duration : null,
    thumbnail: (info.thumbnail as string) ?? null,
    extractor: String(info.extractor ?? ''),
    isPlaylist: false,
  }
}

export function cleanYtDlpError(stderr: string) {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const error = lines.find(line => /^ERROR:/i.test(line)) || lines.at(-1) || ''
  return error.replace(/^ERROR:\s*(?:\[[^\]]+\]\s*)?(?:[A-Za-z0-9_-]{11}:\s*)?/i, '').slice(0, 400)
}

export type AudioFormat = 'best' | 'mp3' | 'm4a' | 'opus' | 'flac'
export type AudioQuality = 'best' | 'high' | 'medium'

export interface DownloadProgress {
  percent: number
  /** Human strings straight from yt-dlp, e.g. "3.42MiB/s", "00:12". */
  speed: string | null
  eta: string | null
  totalSize: string | null
  stage: 'downloading' | 'converting' | 'embedding'
}

export interface DownloadOutcome {
  filePath: string
  thumbnailPath: string | null
}

/**
 * Download the best audio stream for `url` into `outputDir`, converting with
 * ffmpeg when a specific format is requested. The file is named by video id
 * so the organiser step can rename it cleanly afterwards; the thumbnail is
 * kept as a sidecar so it can become cover.jpg if the person wants that.
 */
/**
 * Which stream to ask YouTube for, given where it is going to end up.
 *
 * The same song is offered as Opus (webm) and as AAC (m4a) at near-identical
 * bitrates, and plain `bestaudio` prefers Opus. Taking Opus and then converting
 * to M4A re-encodes lossy audio into lossy audio and *loses* bitrate — measured
 * on a 129 kbps Opus stream, the resulting M4A came out at 114 kbps. Asking for
 * the stream that already matches the target container makes yt-dlp skip the
 * conversion entirely ("Not converting audio; file is already in target
 * format"): better sounding, and quicker, since no ffmpeg pass runs at all.
 *
 * MP3 and FLAC have no matching YouTube stream, so those re-encode whatever the
 * best source is and there is nothing to gain by being fussy.
 */
function audioFormatSelector(format: AudioFormat, premiumAudio = false) {
  const ordinary = format === 'm4a'
    ? 'bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio/best'
    : format === 'opus'
      ? 'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio/best'
      : 'bestaudio/best'
  // With Premium and a token, two more streams exist: 141 is AAC 256 kbps and
  // drops straight into an .m4a, 774 is Opus ~256 kbps and does not. 141 goes
  // first for that reason, then anything else above 200 kbps in case YouTube
  // renumbers them, and finally the ordinary list so a track that has no
  // Premium stream still downloads rather than failing.
  return premiumAudio ? `bestaudio[format_id=141]/bestaudio[format_id=774]/bestaudio[abr>200]/${ordinary}` : ordinary
}

/**
 * Let yt-dlp ride out its own hiccups before the queue has to.
 *
 * Retrying inside one process is far cheaper than failing the job and
 * re-extracting the video minutes later, and it matters most on the long runs —
 * a few thousand songs will meet a dropped fragment or a throttled socket
 * whatever the connection is like.
 */
const RESILIENCE_ARGS = ['--retries', '10', '--fragment-retries', '10', '--extractor-retries', '3', '--socket-timeout', '30', '--concurrent-fragments', '4']

export async function downloadAudio(url: string, outputDir: string, options: { format: AudioFormat; quality: AudioQuality; embedThumbnail: boolean; premiumAudio?: boolean; onProgress: (progress: DownloadProgress) => void; onSpawn: (child: ChildProcess) => void }): Promise<DownloadOutcome> {
  const ytDlp = resolveTool('yt-dlp')
  const ffmpegDir = ffmpegLocation()
  if (!ytDlp) throw new Error('yt-dlp was not found.')
  if (!ffmpegDir) throw new Error('ffmpeg was not found; it is needed to extract and tag audio.')
  await fs.promises.mkdir(outputDir, { recursive: true })
  const template = path.join(outputDir, '%(id)s.%(ext)s')
  let finalPath = null as string | null
  let stage: DownloadProgress['stage'] = 'downloading'
  const attempt = (withCookies: boolean) => {
    finalPath = null
    stage = 'downloading'
    const premium = Boolean(options.premiumAudio) && withCookies
    const args = [...ytDlpCommon, ...jsRuntimeArgs(), ...authArgs(withCookies), '--no-playlist', '--newline', '--progress', '--no-mtime', '--no-overwrites', '--ffmpeg-location', ffmpegDir, '-f', audioFormatSelector(options.format, premium), ...RESILIENCE_ARGS, '-x', '--embed-metadata', '--no-embed-info-json', '--write-thumbnail', '--convert-thumbnails', 'jpg', '-o', template, '-o', `thumbnail:${template}`]
    // The Premium streams live behind the music client, which is also the one
    // that needs the token. Dropping both on the anonymous retry is deliberate:
    // without a signed-in session there is nothing there to ask for.
    if (premium) args.push('--extractor-args', 'youtube:player_client=web_music')
    if (options.format !== 'best') {
      args.push('--audio-format', options.format)
      // Only bites when ffmpeg actually re-encodes. When the stream already
      // matches the container yt-dlp copies it and ignores this.
      args.push('--audio-quality', options.quality === 'best' ? '0' : options.quality === 'high' ? '2' : '5')
    }
    if (options.embedThumbnail) args.push('--embed-thumbnail')
    args.push(premium ? asMusicUrl(url) : url)
    return run(ytDlp, args, {
      timeoutMs: 60 * 60_000,
      env: ytDlpEnv(),
      onSpawn: options.onSpawn,
      onLine: line => {
        const progress = line.match(/\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*(\S+))?(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?/)
        if (progress) { options.onProgress({ percent: Number(progress[1]), totalSize: progress[2] ?? null, speed: progress[3] ?? null, eta: progress[4] ?? null, stage }); return }
        if (/\[ExtractAudio\]|\[ffmpeg\]/.test(line)) { stage = 'converting'; options.onProgress({ percent: 100, totalSize: null, speed: null, eta: null, stage }) }
        if (/\[EmbedThumbnail\]|\[Metadata\]/.test(line)) { stage = 'embedding'; options.onProgress({ percent: 100, totalSize: null, speed: null, eta: null, stage }) }
        const destination = line.match(/\[ExtractAudio\] Destination:\s+(.+)$/) || line.match(/\[download\] Destination:\s+(.+)$/) || line.match(/\[download\]\s+(.+?) has already been downloaded/)
        if (destination) finalPath = destination[1].trim()
      },
    })
  }
  let result = await attempt(true)
  // A signed-in request takes a stricter path through YouTube than an anonymous
  // one; when that is what broke, the public stream is usually still there.
  if (result.code !== 0 && hasCookies() && worthRetryingWithoutCookies(String(result.stderr))) result = await attempt(false)
  if (result.code !== 0) throw new Error(cleanYtDlpError(result.stderr) || 'yt-dlp stopped with an error.')
  // yt-dlp prints the pre-conversion destination first and the converted one later; trust the last audio file it mentioned that still exists.
  const audioExtensions = new Set(['.mp3', '.m4a', '.opus', '.flac', '.ogg', '.webm', '.wav', '.aac', '.mka'])
  let filePath: string | null = finalPath && fs.existsSync(finalPath) && audioExtensions.has(path.extname(finalPath).toLocaleLowerCase()) ? finalPath : null
  if (!filePath) {
    const idMatch = result.stdout.match(/\[youtube\]\s+([A-Za-z0-9_-]{11}):/)?.[1]
    const files = (await fs.promises.readdir(outputDir)).filter(file => audioExtensions.has(path.extname(file).toLocaleLowerCase()) && (!idMatch || file.startsWith(idMatch)))
    files.sort((left, right) => fs.statSync(path.join(outputDir, right)).mtimeMs - fs.statSync(path.join(outputDir, left)).mtimeMs)
    if (files[0]) filePath = path.join(outputDir, files[0])
  }
  if (!filePath) throw new Error('The download finished but no audio file was produced.')
  const thumbnailPath = path.join(outputDir, `${path.parse(filePath).name}.jpg`)
  return { filePath, thumbnailPath: fs.existsSync(thumbnailPath) ? thumbnailPath : null }
}

/** `yt-dlp -U`: keeps YouTube extraction working as the site changes. */
export async function updateYtDlp() {
  const ytDlp = resolveTool('yt-dlp')
  if (!ytDlp) throw new Error('yt-dlp was not found.')
  const result = await run(ytDlp, ['-U'], { timeoutMs: 180_000 })
  versions.delete('yt-dlp')
  const text = `${result.stdout}\n${result.stderr}`.trim()
  return { ok: result.code === 0, message: text.split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || (result.code === 0 ? 'yt-dlp is up to date.' : 'Update failed.') }
}

// ---------------------------------------------------------------------------
// ffplay preview
// ---------------------------------------------------------------------------

let previewProcess: ChildProcess | null = null

/**
 * Play the best audio stream of a URL through ffplay without downloading it —
 * a quick "is this the right upload?" check before queueing. Only one preview
 * runs at a time; starting another stops the first.
 */
export async function previewUrl(url: string) {
  stopPreview()
  const ytDlp = resolveTool('yt-dlp'), ffplay = resolveTool('ffplay')
  if (!ytDlp || !ffplay) throw new Error('yt-dlp and ffplay are both needed for stream preview.')
  const resolved = await run(ytDlp, [...ytDlpCommon, '--no-playlist', '-f', 'bestaudio/best', '-g', url], { timeoutMs: 60_000 })
  const streamUrl = resolved.stdout.trim().split(/\r?\n/).filter(Boolean)[0]
  if (resolved.code !== 0 || !streamUrl) throw new Error(cleanYtDlpError(resolved.stderr) || 'Could not resolve a stream to preview.')
  previewProcess = spawn(ffplay, ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', '80', streamUrl], { windowsHide: true, stdio: 'ignore' })
  const child = previewProcess
  child.on('close', () => { if (previewProcess === child) previewProcess = null })
  return true
}

export function stopPreview() {
  if (previewProcess) { try { previewProcess.kill() } catch { /* already gone */ } previewProcess = null }
}

export function isPreviewing() { return Boolean(previewProcess) }

// ---------------------------------------------------------------------------
// Lyric embedding
// ---------------------------------------------------------------------------

/** How a file took its lyrics, for the message shown to the user. */
export type LyricEmbedOutcome = 'id3' | 'tag' | 'unsupported' | 'failed'

/** Containers whose metadata ffmpeg can carry a `lyrics` key in. */
const TAG_LYRIC_EXTENSIONS = new Set(['.m4a', '.mp4', '.flac', '.ogg', '.opus'])

/**
 * A guard, not a real format limit: spawn() passes arguments straight to
 * Windows' 32767-character command line, and a runaway lyric file should not
 * be what breaks a download. The sidecar keeps the untruncated text.
 */
const MAX_EMBEDDED_CHARS = 12_000

/**
 * Write lyrics into the audio file itself so other players see them.
 *
 * MP3 goes through node-id3, which edits the ID3 tag in place: `USLT` for the
 * plain text and `SYLT` for line timing, with every other frame left alone.
 * Other containers get a remuxed `lyrics` tag from ffmpeg — stream copy, so no
 * re-encode and no quality loss. Formats with nowhere to put lyrics (`.wav`,
 * raw `.aac`) report `unsupported` rather than failing the job.
 */
export async function embedLyrics(filePath: string, lyrics: { plain: string; lines?: Array<{ timeMs: number | null; text: string }> | null; language?: string }): Promise<LyricEmbedOutcome> {
  const plain = lyrics.plain.trim().slice(0, MAX_EMBEDDED_CHARS)
  if (!plain) return 'failed'
  const ext = path.extname(filePath).toLocaleLowerCase()
  const language = lyrics.language || 'eng'

  if (ext === '.mp3') {
    try {
      const { default: NodeID3 } = await import('node-id3')
      const timed = (lyrics.lines ?? []).filter((line): line is { timeMs: number; text: string } => typeof line.timeMs === 'number' && Number.isFinite(line.timeMs) && Boolean(line.text))
      const tags: Record<string, unknown> = { unsynchronisedLyrics: { language, text: plain } }
      if (timed.length) {
        tags.synchronisedLyrics = [{
          language,
          // 2 = absolute milliseconds, 1 = the frame carries lyrics (ID3v2.3 §4.10).
          timeStampFormat: 2,
          contentType: 1,
          shortText: '',
          synchronisedText: timed.map(line => ({ text: line.text, timeStamp: Math.max(0, Math.round(line.timeMs)) })),
        }]
      }
      const result = NodeID3.update(tags as Parameters<typeof NodeID3.update>[0], filePath)
      if (result instanceof Error) throw result
      return 'id3'
    } catch (error) {
      console.warn('Could not write ID3 lyrics', error)
      return 'failed'
    }
  }

  if (!TAG_LYRIC_EXTENSIONS.has(ext)) return 'unsupported'

  const ffmpeg = resolveTool('ffmpeg')
  if (!ffmpeg) return 'failed'
  const temporary = path.join(path.dirname(filePath), `${path.parse(filePath).name}.lyrigen-lyrics${ext}`)
  try {
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', filePath,
      '-map', '0', '-map_metadata', '0', '-c', 'copy',
      '-metadata', `lyrics=${plain}`,
      temporary,
    ]
    const result = await run(ffmpeg, args, { timeoutMs: 120_000 })
    if (result.code !== 0 || !fs.existsSync(temporary)) throw new Error(result.stderr.trim().split(/\r?\n/).pop() || 'ffmpeg could not write the lyrics tag.')
    await fs.promises.rename(temporary, filePath)
    return 'tag'
  } catch (error) {
    console.warn('Could not write lyrics tag', error)
    try { fs.unlinkSync(temporary) } catch { /* nothing to clean */ }
    return 'failed'
  }
}
