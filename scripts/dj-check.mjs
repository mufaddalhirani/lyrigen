// End-to-end check of the DJ screen on a throwaway profile.
//   node scripts/dj-check.mjs <out-dir> <library-root>
// Loads each song to read its detected BPM, then syncs two decks, loops,
// sets a hot cue, runs an effect and the sampler, records a few seconds,
// lets automix blend into a queued song, and opens party mode.
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [out = 'dj-check', root] = process.argv.slice(2)
if (!root) { console.error('usage: node scripts/dj-check.mjs <out-dir> <library-root>'); process.exit(2) }
mkdirSync(out, { recursive: true })
const profile = mkdtempSync(path.join(tmpdir(), 'lyrigen-dj-'))
writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({ schemaVersion: 3, libraryRoots: [root], playlists: [], favorites: [], ratings: {}, playHistory: [], resumePositions: {}, queue: { currentTrackId: null, upcomingTrackIds: [], shuffle: false, repeat: 'off', autoplay: true }, settings: { visualMode: 'balanced' }, remoteCache: {}, migration: { importedLegacy: false, importedAt: null } }))
const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, LYRIGEN_USER_DATA: profile } })
const mixFile = path.resolve(out, 'test-mix.opus')
await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, mixFile)
const win = await app.firstWindow()
const errors = []
win.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
win.on('pageerror', error => errors.push(String(error)))
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1536, height: 900 })
await win.evaluate(() => localStorage.setItem('lyrigen-debug', '1'))
await win.reload()
await win.waitForTimeout(6000)
await win.getByRole('button', { name: 'DJ', exact: true }).click()
await win.waitForTimeout(1000)
const dj = (fn, arg) => win.evaluate(fn, arg)
const titles = await dj(() => [...document.querySelectorAll('.dj-result strong')].map(node => node.textContent))
console.log('library:', titles.length, 'songs')

const loadOn = async (deck, title) => {
  const started = Date.now()
  await win.locator('.dj-result', { hasText: title }).first().getByRole('button', { name: deck.toUpperCase(), exact: true }).click()
  await win.waitForFunction(id => { const d = window.lyrigenDj.decks[id].state; return d.track && !d.loading }, deck, { timeout: 60_000 })
  return Date.now() - started
}

console.log('\n-- BPM detection --')
for (const title of titles) {
  const ms = await loadOn('a', title)
  const bpm = await dj(() => window.lyrigenDj.decks.a.state.analysis?.bpm)
  console.log(`${String(bpm ?? '-').padStart(7)} BPM  ${String(ms).padStart(5)} ms  ${title}`)
}

console.log('\n-- sync --')
await loadOn('a', 'Get Lucky')
await loadOn('b', 'Stayin')
await win.locator('.deck-a .dj-pad.play').click()
await win.waitForTimeout(1500)
await win.locator('.deck-b .dj-pad.play').click()
await win.waitForTimeout(400)
await win.locator('.deck-b .dj-pad.sync').click()
for (const wait of [2000, 6000]) {
  await win.waitForTimeout(wait)
  const report = await dj(() => {
    const { a, b } = window.lyrigenDj.decks
    let delta = a.phase() - b.phase(); if (delta > 0.5) delta -= 1; if (delta < -0.5) delta += 1
    return { a: a.liveBpm?.toFixed(2), b: b.liveBpm?.toFixed(2), synced: b.state.synced, errorMs: Math.round(delta * b.realBeat * 1000), playing: [a.state.playing, b.state.playing] }
  })
  console.log(`after ${wait / 1000}s more:`, JSON.stringify(report))
}
await win.screenshot({ path: path.join(out, 'dj-sync.png') })

