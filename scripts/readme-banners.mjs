// Renders the README banners (scripts/banners/banner.html) to PNG with Electron.
//   node scripts/readme-banners.mjs
// Writes docs/banner.png and lyric-studio/docs/banner.png.
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(path.join(tmpdir(), 'lyrigen-banner-'))
const main = path.join(dir, 'main.cjs')
writeFileSync(main, `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => { const w = new BrowserWindow({ width: 1600, height: 560, useContentSize: true, show: false, webPreferences: { zoomFactor: 1 } }); w.loadURL(process.env.BANNER_URL) })`)
const page = pathToFileURL(path.resolve('scripts/banners/banner.html')).href
for (const [variant, out] of [['lyrigen', 'docs/banner.png'], ['studio', 'lyric-studio/docs/banner.png']]) {
  const app = await electron.launch({ args: [main], env: { ...process.env, BANNER_URL: `${page}?app=${variant}` } })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1600, height: 560 })
  await win.waitForLoadState('load')
  await win.evaluate(() => document.fonts.ready)
  await win.waitForTimeout(300)
  await win.screenshot({ path: out })
  console.log('wrote', out)
  await app.close()
}
