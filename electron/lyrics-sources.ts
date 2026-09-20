import { createRateLimiter } from './catalog'
import { normalizeKey, primaryArtist } from './song-naming'

/**
 * Every free lyric source Lyrigen knows about, behind one candidate model.
 *
 *  - **Unison** (better-lyrics/unison, https://unison.boidu.dev) — the
 *    crowdsourced database behind the Better Lyrics extension. Entries are
 *    keyed by YouTube video id, which makes it the natural first stop for
 *    anything downloaded with yt-dlp: `GET /lyrics?v=<id>` is an exact match,
 *    no fuzzy title search needed. Search results carry vote counts and a
 *    confidence level, and richsync TTML entries are real word-level timing.
 *    Read endpoints need no key. Attribution: "Lyrics from Unison".
 *  - **AMLL TTML DB** (api.amll.dev) — community mirror of Apple Music
 *    word-synced TTML.
 *  - **LRCLIB** (lrclib.net) — line-synced LRC + plain text.
 *
 * `findBestLyrics()` is the automatic path the player and the downloader use;
 * `searchLyricCandidates()` + `fetchLyricCandidate()` power the Lyrics Finder
 * GUI where the person picks.
 */

export const UNISON_BASE_URL = 'https://unison.boidu.dev'
export const UNISON_ATTRIBUTION = 'Lyrics from Unison (https://unison.boidu.dev)'
const USER_AGENT = 'Lyrigen/2.1.0 (local music player; https://github.com/lyrigen)'

export type LyricFormat = 'ttml' | 'lrc' | 'plain'
/**
 * Timing granularity, best first. `syllable` splits *within* a word (Apple's
 * "Syllable" TTML), `richsync` is one timestamp per word, `linesync` one per
 * line. Ranking prefers the finest available, which is what makes the
 * highlight track the voice instead of jumping a line at a time.
 */
export type LyricSync = 'syllable' | 'richsync' | 'linesync' | 'plain'
export type LyricSourceId = 'betterlyrics' | 'unison' | 'amll' | 'lrclib'

export interface LyricCandidate {
  /** Stable, source-prefixed id, e.g. `unison:1133`. */
  id: string
  source: LyricSourceId
  sourceLabel: string
  sourceUrl: string | null
  song: string
  artist: string
  album: string | null
  /** Seconds, when the source knows it. */
  duration: number | null
  format: LyricFormat
  syncType: LyricSync
  language: string | null
  /** Community confidence for Unison; heuristic match quality elsewhere. */
  confidence: 'high' | 'medium' | 'low'
  votes: number | null
  score: number | null
  submitter: string | null
  videoId: string | null
  /** How well this entry matches what was asked for (0–1), computed locally. */
  match: number
  /** Content is inlined when the search already returned it (LRCLIB); otherwise fetch it by id. */
  content?: string
}

export interface LyricLookupRequest {
  trackName: string
  artistName?: string | null
  albumName?: string | null
  /** Seconds. Leave out for sped-up / slowed edits, where it would only filter out the right song. */
  duration?: number | null
  /** YouTube video id when known — Unison can answer exactly. */
  videoId?: string | null
  /** Restrict to some sources; defaults to all three. */
  sources?: LyricSourceId[]
}

export interface LyricLookupResult {
  found: boolean
  source?: string
  sourceUrl?: string
  id?: number | null
  instrumental?: boolean
  syncedLyrics?: string | null
  plainLyrics?: string | null
  ttmlLyrics?: string | null
  /** The candidate the content came from, so callers can show votes / confidence. */
  candidate?: LyricCandidate
  message?: string
}

const waitForUnison = createRateLimiter(250)
const waitForLrclib = createRateLimiter(350)
const waitForAmll = createRateLimiter(50)
// Better Lyrics publishes a 60/minute limit; one request per second stays under it.
const waitForBetterLyrics = createRateLimiter(1000)

export const BETTER_LYRICS_BASE_URL = 'https://lyrics-api.boidu.dev'
export const BETTER_LYRICS_ATTRIBUTION = 'Lyrics from Better Lyrics (better-lyrics.boidu.dev)'

/**
 * Optional Better Lyrics API key. Cached songs answer without one, which
 * covers most popular music; anything not already in their cache returns 401
 * until a key is set in Settings.
 */
let betterLyricsApiKey: string | null = null
export function setBetterLyricsApiKey(key: string | null) {
  betterLyricsApiKey = key && key.trim() ? key.trim() : null
}
export function hasBetterLyricsApiKey() { return Boolean(betterLyricsApiKey) }

