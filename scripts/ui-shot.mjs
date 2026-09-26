// Launches the real app on a throwaway profile seeded with a library folder,
// plays a track, and measures whether anything overlaps the control dock.
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node scripts/ui-shot.mjs <music-folder>'); process.exit(2) }
const profile = mkdtempSync(path.join(tmpdir(), 'lyrigen-ui-'))
writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({
  schemaVersion: 3, libraryRoots: [root], playlists: [], favorites: [], ratings: {}, playHistory: [],
  resumePositions: {}, queue: { currentTrackId: null, upcomingTrackIds: [], shuffle: false, repeat: 'off', autoplay: true },
  settings: { visualMode: 'balanced', lyricFontSize: 1, lyricDensity: 'comfortable', crossfade: false },
  remoteCache: {}, migration: { importedLegacy: false, importedAt: null },
}))

const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, LYRIGEN_USER_DATA: profile } })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1536, height: 864 })
await win.waitForTimeout(6000)

console.log('roots:', await win.evaluate(() => window.electronAPI.getLibraryRoots()))
// Land on the library list, then wait for the scan to populate it.
const nav = win.locator('.nav button', { hasText: 'Library' }).first()
if (await nav.count()) await nav.click({ force: true })
await win.waitForTimeout(1500)
const listBtn = win.locator('button', { hasText: /^Songs$/ }).first()
if (await listBtn.count()) await listBtn.click({ force: true }).catch(() => {})
await win.waitForTimeout(2500)
const tracks = await win.evaluate(() => document.querySelectorAll('.track-row, .track-card').length)
console.log('library rows rendered:', tracks)
// open the first track
const row = win.locator('.track-row, .track-card').first()
if (await row.count()) { await row.dblclick({ force: true }).catch(() => row.click({ force: true })) }
await win.waitForTimeout(3500)
// Playing always opens the full player; collapse it to reach the mini bar.
const toMini = win.locator('[aria-label="Mini player"]').first()
if (await toMini.count()) { await toMini.click({ force: true }); await win.waitForTimeout(1200) }
await win.screenshot({ path: (process.argv[3] || 'ui-check.png').replace(/\.png$/, '-mini.png') })
const miniGeom = await win.evaluate(() => { const el = document.querySelector('.mini-player'); if (!el) return null; const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height), centred: Math.abs((b.left + b.right) / 2 - window.innerWidth / 2) < 2 } })
console.log('mini player:', JSON.stringify(miniGeom))
// go to the full now-playing screen if we're docked
const expand = win.locator('.mini-expand, [aria-label*="full" i], [aria-label*="Now playing" i]').first()
if (await expand.count()) await expand.click({ force: true }).catch(() => {})
await win.waitForTimeout(2500)

const geom = await win.evaluate(() => {
  const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { sel, top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) } }
  return { details: r('.track-details'), album: r('.track-details p'), dock: r('.control-dock'), art: r('.hero-artwork'), layout: r('.now-playing-layout'), lyrics: r('.lyrics-column'), vh: window.innerHeight }
})
console.log(JSON.stringify(geom, null, 1))
if (geom.dock && geom.details) {
  const overlapY = geom.details.bottom - geom.dock.top
  const overlapX = Math.min(geom.details.right, geom.dock.right) - Math.max(geom.details.left, geom.dock.left)
  console.log(`\nOVERLAP: vertical ${overlapY}px, horizontal ${overlapX}px -> ${overlapY > 0 && overlapX > 0 ? 'COLLIDING' : 'clear'}`)
}
await win.screenshot({ path: process.argv[3] || 'ui-check.png' })
await app.close()