console.log('\n-- loop, hot cue, effect, sampler --')
await win.locator('.deck-a .dj-loops .dj-pad', { hasText: /^4$/ }).click()
const loop = await dj(() => window.lyrigenDj.decks.a.state.loop)
await win.waitForTimeout(4500)
const inLoop = await dj(() => { const a = window.lyrigenDj.decks.a; const l = a.state.loop; return Boolean(l) && a.position >= l.start - 0.05 && a.position <= l.end + 0.05 })
console.log('4-beat loop', loop && `${loop.start.toFixed(2)}-${loop.end.toFixed(2)}s`, '| still inside after 4.5 s:', inLoop)
await win.locator('.deck-a .dj-loops .dj-pad', { hasText: 'EXIT' }).click()
await win.locator('.deck-a .dj-hotcues .dj-pad').first().click()
const cue = await dj(() => window.lyrigenDj.decks.a.state.hotcues[0])
await win.waitForTimeout(1500)
await win.locator('.deck-a .dj-hotcues .dj-pad').first().click()
await win.waitForTimeout(200)
const back = await dj(() => window.lyrigenDj.decks.a.position)
console.log('hot cue 1 at', cue?.toFixed(2), '-> jumped back to', back.toFixed(2))
await win.locator('.deck-a .dj-fx select').selectOption('reverb')
await win.locator('.deck-b .dj-fx select').selectOption('echo')
await win.waitForTimeout(1200)
await win.locator('.deck-a .dj-fx select').selectOption('flanger')
await win.locator('.deck-b .dj-fx select').selectOption('crush')
await win.waitForTimeout(1200)
await win.locator('.deck-a .dj-fx select').selectOption('none')
await win.locator('.deck-b .dj-fx select').selectOption('none')
for (const pad of ['Air horn', 'Kick', 'Riser', 'Siren']) await win.locator('.dj-sampler-pads .dj-pad', { hasText: pad }).click()
console.log('effects + sampler ran; console errors so far:', errors.length)

console.log('\n-- recording --')
await win.locator('.dj-toggle.rec').click()
await win.waitForTimeout(4000)
await win.locator('.dj-toggle.rec').click()
await win.waitForTimeout(5000)
try { console.log('saved mix:', mixFile, Math.round(statSync(mixFile).size / 1024), 'KB') } catch { console.log('mix NOT saved') }

console.log('\n-- performance --')
const fps = await dj(() => new Promise(resolve => { let frames = 0; const start = performance.now(); const tick = () => { frames++; if (performance.now() - start < 3000) requestAnimationFrame(tick); else resolve(Math.round(frames / 3)) }; requestAnimationFrame(tick) }))
const longTask = await dj(() => new Promise(resolve => { let worst = 0; const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) worst = Math.max(worst, entry.duration) }); observer.observe({ entryTypes: ['longtask'] }); setTimeout(() => { observer.disconnect(); resolve(Math.round(worst)) }, 3000) }))
const memory = await dj(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576))
console.log(`frames/s with both decks playing: ${fps} | longest task: ${longTask} ms | JS heap: ${memory} MB`)

console.log('\n-- automix --')
await win.locator('.deck-b .dj-pad.play').click() // stop B; automix wants one deck playing
await win.locator('.dj-result', { hasText: 'Uptown Girl' }).first().getByRole('button').nth(2).click()
await win.locator('.dj-automix .dj-toggle').click()
await dj(() => { const a = window.lyrigenDj.decks.a; a.state.loop = null; a.seek(a.duration - 32) })
const mixStarted = Date.now()
await win.waitForFunction(() => window.lyrigenDj.automix.running && performance.now() >= window.lyrigenDj.automix.running.started, null, { timeout: 45_000 }).catch(() => undefined)
console.log('transition began after', Math.round((Date.now() - mixStarted) / 1000), 's; next deck:', await dj(() => window.lyrigenDj.decks.b.state.track?.title))
await win.waitForTimeout(3000)
await win.screenshot({ path: path.join(out, 'dj-automix.png') })
await win.waitForFunction(() => !window.lyrigenDj.automix.running, null, { timeout: 60_000 }).catch(() => undefined)
console.log('after the blend:', JSON.stringify(await dj(() => ({ crossfader: window.lyrigenDj.crossfader.toFixed(2), aPlaying: window.lyrigenDj.decks.a.state.playing, bPlaying: window.lyrigenDj.decks.b.state.playing, bBpm: window.lyrigenDj.decks.b.liveBpm?.toFixed(1), bSynced: window.lyrigenDj.decks.b.state.synced }))))

console.log('\n-- party mode --')
await win.locator('.dj-toggle', { hasText: 'Party' }).click()
await win.waitForTimeout(2500)
await win.screenshot({ path: path.join(out, 'dj-party.png') })
await win.keyboard.press('Escape')
await win.waitForTimeout(300)
console.log('party closed:', !(await win.locator('.dj-party').count()))

console.log('\nconsole errors:', errors.length, errors.slice(0, 5).join(' | '))
await app.close()
