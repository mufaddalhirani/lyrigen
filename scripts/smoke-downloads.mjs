// End-to-end check for the Downloads / Organizer / Lyrics Finder backend.
// Boots the built app under Playwright's Electron driver with a throwaway
// profile, then drives the real IPC surface from the renderer:
//   1. tool discovery (yt-dlp / ffmpeg / ffprobe / ffplay)
//   2. Unison / AMLL / LRCLIB candidate search + fetch + re-timing
//   3. organiser planning on a scratch copy of a yt-dlp style file
//   4. (optional, --download) a real yt-dlp download of one short video,
//      tagging, lyric fetch and filing into a temp destination
//
// Usage: npm run build:dir && node scripts/smoke-downloads.mjs [--download] [--url=https://...]
// Requires the tools somewhere Lyrigen looks (C:\seng, PATH, …).

import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const wantDownload = process.argv.includes('--download')
const url = process.argv.find(argument => argument.startsWith('--url='))?.slice(6) || 'https://www.youtube.com/watch?v=g7eBUcivTE0'
const sampleFolder = process.argv.find(argument => argument.startsWith('--sample-folder='))?.slice(16) || 'C:\\seng\\night core'

function mktemp(label) { return mkdtempSync(path.join(tmpdir(), `lyrigen-${label}-`)) }
let failures = 0
function check(condition, message) { console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`); if (!condition) failures += 1 }

// Reads whatever lyrics live in the file's own tags. ffprobe surfaces an ID3
// USLT frame as `lyrics-eng` and a Vorbis/MP4 lyrics tag as `lyrics`, so one
// probe covers every container Lyrigen writes into.
function embeddedLyrics(file) {
  const ffprobe = ['C:\\seng\\ffprobe.exe', 'ffprobe'].find(candidate => {
    try { execFileSync(candidate, ['-version'], { stdio: 'ignore' }); return true } catch { return false }
  })
  if (!ffprobe) return null
  try {
    const probed = JSON.parse(execFileSync(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' }))
    const tags = Object.assign({}, probed.format?.tags, ...(probed.streams ?? []).map(stream => stream.tags ?? {}))
    for (const [key, value] of Object.entries(tags)) if (/^lyrics/i.test(key) && String(value).trim()) return String(value)
    return null
  } catch { return null }
}

async function main() {
  const profile = mktemp('profile')
  const destination = mktemp('dest')
  const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: projectRoot, env: { ...process.env, LYRIGEN_USER_DATA: profile } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForTimeout(800)

    // 1. Tools
    const tools = await win.evaluate(() => window.electronAPI.getToolsStatus())
    console.log('tools:', tools.tools.map(tool => `${tool.name}=${tool.ok ? tool.version : 'missing'}`).join('  '))
    check(tools.ready, 'yt-dlp + ffmpeg found')

    // 2. Lyrics sources
    const candidates = await win.evaluate(() => window.electronAPI.searchLyricCandidates({ trackName: 'Flashing Lights', artistName: 'Kanye West', videoId: 'cxKs2b5lRsA' }))
    console.log('candidates:', candidates.slice(0, 5).map(candidate => `${candidate.id} ${candidate.syncType} ${candidate.confidence} match=${candidate.match.toFixed(2)}`).join(' | '))
    check(candidates.length > 0, 'lyric search returned candidates')
    check(candidates.some(candidate => candidate.source === 'unison'), 'Unison contributed candidates')
    check(candidates[0]?.videoId === 'cxKs2b5lRsA', 'exact Unison video match ranked first')
    const fetched = await win.evaluate(candidate => window.electronAPI.fetchLyricCandidate(candidate, { retimeToDuration: candidate.duration ? candidate.duration / 1.25 : null }), candidates[0])
    check(Boolean(fetched?.content?.includes('<tt')), 'fetched TTML content from Unison')
    check(Boolean(fetched?.retimed), 'timing was stretched for a 1.25x speed edit')
    const best = await win.evaluate(() => window.electronAPI.findOnlineLyrics({ trackName: 'Never Gonna Give You Up', artistName: 'Rick Astley', duration: 213 }))
    check(best.found && Boolean(best.syncedLyrics || best.ttmlLyrics), `automatic lookup found synced lyrics (${best.source})`)

    // 3. Organiser plan on a scratch copy of a real yt-dlp file, if the sample folder exists.
    if (existsSync(sampleFolder)) {
      const scratch = mktemp('inbox')
      const sample = readdirSync(sampleFolder).find(file => /\.(m4a|mp3|opus|webm)$/i.test(file))
      if (sample) {
        copyFileSync(path.join(sampleFolder, sample), path.join(scratch, sample))
        const plan = await win.evaluate(([inputs, dest]) => window.electronAPI.planOrganize(inputs, { destination: dest, pathTemplate: '{artist}/{album}/{artist} - {title}', includeCleanFiles: true }), [[scratch], destination])
        console.log('plan:', plan.map(item => `${item.fileName} → ${item.proposedPath.slice(destination.length)} [${item.metadata.confidence}, ${item.metadata.variant ?? 'original'}, yt=${item.videoId}]`).join('\n      '))
        check(plan.length === 1, 'organiser produced a plan for the sample file')
        check(Boolean(plan[0]?.videoId), 'video id recovered from the file name')
        check(plan[0]?.metadata.variant === 'Sped Up' || plan[0]?.metadata.variant === 'Nightcore', 'variant detected')
        const applied = await win.evaluate(([items, dest]) => window.electronAPI.applyOrganize(items.map(item => ({ ...item, selected: true })), { destination: dest, pathTemplate: '{artist}/{album}/{artist} - {title}', rewriteTags: true, fetchLyrics: true, retimeLyrics: true, embedLyrics: true }), [plan, destination])
        check(applied.done === 1, 'organiser moved the file')
        const moved = plan[0] && existsSync(plan[0].proposedPath)
        check(Boolean(moved), `file exists at ${plan[0]?.proposedPath}`)
        if (moved) {
          const lyric = ['.ttml', '.lrc', '.txt'].map(extension => plan[0].proposedPath.replace(/\.[^.]+$/, extension)).find(existsSync)
          console.log('      lyrics sidecar:', lyric ?? 'none')
          if (lyric) {
            const embedded = embeddedLyrics(plan[0].proposedPath)
            console.log('      embedded tag  :', embedded ? `${embedded.split('\n').length} lines` : 'none')
            check(Boolean(embedded), 'lyrics embedded into the organised file')
          }
          const undo = await win.evaluate(() => window.electronAPI.undoOrganize())
          check(undo.undone && existsSync(path.join(scratch, sample)), 'undo moved the file back')
        }
      }
      rmSync(scratch, { recursive: true, force: true })
    } else console.log('skip  sample folder not found:', sampleFolder)

    // 4. Real download
    if (wantDownload) {
      const inspected = await win.evaluate(([link, dest]) => window.electronAPI.inspectDownloadUrl(link, { destination: dest }), [url, destination])
      check(inspected.ok && inspected.items.length === 1, `inspected ${url}: ${inspected.items[0]?.metadata.artist} — ${inspected.items[0]?.metadata.title} (${inspected.items[0]?.metadata.variant ?? 'original'})`)
      if (inspected.ok) {
        const item = inspected.items[0]
        const [job] = await win.evaluate(([entry, dest]) => window.electronAPI.enqueueDownloads([{ url: entry.url, videoId: entry.videoId, metadata: entry.metadata, info: { title: entry.info.title, uploader: entry.info.uploader, thumbnail: entry.info.thumbnail, duration: entry.info.duration, extractor: entry.info.extractor } }], { destination: dest, format: 'mp3', quality: 'high', organize: true, fetchLyrics: true, retimeLyrics: true, embedLyrics: true, embedThumbnail: true, pathTemplate: '{artist}/{album}/{artist} - {title}' }), [item, destination])
        let final = job
        for (let tick = 0; tick < 240; tick++) {
          await win.waitForTimeout(1000)
          const jobs = await win.evaluate(() => window.electronAPI.listDownloads())
          final = jobs.find(entry => entry.id === job.id)
          if (tick % 5 === 0) console.log(`      ${final.status} ${final.stage} ${Math.round(final.progress)}% ${final.speed ?? ''} ${final.eta ?? ''}`)
          if (['done', 'error', 'cancelled'].includes(final.status)) break
        }
        check(final.status === 'done', `download finished: ${final.stage}${final.error ? ` (${final.error})` : ''}`)
        if (final.outputPath) {
          console.log('      output:', final.outputPath, '\n      lyrics:', final.lyricPath, final.lyricSource, final.lyricRetimed ? '(re-timed)' : '')
          check(existsSync(final.outputPath), 'output file exists')
          const meta = await win.evaluate(file => window.electronAPI.getAudioMetadata(file), final.outputPath)
          console.log('      tags:', JSON.stringify({ title: meta?.title, artist: meta?.artist, album: meta?.album, year: meta?.year, cover: Boolean(meta?.cover), duration: meta?.duration }))
          check(meta?.title === (item.metadata.featuring ? `${item.metadata.title} (feat. ${item.metadata.featuring})` : item.metadata.title), 'clean title written to tags')
          check(Boolean(meta?.cover), 'cover art embedded')
          if (final.lyricPath) {
            const text = readFileSync(final.lyricPath, 'utf8')
            check(text.length > 100, `lyric file has content (${text.length} chars)`)
            const embedded = embeddedLyrics(final.outputPath)
            console.log('      embedded tag:', embedded ? `${embedded.split('\n').length} lines` : 'none')
            check(final.lyricEmbedded && Boolean(embedded), 'lyrics embedded into the downloaded file')
          }
        }
      }
    }
  } finally {
    await app.close()
    console.log(`\nartifacts kept in ${destination}`)
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
    process.exit(failures ? 1 : 0)
  }
}

main().catch(error => { console.error(error); process.exit(1) })