async function getJson<T>(url: string, timeoutMs = 10_000): Promise<T | null> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${new URL(url).host} returned ${response.status}`)
  return response.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Better Lyrics
//
// One endpoint, `GET /getLyrics?s=<song>&a=<artist>`, which aggregates the
// same provider stack the browser extension uses (its own TTML corpus plus
// Musixmatch, BiniLyrics, Kugou and others) and hands back a single Apple-style
// TTML document. That makes it both the highest-quality source — often
// syllable-level — and the broadest, so it is tried first.
// ---------------------------------------------------------------------------

/**
 * Work out how fine the timing in a TTML document actually is.
 *
 * Apple-derived documents state it outright (`itunes:timing="Syllable|Word|
 * Line"`). Otherwise infer it: more timed spans than lines means per-word
 * timing, and several spans inside a single word means per-syllable.
 */
export function ttmlGranularity(ttml: string): LyricSync {
  const declared = ttml.match(/itunes:timing="([^"]+)"/i)?.[1]?.toLowerCase()
  if (declared === 'syllable') return 'syllable'
  if (declared === 'word') return 'richsync'
  if (declared === 'line') return 'linesync'
  const lines = (ttml.match(/<p\b/g) ?? []).length
  const timedSpans = (ttml.match(/<span\b[^>]*\bbegin=/g) ?? []).length
  if (!lines || !timedSpans) return lines ? 'linesync' : 'plain'
  // A span that does not end on whitespace or a word boundary is part of a word.
  const partials = (ttml.match(/<span\b[^>]*\bbegin=[^>]*>[^<\s]*<\/span>(?=<span)/g) ?? []).length
  if (partials > timedSpans * 0.3) return 'syllable'
  return timedSpans > lines ? 'richsync' : 'linesync'
}

/** Pull the plain song title out of a TTML document, for display only. */
function ttmlTitle(ttml: string) {
  return ttml.match(/<ttm:title[^>]*>([^<]+)<\/ttm:title>/i)?.[1]?.trim() || null
}

export async function betterLyricsSearch(request: LyricLookupRequest): Promise<LyricCandidate[]> {
  if (!request.trackName?.trim()) return []
  await waitForBetterLyrics()
  const params = new URLSearchParams({ s: request.trackName })
  if (request.artistName) params.set('a', request.artistName)
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' }
  if (betterLyricsApiKey) headers['X-API-Key'] = betterLyricsApiKey
  // This host sits behind Cloudflare and occasionally refuses the first
  // connection. One retry turns a transient blip into a slower answer rather
  // than a silent downgrade to line-synced lyrics from another source.
  let response: Response | null = null
  for (let attempt = 0; attempt < 2 && !response; attempt++) {
    try {
      response = await fetch(`${BETTER_LYRICS_BASE_URL}/getLyrics?${params}`, { headers, signal: AbortSignal.timeout(15_000) })
    } catch (error) {
      if (attempt === 1) throw error
      await new Promise(resolve => setTimeout(resolve, 600))
    }
  }
  if (!response) return []
  // 404 = no match; 401 = the song is not cached and we have no key. Neither is an error worth surfacing.
  if (response.status === 404 || response.status === 401) return []
  if (!response.ok) throw new Error(`Better Lyrics returned ${response.status}`)
  const body = await response.json() as { ttml?: string; score?: number }
  const ttml = body?.ttml
  if (!ttml || !ttml.includes('<tt')) return []
  const duration = ttmlDuration(ttml)
  const syncType = ttmlGranularity(ttml)
  return [{
    id: 'betterlyrics:1',
    source: 'betterlyrics',
    sourceLabel: 'Better Lyrics',
    sourceUrl: 'https://better-lyrics.boidu.dev/',
    song: ttmlTitle(ttml) || request.trackName,
    artist: request.artistName || '',
    album: request.albumName ?? null,
    duration,
    format: 'ttml',
    syncType,
    language: ttml.match(/xml:lang="([^"]+)"/i)?.[1] ?? null,
    // The API only answers when it is confident, and returns its own match score.
    confidence: typeof body.score === 'number' ? (body.score >= 80 ? 'high' : body.score >= 50 ? 'medium' : 'low') : 'high',
    votes: null,
    score: body.score ?? null,
    submitter: null,
    videoId: null,
    content: ttml,
    match: localMatch(request, ttmlTitle(ttml) || request.trackName, request.artistName || '', duration),
  }]
}

