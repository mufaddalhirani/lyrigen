// Walks every screen of the real app against a real library and reports how
// smooth each one is: time to render, the longest main-thread stall, heap.
// Then exercises search (typing, clearing), scrolling the song list, playing
// a song, the full player, and the fluid background.
//   node scripts/app-check.mjs <out-dir> <library-root> [profile-dir]
// Pass a profile directory to reuse a library index from an earlier run.
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [out = 'app-check', root, profileArg] = process.argv.slice(2)
if (!root) { console.error('usage: node scripts/app-check.mjs <out-dir> <library-root> [profile-dir]'); process.exit(2) }
mkdirSync(out, { recursive: true })
const profile = profileArg || mkdtempSync(path.join(tmpdir(), 'lyrigen-app-'))
mkdirSync(profile, { recursive: true })
if (!existsSync(path.join(profile, 'lyrigen-state.json'))) writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({ schemaVersion: 3, libraryRoots: [root], playlists: [], favorites: [], ratings: {}, playHistory: [], resumePositions: {}, queue: { currentTrackId: null, upcomingTrackIds: [], shuffle: false, repeat: 'off', autoplay: true }, settings: { visualMode: 'balanced' }, remoteCache: {}, migration: { importedLegacy: false, importedAt: null } }))

const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, LYRIGEN_USER_DATA: profile } })
const win = await app.firstWindow()
const errors = []
win.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 240)) })
win.on('pageerror', error => errors.push('PAGE: ' + String(error).slice(0, 240)))
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1536, height: 864 })
await win.waitForFunction(() => Number(document.querySelector('.nav button:nth-child(2) b')?.textContent || 0) > 0 && !/Scanning|Loading/.test(document.querySelector('.root-status strong')?.textContent ?? ''), null, { timeout: 15 * 60_000 })
console.log('library:', await win.evaluate(() => document.querySelector('.nav button:nth-child(2) b')?.textContent), 'songs')

// Long tasks are gathered for the whole run; each step reads the worst since it began.
await win.evaluate(() => { window.__longTasks = []; new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__longTasks.push(entry.duration) }).observe({ entryTypes: ['longtask'] }) })
const worstSince = async () => win.evaluate(() => { const worst = Math.max(0, ...window.__longTasks); window.__longTasks = []; return Math.round(worst) })
const heap = () => win.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576))
const report = []

const visit = async (label, click) => {
  await worstSince()
  const started = Date.now()
  await click()
  await win.waitForFunction(() => document.querySelector('.main-content')?.children.length, null, { timeout: 20_000 })
  await win.waitForTimeout(1200)
  const ms = Date.now() - started - 1200
  const stall = await worstSince()
  report.push({ screen: label, clickToRenderMs: ms, longestStallMs: stall, heapMB: await heap() })
  await win.screenshot({ path: path.join(out, `${label.replace(/\W+/g, '-').toLowerCase()}.png`) })
}

for (const name of ['Home', 'Library', 'Playlists', 'Smart Library', 'Listening', 'Discover']) await visit(name, () => win.locator('.nav button', { hasText: name }).first().click())
for (const name of ['Metadata Studio', 'Downloads', 'Organizer', 'Lyrics Finder', 'Sound Lab', 'DJ', 'Settings']) await visit(name, () => win.locator('.sidebar-section button', { hasText: name }).first().click())
await win.locator('.nav button', { hasText: 'Library' }).first().click()
await win.waitForTimeout(800)
await visit('Songs', () => win.locator('.segmented-tabs button', { hasText: 'Songs' }).first().click())
console.table(report)

console.log('\n-- search --')
const search = win.locator('.global-search input')
await worstSince()
await search.click()
await search.pressSequentially('radiohead', { delay: 60 })
await win.waitForTimeout(600)
const typingStall = await worstSince()
const matched = await win.evaluate(() => document.querySelectorAll('.track-row').length)
const clear = win.locator('.search-clear')
console.log(`typing: longest stall ${typingStall} ms · rows after "radiohead": ${matched} · clear button shown: ${await clear.count() === 1}`)
await clear.click()
await win.waitForTimeout(500)
console.log(`after clear: box "${await search.inputValue()}" · rows: ${await win.evaluate(() => document.querySelectorAll('.track-row').length)}`)
await search.fill('abc')
await search.press('Escape')
console.log('Esc clears:', (await search.inputValue()) === '')
await win.locator('body').click({ position: { x: 5, y: 500 } })
await win.keyboard.press('Control+k')
console.log('Ctrl+K focuses search:', await win.evaluate(() => document.activeElement?.closest('.global-search') !== null))

console.log('\n-- scrolling the song list --')
const scrollReport = await win.evaluate(() => new Promise(resolve => {
  const scroller = document.querySelector('.main-content')
  let frames = 0, worst = 0, last = performance.now()
  const start = last
  const step = now => {
    frames++; worst = Math.max(worst, now - last); last = now
    scroller.scrollTop += 60
    if (now - start < 3000) requestAnimationFrame(step)
    else resolve({ fps: Math.round(frames / 3), worstFrameMs: Math.round(worst), rows: document.querySelectorAll('.track-row').length })
  }
  requestAnimationFrame(step)
}))
console.log('scroll:', JSON.stringify(scrollReport), 'longest stall:', await worstSince(), 'ms')

console.log('\n-- playback --')
await win.evaluate(() => document.querySelector('.main-content').scrollTop = 0)
await win.locator('.track-row').first().dblclick({ force: true })
await win.waitForTimeout(2500)
const playing = await win.evaluate(() => { const a = document.querySelector('audio'); return a && !a.paused && a.currentTime > 0 })
console.log('playing:', playing)
await win.getByRole('button', { name: /full player/i }).first().click().catch(() => undefined)
await win.waitForTimeout(2500)
await worstSince()
const playerFps = await win.evaluate(() => new Promise(resolve => { let frames = 0; const start = performance.now(); const tick = () => { frames++; if (performance.now() - start < 3000) requestAnimationFrame(tick); else resolve(Math.round(frames / 3)) }; requestAnimationFrame(tick) }))
console.log(`full player: ${playerFps} fps · longest stall ${await worstSince()} ms · fluid canvas: ${await win.evaluate(() => Boolean(document.querySelector('.fluid-background')))} · lyrics: ${await win.evaluate(() => document.querySelector('.lyrics-heading p')?.textContent)}`)
await win.screenshot({ path: path.join(out, 'player.png') })
await win.getByRole('button', { name: /Library/ }).first().click().catch(() => undefined)

console.log('\nheap at end:', await heap(), 'MB')
console.log('console errors:', errors.length)
for (const error of [...new Set(errors)].slice(0, 12)) console.log('  ', error)
await app.close()
