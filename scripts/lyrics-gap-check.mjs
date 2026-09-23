// Checks the visualizer that replaces AMLL's interlude dots: shown in a gap
// between lines, hidden while a line is sung, and never left behind after a
// quick seek from a gap into a line (the old "stuck dots" bug).
//   node scripts/lyrics-gap-check.mjs <out-dir> <library-root> <gap-seconds> <line-seconds>
// The first song in the library is played; pick times from its lyric file.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [out = 'gap-check', root, gapAt = '20', lineAt = '45'] = process.argv.slice(2)
if (!root) { console.error('usage: node scripts/lyrics-gap-check.mjs <out-dir> <library-root> <gap-seconds> <line-seconds>'); process.exit(2) }
mkdirSync(out, { recursive: true })
const profile = mkdtempSync(path.join(tmpdir(), 'lyrigen-gap-'))
writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({ schemaVersion: 3, libraryRoots: [root], playlists: [], favorites: [], ratings: {}, playHistory: [], resumePositions: {}, queue: { currentTrackId: null, upcomingTrackIds: [], shuffle: false, repeat: 'off', autoplay: true }, settings: { visualMode: 'balanced' }, remoteCache: {}, migration: { importedLegacy: false, importedAt: null } }))
const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, LYRIGEN_USER_DATA: profile } })
const win = await app.firstWindow()
const errors = []
win.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1536, height: 864 })
await win.waitForTimeout(5000)
await win.locator('.nav button', { hasText: 'Library' }).first().click(); await win.waitForTimeout(1200)
await win.locator('.segmented-tabs button', { hasText: 'Songs' }).first().click(); await win.waitForTimeout(1200)
await win.locator('.track-row').first().dblclick({ force: true }); await win.waitForTimeout(2500)
await win.getByRole('button', { name: /full player/i }).first().click().catch(() => {})
await win.waitForTimeout(1500)

const state = () => win.evaluate(() => {
  const canvas = document.querySelector('.lyric-gap-visualizer')
  const wrapper = document.querySelector('.synced-lyrics [data-gap]')
  if (!canvas) return { canvas: false }
  const rect = canvas.getBoundingClientRect()
  return { time: document.querySelector('audio').currentTime.toFixed(1), gap: wrapper?.dataset.gap, size: `${Math.round(rect.width)}x${Math.round(rect.height)}`, opacity: getComputedStyle(canvas).opacity, background: getComputedStyle(canvas).backgroundColor }
})
const seek = seconds => win.evaluate(value => { const audio = document.querySelector('audio'); audio.currentTime = value; void audio.play() }, seconds)

await seek(Number(gapAt)); await win.waitForTimeout(2500)
console.log('in a gap   :', JSON.stringify(await state()))
await win.screenshot({ path: path.join(out, 'gap-visualizer.png') })
await seek(Number(lineAt)); await win.waitForTimeout(1500)
console.log('in a line  :', JSON.stringify(await state()))
await seek(Number(gapAt)); await win.waitForTimeout(300); await seek(Number(lineAt) + 1); await win.waitForTimeout(800)
console.log('gap → line :', JSON.stringify(await state()))
await win.screenshot({ path: path.join(out, 'gap-after-jump.png') })
console.log('console errors:', errors.length, errors.slice(0, 3).join(' | '))
await app.close()
