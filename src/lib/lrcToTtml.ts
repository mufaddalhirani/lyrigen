export interface LrcCue {
  startTime: number
  endTime: number
  text: string
}

export interface LrcDocumentInfo {
  title: string | null
  artist: string | null
  offsetMs: number
}

export interface LrcConversionResult {
  cues: LrcCue[]
  info: LrcDocumentInfo
  ttml: string
  warnings: string[]
}

const timeTagPattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
const metadataPattern = /^\[([^:]+):([^\]]*)\]$/

function parseTimestamp(minutesText: string, secondsText: string, fractionText = '') {
  const minutes = Number(minutesText)
  const seconds = Number(secondsText)
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds > 59) return null

  const fraction = fractionText ? Number(`0.${fractionText}`) : 0
  return Math.round((minutes * 60 + seconds + fraction) * 1000)
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function formatTtmlTime(milliseconds: number) {
  const safeMilliseconds = Math.max(0, Math.round(milliseconds))
  const hours = Math.floor(safeMilliseconds / 3_600_000)
  const minutes = Math.floor((safeMilliseconds % 3_600_000) / 60_000)
  const seconds = Math.floor((safeMilliseconds % 60_000) / 1000)
  const remainder = safeMilliseconds % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`
}

function splitWords(text: string) {
  return text.match(/\S+(?:\s+|$)/g) ?? [text]
}

function wordSpans(text: string, startTime: number, endTime: number) {
  const words = splitWords(text)
  if (words.length === 1) {
    return `<span begin="${formatTtmlTime(startTime)}" end="${formatTtmlTime(endTime)}">${escapeXml(words[0])}</span>`
  }

  const weights = words.map(word => Math.max(1, word.trim().length))
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const duration = Math.max(1, endTime - startTime)
  let cursor = startTime

  return words.map((word, index) => {
    const wordStart = cursor
    cursor += index === words.length - 1 ? endTime - cursor : duration * (weights[index] / totalWeight)
    return `<span begin="${formatTtmlTime(wordStart)}" end="${formatTtmlTime(cursor)}">${escapeXml(word)}</span>`
  }).join('')
}

function createTtml(cues: LrcCue[], info: LrcDocumentInfo) {
  const title = info.title ? `\n    <metadata><title>${escapeXml(info.title)}</title>${info.artist ? `<artist>${escapeXml(info.artist)}</artist>` : ''}</metadata>` : ''
  const lines = cues.map(cue => `      <p begin="${formatTtmlTime(cue.startTime)}" end="${formatTtmlTime(cue.endTime)}">${wordSpans(cue.text, cue.startTime, cue.endTime)}</p>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml">${title}\n  <body>\n    <div>\n${lines}\n    </div>\n  </body>\n</tt>\n`
}

export function convertLrcToTtml(source: string): LrcConversionResult {
  const info: LrcDocumentInfo = { title: null, artist: null, offsetMs: 0 }
  const warnings: string[] = []
  const rawCues: Array<{ startTime: number; text: string; order: number }> = []
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)

  lines.forEach(line => {
    const metadata = line.trim().match(metadataPattern)
    if (!metadata) return
    const key = metadata[1].toLocaleLowerCase()
    if (key === 'ti' && metadata[2].trim()) info.title = metadata[2].trim()
    if (key === 'ar' && metadata[2].trim()) info.artist = metadata[2].trim()
    if (key === 'offset' && Number.isFinite(Number(metadata[2]))) info.offsetMs = Number(metadata[2])
  })

  let order = 0

  lines.forEach(line => {
    const timestamps: Array<{ startTime: number; endIndex: number }> = []
    timeTagPattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = timeTagPattern.exec(line))) {
      const startTime = parseTimestamp(match[1], match[2], match[3] ?? '')
      if (startTime !== null) timestamps.push({ startTime, endIndex: (match.index ?? 0) + match[0].length })
    }

    if (!timestamps.length) return
    const text = line.slice(Math.max(...timestamps.map(timestamp => timestamp.endIndex))).trim()
    if (!text) return
    timestamps.forEach(timestamp => {
      rawCues.push({ startTime: Math.max(0, timestamp.startTime + info.offsetMs), text, order: order++ })
    })
  })

  const sorted = rawCues.sort((left, right) => left.startTime - right.startTime || left.order - right.order)
  const cues = sorted.map((cue, index) => {
    const nextStart = sorted[index + 1]?.startTime
    const naturalEnd = nextStart === undefined ? cue.startTime + 4000 : nextStart
    const endTime = Math.max(cue.startTime + 500, naturalEnd)
    return { startTime: cue.startTime, endTime, text: cue.text }
  })

  if (!cues.length) warnings.push('No timestamped lyric lines were found.')
  if (info.offsetMs) warnings.push(`Applied the LRC offset of ${info.offsetMs > 0 ? '+' : ''}${info.offsetMs} ms.`)
  if (cues.length && cues[cues.length - 1].endTime === cues[cues.length - 1].startTime + 4000) warnings.push('The final line uses an estimated four-second duration.')

  return { cues, info, ttml: createTtml(cues, info), warnings }
}

export function ttmlFileName(fileName: string) {
  return fileName.replace(/\.lrc$/i, '') + '.ttml'
}
