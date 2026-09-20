import path from 'node:path'

/**
 * Turning a YouTube-style video title into song metadata, and song metadata
 * into a tidy library path.
 *
 * yt-dlp names files `<video title> [<id>].<ext>` and tags them with the
 * *uploader* as the artist and the YouTube category ("People & Blogs") as the
 * genre. For re-uploads ("all the stars - kendrick lamar & sza (sped up)") the
 * only real information is in the title, so this module does the unglamorous
 * work of splitting it into artist / title / variant and stripping the noise
 * words that uploaders add. Everything here is pure and has no Electron
 * dependency so it can be unit-tested with plain Node.
 */

export type SongVariant =
  | 'Sped Up' | 'Nightcore' | 'Slowed' | 'Slowed + Reverb' | 'Reverb' | 'Lo-Fi' | 'Daycore'
  | '8D' | 'Bass Boosted' | 'Remix' | 'Acoustic' | 'Live' | 'Instrumental' | 'Karaoke' | 'Cover' | 'Mashup'

export interface ParsedSongName {
  artist: string | null
  title: string
  featuring: string | null
  variant: SongVariant | null
  /** How much of the result came from real structure vs. guesswork. */
  confidence: 'high' | 'medium' | 'low'
  /** The uploader was used as the artist because the title had no separator. */
  artistFromUploader: boolean
}

/** Variant tags, most specific first so "slowed + reverb" wins over "slowed". */
const VARIANT_PATTERNS: Array<[RegExp, SongVariant]> = [
  [/slowed\s*(?:\+|&|and|n|'n'|x|,)?\s*(?:down\s*)?(?:\+|&|and)?\s*reverb(?:ed)?/i, 'Slowed + Reverb'],
  [/sped\s*up\s*(?:\+|&|and)?\s*reverb/i, 'Sped Up'],
  [/\b(?:sped|speed|speeded|spedup)\s*[- ]?\s*up\b/i, 'Sped Up'],
  [/\bnight\s*core\b/i, 'Nightcore'],
  [/\bday\s*core\b/i, 'Daycore'],
  [/\bslowed(?:\s*down)?\b/i, 'Slowed'],
  [/\breverb(?:ed)?\b/i, 'Reverb'],
  [/\blo-?\s?fi\b/i, 'Lo-Fi'],
  [/\b8d(?:\s*audio)?\b/i, '8D'],
  [/\bbass\s*boost(?:ed)?\b/i, 'Bass Boosted'],
  [/\binstrumental\b/i, 'Instrumental'],
  [/\bkaraoke\b/i, 'Karaoke'],
  [/\bacoustic\b/i, 'Acoustic'],
  [/\bmashup\b/i, 'Mashup'],
  [/\bcover\b/i, 'Cover'],
  [/\b(?:remix|flip|edit|bootleg|rework)\b/i, 'Remix'],
  [/\blive\b(?!\s+(?:your|the|it|a|and|in|is|on|life|love|forever|wire|for))/i, 'Live'],
]

/** Words that add nothing to a song title. Only removed inside brackets or after a `|` style separator. */
const NOISE = /^(?:official\s+(?:music\s+)?(?:video|audio|lyric\s*video|visuali[sz]er|mv)|official|(?:full\s+)?(?:hd|hq|4k|1080p|720p)(?:\s+(?:audio|video|quality))?|(?:with\s+)?lyrics?(?:\s+video)?|lyric\s*video|letra|legendado|sub(?:titulad[oa]|s)?|tradu[cç][aã]o|audio|video|visuali[sz]er|m\/?v|clip\s+officiel|music\s+video|full\s+(?:song|version|track)|new\s+(?:song|video)?\s*(?:20\d\d)?|20\d\d|tik\s*tok(?:\s+(?:version|song|edit|remix|viral|trend))?|viral|trending|best\s+(?:part|version)|extended|loop(?:ed)?|1\s*hour|bass|clean(?:\s+version)?|explicit|free\s+download|no\s+copyright|copyright\s+free|prod\.?\s*(?:by)?\s*[^)\]]*|dir(?:ected)?\.?\s*(?:by)?\s*[^)\]]*|ft\.?|feat\.?|from\s+.*|soundtrack|ost|theme|out\s+now|premiere|reupload|re-?upload|version|ver\.?|edit|remaster(?:ed)?(?:\s+20\d\d)?|\d{4}\s+remaster(?:ed)?|album\s+version|radio\s+edit|single|ep|mixtape|leak(?:ed)?|snippet|preview|teaser|unreleased|rare|classic|throwback|nostalgia|vibes?|aesthetic|playlist|mix|edit\s+audio|audio\s+edit|use\s+headphones?|headphones?\s+(?:recommended|on)|read\s+desc(?:ription)?|check\s+desc(?:ription)?|link\s+in\s+(?:bio|desc(?:ription)?))\s*[!.]*$/i

