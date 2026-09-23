// How long until the library is on screen, on a first and a second launch.
//   node scripts/startup-check.mjs <library-root> [runs=2]
// Both launches share one throwaway profile, so the second shows what every
// launch after the first feels like.
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.argv[2]
const runs = Number(process.argv[3] || 2)
if (!root) { console.error('usage: node scripts/startup-check.mjs <library-root> [runs]'); process.exit(2) }
const profile = mkdtempSync(path.join(tmpdir(), 'lyrigen-startup-'))
writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({ schemaVersion: 3, libraryRoots: [root], playlists: [], favorites: [], ratings: {}, playHistory: [], resumePositions: {}, queue: { currentTrackId: null, upcomingTrackIds: [], shuffle: false, repeat: 'off', autoplay: true }, settings: { visualMode: 'balanced' }, remoteCache: {}, migration: { importedLegacy: false, importedAt: null } }))

for (let run = 1; run <= runs; run++) {
  const started = Date.now()
  const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, LYRIGEN_USER_DATA: profile } })
  const win = await app.firstWindow()
  const errors = []
  win.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await win.waitForLoadState('domcontentloaded')
  let sawScanning = false
  const count = async () => win.evaluate(() => Number(document.querySelector('.nav button:nth-child(2) b')?.textContent || 0)).catch(() => 0)
  let shown = 0
  while (Date.now() - started < 15 * 60_000) {
    const status = await win.evaluate(() => document.querySelector('.root-status strong')?.textContent ?? '').catch(() => '')
    if (/Scanning/.test(status)) sawScanning = true
    shown = await count()
    if (shown > 0 && !/Loading/.test(status)) break
    await win.waitForTimeout(100)
  }
  const onScreen = Date.now() - started
  // Then wait for the background check to finish.
  const settled = await win.waitForFunction(() => !/Scanning|Loading/.test(document.querySelector('.root-status strong')?.textContent ?? ''), null, { timeout: 15 * 60_000 }).then(() => Date.now() - started).catch(() => null)
  console.log(`launch ${run}: ${shown} songs on screen after ${(onScreen / 1000).toFixed(1)} s · background check done at ${settled ? (settled / 1000).toFixed(1) + ' s' : 'n/a'} · showed "Scanning": ${sawScanning} · console errors: ${errors.length}`)
  await app.close()
}
