// Boots the app and clicks through every screen, collecting console errors.
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.argv[2]
const profile = mkdtempSync(path.join(tmpdir(), 'lyrigen-health-'))
writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({ schemaVersion:3, libraryRoots:[root], playlists:[], favorites:[], ratings:{}, playHistory:[], resumePositions:{}, queue:{currentTrackId:null,upcomingTrackIds:[],historyTrackIds:[],shuffle:false,repeat:'off',autoplay:true,manualTrackIds:[]}, settings:{visualMode:'balanced'}, remoteCache:{}, migration:{importedLegacy:false,importedAt:null} }))

const app = await electron.launch({ args:['.','--no-sandbox'], cwd: process.cwd(), env:{...process.env, LYRIGEN_USER_DATA: profile} })
const win = await app.firstWindow()
const errors = []
win.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 200)) })
win.on('pageerror', err => errors.push('PAGEERROR: ' + String(err).slice(0, 200)))
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1400, height: 900 })
await win.waitForTimeout(8000)

const screens = ['Home', 'Library', 'Playlists', 'Smart Library', 'Listening', 'Discover']
const tools = ['Metadata Studio', 'Downloads', 'Organizer', 'Lyrics Finder', 'Sound Lab', 'Settings']
for (const name of screens) {
  await win.locator('.nav button', { hasText: name }).first().click({ force: true }).catch(() => {})
  await win.waitForTimeout(1200)
  const rendered = await win.evaluate(() => Boolean(document.querySelector('.main-content')?.children.length))
  console.log(`${name.padEnd(15)} rendered=${rendered}`)
}
for (const name of tools) {
  await win.locator('.sidebar-section button', { hasText: name }).first().click({ force: true }).catch(() => {})
  await win.waitForTimeout(1400)
  const rendered = await win.evaluate(() => Boolean(document.querySelector('.main-content')?.children.length))
  console.log(`${name.padEnd(15)} rendered=${rendered}`)
}
// Play something, then open the full player.
await win.locator('.nav button', { hasText: 'Library' }).first().click({ force: true }); await win.waitForTimeout(1200)
// Library lands on Folders; Songs is the flat list.
await win.locator('.segmented-tabs button', { hasText: 'Songs' }).first().click({ force: true }).catch(() => {})
await win.waitForTimeout(2000)
console.log('rows visible:', await win.evaluate(() => document.querySelectorAll('.track-row').length))
const row = win.locator('.track-row').first()
if (await row.count()) {
  // The artwork button is the actual play target on a row.
  const art = row.locator('.row-art-button').first()
  if (await art.count()) { await art.click({ force: true }); }
  else { await row.dblclick({ force: true }).catch(() => {}) }
  await win.waitForTimeout(5000)
}
console.log('queue currentTrackId:', await win.evaluate(() => window.electronAPI.getQueueState().then(q => q.currentTrackId)))
console.log('player rendered:', await win.evaluate(() => ({ shell: Boolean(document.querySelector('.player-shell')), mini: Boolean(document.querySelector('.mini-player')) })))

console.log('\n--- console errors (' + errors.length + ') ---')
for (const e of [...new Set(errors)].slice(0, 15)) console.log(' •', e)
await app.close()