const FEATURE = /\s+(?:\(|\[)?\s*(?:ft\.?|feat\.?|featuring)\s+([^()[\]]+?)\s*(?:\)|\])?\s*$/i
/** `&`, `ft.`, `x`, commas: several names joined together is a strong sign that a fragment is the artist credit, not the song title. */
const ARTIST_CONNECTORS = /\s(?:&|\+|x|×|vs\.?|ft\.?|feat\.?|featuring)\s|,\s/i
const YT_ID_SUFFIX = /\s*[[(]([A-Za-z0-9_-]{11})[\])]\s*$/
const BRACKETED = /\s*[([{《【「]([^()[\]{}《》【】「」]*)[)\]}》】」]/g
/** ` - `, ` – `, ` — `, ` | `, `｜`, `//`, `⧸⧸`, ` ~ `, ` : ` (with spaces) all show up as artist/title separators in the wild. */
const SEPARATOR = /\s+(?:-|–|—|\||｜|\/\/|⧸⧸|~|:)\s+|\s*(?:\||｜|\/\/|⧸⧸)\s*/

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'nor', 'of', 'on', 'or', 'so', 'the', 'to', 'vs', 'via', 'with', 'yet', 'x', 'ft', 'feat', 'ft.', 'feat.', 'de', 'la', 'le', 'y', 'e'])

export function titleCase(value: string) {
  const words = value.split(/(\s+)/)
  return words.map((word, index) => {
    if (!word.trim()) return word
    const lower = word.toLocaleLowerCase()
    if (index > 0 && SMALL_WORDS.has(lower)) return lower
    if (/^[ivx]+$/i.test(word) && word.length > 1) return word.toLocaleUpperCase()
    return lower.charAt(0).toLocaleUpperCase() + lower.slice(1)
  }).join('')
}

function tidy(value: string) {
  return value
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—|:~.,/]+|[\s\-–—|:~.,/]+$/g, '')
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Only re-case strings that were typed entirely in lower or upper case; keep deliberate casing alone. */
function smartCase(value: string) {
  if (!value) return value
  const letters = value.replace(/[^\p{L}]/gu, '')
  if (letters && (letters === letters.toLocaleLowerCase() || (letters === letters.toLocaleUpperCase() && letters.length > 4))) return titleCase(value)
  return value
}

function detectVariant(text: string): SongVariant | null {
  for (const [pattern, variant] of VARIANT_PATTERNS) if (pattern.test(text)) return variant
  return null
}

/** Strip variant words from a fragment, e.g. "sped up + reverb" → "" or "cheerleader (sped up)" → "cheerleader". */
function stripVariantWords(text: string) {
  let out = text
  for (const [pattern] of VARIANT_PATTERNS) out = out.replace(pattern, ' ')
  return tidy(out.replace(/\s*(?:\+|&|and)\s*$/i, ''))
}

export function stripYoutubeIdSuffix(fileNameWithoutExt: string) {
  const match = fileNameWithoutExt.match(YT_ID_SUFFIX)
  return { name: fileNameWithoutExt.replace(YT_ID_SUFFIX, '').trim(), videoId: match?.[1] ?? null }
}

/**
 * Parse a video title (or a yt-dlp file name without extension) into song
 * metadata. `uploader` is only used as a last-resort artist guess and to work
 * out which side of "A - B" is the artist when the uploader is a known name.
 */