// ---------------------------------------------------------------------------
// Unison
// ---------------------------------------------------------------------------

interface UnisonEntry {
  id: number
  videoId?: string | null
  song?: string
  artist?: string
  album?: string | null
  isrc?: string | null
  duration?: number | null
  lyrics?: string
  format?: LyricFormat
  language?: string | null
  syncType?: LyricSync
  score?: number
  effectiveScore?: number
  voteCount?: number
  confidence?: 'high' | 'medium' | 'low'
  matchScore?: number | null
  submitter?: { displayName?: string | null } | null
}

interface UnisonEnvelope<T> { success: boolean; data: T; error?: string }

function similarity(a: string | null | undefined, b: string | null | undefined) {
  const left = normalizeKey(a || ''), right = normalizeKey(b || '')
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.includes(right) || right.includes(left)) return 0.8
  const leftWords = new Set(left.split(' ')), rightWords = new Set(right.split(' '))
  let shared = 0
  for (const word of leftWords) if (rightWords.has(word)) shared++
  return shared / Math.max(leftWords.size, rightWords.size)
}

/** 0–1 local match quality so candidates from different sources sort together sensibly. */
function localMatch(request: LyricLookupRequest, song: string, artist: string, duration: number | null) {
  const title = similarity(request.trackName, song)
  const byArtist = request.artistName ? similarity(request.artistName, artist) : 0.5
  let score = title * 0.6 + byArtist * 0.4
  if (request.duration && duration) {
    const delta = Math.abs(request.duration - duration)
    if (delta <= 3) score += 0.1
    else if (delta > 20) score -= 0.25
  }
  return Math.max(0, Math.min(1, score))
}

/** Apple-style TTML often states the recording length on `<body dur>`; use it when a source does not report duration. */
export function ttmlDuration(content: string | undefined): number | null {
  const dur = content?.match(/<body[^>]*\sdur="([^"]+)"/)?.[1]
  const ms = dur ? parseTtmlTime(dur) : null
  return ms && ms > 1000 ? ms / 1000 : null
}

