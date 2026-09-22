// Screenshots the main views of the real app on a throwaway profile, so UI
// changes can be looked at rather than guessed at.
//   node scripts/tour-shot.mjs <out-dir> [library-root ...]
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const out = process.argv[2] || 'tour'
const roots = process.argv.slice(3)
mkdirSync(out, { recursive: true })
// TOUR_HISTORY: files to pretend were played, oldest first, so Home has something to show.
const history = (process.env.TOUR_HISTORY || '').split(';').filter(Boolean).map((file, index) => ({ trackId: file.toLocaleLowerCase(), playedAt: new Date(Date.now() - (100 - index) * 60_000).toISOString(), seconds: 200 }))
const profile = mkdtempSync(path.join(tmpdir(), 'lyrigen-tour-'))
writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({
  schemaVersion: 3, libraryRoots: roots, playlists: [], favorites: [], ratings: {}, playHistory: history,
  resumePositions: {}, queue: { currentTrackId: null, upcomingTrackIds: [], shuffle: false, repeat: 'off', autoplay: true },
  settings: { visualMode: 'balanced', lyricFontSize: 1, lyricDensity: 'comfortable', crossfade: false },
  remoteCache: {}, migration: { importedLegacy: false, importedAt: null },
}))
// Optionally borrow real download settings (never the queue), so the quality
// panel tests the machine's actual sign-in and token setup.
if (process.env.TOUR_DOWNLOAD_SETTINGS) {
  const real = JSON.parse(readFileSync(process.env.TOUR_DOWNLOAD_SETTINGS, 'utf8')).settings
  writeFileSync(path.join(profile, 'downloads.json'), JSON.stringify({ settings: { ...real, potProviderFolder: real.potProviderFolder || process.env.TOUR_POT_FOLDER || null }, jobs: [], organizeJournal: [], noPremiumStream: [] }))
}
const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, LYRIGEN_USER_DATA: profile } })
const win = await app.firstWindow()
const errors = []
win.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1536, height: 864 })
await win.waitForTimeout(9000)
const views = (process.env.TOUR_VIEWS || 'Home,Library,Downloads').split(',')
for (const view of views) {
  let nav = win.locator('.nav button', { hasText: view }).first()
  // Tools live in a second list in the sidebar with a different class.
  if (!(await nav.count())) nav = win.getByRole('button', { name: view, exact: true }).first()
  if (!(await nav.count())) { console.log('no nav for', view); continue }
  await nav.click({ force: true })
  await win.waitForTimeout(Number(process.env.TOUR_WAIT || 2500))
  await win.screenshot({ path: path.join(out, `${view.replace(/\W+/g, '-').toLowerCase()}.png`) })
  console.log('shot', view)
}
if (process.env.TOUR_SONGS) {
  const tab = win.getByRole('button', { name: 'Songs', exact: true }).first()
  if (await tab.count()) { await tab.click(); await win.waitForTimeout(2500); await win.screenshot({ path: path.join(out, 'songs.png') }); console.log('shot songs') }
}
if (process.env.TOUR_PLAY) {
  const row = win.locator('.track-row, .track-card').first()
  if (await row.count()) { await row.dblclick({ force: true }).catch(() => row.click({ force: true })); await win.waitForTimeout(4000); await win.screenshot({ path: path.join(out, 'now-playing.png') }); console.log('shot now playing') }
}
console.log('console errors:', errors.length, errors.slice(0, 3).join(' | '))
await app.close()
