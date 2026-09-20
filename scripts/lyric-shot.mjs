import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const root = process.argv[2], out = process.argv[3] || '.'
const profile = mkdtempSync(path.join(tmpdir(), 'lyrigen-lyr-'))
writeFileSync(path.join(profile, 'lyrigen-state.json'), JSON.stringify({ schemaVersion:3, libraryRoots:[root], playlists:[], favorites:[], ratings:{}, playHistory:[], resumePositions:{}, queue:{currentTrackId:null,upcomingTrackIds:[],shuffle:false,repeat:'off',autoplay:true}, settings:{visualMode:'lyrics',lyricFontSize:1,lyricDensity:'comfortable',crossfade:false}, remoteCache:{}, migration:{importedLegacy:false,importedAt:null} }))
const app = await electron.launch({ args:['.','--no-sandbox'], cwd: process.cwd(), env:{...process.env, LYRIGEN_USER_DATA: profile} })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded'); await win.setViewportSize({width:1400,height:880}); await win.waitForTimeout(7000)
await win.locator('.nav button', { hasText: 'Library' }).first().click({ force: true }); await win.waitForTimeout(1200)
await win.locator('button', { hasText: /^Songs$/ }).first().click({ force: true }).catch(()=>{}); await win.waitForTimeout(2200)
const row = win.locator('.track-row').first()
await row.dblclick({ force: true }).catch(() => row.click({ force: true }))
await win.waitForTimeout(9000)   // let the online lyric lookup finish
for (const motion of ['glow', 'blur', 'none']) {
  await win.evaluate(m => { document.documentElement.dataset.lyricMotion = m }, motion)
  await win.waitForTimeout(1600)
  const info = await win.evaluate(() => ({
    status: document.querySelector('.lyrics-heading p')?.textContent,
    lines: document.querySelectorAll('[class*="lyricLine"]').length,
    words: document.querySelectorAll('[class*="emphasizeWrapper"]').length,
    blurred: [...document.querySelectorAll('[class*="lyricLine"]')].filter(el => /blur\((?!0px)/.test(el.style.filter)).length,
  }))
  console.log(`${motion.padEnd(5)} ->`, JSON.stringify(info))
  if (motion === 'glow') {
    const dump = await win.evaluate(() => {
      const line = [...document.querySelectorAll('[class*="lyricMainLine"]')].find(el => el.textContent.trim().length > 4)
      const classes = new Set()
      document.querySelectorAll('.amll-lyric-player *').forEach(el => el.classList.forEach(c => classes.add(c)))
      return { sample: line ? line.outerHTML.slice(0, 900) : 'none', classes: [...classes].slice(0, 25) }
    })
    console.log('CLASSES:', dump.classes.join(' '))
    console.log('SAMPLE:', dump.sample)
  }
  await win.screenshot({ path: path.join(out, `lyric-${motion}.png`) })
}
await app.close()