function unisonCandidate(entry: UnisonEntry, request: LyricLookupRequest): LyricCandidate {
  const format = entry.format || (entry.lyrics?.includes('<tt') ? 'ttml' : /\[\d+:\d+/.test(entry.lyrics || '') ? 'lrc' : 'plain')
  const duration = entry.duration ?? ttmlDuration(entry.lyrics)
  return {
    id: `unison:${entry.id}`,
    source: 'unison',
    sourceLabel: 'Unison',
    sourceUrl: `${UNISON_BASE_URL}/lyrics/${entry.id}`,
    song: entry.song || request.trackName,
    artist: entry.artist || request.artistName || '',
    album: entry.album || null,
    duration,
    format,
    syncType: entry.syncType || (format === 'ttml' ? 'richsync' : format === 'lrc' ? 'linesync' : 'plain'),
    language: entry.language || null,
    confidence: entry.confidence || 'low',
    votes: entry.voteCount ?? null,
    score: entry.effectiveScore ?? entry.score ?? null,
    submitter: entry.submitter?.displayName || null,
    videoId: entry.videoId || null,
    match: entry.videoId && request.videoId && entry.videoId === request.videoId ? 1 : localMatch(request, entry.song || '', entry.artist || '', duration),
    content: entry.lyrics || undefined,
  }
}

export async function unisonByVideoId(videoId: string, request: LyricLookupRequest): Promise<LyricCandidate | null> {
  await waitForUnison()
  const body = await getJson<UnisonEnvelope<UnisonEntry | null>>(`${UNISON_BASE_URL}/lyrics?v=${encodeURIComponent(videoId)}`)
  if (!body?.success || !body.data?.id) return null
  return unisonCandidate(body.data, request)
}

export async function unisonSearch(request: LyricLookupRequest): Promise<LyricCandidate[]> {
  const params = new URLSearchParams()
  if (request.trackName) params.set('song', request.trackName)
  if (request.artistName) params.set('artist', request.artistName)
  if (request.albumName) params.set('album', request.albumName)
  if (request.duration) params.set('duration', String(Math.round(request.duration)))
  await waitForUnison()
  // The structured search rejects a bare song name with 400. Treat that as
  // "no results" so an untagged file still reaches the free-text search below,
  // which is exactly the case that needs it most.
  let body = await getJson<UnisonEnvelope<UnisonEntry[]>>(`${UNISON_BASE_URL}/lyrics/search?${params}`).catch(error => {
    if (!/returned 4\d\d/.test(String(error))) throw error
    return null
  })
  let entries = body?.success && Array.isArray(body.data) ? body.data : []
  // Structured search is strict about the artist; the free-text `q` search also covers ISRC/lyrics content and copes with "feat." noise.
  if (!entries.length && request.trackName) {
    await waitForUnison()
    body = await getJson<UnisonEnvelope<UnisonEntry[]>>(`${UNISON_BASE_URL}/lyrics/search?q=${encodeURIComponent([request.trackName, request.artistName].filter(Boolean).join(' '))}`)
    entries = body?.success && Array.isArray(body.data) ? body.data : []
  }
  return entries.map(entry => unisonCandidate(entry, request)).filter(candidate => candidate.match >= 0.35)
}

export async function unisonGet(id: number): Promise<{ content: string; format: LyricFormat; entry: UnisonEntry } | null> {
  await waitForUnison()
  const body = await getJson<UnisonEnvelope<UnisonEntry | null>>(`${UNISON_BASE_URL}/lyrics/${id}`)
  if (!body?.success || !body.data?.lyrics) return null
  const entry = body.data
  const format = entry.format || (entry.lyrics!.includes('<tt') ? 'ttml' : /\[\d+:\d+/.test(entry.lyrics!) ? 'lrc' : 'plain')
  return { content: entry.lyrics!, format, entry }
}

// ---------------------------------------------------------------------------
// AMLL TTML DB
// ---------------------------------------------------------------------------

/**
 * The AMLL search endpoint returns every known *alias* for a track, not one
 * name: `musicNames: ["Flashing Lights", "Flashing Lights (feat. Dwele)"]`,
 * `artistNames: ["Kanye West", "Ye", "Ye (侃爷)"]`. It reports no duration.
 */
interface AmllItem { id: number; musicNames?: string[]; artistNames?: string[]; albumNames?: string[]; isrcs?: string[] }

/** Pick the alias closest to what we asked for, so "Ye" still matches "Kanye West". */
function bestAlias(names: string[] | undefined, wanted: string | null | undefined) {
  const list = (names ?? []).filter(name => typeof name === 'string' && name.trim())
  if (!list.length) return ''
  if (!wanted) return list[0]
  return list.reduce((best, name) => (similarity(wanted, name) > similarity(wanted, best) ? name : best), list[0])
}

export async function amllSearch(request: LyricLookupRequest): Promise<LyricCandidate[]> {
  if (!request.trackName?.trim()) return []
  await waitForAmll()
  const params = new URLSearchParams({ musicName: request.trackName, pageSize: '6' })
  if (request.artistName) params.set('artistName', request.artistName)
  const body = await getJson<{ data?: { items?: AmllItem[] } }>(`https://api.amll.dev/v1/lyrics/search?${params}`, 8_000)
  return (body?.data?.items ?? []).map(item => {
    const song = bestAlias(item.musicNames, request.trackName)
    const artist = bestAlias(item.artistNames, request.artistName)
    return {
      id: `amll:${item.id}`,
      source: 'amll' as const,
      sourceLabel: 'AMLL TTML DB',
      sourceUrl: `https://api.amll.dev/v1/lyrics/get?id=${item.id}`,
      song: song || request.trackName,
      artist: artist || request.artistName || '',
      album: bestAlias(item.albumNames, request.albumName) || null,
      // AMLL reports no duration; the TTML itself carries one, read after fetching.
      duration: null,
      format: 'ttml' as const,
      syncType: 'richsync' as const,
      language: null,
      confidence: 'medium' as const,
      votes: null,
      score: null,
      submitter: null,
      videoId: null,
      match: localMatch(request, song, artist, null),
    }
  }).filter(candidate => candidate.match >= 0.35)
}

export async function amllGet(id: number): Promise<string | null> {
  await waitForAmll()
  const body = await getJson<{ data?: { lyrics?: string } }>(`https://api.amll.dev/v1/lyrics/get?id=${id}`, 8_000)
  const ttml = body?.data?.lyrics
  return ttml && ttml.includes('<tt') ? ttml : null
}

// ---------------------------------------------------------------------------
// LRCLIB
// ---------------------------------------------------------------------------

interface LrclibItem { id?: number; trackName?: string; artistName?: string; albumName?: string; duration?: number; instrumental?: boolean; syncedLyrics?: string | null; plainLyrics?: string | null }

function lrclibCandidate(item: LrclibItem, request: LyricLookupRequest): LyricCandidate | null {
  const content = item.syncedLyrics || item.plainLyrics
  if (!content) return null
  return {
    id: `lrclib:${item.id ?? Math.random().toString(36).slice(2)}`,
    source: 'lrclib',
    sourceLabel: 'LRCLIB',
    sourceUrl: item.id ? `https://lrclib.net/api/get/${item.id}` : null,
    song: item.trackName || request.trackName,
    artist: item.artistName || request.artistName || '',
    album: item.albumName || null,
    duration: item.duration ?? null,
    format: item.syncedLyrics ? 'lrc' : 'plain',
    syncType: item.syncedLyrics ? 'linesync' : 'plain',
    language: null,
    confidence: item.syncedLyrics ? 'medium' : 'low',
    votes: null,
    score: null,
    submitter: null,
    videoId: null,
    match: localMatch(request, item.trackName || '', item.artistName || '', item.duration ?? null),
    content,
  }
}

export async function lrclibSearch(request: LyricLookupRequest): Promise<LyricCandidate[]> {
  if (!request.trackName?.trim()) return []
  const results: LyricCandidate[] = []
  // Exact endpoint first (needs artist + duration to be meaningful), then the tolerant search.
  if (request.artistName && request.duration) {
    await waitForLrclib()
    const params = new URLSearchParams({ track_name: request.trackName, artist_name: request.artistName, duration: String(Math.round(request.duration)) })
    if (request.albumName) params.set('album_name', request.albumName)
    try {
      const exact = await getJson<LrclibItem>(`https://lrclib.net/api/get?${params}`)
      const candidate = exact ? lrclibCandidate(exact, request) : null
      if (candidate) { candidate.confidence = 'high'; candidate.match = Math.max(candidate.match, 0.95); results.push(candidate) }
    } catch (error) { console.warn('LRCLIB exact lookup failed', error) }
  }
  await waitForLrclib()
  const params = new URLSearchParams({ track_name: request.trackName })
  if (request.artistName) params.set('artist_name', request.artistName)
  const matches = await getJson<LrclibItem[]>(`https://lrclib.net/api/search?${params}`) ?? []
  for (const item of matches.slice(0, 10)) {
    const candidate = lrclibCandidate(item, request)
    if (candidate && !results.some(existing => existing.id === candidate.id) && candidate.match >= 0.35) results.push(candidate)
  }
  return results
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const SYNC_WEIGHT: Record<LyricSync, number> = { syllable: 0.4, richsync: 0.3, linesync: 0.15, plain: 0 }

/**
 * Strict quality tiers, best first. Ranking within a tier is by match score,
 * but a finer-grained match always beats a coarser one — a line-synced LRCLIB
 * hit should never win over word-synced TTML for the same song.
 */
const SYNC_TIER: Record<LyricSync, number> = { syllable: 3, richsync: 2, linesync: 1, plain: 0 }

/** Tie-break between equally-timed candidates: the better-curated corpus first. */
const SOURCE_TIER: Record<LyricSourceId, number> = { betterlyrics: 3, unison: 2, amll: 2, lrclib: 1 }
const CONFIDENCE_WEIGHT = { high: 0.2, medium: 0.1, low: 0 }

/** Sort key: match quality first, then richer sync, then community confidence. */
export function rankCandidate(candidate: LyricCandidate) {
  return candidate.match + SYNC_WEIGHT[candidate.syncType] + CONFIDENCE_WEIGHT[candidate.confidence] + Math.min(0.1, (candidate.votes ?? 0) / 100)
}

/**
 * Order for the *automatic* pick, which is deliberately stricter than the
 * display sort: timing granularity first, then how well it matches, then the
 * source. An exact YouTube video id match is treated as a perfect match,
 * because that is an identity, not a guess.
 */
export function effectiveMatch(candidate: LyricCandidate, request: LyricLookupRequest) {
  // An exact video id is an identity, not a guess.
  if (candidate.videoId && candidate.videoId === request.videoId) return 1
  // A community entry nobody has vouched for is worth less than its title
  // similarity suggests — mis-titled submissions are common.
  const penalty = candidate.confidence === 'low' ? 0.15 : 0
  return Math.max(0, candidate.match - penalty)
}

/**
 * How far below the best match a candidate may sit and still win on timing.
 *
 * Without this, *any* word-synced entry beats a perfect line-synced match —
 * so a half-matching, low-confidence submission outranks the obviously
 * correct lyrics. Richer timing is only worth having when the words under it
 * are the right words.
 */
const MATCH_TOLERANCE = 0.2

function autoPickOrder(request: LyricLookupRequest, candidates: LyricCandidate[]) {
  const best = Math.max(...candidates.map(candidate => effectiveMatch(candidate, request)), 0)
  const floor = best - MATCH_TOLERANCE
  // Candidates that match roughly as well as the best one compete on timing;
  // anything worse is ranked purely on how well it matches.
  const contends = (candidate: LyricCandidate) => effectiveMatch(candidate, request) >= floor
  return (left: LyricCandidate, right: LyricCandidate) => {
    if (contends(left) !== contends(right)) return contends(right) ? 1 : -1
    if (contends(left) && SYNC_TIER[right.syncType] !== SYNC_TIER[left.syncType]) return SYNC_TIER[right.syncType] - SYNC_TIER[left.syncType]
    const delta = effectiveMatch(right, request) - effectiveMatch(left, request)
    if (Math.abs(delta) > 0.05) return delta
    if (SOURCE_TIER[right.source] !== SOURCE_TIER[left.source]) return SOURCE_TIER[right.source] - SOURCE_TIER[left.source]
    return rankCandidate(right) - rankCandidate(left)
  }
}

/**
 * Search every enabled source, then widen the query if that found nothing.
 *
 * Tags routinely carry a full credit list — "JVKE, Jake Lawson, Zac Lawson" —
 * while every lyric database indexes the lead artist alone, so the literal tag
 * matches nothing at all. A second pass with just the lead artist (and no
 * album, since singles often repeat the title there) rescues those files.
 */
export async function searchLyricCandidates(request: LyricLookupRequest): Promise<LyricCandidate[]> {
  const direct = await runLyricSources(request)
  if (direct.length) return direct
  const lead = primaryArtist(request.artistName)
  const widened: LyricLookupRequest[] = []
  if (lead && lead !== request.artistName) widened.push({ ...request, artistName: lead, albumName: null })
  else if (request.albumName) widened.push({ ...request, albumName: null })
  for (const attempt of widened) {
    const found = await runLyricSources(attempt)
    if (found.length) return found
  }
  return direct
}

async function runLyricSources(request: LyricLookupRequest): Promise<LyricCandidate[]> {
  const sources = request.sources ?? ['betterlyrics', 'unison', 'amll', 'lrclib']
  const tasks: Array<Promise<LyricCandidate[]>> = []
  if (sources.includes('betterlyrics')) tasks.push(betterLyricsSearch(request).catch(error => { console.warn('Better Lyrics search failed', error); return [] }))
  if (sources.includes('unison')) {
    tasks.push((async () => {
      const found: LyricCandidate[] = []
      if (request.videoId) { try { const exact = await unisonByVideoId(request.videoId, request); if (exact) found.push(exact) } catch (error) { console.warn('Unison video lookup failed', error) } }
      try {
        for (const candidate of await unisonSearch(request)) {
          // The video-id endpoint returns content but no duration; the search returns duration but no content. Keep both.
          const existing = found.find(item => item.id === candidate.id)
          if (existing) { existing.duration ??= candidate.duration; existing.album ??= candidate.album }
          else found.push(candidate)
        }
      } catch (error) { console.warn('Unison search failed', error) }
      return found
    })())
  }
  if (sources.includes('amll')) tasks.push(amllSearch(request).catch(error => { console.warn('AMLL search failed', error); return [] }))
  if (sources.includes('lrclib')) tasks.push(lrclibSearch(request).catch(error => { console.warn('LRCLIB search failed', error); return [] }))
  const candidates = (await Promise.all(tasks)).flat()
  return candidates.sort((left, right) => rankCandidate(right) - rankCandidate(left))
}

export async function fetchLyricCandidate(candidate: LyricCandidate): Promise<{ content: string; format: LyricFormat } | null> {
  if (candidate.content) return { content: candidate.content, format: candidate.format }
  const [source, rawId] = candidate.id.split(':')
  const id = Number(rawId)
  if (source === 'unison') { const result = await unisonGet(id); return result ? { content: result.content, format: result.format } : null }
  if (source === 'amll') { const ttml = await amllGet(id); return ttml ? { content: ttml, format: 'ttml' } : null }
  return null
}

function toResult(candidate: LyricCandidate, content: string, format: LyricFormat): LyricLookupResult {
  const base = { found: true, source: candidate.sourceLabel, sourceUrl: candidate.sourceUrl ?? undefined, id: Number(candidate.id.split(':')[1]) || null, instrumental: false, candidate }
  if (format === 'ttml') return { ...base, ttmlLyrics: content, syncedLyrics: null, plainLyrics: null }
  if (format === 'lrc') return { ...base, ttmlLyrics: null, syncedLyrics: content, plainLyrics: null }
  return { ...base, ttmlLyrics: null, syncedLyrics: null, plainLyrics: content }
}

/**
 * The automatic path: try the exact Unison video match, then the best ranked
 * candidate across every source, fetching content until one actually has some.
 * Synced results win over plain text even when a plain entry ranks slightly higher on title similarity.
 */
export async function findBestLyrics(request: LyricLookupRequest): Promise<LyricLookupResult> {
  try {
    const candidates = await searchLyricCandidates(request)
    if (!candidates.length) return { found: false, message: 'No lyrics found on Better Lyrics, Unison, AMLL TTML DB or LRCLIB.' }
    const plausible = candidates.filter(candidate => candidate.match >= 0.5 || (candidate.videoId && candidate.videoId === request.videoId))
    // One comparator, used both to walk the list and to pick the winner, so the
    // match gate cannot be bypassed by the final sort.
    const order = autoPickOrder(request, plausible)
    const ordered = [...plausible].sort(order)
    const shortlist = ordered.slice(0, 6)
    const resolved: Array<{ candidate: LyricCandidate; content: string; format: LyricFormat }> = []
    for (const [index, candidate] of shortlist.entries()) {
      try {
        const fetched = await fetchLyricCandidate(candidate)
        if (!fetched?.content?.trim()) continue
        // A search result only *claims* a granularity; the document proves it.
        const sync = fetched.format === 'ttml' ? ttmlGranularity(fetched.content) : candidate.syncType
        // A document can be well-formed and still contain nothing usable.
        // Counting the lines here keeps "found lyrics" from meaning an empty
        // pane in the player.
        if (!lyricLines(fetched.content, fetched.format).length) { console.warn(`${candidate.id} parsed to zero lines; skipping`); continue }
        resolved.push({ candidate: { ...candidate, syncType: sync }, content: fetched.content, format: fetched.format })
        // Stop once nothing still unfetched would outrank what we already hold.
        const holding = resolved.map(item => item.candidate).sort(order)[0]
        if (!shortlist.slice(index + 1).some(next => order(next, holding) < 0)) break
      } catch (error) { console.warn(`Could not fetch ${candidate.id}`, error) }
    }
    const winner = resolved.sort((left, right) => order(left.candidate, right.candidate))[0]
    if (winner) return toResult(winner.candidate, winner.content, winner.format)
    return { found: false, message: 'Matches were found but none were confident enough. Open the Lyrics Finder to pick one yourself.' }
  } catch (error) {
    console.error('Lyric lookup failed', error)
    return { found: false, message: 'The free lyric services are unavailable right now.' }
  }
}

// ---------------------------------------------------------------------------
// Re-timing for sped-up / slowed edits
// ---------------------------------------------------------------------------

/**
 * Lyrics for a Nightcore or Slowed edit come from the original recording, so
 * every timestamp is off by the speed ratio. Scaling them by
 * `originalDuration / fileDuration` lines them back up well enough to be
 * useful. Works on LRC (`[mm:ss.xx]`, `<mm:ss.xx>`) and TTML (`begin`/`end`/`dur`).
 */
export function retimeLyrics(content: string, format: LyricFormat, ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 0.005 || format === 'plain') return content
  const scale = (ms: number) => Math.max(0, Math.round(ms * ratio))
  if (format === 'lrc') {
    return content.replace(/([[<])(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?([\]>])/g, (_match, open: string, minutes: string, seconds: string, fraction: string | undefined, close: string) => {
      const fractionMs = fraction ? Math.round(Number(`0.${fraction}`) * 1000) : 0
      const total = scale(Number(minutes) * 60_000 + Number(seconds) * 1000 + fractionMs)
      const mm = Math.floor(total / 60_000), ss = Math.floor((total % 60_000) / 1000), ff = Math.floor((total % 1000) / 10)
      return `${open}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ff).padStart(2, '0')}${close}`
    })
  }
  // TTML clock-time (h:mm:ss.fff, mm:ss.fff, ss.fff) and offset-time (12.5s, 300ms).
  return content.replace(/\b(begin|end|dur)="([^"]+)"/g, (_match, attribute: string, value: string) => {
    const ms = parseTtmlTime(value)
    if (ms === null) return `${attribute}="${value}"`
    return `${attribute}="${formatTtmlTime(scale(ms))}"`
  })
}

