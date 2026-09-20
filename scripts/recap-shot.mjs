import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const root = process.argv[2], out = process.argv[3] || '.'
const profile = mkdtempSync(path.join(tmpdir(), 'lyrigen-recap-'))
// Seed a plausible play history so the recap has something to summarise.
const now = Date.now()
const history = []
for (let i = 0; i < 40; i++) history.push({ trackId: 'seed', playedAt: new Date(now - i * 3600_000 * 5).toISOString(), seconds: 200 })
writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({ schemaVersion:3, libraryRoots:[root], playlists:[], favorites:[], ratings:{}, playHistory:history, resumePositions:{}, queue:{currentTrackId:null,upcomingTrackIds:[],shuffle:false,repeat:'off',autoplay:true}, settings:{visualMode:'balanced',lyricFontSize:1,lyricDensity:'comfortable',crossfade:false}, remoteCache:{}, migration:{importedLegacy:false,importedAt:null} }))
const app = await electron.launch({ args:['.','--no-sandbox'], cwd: process.cwd(), env:{...process.env, LYRIGEN_USER_DATA: profile} })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded'); await win.setViewportSize({width:1400,height:900}); await win.waitForTimeout(7000)
// Real plays, so the recap joins against actual library tracks.
const ids = await win.evaluate(async () => {
  const lib = await window.electronAPI.getLibrary()
  const picks = lib.items.slice(0, 6)
  for (let i = 0; i < picks.length; i++) for (let n = 0; n <= i; n++) await window.electronAPI.recordPlay(picks[i].id, picks[i].duration || 200)
  return picks.length
})
console.log('seeded plays for', ids, 'tracks')
await win.locator('.nav button', { hasText: 'Listening' }).first().click({ force: true })
await win.waitForTimeout(2500)
for (const range of ['week', 'year']) {
  if (range !== 'week') { await win.locator('.recap-ranges button', { hasText: range === 'year' ? 'This year' : 'This week' }).click({ force: true }); await win.waitForTimeout(1500) }
  const info = await win.evaluate(() => ({
    figures: [...document.querySelectorAll('.recap-figures div')].map(d => d.textContent),
    bars: document.querySelectorAll('.plays-bar').length,
    artists: [...document.querySelectorAll('.recap-lists ol')][0]?.children.length ?? 0,
    caption: document.querySelector('.plays-chart figcaption')?.textContent,
  }))
  console.log(range, '->', JSON.stringify(info))
}
await win.screenshot({ path: path.join(out, 'recap.png') })
await app.close()
