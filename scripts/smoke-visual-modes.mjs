// Headless verification for the Player's visual modes (balanced / lyrics /
// cover / vinyl / visualizer). Builds the app, boots it under Playwright's
// Electron driver with a tiny synthetic library, cycles every visual mode,
// and asserts the CSS actually changed what it should. Screenshots land in
// .smoke-shots/ so a human can eyeball them too.
//
// Usage: npm run build:dir && npm run smoke:visual-modes
// Requires: ffmpeg on PATH (to synthesize a throwaway test track) and an X
// server (xvfb-run on Linux CI; not needed on Windows/macOS dev machines).

import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const shotsDir = path.join(projectRoot, '.smoke-shots')
mkdirSync(shotsDir, { recursive: true })

function makeLibrary() {
  const dir = mktemp()
  const track = path.join(dir, 'Smoke Test Track.mp3')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '44100', track], { stdio: 'ignore' })
  return dir
}
function mktemp() { return mkdtempSync(path.join(tmpdir(), 'lyrigen-smoke-')) }

async function main() {
  const libraryRoot = makeLibrary()
  // A throwaway profile: never the real one, whose library, settings and
  // single-instance lock belong to the copy of Lyrigen you actually use.
  const profile = mktemp()
  writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({ schemaVersion: 3, libraryRoots: [libraryRoot], playlists: [], favorites: [], ratings: {}, playHistory: [], resumePositions: {}, queue: { currentTrackId: null, upcomingTrackIds: [], shuffle: false, repeat: 'off', autoplay: true }, settings: { visualMode: 'balanced' }, remoteCache: {}, migration: { importedLegacy: false, importedAt: null } }))
  const app = await electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: projectRoot,
    env: { ...process.env, LYRIGEN_USER_DATA: profile },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForTimeout(1000)

    await win.click('.nav[aria-label="Library"] button:nth-child(2)')
    await win.waitForTimeout(250)
    await win.locator('.segmented-tabs button', { hasText: 'Songs' }).first().click() // flat rows
    await win.locator('[data-track-index="0"]').waitFor({ timeout: 20_000 }).catch(() => { throw new Error('No track row found - is ffmpeg on PATH?') })
    await win.click('[data-track-index="0"] .row-art-button')
    await win.waitForTimeout(1200)
    await win.click('[aria-label="Sound and lyrics settings"]')
    await win.waitForTimeout(250)

    const expectations = {
      balanced: { lyricsColumnVisible: true, artworkColumnVisible: true, hasVinylRim: false, visualizerVisible: false },
      lyrics: { lyricsColumnVisible: true, artworkColumnVisible: false },
      cover: { lyricsColumnVisible: false, artworkColumnVisible: true, hasVinylRim: false },
      vinyl: { lyricsColumnVisible: false, artworkColumnVisible: true, hasVinylRim: true },
      visualizer: { lyricsColumnVisible: true, artworkColumnVisible: true, visualizerVisible: true },
      brat: { lyricsColumnVisible: true, artworkColumnVisible: true, bratBackground: true },
    }

    let failures = 0
    for (const [mode, expected] of Object.entries(expectations)) {
      await win.selectOption('select[aria-label="Visual mode"]', mode)
      await win.waitForTimeout(500)
      const actual = await win.evaluate(() => ({
        lyricsColumnVisible: getComputedStyle(document.querySelector('.lyrics-column')).display !== 'none',
        artworkColumnVisible: getComputedStyle(document.querySelector('.artwork-column')).display !== 'none',
        hasVinylRim: Boolean(document.querySelector('.vinyl-rim')),
        visualizerVisible: getComputedStyle(document.querySelector('.visualizer-stage')).display !== 'none',
        bratBackground: getComputedStyle(document.querySelector('.player-shell')).backgroundColor === 'rgb(138, 206, 0)',
      }))
      const ok = Object.entries(expected).every(([key, value]) => actual[key] === value)
      console.log(`${ok ? 'PASS' : 'FAIL'} ${mode}`, actual)
      if (!ok) failures += 1
      await win.screenshot({ path: path.join(shotsDir, `mode-${mode}.png`) })
    }

    if (failures) { console.error(`${failures} visual mode check(s) failed. See ${shotsDir}`); process.exitCode = 1 }
    else console.log(`All visual modes verified. Screenshots in ${shotsDir}`)
  } finally {
    await app.close()
  }
}

main().catch(error => { console.error('smoke-visual-modes failed:', error); process.exitCode = 1 })
