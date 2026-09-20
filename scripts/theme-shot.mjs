// Opens Sound Lab and screenshots each theme, to eyeball the palettes.
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const outDir = process.argv[2] || '.'
const profile = mkdtempSync(path.join(tmpdir(), 'lyrigen-theme-'))
writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({
  schemaVersion: 3, libraryRoots: [], playlists: [], favorites: [], ratings: {}, playHistory: [],
  resumePositions: {}, queue: { currentTrackId: null, upcomingTrackIds: [], shuffle: false, repeat: 'off', autoplay: true },
  settings: { visualMode: 'balanced', lyricFontSize: 1, lyricDensity: 'comfortable', crossfade: false },
  remoteCache: {}, migration: { importedLegacy: false, importedAt: null },
}))
const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, LYRIGEN_USER_DATA: profile } })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForTimeout(3000)
await win.locator('.sidebar-section button', { hasText: 'Sound Lab' }).first().click({ force: true })
await win.waitForTimeout(1200)
const chips = await win.locator('.appearance-row').first().locator('.appearance-chip').count()
console.log('theme chips rendered:', chips)
for (const theme of ['nocturne', 'spotlight', 'lucid', 'ember', 'paper', 'monochrome']) {
  await win.locator(`.appearance-chip.theme-${theme}`).first().click({ force: true })
  await win.waitForTimeout(500)
  const applied = await win.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }))
  console.log(`${theme.padEnd(11)} -> data-theme=${applied.theme} bg=${applied.bg} accent=${applied.accent}`)
  await win.screenshot({ path: path.join(outDir, `theme-${theme}.png`) })
}
// fonts + motion apply too
await win.locator('.appearance-row').nth(1).locator('.appearance-chip', { hasText: 'Serif' }).click({ force: true })
await win.locator('.appearance-row').nth(2).locator('.appearance-chip', { hasText: 'Focus' }).click({ force: true })
await win.waitForTimeout(400)
console.log('font/motion:', await win.evaluate(() => ({ font: document.documentElement.dataset.font, motion: document.documentElement.dataset.lyricMotion, family: getComputedStyle(document.body).fontFamily.slice(0, 40) })))
await app.close()
