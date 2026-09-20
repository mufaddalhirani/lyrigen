import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import NodeID3 from 'node-id3'

export interface SongTags {
  title?: string; artist?: string; album?: string; albumArtist?: string; year?: string; releaseDate?: string
  genre?: string; trackNumber?: string; discNumber?: string; composer?: string; source?: string | null; sourceUrl?: string | null
  recordingId?: string | null; releaseId?: string | null; coverPath?: string | null
}
const supported = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif'])
export const overlayPath = (file: string) => path.join(path.dirname(file), `${path.parse(file).name}.lyrigen-metadata.json`)
export async function readOverlay(file: string): Promise<SongTags> {
  try { return JSON.parse(await fs.readFile(overlayPath(file), 'utf8')) } catch { return {} }
}
export async function readTags(file: string) {
  const { parseFile } = await import('music-metadata')
  const [tags, overlay] = await Promise.all([parseFile(file), readOverlay(file)])
  return { tags, overlay }
}
interface UndoEntry { target: string; backup: string | null }
export class MetadataFiles {
  constructor(private readonly dataDir: string) {}
  private get journal() { return path.join(this.dataDir, 'metadata-undo.json') }
  private async backup(target: string, entries: UndoEntry[]) {
    try {
      await fs.access(target)
      const folder = path.join(this.dataDir, 'backups')
      await fs.mkdir(folder, { recursive: true })
      const backup = path.join(folder, `${Date.now()}-${crypto.randomUUID()}${path.extname(target)}.bak`)
      await fs.copyFile(target, backup)
      entries.push({ target, backup })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      entries.push({ target, backup: null })
    }
  }
  async write(request: { filePath: string; metadata: SongTags; coverData?: string | null; source?: string | null; sourceUrl?: string | null }) {
    const file = path.resolve(request.filePath)
    if (!supported.has(path.extname(file).toLowerCase()) || !(await fs.stat(file)).isFile()) throw new Error('Choose an existing audio file.')
    const metadata: SongTags = { ...await readOverlay(file) }
    for (const field of ['title','artist','album','albumArtist','year','releaseDate','genre','trackNumber','discNumber','composer','recordingId','releaseId'] as const) {
      const value = request.metadata[field]
      if (typeof value === 'string' && value.trim()) metadata[field] = value.trim().slice(0, 2000)
    }
    metadata.source = request.source ?? metadata.source
    metadata.sourceUrl = request.sourceUrl ?? metadata.sourceUrl
    let picture: { mime: string; bytes: Buffer } | null = null
    if (request.coverData) {
      const match = request.coverData.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/)
      if (!match) throw new Error('Artwork must be JPEG, PNG, or WebP.')
      const bytes = Buffer.from(match[2], 'base64')
      if (bytes.length > 5_000_000) throw new Error('Artwork exceeds 5 MB.')
      picture = { mime: match[1], bytes }
    }
    const entries: UndoEntry[] = []
    const sidecar = overlayPath(file)
    await this.backup(sidecar, entries)
    const embedded = path.extname(file).toLowerCase() === '.mp3'
    if (embedded) await this.backup(file, entries)
    if (picture) {
      metadata.coverPath = `${sidecar}.${picture.mime.split('/')[1]}`
      await this.backup(metadata.coverPath, entries)
    }
    // Record recovery information before writing any target. Backups are grouped per operation.
    let history: UndoEntry[][] = []
    try { history = JSON.parse(await fs.readFile(this.journal, 'utf8')) } catch { /* first edit */ }
    await fs.mkdir(this.dataDir, { recursive: true })
    await fs.writeFile(this.journal, JSON.stringify([...history, entries]))
    try {
      if (embedded) {
        const update: NodeID3.Tags = {}
        const mapping = { title: 'title', artist: 'artist', album: 'album', albumArtist: 'performerInfo', year: 'year', genre: 'genre', trackNumber: 'trackNumber', discNumber: 'partOfSet', composer: 'composer', releaseDate: 'releaseTime' } as const
        for (const [from, to] of Object.entries(mapping)) {
          const value = metadata[from as keyof SongTags]
          if (value) Object.assign(update, { [to]: value })
        }
        if (picture) update.image = { mime: picture.mime, type: { id: 3, name: 'front cover' }, description: 'Front cover', imageBuffer: picture.bytes }
        const original = await fs.readFile(file)
        const updated = NodeID3.update(update, original)
        if (!Buffer.isBuffer(updated)) throw new Error('The MP3 tag writer could not update this file.')
        const temporary = `${file}.lyrigen-writing`
        await fs.writeFile(temporary, updated)
        await fs.rename(temporary, file)
      }
      if (picture && metadata.coverPath) await fs.writeFile(metadata.coverPath, picture.bytes)
      await fs.writeFile(`${sidecar}.tmp`, JSON.stringify(metadata, null, 2), 'utf8')
      await fs.rename(`${sidecar}.tmp`, sidecar)
      return { written: true as const, mode: embedded ? 'embedded' as const : 'sidecar' as const, path: file }
    } catch (error) {
      await this.undo()
      throw error
    }
  }
  async undo() {
    let history: UndoEntry[][]
    try { history = JSON.parse(await fs.readFile(this.journal, 'utf8')) } catch { return { undone: false, message: 'No metadata edits to undo.' } }
    const entries = history.at(-1)
    if (!entries) return { undone: false, message: 'No metadata edits to undo.' }
    for (const entry of [...entries].reverse()) {
      if (entry.backup) await fs.copyFile(entry.backup, entry.target)
      else await fs.unlink(entry.target).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
    await fs.writeFile(this.journal, JSON.stringify(history.slice(0, -1)))
    return { undone: true, message: 'Restored the previous metadata and artwork.' }
  }
}
