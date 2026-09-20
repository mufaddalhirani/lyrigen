export function normalize(value: string) { return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() }
export function cleanTitle(value: string) { return value.replace(/^\s*\d{1,2}[-. ]\d{1,3}\s*[-. ]\s*/, '').replace(/^\s*\d{1,3}\s*[-.]\s*/, '').replace(/\.(mp3|flac|m4a|wav|opus)$/i, '').trim() }
type Match = { title?: string; artist?: string; album?: string; duration?: number | null }
export function matchScore(wanted: Match, candidate: Match) {
  const equal = (a?: string, b?: string) => Boolean(a && b && normalize(a) === normalize(b))
  const title = equal(cleanTitle(wanted.title || ''), candidate.title)
  const artist = equal(wanted.artist, candidate.artist)
  const album = equal(wanted.album, candidate.album)
  const duration = wanted.duration && candidate.duration ? Math.abs(wanted.duration - candidate.duration) : null
  const score = (title ? 45 : 0) + (artist ? 35 : 0) + (album ? 10 : 0) + (duration !== null && duration < 3 ? 10 : 0) - (duration !== null && duration > 15 ? 35 : 0)
  return { score, confidence: title && artist && (duration === null || duration < 5) ? 'high' as const : score >= 45 ? 'medium' as const : 'low' as const }
}

/** Reserve request slots synchronously so parallel callers cannot violate provider limits. */
export function createRateLimiter(interval: number) {
  let nextSlot = 0
  return async () => {
    const now = Date.now(), slot = Math.max(now, nextSlot)
    nextSlot = slot + interval
    if (slot > now) await new Promise(resolve => setTimeout(resolve, slot - now))
  }
}
export async function mapLimited<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; result[index] = await worker(items[index], index) }
  }))
  return result
}
