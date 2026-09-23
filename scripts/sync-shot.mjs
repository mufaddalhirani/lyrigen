// End-to-end check of Sync with AI on a throwaway profile: pick a song in the
// Lyrics Finder, let the panel find its lyrics, generate, then play the song
// and look at the lyrics it made.
//   node scripts/sync-shot.mjs <out-dir> <library-root> [song title]
// SYNC_LEVEL=word|syllable (default syllable), SYNC_SEEK=seconds to play from.
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [out = 'sync-shots', root, title = ''] = process.argv.slice(2)
if (!root) { console.error('usage: node scripts/sync-shot.mjs <out-dir> <library-root> [song title]'); process.exit(2) }
mkdirSync(out, { recursive: true })
const profile = mkdtempSync(path.join(tmpdir(), 'lyrigen-sync-'))
writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({
  schemaVersion: 3, libraryRoots: [root], playlists: [], favorites: [], ratings: {}, playHistory: [],
  resumePositions: {}, queue: { currentTrackId: null, upcomingTrackIds: [], shuffle: false, repeat: 'off', autoplay: true },
  settings: { visualMode: 'balanced', lyricFontSize: 1, lyricDensity: 'comfortable', crossfade: false },
  remoteCache: {}, migration: { importedLegacy: false, importedAt: null },
}))
const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, LYRIGEN_USER_DATA: profile } })
const win = await app.firstWindow()
const errors = []
win.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1536, height: 864 })
await win.waitForTimeout(7000)
await win.evaluate(level => localStorage.setItem('lyrigen.aiSync', JSON.stringify({ level })), process.env.SYNC_LEVEL || 'syllable')

await win.getByRole('button', { name: /Lyrics Finder/ }).first().click()
await win.waitForTimeout(1500)
await win.getByRole('button', { name: 'All songs' }).first().click()
await win.waitForTimeout(800)
const row = win.locator('.lyrics-row, .row', { hasText: title }).filter({ has: win.getByRole('button', { name: 'AI sync' }) }).first()
await row.getByRole('button', { name: 'AI sync' }).click()
const panel = win.locator('.ai-sync')
await panel.scrollIntoViewIfNeeded()
// The lyrics should arrive by themselves.
await win.waitForFunction(() => (document.querySelector('.ai-sync textarea')?.value ?? '').length > 20 || /No lyrics|could not/.test(document.querySelector('.ai-sync')?.textContent ?? ''), null, { timeout: 60_000 })
console.log('lyrics label:', await panel.locator('.ai-sync-lyrics-head > span').textContent())
console.log('plan:', await panel.locator('.ai-sync-actions small').textContent())
console.log('level:', await panel.locator('select').first().inputValue())
await panel.screenshot({ path: path.join(out, 'panel-found.png') })

const started = Date.now()
await panel.getByRole('button', { name: /Generate synced lyrics/ }).click()
await win.waitForSelector('.ai-sync-status.done, .ai-sync-status.error', { timeout: 15 * 60_000 })
console.log(`finished in ${Math.round((Date.now() - started) / 1000)}s:`, await panel.locator('.ai-sync-status-line span').first().textContent())
console.log('saved:', await panel.locator('.cookie-status').first().textContent().catch(() => '—'))
await panel.screenshot({ path: path.join(out, 'panel-done.png') })

// Play it and look at the lyrics.
await win.waitForTimeout(2500)
await win.locator('.nav button', { hasText: 'Library' }).first().click()
await win.waitForTimeout(1500)
const songsTab = win.getByRole('button', { name: 'Songs', exact: true }).first()
if (await songsTab.count()) { await songsTab.click(); await win.waitForTimeout(1500) }
await win.locator('.track-row', { hasText: title }).first().dblclick({ force: true })
await win.waitForTimeout(3000)
// The dock expands into the full player, where the lyrics are.
const expand = win.getByRole('button', { name: /full player|expand|now playing/i }).first()
if (await expand.count()) await expand.click().catch(() => undefined)
await win.waitForTimeout(2000)
const seek = Number(process.env.SYNC_SEEK || 45)
await win.evaluate(seconds => { const media = document.querySelector('audio'); if (media) { media.currentTime = seconds; void media.play() } }, seek)
await win.waitForTimeout(4000)
await win.screenshot({ path: path.join(out, 'playing.png') })
const words = await win.evaluate(() => {
  const line = document.querySelector('[class*="lyricLine"][class*="active"], [class*="active"][class*="line"]')
  return line ? [...line.querySelectorAll('span')].map(span => span.textContent).filter(Boolean).slice(0, 30) : null
})
console.log('active line pieces:', JSON.stringify(words))
console.log('console errors:', errors.length, errors.slice(0, 3).join(' | '))
await app.close()