export function parseSongName(rawTitle: string, uploader?: string | null, knownArtists: Iterable<string> = []): ParsedSongName {
  let working = stripYoutubeIdSuffix(rawTitle.normalize('NFKC')).name
  let variant: SongVariant | null = null
  let featuring: string | null = null

  // 1. Bracketed segments: pull out variant / featuring, drop noise, keep anything meaningful (e.g. "(Remastered)" stays as variant, "(Deluxe)" is kept as title text).
  const kept: string[] = []
  working = working.replace(BRACKETED, (_whole, inner: string) => {
    const text = tidy(inner)
    if (!text) return ' '
    const found = detectVariant(text)
    if (found) { variant ??= found; const rest = stripVariantWords(text); if (rest && !NOISE.test(rest)) kept.push(rest); return ' ' }
    const feat = text.match(/^(?:ft\.?|feat\.?|featuring|with)\s+(.+)$/i)
    if (feat) { featuring ??= tidy(feat[1]); return ' ' }
    if (NOISE.test(text)) return ' '
    if (/^\d{4}$/.test(text)) return ' '
    return ` (${text})`
  })

  // 2. Pipe / slash style trailers ("Song | Lyrics", "song ⧸⧸ sped up") — segments after the first that are pure noise or variants are dropped.
  const segments = working.split(SEPARATOR).map(tidy).filter(Boolean)
  const meaningful: string[] = []
  for (const segment of segments) {
    const found = detectVariant(segment)
    if (found) { variant ??= found; const rest = stripVariantWords(segment); if (rest && !NOISE.test(rest)) meaningful.push(rest); continue }
    if (NOISE.test(segment)) continue
    meaningful.push(segment)
  }

  // 3. Free-standing variant words that were not bracketed ("Shape of You sped up").
  for (let index = 0; index < meaningful.length; index++) {
    const found = detectVariant(meaningful[index])
    if (found) { variant ??= found; meaningful[index] = stripVariantWords(meaningful[index]) }
  }
  const parts = meaningful.filter(Boolean)

  let artist: string | null = null
  let title = ''
  let confidence: ParsedSongName['confidence'] = 'low'
  let artistFromUploader = false
  const uploaderKey = uploader ? normalizeKey(uploader) : ''
  const known = new Set(Array.from(knownArtists, normalizeKey).filter(Boolean))
  const isKnownArtist = (value: string) => known.has(normalizeKey(value)) || known.has(normalizeKey(primaryArtist(value) || ''))

  if (parts.length >= 2) {
    // "Artist - Title" is the convention, but fan re-uploads often flip it ("all the stars - kendrick lamar & sza").
    // Swap when the right side is the uploader, a known library artist, or carries artist connectors the left side lacks.
    let [left, right] = parts
    const rightLooksLikeArtist = (uploaderKey && normalizeKey(right) === uploaderKey) || (isKnownArtist(right) && !isKnownArtist(left)) || (ARTIST_CONNECTORS.test(right) && !ARTIST_CONNECTORS.test(left))
    const leftLooksLikeTitle = /\bby\b/i.test(left)
    if (rightLooksLikeArtist || leftLooksLikeTitle) [left, right] = [right, left]
    artist = left
    title = right
    if (parts.length > 2) title = [right, ...parts.slice(2).filter(part => !NOISE.test(part))].join(' ')
    confidence = 'high'
  } else if (parts.length === 1) {
    const by = parts[0].match(/^(.*?)\s+by\s+(.+)$/i)
    if (by) { title = by[1]; artist = by[2]; confidence = 'medium' }
    else {
      title = parts[0]
      if (uploader && !/\b(?:topic|official|records|music|vevo|lyrics|audio|tv|channel)\b/i.test(uploader)) { artist = tidy(uploader); artistFromUploader = true }
      confidence = 'low'
    }
  } else {
    title = tidy(rawTitle)
  }

  // "Artist - Title (ft. X)" / "Artist ft. X - Title": normalise the feature credit onto the artist.
  const titleFeat = title.match(FEATURE)
  if (titleFeat) { featuring ??= tidy(titleFeat[1]); title = tidy(title.replace(FEATURE, '')) }
  if (artist) {
    const artistFeat = artist.match(/^(.*?)\s+(?:ft\.?|feat\.?|featuring)\s+(.+)$/i)
    if (artistFeat) { artist = tidy(artistFeat[1]); featuring ??= tidy(artistFeat[2]) }
    artist = artist.replace(/\s*-\s*topic$/i, '')
  }

  title = smartCase(tidy(title.replace(/\s+by\s*$/i, '')))
  artist = artist ? smartCase(tidy(artist)) : null
  featuring = featuring ? smartCase(tidy(featuring)) : null
  if (!title) title = tidy(rawTitle) || 'Unknown title'
  return { artist, title, featuring, variant, confidence, artistFromUploader }
}

