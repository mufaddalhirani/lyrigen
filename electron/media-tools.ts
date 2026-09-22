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
  const result = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,bit_rate:format_tags:stream=codec_type,codec_name,sample_rate,disposition:stream_tags', '-of', 'json', filePath], { timeoutMs: 30_000 })
  if (result.code !== 0) return null
  try {
    const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, '')) as {
      format?: { duration?: string; bit_rate?: string; tags?: Record<string, string> }
      streams?: Array<{ codec_type?: string; codec_name?: string; sample_rate?: string; disposition?: { attached_pic?: number }; tags?: Record<string, string> }>
    }
    const audio = parsed.streams?.find(stream => stream.codec_type === 'audio')
    const tags: Record<string, string> = {}
    // Ogg keeps its comments on the audio stream, not the file, so reading only
    // file-level tags made every Opus song look untagged \u2014 to the organiser, the
    // duplicate check, everything. Stream tags first, file tags over the top.
    for (const [key, value] of Object.entries(audio?.tags ?? {})) tags[key.toLocaleLowerCase()] = String(value)
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
const OGG_EXTENSIONS = new Set(['.opus', '.ogg', '.oga'])

/**
 * Rewrite an Ogg (Opus / Vorbis) file's comments without losing its cover.
 *
 * ffmpeg reads Ogg cover art — a METADATA_BLOCK_PICTURE comment — as a picture
 * stream, but cannot write a picture stream back into Ogg. So the usual "copy
 * every stream, change a tag" call dies with "Could not write header", and it
 * did for every .opus download: none of them got clean tags or embedded
 * lyrics, and the raw YouTube title stayed as the song's name.
 *
 * Here the audio is copied on its own and the cover goes back in the only form
 * Ogg has for it, the FLAC picture block base64'd into a comment. Everything
 * travels in an ffmetadata file, because a cover as base64 is far longer than
 * a Windows command line allows. Ogg keeps comments on the stream, not the
 * file, which is why the metadata is mapped onto the audio stream itself.
 */
