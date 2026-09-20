import { parseLrc, parseEslrc, parseTTML, parseYrc, stringifyTTML, type LyricLine } from '@applemusic-like-lyrics/lyric'

export type LyricTiming = 'word' | 'estimated' | 'unsynced'
export interface LyricDocument { lines: LyricLine[]; timing: LyricTiming; metadata: [string, string[]][] }

const ms = (value: number) => Math.max(0, Math.round(Number.isFinite(value) ? value : 0))

export function normalizeLines(input: LyricLine[], durationMs = 0): LyricLine[] {
  const sorted = input.filter(line => line.words.some(word => word.word.trim())).map(line => ({ ...line, words: line.words.map(word => ({ ...word })) })).sort((a, b) => a.startTime - b.startTime)
  return sorted.map((line, index) => {
    const startTime = ms(line.startTime)
    const next = sorted.slice(index + 1).find(item => item.startTime > startTime)?.startTime
    const fallbackEnd = next ?? (durationMs > startTime ? durationMs : startTime + 4000)
    const endTime = Math.max(startTime + 1, ms(!Number.isFinite(line.endTime) || line.endTime > (durationMs || 86400000) || line.endTime <= startTime ? fallbackEnd : line.endTime))
    return { ...line, startTime, endTime, words: line.words.map(word => ({ ...word, startTime: ms(word.startTime), endTime: Math.max(ms(word.startTime) + 1, ms(word.endTime > word.startTime && word.endTime <= endTime ? word.endTime : endTime)) })) }
  })
}

export function estimateWordTiming(lines: LyricLine[]): LyricLine[] {
  return lines.map(line => {
    if (line.words.length !== 1) return line
    const parts = line.words[0].word.match(/\S+\s*/gu) ?? []
    const weights = parts.map(word => Math.max(1, [...word.trim()].length))
    const total = weights.reduce((a, b) => a + b, 0)
    let cursor = line.startTime
    return { ...line, words: parts.map((word, index) => {
      const startTime = ms(cursor)
      cursor += (line.endTime - line.startTime) * weights[index] / total
      return { word, startTime, endTime: index === parts.length - 1 ? line.endTime : ms(cursor) }
    }) }
  })
}

/**
 * Give every `<p>` an `itunes:key`, because the TTML parser needs one.
 *
 * `processLineElement` in @applemusic-like-lyrics/ttml starts with
 * `const id = getAttr(p, ITUNES, "key"); if (!id) return` — so a line with no
 * `itunes:key` is dropped without a word of complaint. Apple-derived documents
 * always carry those keys; plenty of perfectly good community TTML does not,
 * and would otherwise parse to zero lines and look like an empty lyric file.
 *
 * Keys are only added where one is missing, and the prefix is deliberately
 * odd so a synthesised key can never collide with a real one.
 */
function withLineKeys(content: string) {
  if (!/<p\b/i.test(content)) return content
  let index = 0
  const keyed = content.replace(/<p\b([^>]*?)(\/?)>/gi, (match, attributes: string, selfClosing: string) => {
    index += 1
    if (/\bitunes:key\s*=/i.test(attributes)) return match
    return `<p${attributes} itunes:key="lyrigen-l${index}"${selfClosing}>`
  })
  if (keyed === content) return content
  // The attribute is meaningless unless the prefix is bound to Apple's namespace.
  return /xmlns:itunes\s*=/i.test(keyed)
    ? keyed
    : keyed.replace(/<tt\b/i, '<tt xmlns:itunes="http://music.apple.com/lyric-ttml-internal"')
}

export function parseLyricDocument(source: string, extension: string, durationMs = 0): LyricDocument {
  const content = source.replace(/^\uFEFF/, '').trim()
  if (content.length > 5_000_000) throw new Error('The lyric file is too large (maximum 5 MB).')
  if (extension === 'ttml') {
    const xml = new DOMParser().parseFromString(content, 'application/xml')
    if (xml.querySelector('parsererror')) throw new Error('Invalid TTML XML. Check closing tags and escaped ampersands.')
    const parsed = parseTTML(withLineKeys(content))
    const estimated = /<meta[^>]*key=["']lyrigen:timing["'][^>]*value=["']estimated["']/i.test(content)
    return { lines: normalizeLines(parsed.lines, durationMs), metadata: parsed.metadata, timing: estimated ? 'estimated' : 'word' }
  }
  if (extension === 'yrc') return { lines: normalizeLines(parseYrc(content), durationMs), metadata: [], timing: 'word' }
  if (extension === 'txt') {
    const lines = content.split(/\r?\n/).filter(row => row.trim()).map((word): LyricLine => ({ words: [{ word, startTime: 0, endTime: 1 }], startTime: 0, endTime: 1, isBG: false, isDuet: false, translatedLyric: '', romanLyric: '' }))
    return { lines, metadata: [], timing: 'unsynced' }
  }
  const enhanced = /<\d+:\d+(?:\.\d+)?>/.test(content)
  const offset = Number(content.match(/\[offset:([+-]?\d+)\]/i)?.[1] ?? 0)
  const lines = (enhanced ? parseEslrc(content) : parseLrc(content)).map(line => ({ ...line, startTime: line.startTime + offset, endTime: line.endTime + offset, words: line.words.map(word => ({ ...word, startTime: word.startTime + offset, endTime: word.endTime + offset })) }))
  const normalized = normalizeLines(lines, durationMs)
  return { lines: enhanced ? normalized : estimateWordTiming(normalized), metadata: [], timing: enhanced ? 'word' : 'estimated' }
}

export function exportLyricDocument(document: LyricDocument) {
  if (document.timing === 'unsynced') throw new Error('Untimed text needs alignment before TTML export.')
  return stringifyTTML({ lines: document.lines, metadata: [...document.metadata.filter(([key]) => key !== 'lyrigen:timing'), ['lyrigen:timing', [document.timing]]] })
}

/** Whisper/stable-ts JSON timestamps are seconds. AMLL always receives integer milliseconds. */
export function fromAlignmentJson(source: string): LyricDocument {
  const data = JSON.parse(source) as { segments?: Array<{ words?: Array<{ word: string; start: number; end: number }> }> }
  if (!Array.isArray(data.segments)) throw new Error('Expected Whisper/stable-ts JSON containing segments and words.')
  const lines = data.segments.filter(segment => segment.words?.length).map((segment): LyricLine => {
    const words = segment.words!.map(word => {
      if (typeof word.word !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start) throw new Error('Every word needs valid start/end timestamps in seconds.')
      return { word: word.word, startTime: ms(word.start * 1000), endTime: ms(word.end * 1000) }
    })
    return { words, startTime: words[0].startTime, endTime: words[words.length - 1].endTime, isBG: false, isDuet: false, translatedLyric: '', romanLyric: '' }
  })
  if (!lines.length) throw new Error('No word timestamps found in this JSON.')
  return { lines: normalizeLines(lines), timing: 'word', metadata: [['lyrigen:alignment', ['machine-aligned; review recommended']]] }
}