function parseTtmlTime(value: string): number | null {
  const trimmed = value.trim()
  const offset = trimmed.match(/^(\d+(?:\.\d+)?)(h|m|s|ms)$/)
  if (offset) { const amount = Number(offset[1]); return offset[2] === 'h' ? amount * 3_600_000 : offset[2] === 'm' ? amount * 60_000 : offset[2] === 's' ? amount * 1000 : amount }
  const clock = trimmed.match(/^(?:(\d+):)?(?:(\d{1,2}):)?(\d{1,2}(?:\.\d+)?)$/)
  if (!clock) return null
  const [, hoursOrMinutes, minutes, seconds] = clock
  if (hoursOrMinutes !== undefined && minutes !== undefined) return Number(hoursOrMinutes) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1000
  if (hoursOrMinutes !== undefined) return Number(hoursOrMinutes) * 60_000 + Number(seconds) * 1000
  return Number(seconds) * 1000
}

function formatTtmlTime(ms: number) {
  const minutes = Math.floor(ms / 60_000), seconds = Math.floor((ms % 60_000) / 1000), millis = ms % 1000
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/** File extension for a lyric format when saving beside a song. */
export function lyricExtension(format: LyricFormat) {
  return format === 'ttml' ? '.ttml' : format === 'lrc' ? '.lrc' : '.txt'
}

// ---------------------------------------------------------------------------
// Conversion for embedding
//
// Tag frames cannot hold word-level timing: ID3's SYLT is one timestamp per
// entry and the `lyrics` tag other containers use is plain text. So embedding
// flattens whatever we found into lines — the `.ttml` sidecar stays on disk
// and remains what Lyrigen itself reads for word-by-word sync.
// ---------------------------------------------------------------------------

/** One lyric line with its start time, or `null` for unsynced text. */
export interface LyricLine { timeMs: number | null; text: string }

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(value: string) {
  return value.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal) return String.fromCodePoint(Number(decimal))
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    return (name && XML_ENTITIES[name.toLowerCase()]) ?? match
  })
}

