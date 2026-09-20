import { app, nativeImage } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

/**
 * Cover-art thumbnail cache.
 *
 * Profiling the library view found 80 covers on screen holding 82 megapixels
 * of decoded bitmap while occupying under 2 megapixels of actual screen space
 * -- a 42x waste. Full 1000x1000 and 1500x1472 artwork was being decoded and
 * downscaled on every paint to fill 42x42 list rows.
 *
 * This resizes once, on disk, in the main process, and hands the renderer a
 * file:// URL to a thumbnail that is close to its display size. Cached by
 * source path + mtime + size, so edited artwork re-renders and unchanged
 * artwork never resizes twice.
 */

export type ThumbSize = 64 | 128 | 256 | 512

const VALID_SIZES: ThumbSize[] = [64, 128, 256, 512]

/** In-flight and completed lookups, so a list of 500 rows resizes each file once. */
const pending = new Map<string, Promise<string | null>>()

function cacheRoot() {
  return path.join(app.getPath('userData'), 'artwork-cache')
}

function keyFor(sourcePath: string, size: ThumbSize, mtimeMs: number) {
  const hash = crypto
    .createHash('sha1')
    .update(`${sourcePath}|${size}|${Math.round(mtimeMs)}`)
    .digest('hex')
  return `${hash}-${size}.jpg`
}

/** Snap a requested pixel size up to the nearest cached tier. */
export function normaliseSize(requested: number): ThumbSize {
  for (const size of VALID_SIZES) {
    if (requested <= size) return size
  }
  return 512
}

async function buildThumbnail(
  sourcePath: string,
  size: ThumbSize,
  destination: string,
): Promise<string | null> {
  const image = nativeImage.createFromPath(sourcePath)
  if (image.isEmpty()) return null

  const { width, height } = image.getSize()
  if (!width || !height) return null

  // Never upscale -- a 48x48 embedded cover should stay 48x48.
  const longest = Math.max(width, height)
  const target = Math.min(size, longest)

  const resized =
    width >= height
      ? image.resize({ width: target, quality: 'good' })
      : image.resize({ height: target, quality: 'good' })

  // JPEG at 82 is visually indistinguishable at thumbnail scale and keeps the
  // cache small; PNG album art routinely costs 10x more for no visible gain.
  const buffer = resized.toJPEG(82)
  await fs.promises.mkdir(path.dirname(destination), { recursive: true })
  await fs.promises.writeFile(destination, buffer)
  return destination
}

/**
 * Returns a file:// URL for a thumbnail of `sourcePath` at roughly `size`
 * pixels on its longest edge, generating it if necessary. Returns the
 * original file URL if the source cannot be decoded, so callers always get
 * something displayable.
 */
export async function getThumbnailUrl(
  sourcePath: string,
  requestedSize: number,
): Promise<string | null> {
  if (!sourcePath) return null

  const size = normaliseSize(requestedSize)

  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(sourcePath)
  } catch {
    return null
  }

  const destination = path.join(cacheRoot(), keyFor(sourcePath, size, stat.mtimeMs))
  const dedupeKey = destination

  const existing = pending.get(dedupeKey)
  if (existing) return existing

  const job = (async () => {
    try {
      // Already cached from an earlier session.
      await fs.promises.access(destination, fs.constants.R_OK)
      return pathToFileURL(destination).toString()
    } catch {
      // Not cached yet -- build it.
    }

    try {
      const built = await buildThumbnail(sourcePath, size, destination)
      if (built) return pathToFileURL(built).toString()
    } catch (error) {
      console.warn('[artwork] thumbnail failed for', sourcePath, error)
    }

    // Fall back to the original so the UI still shows a cover.
    return pathToFileURL(sourcePath).toString()
  })()

  pending.set(dedupeKey, job)
  // Keep the resolved promise cached -- repeated scrolling hits it constantly.
  job.catch(() => pending.delete(dedupeKey))
  return job
}

/** Drops cache entries not touched in `maxAgeDays`. Cheap, best-effort. */
export async function pruneThumbnailCache(maxAgeDays = 60) {
  const root = cacheRoot()
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  try {
    const entries = await fs.promises.readdir(root)
    await Promise.all(
      entries.map(async name => {
        const full = path.join(root, name)
        try {
          const stat = await fs.promises.stat(full)
          if (stat.atimeMs < cutoff) await fs.promises.unlink(full)
        } catch {
          /* ignore */
        }
      }),
    )
  } catch {
    /* cache folder may not exist yet */
  }
}