export function normalizeKey(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** Primary artist for folder sorting: "Kendrick Lamar & SZA" → "Kendrick Lamar", "A x B" → "A". */
export function primaryArtist(artist: string | null | undefined) {
  if (!artist) return null
  const split = artist.split(/\s*(?:,|&|\+|\/|;|\bx\b|\bvs\.?\b|\band\b|\bft\.?\b|\bfeat\.?\b|\bfeaturing\b|\bwith\b)\s*/i).map(tidy).filter(Boolean)
  return split[0] || artist
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** One path segment: no separators, no control characters, no trailing dots/spaces, never empty. */
export function sanitizeSegment(value: string, fallback = 'Unknown') {
  let out = value.normalize('NFKC')
    .replace(/\s*[/\\]\s*/g, '-')
    .replace(/[<>:"|?*\p{Cc}]/gu, '')
    .replace(/[⁄∕⧸／]/g, '-') // fraction slash, division slash, big solidus, fullwidth solidus
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (!out || WINDOWS_RESERVED.test(out)) out = fallback
  if (out.length > 120) out = out.slice(0, 120).trim()
  return out
}

export interface PathFields {
  artist?: string | null
  albumArtist?: string | null
  album?: string | null
  title: string
  year?: string | number | null
  variant?: string | null
  genre?: string | null
  uploader?: string | null
  videoId?: string | null
  trackNumber?: string | number | null
  ext: string
}

export const PATH_PRESETS: Array<{ id: string; label: string; template: string; hint: string }> = [
  { id: 'artist-album', label: 'Artist / Album / Title', template: '{artist}/{album}/{artist} - {title}', hint: 'Classic library layout. Singles and variants go under an "Singles" or "Sped Up" style album folder.' },
  { id: 'artist-flat', label: 'Artist / Title', template: '{artist}/{artist} - {title}', hint: 'One folder per artist, no album level.' },
  { id: 'variant-first', label: 'Variant / Artist - Title', template: '{variant|Originals}/{artist} - {title}', hint: 'Keeps all Nightcore, Sped Up and Slowed edits together, like a "night core" folder.' },
  { id: 'genre-artist', label: 'Genre / Artist / Title', template: '{genre|Unsorted}/{artist}/{artist} - {title}', hint: 'Group by tag genre first.' },
  { id: 'flat', label: 'Artist - Title (no folders)', template: '{artist} - {title}', hint: 'Everything in the destination root.' },
]

/**
 * Expand a template like `{artist}/{album|Singles}/{artist} - {title}` into a
 * relative path (no extension). Unknown fields fall back to the `|default`
 * text, or a sensible built-in. Each expanded segment is sanitised separately
 * so a song called "AC/DC - Back In Black" cannot escape its folder.
 */
export function buildRelativePath(template: string, fields: PathFields) {
  const artist = fields.artist?.trim() || 'Unknown Artist'
  const albumFallback = fields.variant ? fields.variant : 'Singles'
  const values: Record<string, string> = {
    artist,
    albumartist: fields.albumArtist?.trim() || primaryArtist(artist) || artist,
    album: fields.album?.trim() || '',
    title: fields.title?.trim() || 'Unknown Title',
    year: fields.year ? String(fields.year).slice(0, 4) : '',
    variant: fields.variant || '',
    genre: fields.genre?.trim() || '',
    uploader: fields.uploader?.trim() || '',
    id: fields.videoId || '',
    track: fields.trackNumber ? String(fields.trackNumber).padStart(2, '0') : '',
  }
  const defaults: Record<string, string> = { album: albumFallback, year: '', variant: '', genre: '', uploader: '', id: '', track: '' }
  const segments = template.replace(/\\/g, '/').split('/').map(segment => {
    const expanded = segment.replace(/\{(\w+)(?:\|([^}]*))?\}/g, (_match, key: string, fallback?: string) => {
      const name = key.toLocaleLowerCase()
      const value = values[name] ?? ''
      if (value) return value
      return fallback ?? defaults[name] ?? ''
    })
    return sanitizeSegment(tidy(expanded), 'Unknown')
  }).filter(Boolean)
  if (!segments.length) segments.push(sanitizeSegment(values.title))
  // A title-only file name is fine, but a variant should be visible in it so "song.mp3" and "song (Sped Up).mp3" never collide.
  if (fields.variant && !new RegExp(fields.variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(segments[segments.length - 1])) {
    segments[segments.length - 1] = sanitizeSegment(`${segments[segments.length - 1]} (${fields.variant})`)
  }
  const ext = fields.ext.replace(/^\./, '').toLocaleLowerCase()
  return `${segments.join(path.sep)}.${ext}`
}

/** `song.mp3` → `song (2).mp3` … until the name is free according to `exists`. */
export function uniquePath(candidate: string, exists: (candidate: string) => boolean) {
  if (!exists(candidate)) return candidate
  const parsed = path.parse(candidate)
  for (let index = 2; index < 1000; index++) {
    const next = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`)
    if (!exists(next)) return next
  }
  return path.join(parsed.dir, `${parsed.name} (${Date.now()})${parsed.ext}`)
}