/** Strip tags from a TTML line, keeping the spacing that sits between word spans. */
function ttmlLineText(inner: string) {
  // Background-vocal spans are parenthetical asides; they read badly inline, so drop them.
  const withoutBackground = inner.replace(/<span[^>]*ttm:role\s*=\s*"x-bg"[\s\S]*?<\/span>/gi, ' ')
  const spans = Array.from(withoutBackground.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)).map(match => decodeEntities(match[1].replace(/<[^>]*>/g, '')))
  const stripped = decodeEntities(withoutBackground.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
  // Some exporters put no whitespace between word spans, which would glue the line into one word.
  if (spans.length > 1 && !/\s/.test(stripped)) return spans.map(span => span.trim()).filter(Boolean).join(' ')
  return stripped
}

/** Flatten any lyric format into timed lines, in order. */
export function lyricLines(content: string, format: LyricFormat): LyricLine[] {
  if (format === 'ttml') {
    const lines: LyricLine[] = []
    for (const match of content.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
      const text = ttmlLineText(match[2])
      if (!text) continue
      const begin = match[1].match(/\bbegin\s*=\s*"([^"]*)"/i)
      lines.push({ timeMs: begin ? parseTtmlTime(begin[1]) : null, text })
    }
    return lines
  }
  if (format === 'lrc') {
    const lines: LyricLine[] = []
    for (const raw of content.split(/\r?\n/)) {
      // `[ar:…]`, `[length:…]` and friends are file metadata, not lyrics.
      if (/^\s*\[[a-z]+:/i.test(raw)) continue
      const stamps = Array.from(raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g))
      const text = raw.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      // A line can carry several timestamps when a refrain repeats; emit it at each.
      if (!stamps.length) { lines.push({ timeMs: null, text }); continue }
      for (const stamp of stamps) {
        const fraction = stamp[3] ? Math.round(Number(`0.${stamp[3]}`) * 1000) : 0
        lines.push({ timeMs: Number(stamp[1]) * 60_000 + Number(stamp[2]) * 1000 + fraction, text })
      }
    }
    return lines.sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0))
  }
  return content.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(text => ({ timeMs: null, text }))
}

/** Plain, untimed text — what goes into an ID3 USLT frame or a `lyrics` tag. */
export function lyricsToPlainText(content: string, format: LyricFormat) {
  if (format === 'plain') return content.trim()
  return lyricLines(content, format).map(line => line.text).join('\n').trim()
}