async function rewriteOggTags(filePath: string, updates: Record<string, string | null>, coverFallback?: string | null) {
  const ffmpeg = resolveTool('ffmpeg'), ffprobe = resolveTool('ffprobe')
  if (!ffmpeg || !ffprobe) throw new Error('ffmpeg and ffprobe are both needed to retag Ogg files.')
  const probed = await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,width,height:stream_tags', '-of', 'json', filePath], { timeoutMs: 30_000 })
  const streams = ((JSON.parse(probed.stdout.replace(/^﻿/, '') || '{}') as { streams?: unknown[] }).streams ?? []) as Array<{ index: number; codec_type?: string; codec_name?: string; width?: number; height?: number; tags?: Record<string, string> }>
  const audio = streams.find(stream => stream.codec_type === 'audio')
  const picture = streams.find(stream => stream.codec_type === 'video')
  // Vorbis comment names and ffmpeg's generic names differ for a few fields;
  // fold them together so an update replaces the old value instead of joining it.
  const aliases: Record<string, string> = { albumartist: 'album_artist', 'album artist': 'album_artist', tracknumber: 'track' }
  const keyOf = (name: string) => aliases[name.toLocaleLowerCase()] ?? name.toLocaleLowerCase()
  const merged = new Map<string, string>()
  for (const [name, value] of Object.entries(audio?.tags ?? {})) {
    const key = keyOf(name)
    if (key !== 'metadata_block_picture' && key !== 'encoder') merged.set(key, value)
  }
  for (const [name, value] of Object.entries(updates)) {
    if (value === null || value === '') merged.delete(keyOf(name)); else merged.set(keyOf(name), value)
  }
  const stem = path.join(path.dirname(filePath), `${path.parse(filePath).name}.lyrigen-ogg`)
  const isPng = picture?.codec_name === 'png'
  const coverFile = `${stem}${isPng ? '.png' : '.jpg'}`, metaFile = `${stem}.ffmeta`, temporary = `${stem}${path.extname(filePath)}`
  try {
    let cover: { data: Buffer; mime: string; width: number; height: number } | null = null
    if (picture) {
      const extracted = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', filePath, '-map', `0:${picture.index}`, '-c', 'copy', '-frames:v', '1', '-f', 'image2', coverFile], { timeoutMs: 60_000 })
      if (extracted.code === 0 && fs.existsSync(coverFile)) cover = { data: fs.readFileSync(coverFile), mime: isPng ? 'image/png' : 'image/jpeg', width: picture.width ?? 0, height: picture.height ?? 0 }
    } else if (coverFallback && fs.existsSync(coverFallback)) {
      cover = { data: fs.readFileSync(coverFallback), mime: /\.png$/i.test(coverFallback) ? 'image/png' : 'image/jpeg', width: 0, height: 0 }
    }
    if (cover) merged.set('metadata_block_picture', pictureBlock(cover.data, cover.mime, cover.width, cover.height))
    const escape = (value: string) => value.replace(/[\\=;#\n]/g, match => `\\${match}`)
    fs.writeFileSync(metaFile, `${[';FFMETADATA1', ...Array.from(merged, ([key, value]) => `${escape(key)}=${escape(value)}`)].join('\n')}\n`, 'utf8')
    const result = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', filePath, '-f', 'ffmetadata', '-i', metaFile, '-map', '0:a', '-c', 'copy', '-map_metadata', '-1', '-map_metadata:s:a:0', '1:g', temporary], { timeoutMs: 120_000 })
    if (result.code !== 0 || !fs.existsSync(temporary)) throw new Error(result.stderr.trim().split(/\r?\n/).pop() || 'ffmpeg could not rewrite the Ogg tags.')
    await fs.promises.rename(temporary, filePath)
  } finally {
    for (const leftover of [coverFile, metaFile, temporary]) { try { fs.unlinkSync(leftover) } catch { /* already gone */ } }
  }
}

/** A FLAC picture block — the structure Ogg files carry cover art in — as base64. */
function pictureBlock(image: Buffer, mimeType: string, width: number, height: number) {
  const mime = Buffer.from(mimeType)
  const header = Buffer.alloc(32 + mime.length)
  let offset = 0
  const u32 = (value: number) => { header.writeUInt32BE(value >>> 0, offset); offset += 4 }
  u32(3) // front cover
  u32(mime.length); mime.copy(header, offset); offset += mime.length
  u32(0) // no description
  u32(width); u32(height); u32(24); u32(0)
  u32(image.length)
  return Buffer.concat([header, image]).toString('base64')
}

export async function writeTags(filePath: string, tags: TagSet, options: { coverPath?: string | null } = {}) {
  const ffmpeg = resolveTool('ffmpeg')
  if (!ffmpeg) throw new Error('ffmpeg was not found, so tags could not be written.')
  const ext = path.extname(filePath).toLocaleLowerCase()
  if (OGG_EXTENSIONS.has(ext)) {
    const updates: Record<string, string | null> = {}
    const put = (key: string, value: string | number | null | undefined) => { if (value !== undefined) updates[key] = value === null ? null : String(value) }
    put('title', tags.title); put('artist', tags.artist); put('album', tags.album); put('album_artist', tags.albumArtist)
    put('genre', tags.genre); put('date', tags.date); put('track', tags.track)
    updates.comment = tags.comment ?? tags.sourceUrl ?? null
    updates.purl = tags.sourceUrl ?? null
    // yt-dlp writes the whole video description into these; it is not song metadata.
    updates.description = null
    updates.synopsis = null
    await rewriteOggTags(filePath, updates, options.coverPath)
    return
  }
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
function hasCookies() { return Boolean(cookieFile && fs.existsSync(cookieFile)) || cookieSource !== 'none' }

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
  // Lyrigen's own data folder first. Keeping it beside the tools looked tidy,
  // but the tools folder can double as a music folder, and a Node project full
  // of node_modules is exactly what a person tidying their music deletes.
  try { folders.push(path.join(app.getPath('userData'), 'pot-provider')) } catch { /* not in Electron */ }
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
  return { folder: potCandidates()[0] ?? null, plugin: potPluginInstalled() || await ytDlpSeesPotPlugin(), running: await potServerListening() }
}

/**
 * Ask yt-dlp itself whether it loads a token plugin.
 *
 * The folder check above is a guess at yt-dlp's plugin search, and a guess can
 * disagree with the real thing — it once reported "plugin missing" while
 * yt-dlp was loading the plugin fine, which hid Premium behind a false alarm.
 * `yt-dlp -v` lists the plugin directories it actually loaded in about a
 * second, so that settles it. Cached briefly: a queue asks many times a minute.
 */
let ytDlpPluginCheck: { at: number; value: boolean } | null = null
async function ytDlpSeesPotPlugin() {
  if (ytDlpPluginCheck && Date.now() - ytDlpPluginCheck.at < 5 * 60_000) return ytDlpPluginCheck.value
  const ytDlp = resolveTool('yt-dlp')
  if (!ytDlp) return false
  const result = await run(ytDlp, ['-v', '--ignore-config'], { timeoutMs: 30_000 })
  const listed = `${result.stdout}\n${result.stderr}`.match(/Plugin directories:\s*(.+)/i)?.[1] ?? ''
  const value = listed.split(/,\s*/).some(folder => {
    try { return fs.readdirSync(path.join(folder.trim(), 'extractor')).some(file => file.startsWith('getpot_')) } catch { return false }
  })
  ytDlpPluginCheck = { at: Date.now(), value }
  return value
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
let potStarting: Promise<PotStatus> | null = null

export function startPotProvider(): Promise<PotStatus> {
  // A queue starts a dozen downloads in the same instant, and each one asks
  // for the server. Without a shared promise the first spawns it and the other
  // eleven see "not running yet" and quietly drop to 130 kbps.
  if (!potStarting) potStarting = startPotProviderOnce().finally(() => { potStarting = null })
  return potStarting
}

async function startPotProviderOnce(): Promise<PotStatus> {
  const status = await potStatus()
  if (status.running || !status.folder) return status
  const runtime = jsRuntimeStatus()
  if (!runtime.available || !runtime.path || runtime.kind === 'electron') return status
  if (!potProcess) {
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
function audioFormatSelector(format: AudioFormat, premiumAudio = false, youtube = true, premiumOnly = false) {
  // An upgrade wants a Premium stream or nothing. Without the ordinary tail,
  // yt-dlp refuses before a byte is fetched when the track has none, so
  // checking a whole library costs one lookup per song, not one download.
  // Either Premium codec is fine here — upgrades keep whatever arrives as is.
  if (premiumOnly) return format === 'opus'
    ? 'bestaudio[acodec=opus][abr>200]/bestaudio[acodec^=mp4a][abr>200]'
    : 'bestaudio[acodec^=mp4a][abr>200]/bestaudio[acodec=opus][abr>200]'
  // The trailing `best` is a muxed *video*. On YouTube that is format 18, a
  // 360p clip whose audio track is often HE-AAC at ~50 kbps — and when a client
  // serves no audio-only streams (web_music without its token does exactly
  // that), a selector ending in `best` quietly downloads it, extracts the
  // audio, and hands you something worse than any real audio stream. Measured:
  // God's Plan arrived as 50 kbps HE-AAC this way. On YouTube, no audio-only
  // stream must be an error the caller can react to, never a quiet downgrade.
  // Other sites keep the fallback, since some list audio with no codec info.
  const tail = youtube ? '' : '/best'
  const ordinary = format === 'm4a'
    ? `bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio${tail}`
    : format === 'opus'
      ? `bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio${tail}`
      : `bestaudio${tail}`
  if (!premiumAudio) return ordinary
  // With Premium and a token, two more streams appear: AAC ~258 kbps at 44.1
  // kHz (id 141) and Opus ~261 kbps at 48 kHz (id 774). They are asked for by
  // codec and bitrate rather than by id, because `bestaudio[format_id=141]`
  // matches nothing at all — measured — and a selector that silently fails
  // falls through to the next branch instead of erroring, which is how "best
  // available" quietly became a re-encode down to 119 kbps.
  const premiumAac = 'bestaudio[acodec^=mp4a][abr>200]'
  const premiumOpus = 'bestaudio[acodec=opus][abr>200]'
  // Crossing codecs is never worth it while a container is being targeted: it
  // means decoding a 260 kbps stream and re-encoding it, which is exactly the
  // trade this function exists to avoid. So each target falls back to its own
  // ordinary stream instead, and only the no-conversion paths may cross.
  if (format === 'm4a') return `${premiumAac}/${ordinary}`
  if (format === 'opus') return `${premiumOpus}/${ordinary}`
  if (format === 'best') return `${premiumAac}/${premiumOpus}/${ordinary}`
  // MP3 and FLAC re-encode whatever they are given, so take the best source.
  return `bestaudio[abr>200]/${ordinary}`
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

/** Thrown when an upgrade finds no Premium stream for a track, so the caller can keep the file it has. */
export const NO_PREMIUM_STREAM = 'No Premium stream is offered for this track.'

export async function downloadAudio(url: string, outputDir: string, options: { format: AudioFormat; quality: AudioQuality; embedThumbnail: boolean; premiumAudio?: boolean; requirePremium?: boolean; onProgress: (progress: DownloadProgress) => void; onSpawn: (child: ChildProcess) => void }): Promise<DownloadOutcome> {
  const ytDlp = resolveTool('yt-dlp')
  const ffmpegDir = ffmpegLocation()
  if (!ytDlp) throw new Error('yt-dlp was not found.')
  if (!ffmpegDir) throw new Error('ffmpeg was not found; it is needed to extract and tag audio.')
  await fs.promises.mkdir(outputDir, { recursive: true })
  const template = path.join(outputDir, '%(id)s.%(ext)s')
  let finalPath = null as string | null
  let stage: DownloadProgress['stage'] = 'downloading'
  const youtube = /(?:^|\/\/|\.)(?:youtube\.com|youtu\.be)\//i.test(url)
  // Premium streams come from the music client, and without its token that
  // client serves no audio at all. So only ask for them when the token server
  // is actually answering — starting it here if need be, since this is the
  // first moment it is needed. It used to be started only when the setting was
  // switched on, so after any restart every "Premium" download quietly ran
  // tokenless.
  let premiumReady = false
  if ((options.premiumAudio || options.requirePremium) && youtube && hasCookies()) {
    // A running server is the only thing that has to be true. Whether yt-dlp
    // loads the plugin is settled by trying: without it the music client comes
    // back empty and the ordinary retry below takes over. Gating on a guess
    // about the plugin once kept Premium off while everything worked.
    const pot = await startPotProvider()
    premiumReady = pot.running
  }
  if (options.requirePremium && !premiumReady) throw new Error('Premium audio is not ready: it needs a signed-in session and the token provider. Run the quality check in Downloads to see which part is missing.')
  // An upgrade keeps whichever Premium stream arrives rather than converting it.
  const format: AudioFormat = options.requirePremium ? 'best' : options.format
  const attempt = (withCookies: boolean, premium: boolean) => {
    finalPath = null
    stage = 'downloading'
    const args = [...ytDlpCommon, ...jsRuntimeArgs(), ...authArgs(withCookies), '--no-playlist', '--newline', '--progress', '--no-mtime', '--no-overwrites', '--ffmpeg-location', ffmpegDir, '-f', audioFormatSelector(options.format, premium, youtube, Boolean(options.requirePremium)), ...RESILIENCE_ARGS, '-x', '--embed-metadata', '--no-embed-info-json', '--write-thumbnail', '--convert-thumbnails', 'jpg', '-o', template, '-o', `thumbnail:${template}`]
    // The Premium streams live behind the music client, which is also the one
    // that needs the token. Dropping both on the anonymous retry is deliberate:
    // without a signed-in session there is nothing there to ask for.
    if (premium) args.push('--extractor-args', 'youtube:player_client=web_music')
    if (format !== 'best') {
      args.push('--audio-format', format)
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
  let result = await attempt(true, premiumReady)
  if (options.requirePremium) {
    // No fallbacks for an upgrade: the ordinary stream is what the file already is.
    if (result.code !== 0 && /requested format is not available|no video formats|only images are available/i.test(result.stderr)) throw new Error(NO_PREMIUM_STREAM)
  }
  // The music client can still come back with no audio for a particular
  // track — an official video rather than a catalogue song, or a token that
  // could not be minted. The ordinary clients serve those fine, so try them
  // before calling it a failure.
  if (result.code !== 0 && premiumReady && !options.requirePremium) result = await attempt(true, false)
  // A signed-in request takes a stricter path through YouTube than an anonymous
  // one; when that is what broke, the public stream is usually still there.
  if (result.code !== 0 && hasCookies() && !options.requirePremium && worthRetryingWithoutCookies(String(result.stderr))) result = await attempt(false, false)
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

// ---------------------------------------------------------------------------
// Quality check: what will the next download actually be?
// ---------------------------------------------------------------------------

export interface QualityCheckStep { id: 'tools' | 'engine' | 'signin' | 'token' | 'stream'; label: string; state: 'ok' | 'warn' | 'fail' | 'skip'; detail: string }
export interface QualityCheckResult {
  steps: QualityCheckStep[]
  /** The stream a download would take right now — chosen by yt-dlp itself, not predicted. */
  expected: { formatId: string; codec: string; kbps: number | null; sampleRate: number | null; premium: boolean; converted: string | null } | null
  headline: string
  testedUrl: string
}

/** Rick Astley, 2022 remaster: a catalogue track that has both Premium streams. */
const QUALITY_TEST_URL = 'https://www.youtube.com/watch?v=3BFTio5296w'

function codecName(acodec: string | undefined) {
  if (!acodec) return 'Unknown'
  if (/^opus/i.test(acodec)) return 'Opus'
  if (/mp4a\.40\.5|mp4a\.40\.29/i.test(acodec)) return 'HE-AAC'
  if (/^mp4a|aac/i.test(acodec)) return 'AAC'
  if (/vorbis/i.test(acodec)) return 'Vorbis'
  if (/mp3/i.test(acodec)) return 'MP3'
  return acodec
}

/**
 * Walk the chain a download depends on and say what the file will be.
 *
 * Every link can fail silently: the tools, the JS engine, the sign-in, the
 * token server — and each failure used to mean a smaller file, not an error.
 * The last step is not a prediction. It asks yt-dlp to choose a stream with
 * the exact arguments a download would use, and `--simulate` stops it there,
 * so the answer is whatever the next download will genuinely get.
 */
export async function checkDownloadQuality(options: { format: AudioFormat; premiumAudio: boolean; url?: string | null }): Promise<QualityCheckResult> {
  const steps: QualityCheckStep[] = []
  const url = options.url && /(?:youtube\.com|youtu\.be)\//i.test(options.url) ? options.url : QUALITY_TEST_URL
  const ytDlp = resolveTool('yt-dlp'), ffmpeg = resolveTool('ffmpeg')
  const toolsOk = Boolean(ytDlp && ffmpeg)
  steps.push({ id: 'tools', label: 'yt-dlp and ffmpeg', state: toolsOk ? 'ok' : 'fail', detail: toolsOk ? 'Both found.' : `Missing: ${[ytDlp ? '' : 'yt-dlp', ffmpeg ? '' : 'ffmpeg'].filter(Boolean).join(' and ')}.` })
  if (!ytDlp || !toolsOk) return { steps, expected: null, headline: 'Nothing can download until the tools are found.', testedUrl: url }

  const runtime = jsRuntimeStatus()
  steps.push({ id: 'engine', label: 'JavaScript engine', state: runtime.available ? 'ok' : 'fail', detail: runtime.available ? `${runtime.kind} — solves YouTube's player challenges.` : 'None found. Install Node.js; signed-in downloads fail without one.' })

  let signedIn = false
  if (!hasCookies()) {
    steps.push({ id: 'signin', label: 'YouTube sign-in', state: options.premiumAudio ? 'fail' : 'warn', detail: 'No sign-in set. Choose Firefox under "Use cookies from", with YouTube signed in there.' })
  } else {
    // Reading the first entry of the watch history only succeeds when YouTube
    // itself says the session is logged in; nothing from it is kept or shown.
    const probe = await run(ytDlp, [...ytDlpCommon, ...jsRuntimeArgs(), ...authArgs(true), '--flat-playlist', '--playlist-end', '1', '--print', 'id', ':ythistory'], { timeoutMs: 90_000, env: ytDlpEnv() })
    signedIn = probe.code === 0
    const via = cookieFile ? 'the cookies.txt file' : `${cookieSource[0].toUpperCase()}${cookieSource.slice(1)}`
    steps.push({
      id: 'signin', label: 'YouTube sign-in', state: signedIn ? 'ok' : 'fail',
      detail: signedIn ? `Signed in through ${via}.` : cookieFile
        ? 'The cookies.txt file is no longer signed in. Exported cookies go stale within hours; switch to Firefox for a session that stays live.'
        : `${via} is not signed in to YouTube. Open YouTube there and sign in, then run this again.`,
    })
  }

  let tokenReady = false
  if (!options.premiumAudio) {
    steps.push({ id: 'token', label: 'Premium token server', state: 'skip', detail: '256 kbps audio is switched off.' })
  } else {
    const pot = await startPotProvider()
    // Try Premium whenever the server answers; the test download below is the
    // real verdict on the plugin, and corrects this step if it disagrees.
    tokenReady = pot.running
    steps.push({
      id: 'token', label: 'Premium token server',
      state: pot.running ? (pot.plugin ? 'ok' : 'warn') : 'fail',
      detail: pot.running
        ? pot.plugin ? 'Running.' : 'Running, but yt-dlp does not list the token plugin. The test download below settles whether it works.'
        : !pot.folder ? 'The token provider is not installed.' : 'Found, but it would not start. It needs Node.js on PATH.',
    })
  }

  const pick = async (premium: boolean) => {
    const args = [...ytDlpCommon, ...jsRuntimeArgs(), ...authArgs(true), '--no-playlist', '--simulate', '-f', audioFormatSelector(options.format, premium, true), '--print', '%(format_id)s|%(acodec)s|%(abr)s|%(asr)s']
    if (premium) args.push('--extractor-args', 'youtube:player_client=web_music')
    args.push(premium ? asMusicUrl(url) : url)
    const result = await run(ytDlp, args, { timeoutMs: 120_000, env: ytDlpEnv() })
    const line = result.stdout.split(/\r?\n/).map(entry => entry.trim()).filter(Boolean).pop()
    if (result.code !== 0 || !line) return { error: cleanYtDlpError(result.stderr) || 'yt-dlp found no audio stream.' }
    const [formatId = "?", acodec, abr, asr] = line.split("|")
    const kbps = Number(abr) ? Math.round(Number(abr)) : null
    return { formatId, codec: codecName(acodec), kbps, sampleRate: Number(asr) || null, premium: premium && (kbps ?? 0) > 200 }
  }
  const tryPremium = options.premiumAudio && tokenReady && hasCookies()
  let chosen = tryPremium ? await pick(true) : null
  if (!chosen || 'error' in chosen) chosen = await pick(false)
  if ('error' in chosen) {
    const reason = chosen.error ?? 'yt-dlp found no audio stream.'
    steps.push({ id: 'stream', label: 'Test download', state: 'fail', detail: reason })
    return { steps, expected: null, headline: `Downloads would fail right now: ${reason}`, testedUrl: url }
  }
  const converted = options.format === 'mp3' || options.format === 'flac' ? options.format.toUpperCase() : null
  const expected = { ...chosen, converted }
  // A Premium stream arriving proves the token chain works end to end, so
  // no earlier guess about the plugin gets to say otherwise.
  if (chosen.premium) {
    const token = steps.find(step => step.id === 'token')
    if (token && token.state !== 'ok') Object.assign(token, { state: 'ok', detail: 'Running, and YouTube Music accepted its token.' })
  }
  const described = `${chosen.codec} ${chosen.kbps ?? '?'} kbps${chosen.sampleRate ? `, ${(chosen.sampleRate / 1000).toFixed(1)} kHz` : ''}`
  steps.push({ id: 'stream', label: 'Test download', state: chosen.premium || !options.premiumAudio ? 'ok' : 'warn', detail: `YouTube would send stream ${chosen.formatId}: ${described}.` })

  let headline: string
  if (converted) headline = `Downloads take the ${described} stream and re-encode it to ${converted}, which costs a little quality. Pick M4A or Opus to keep it untouched.`
  else if (chosen.premium) headline = `Downloads will be ${described} — YouTube Music's Premium stream, saved untouched.`
  else if (options.premiumAudio) {
    const blocker = steps.find(step => step.state === 'fail')
    headline = `Downloads will be ${described}. Premium is not coming through${blocker ? `: ${blocker.label.toLowerCase()} — ${blocker.detail}` : ' for this track.'}`
  } else headline = `Downloads will be ${described}, the standard stream. Switch on 256 kbps audio for twice that.`
  return { steps, expected, headline, testedUrl: url }
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

  // Ogg needs the cover-preserving path; the generic one below cannot write it.
  if (OGG_EXTENSIONS.has(ext)) {
    try { await rewriteOggTags(filePath, { lyrics: plain }); return 'tag' } catch (error) { console.warn('Could not write lyrics tag', error); return 'failed' }
  }

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
