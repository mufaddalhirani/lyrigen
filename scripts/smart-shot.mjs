import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const root = process.argv[2], out = process.argv[3] || '.'
const profile = mkdtempSync(path.join(tmpdir(), 'lyrigen-smart-'))
writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({ schemaVersion:3, libraryRoots:[root], playlists:[], favorites:[], ratings:{}, playHistory:[], resumePositions:{}, queue:{currentTrackId:null,upcomingTrackIds:[],shuffle:false,repeat:'off',autoplay:true}, settings:{visualMode:'balanced',lyricFontSize:1,lyricDensity:'comfortable',crossfade:false}, remoteCache:{}, migration:{importedLegacy:false,importedAt:null} }))
const app = await electron.launch({ args:['.','--no-sandbox'], cwd: process.cwd(), env:{...process.env, LYRIGEN_USER_DATA: profile} })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded'); await win.setViewportSize({width:1400,height:860}); await win.waitForTimeout(7000)
await win.locator('.nav button', { hasText: 'Smart Library' }).first().click({ force: true })
await win.waitForTimeout(1200)
console.log('cards:', await win.locator('.smart-card').count())
await win.screenshot({ path: path.join(out, 'smart-1-cards.png') })
await win.locator('.smart-card', { hasText: 'Lossless' }).first().click({ force: true })
await win.waitForTimeout(1500)
const state = await win.evaluate(() => ({
  rows: document.querySelectorAll('.track-row').length,
  cards: document.querySelectorAll('.smart-card').length,
  heading: document.querySelector('.main-topline h2')?.textContent,
  toolbar: Boolean(document.querySelector('.collection-toolbar')),
  back: Boolean(document.querySelector('.back-link')),
}))
console.log('after clicking Lossless:', JSON.stringify(state))
await win.screenshot({ path: path.join(out, 'smart-2-opened.png') })
await app.close()
