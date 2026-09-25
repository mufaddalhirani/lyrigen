// Checks the lyric visuals across whole songs, on a throwaway profile:
//  - the interlude visualizer never overlaps a lyric line while it shows,
//    and shows in the gaps that AMLL leaves room for;
//  - each song's beat grid is found (tempo, downbeat);
//  - Kinetic mode renders a line, the tempo and the beat counter.
//   node scripts/lyrics-visual-check.mjs <out-dir> <library-root> "Title A,Title B"
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [out = 'lyrics-visual-check', root, titleList = ''] = process.argv.slice(2)
if (!root) { console.error('usage: node scripts/lyrics-visual-check.mjs <out> <library-root> "Title A,Title B"'); process.exit(2) }
mkdirSync(out, { recursive: true })
const profile = mkdtempSync(path.join(tmpdir(), 'lyrigen-lyrics-'))
writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({ schemaVersion: 3, libraryRoots: [root], playlists: [], favorites: [], ratings: {}, playHistory: [], resumePositions: {}, queue: { currentTrackId: null, upcomingTrackIds: [], shuffle: false, repeat: 'off', autoplay: true }, settings: {}, remoteCache: {}, migration: { importedLegacy: true, importedAt: null } }))
const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, LYRIGEN_USER_DATA: profile } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', error => errors.push(String(error)))
win.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1440, height: 900 })
await win.evaluate(() => { localStorage.setItem('lyrigen-debug', '1'); localStorage.setItem('lyrigen-visual-mode-v1', 'balanced') })
await win.reload()
await win.waitForTimeout(5000)
const audio = 'audio:not(.track-preloader)'

for (const title of titleList.split(',').filter(Boolean)) {
  await win.locator('.player-titlebar .back-button').click({ timeout: 2000 }).catch(() => {})
  await win.waitForTimeout(500)
  await win.locator('.nav button', { hasText: 'Library' }).first().click(); await win.waitForTimeout(700)
  await win.locator('.segmented-tabs button', { hasText: 'Songs' }).first().click(); await win.waitForTimeout(700)
  await win.locator('.track-row', { hasText: title }).first().dblclick({ force: true }); await win.waitForTimeout(1500)
  await win.getByRole('button', { name: /full player/i }).first().click().catch(() => {})
  await win.waitForFunction(() => window.lyrigenBeats?.grid !== undefined && window.lyrigenBeats?.grid !== null, null, { timeout: 30_000 }).catch(() => {})
  const grid = await win.evaluate(() => window.lyrigenBeats?.grid)
  const duration = await win.evaluate(sel => document.querySelector(sel).duration, audio)
  let shown = 0, overlaps = 0, missing = 0, samples = 0, gaps = 0
  const problems = []
  for (let t = 1; t < duration - 4; t += 2.3) {
    await win.evaluate(([sel, value]) => { const a = document.querySelector(sel); a.currentTime = value; void a.play() }, [audio, t])
    await win.waitForTimeout(1500) // the visualizer waits 0.7 s after a seek and 0.45 s into a gap
    const state = await win.evaluate(() => {
      const wrapper = document.querySelector('.synced-lyrics [data-gap]')
      const canvas = document.querySelector('.lyric-gap-visualizer')
      if (!wrapper || !canvas) return null
      const dots = canvas.parentElement
      const opacity = Number(getComputedStyle(canvas).opacity) * Number(getComputedStyle(dots).opacity)
      const box = canvas.getBoundingClientRect()
      const area = box.width * box.height || 1
      let worst = 0
      for (const line of document.querySelectorAll('.synced-lyrics [class*="lyricLine"]')) {
        if (line.contains(canvas) || Number(getComputedStyle(line).opacity) < 0.15) continue
        const r = line.getBoundingClientRect()
        const w = Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left)), h = Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top))
        worst = Math.max(worst, (w * h) / area)
      }
      return { gap: wrapper.dataset.gap === 'true', enabled: /enabled/.test(dots.className), visible: opacity > 0.1, overlap: worst, time: document.querySelector('audio:not(.track-preloader)').currentTime }
    })
    if (!state) continue
    samples++
    if (state.gap) gaps++
    if (state.visible) shown++
    if (state.visible && state.overlap > 0.08) { overlaps++; problems.push(`overlap ${Math.round(state.overlap * 100)}% at ${state.time.toFixed(1)}s`) }
    if (state.gap && state.enabled && !state.visible) { missing++; problems.push(`hidden in a placed gap at ${state.time.toFixed(1)}s`) }
  }
  console.log(`\n${title}: grid ${grid ? `${grid.bpm} BPM, first beat ${grid.firstBeat.toFixed(2)}s, downbeat ${grid.downbeat}` : 'none'}`)
  console.log(`  ${samples} points · in a gap ${gaps} · visualizer shown ${shown} · overlapping a line ${overlaps} · hidden when it should show ${missing}`)
  if (problems.length) console.log('  ' + problems.slice(0, 6).join(' | '))
}

// Kinetic mode, on the last song.
await win.locator('.view-mode-button').click(); await win.waitForTimeout(200)
await win.locator('.view-mode-option', { hasText: 'Kinetic' }).click(); await win.waitForTimeout(500)
const lines = await win.evaluate(() => [...document.querySelectorAll('.kinetic-line')].length)
for (const [name, seconds] of [['kinetic-line', 58.5], ['kinetic-gap', 30]]) {
  await win.evaluate(([sel, value]) => { const a = document.querySelector(sel); a.currentTime = value; void a.play() }, [audio, seconds])
  await win.waitForTimeout(1600)
  const info = await win.evaluate(() => ({ text: document.querySelector('.kinetic-line')?.textContent?.slice(0, 60), on: document.querySelectorAll('.kw.on').length, words: document.querySelectorAll('.kw').length, emphasis: document.querySelectorAll('.kw.em').length, gap: document.querySelector('.kinetic')?.classList.contains('gap'), bpm: document.querySelector('.kinetic-tempo')?.textContent, beat: [...document.querySelectorAll('.kinetic-beats i')].findIndex(i => i.classList.contains('on')) }))
  console.log(`\n${name}:`, JSON.stringify(info))
  await win.screenshot({ path: path.join(out, `${name}.png`) })
}
// Beat counter moves with the music.
const beatsSeen = await win.evaluate(() => new Promise(resolve => { const seen = new Set(); const start = performance.now(); const tick = () => { const i = [...document.querySelectorAll('.kinetic-beats i')].findIndex(x => x.classList.contains('on')); seen.add(i); if (performance.now() - start < 2500) requestAnimationFrame(tick); else resolve([...seen]) }; tick() }))
console.log('beat counter positions seen in 2.5 s:', JSON.stringify(beatsSeen), '| kinetic lines rendered:', lines)
console.log('\nerrors:', errors.length, errors.slice(0, 3).join(' | '))
await app.close()
