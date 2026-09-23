// Screenshots screens at several window sizes and lists anything that spills
// past the right edge of the window or its own panel.
//   node scripts/layout-check.mjs <out-dir> <library-root> [profile-dir] [screens=Library]
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [out = 'layout-check', root, profileArg, screensArg = 'Library'] = process.argv.slice(2)
if (!root) { console.error('usage: node scripts/layout-check.mjs <out-dir> <library-root> [profile-dir] [screens]'); process.exit(2) }
mkdirSync(out, { recursive: true })
const profile = profileArg || mkdtempSync(path.join(tmpdir(), 'lyrigen-layout-'))
mkdirSync(profile, { recursive: true })
if (!existsSync(path.join(profile, 'lyrigen-state.json'))) writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({ schemaVersion: 3, libraryRoots: [root], playlists: [], favorites: [], ratings: {}, playHistory: [], resumePositions: {}, queue: { currentTrackId: null, upcomingTrackIds: [], shuffle: false, repeat: 'off', autoplay: true }, settings: { visualMode: 'balanced' }, remoteCache: {}, migration: { importedLegacy: false, importedAt: null } }))
const sizes = [[800, 600], [1024, 640], [1280, 720], [1366, 768], [1920, 1080], [2560, 1440]]

const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, LYRIGEN_USER_DATA: profile } })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(() => Number(document.querySelector('.nav button:nth-child(2) b')?.textContent || 0) > 0 && !/Scanning|Loading/.test(document.querySelector('.root-status strong')?.textContent ?? ''), null, { timeout: 15 * 60_000 })

for (const screen of screensArg.split(',')) {
  const nav = win.locator('.nav button, .sidebar-section button', { hasText: screen }).first()
  await nav.click()
  await win.waitForTimeout(1500)
  for (const [width, height] of sizes) {
    // Resize the real window, as a person dragging its edge would.
    await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setContentSize(size[0], size[1]) }, [width, height])
    await win.waitForTimeout(700)
    const spills = await win.evaluate(() => {
      const limit = document.documentElement.clientWidth
      const found = []
      for (const element of document.querySelectorAll('.app-shell *')) {
        const rect = element.getBoundingClientRect()
        if (!rect.width || !rect.height) continue
        const style = getComputedStyle(element)
        if (style.position === 'fixed' || style.visibility === 'hidden') continue
        // Past the window, or wider than the panel that should contain it.
        const parent = element.parentElement?.getBoundingClientRect()
        const pastWindow = rect.right > limit + 1
        const pastParent = parent && rect.right > parent.right + 2 && getComputedStyle(element.parentElement).overflowX === 'visible'
        if (pastWindow || pastParent) found.push(`${element.tagName.toLowerCase()}.${String(element.className).split(' ').filter(Boolean).slice(0, 2).join('.')} right=${Math.round(rect.right)} (${pastWindow ? 'window ' + limit : 'parent ' + Math.round(parent.right)})`)
      }
      const pageScrollsSideways = document.scrollingElement.scrollWidth > limit + 1 || (document.querySelector('.main-content')?.scrollWidth ?? 0) > (document.querySelector('.main-content')?.clientWidth ?? 0) + 1
      return { pageScrollsSideways, spills: [...new Set(found)].slice(0, 12) }
    })
    console.log(`${screen} @ ${width}x${height}: sideways scroll ${spills.pageScrollsSideways}; ${spills.spills.length} spilling${spills.spills.length ? ':\n   ' + spills.spills.join('\n   ') : ''}`)
    await win.screenshot({ path: path.join(out, `${screen.toLowerCase().replace(/\W+/g, '-')}-${width}x${height}.png`) })
  }
}
await app.close()
