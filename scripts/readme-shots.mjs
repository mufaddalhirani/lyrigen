// Screenshots for the README, taken from the real app on a throwaway profile.
//   node scripts/readme-shots.mjs <demo-library> [out=docs/screenshots]
// Use a demo library (made-up songs, generated covers, original lyrics) so the
// pictures contain nothing copyrighted and nothing from anyone's own music.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [root, out = 'docs/screenshots'] = process.argv.slice(2)
if (!root) { console.error('usage: node scripts/readme-shots.mjs <demo-library> [out]'); process.exit(2) }
mkdirSync(out, { recursive: true })
const songs = []
const walk = folder => { for (const name of readdirSync(folder)) { const full = path.join(folder, name); if (statSync(full).isDirectory()) walk(full); else if (/\.(opus|mp3|m4a|flac)$/i.test(name)) songs.push(full) } }
walk(root)
const history = songs.slice(0, 6).map((file, index) => ({ trackId: file.toLocaleLowerCase(), playedAt: new Date(Date.now() - (60 - index * 7) * 60_000).toISOString(), seconds: 96 }))
const profile = mkdtempSync(path.join(tmpdir(), 'lyrigen-readme-'))
writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({ schemaVersion: 3, libraryRoots: [root], playlists: [], favorites: [songs[0].toLocaleLowerCase()], ratings: {}, playHistory: history, resumePositions: {}, queue: { currentTrackId: null, upcomingTrackIds: [], shuffle: false, repeat: 'off', autoplay: true }, settings: { visualMode: 'balanced' }, remoteCache: {}, migration: { importedLegacy: true, importedAt: null } }))

const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, LYRIGEN_USER_DATA: profile } })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1440, height: 900 })
await win.evaluate(() => { localStorage.setItem('lyrigen-debug', '1') })
await win.reload()
await win.waitForTimeout(6000)
const shot = async name => { await win.mouse.move(720, 470); await win.waitForTimeout(700); await win.screenshot({ path: path.join(out, `${name}.png`) }); console.log('shot', name) }
const nav = name => win.locator('.nav button, .sidebar-section button', { hasText: name }).first().click()

await nav('Home'); await shot('home')
await nav('Library'); await win.waitForTimeout(800)
await win.locator('.segmented-tabs button', { hasText: 'Albums' }).first().click(); await shot('library')

// The player, mid-line, with the fluid background.
await win.locator('.segmented-tabs button', { hasText: 'Songs' }).first().click(); await win.waitForTimeout(800)
await win.locator('.track-row', { hasText: 'Glass Horizon' }).first().dblclick({ force: true }); await win.waitForTimeout(2500)
await win.getByRole('button', { name: /full player/i }).first().click().catch(() => {})
const seek = seconds => win.evaluate(value => { const audio = document.querySelector('audio:not(.track-preloader)'); audio.currentTime = value; void audio.play() }, seconds)
await seek(13.2); await win.waitForTimeout(2600); await shot('player')
await seek(20.6); await win.waitForTimeout(1800); await shot('player-interlude')

// Kinetic: words land as they are sung, held notes in the serif.
await win.locator('.view-mode-button').click(); await win.waitForTimeout(250)
await win.locator('.view-mode-option', { hasText: 'Kinetic' }).click(); await win.waitForTimeout(400)
await seek(13.6); await win.waitForTimeout(2400); await shot('kinetic')
await win.locator('.view-mode-button').click(); await win.waitForTimeout(250)
await win.locator('.view-mode-option', { hasText: 'Balanced' }).click(); await win.waitForTimeout(400)

// brat mode.
await win.getByRole('button', { name: 'Sound and lyrics settings' }).click().catch(() => {})
await win.waitForTimeout(400)
await win.selectOption('select[aria-label="Visual mode"]', 'brat').catch(() => {})
await win.getByRole('button', { name: 'Sound and lyrics settings' }).click().catch(() => {})
await seek(29.4); await win.waitForTimeout(2200); await shot('brat')
await win.getByRole('button', { name: 'Sound and lyrics settings' }).click().catch(() => {})
await win.selectOption('select[aria-label="Visual mode"]', 'balanced').catch(() => {})
await win.evaluate(() => document.querySelector('audio:not(.track-preloader)').pause())
await win.getByRole('button', { name: /^Library$/ }).first().click().catch(() => {})
await win.waitForTimeout(800)

// DJ: two decks, synced.
await nav('DJ'); await win.waitForTimeout(800)
const load = async (deck, title) => {
  await win.locator('.dj-result', { hasText: title }).first().getByRole('button', { name: deck.toUpperCase(), exact: true }).click()
  await win.waitForFunction(id => { const d = window.lyrigenDj?.decks[id].state; return d?.track && !d.loading }, deck, { timeout: 60_000 })
}
await load('a', 'Glass Horizon'); await load('b', 'Satellite Heart')
await win.locator('.deck-a .dj-pad.play').click(); await win.waitForTimeout(1500)
await win.locator('.deck-b .dj-pad.play').click(); await win.waitForTimeout(300)
await win.locator('.deck-b .dj-pad.sync').click()
await win.evaluate(() => window.lyrigenDj.setCrossfader(0.42))
await win.locator('.deck-a .dj-hotcues .dj-pad').first().click()
await win.evaluate(() => document.querySelector('.main-content').scrollTo(0, 0))
await win.waitForTimeout(2500); await shot('dj')
await win.locator('.deck-a .dj-pad.play').click(); await win.locator('.deck-b .dj-pad.play').click()

// Lyrics Finder with the AI sync panel open.
await nav('Lyrics Finder'); await win.waitForTimeout(800)
await win.getByRole('button', { name: 'All songs' }).first().click().catch(() => {})
await win.locator('.lyrics-row, .row', { hasText: 'Glass Horizon' }).filter({ has: win.getByRole('button', { name: 'AI sync' }) }).first().getByRole('button', { name: 'AI sync' }).click()
await win.waitForTimeout(3500)
await win.evaluate(() => document.querySelector('.ai-sync')?.scrollIntoView({ block: 'start' }))
await shot('lyrics')

await app.close()
