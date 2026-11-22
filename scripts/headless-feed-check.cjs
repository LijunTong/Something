// 无头 UI 校验（Electron 隐藏窗口 + 桩 window.api，不弹可见窗口）。
// 用途：加载 dist 构建产物，点开信息流文章，截图并统计 iframe 内的段落数。
// 前提：先起 npm run preview（默认 http://localhost:4173），可用 HEADLESS_URL 覆盖。
// 运行：npx electron scripts/headless-feed-check.cjs
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.data', 'headless')
const BASE = process.env.HEADLESS_URL || 'http://localhost:4173'
const PRELOAD = path.join(OUT, 'stub-preload.cjs')

const STUB = `
const now = Date.now()
const P = [
  '第一段：这是用来验证段落的正文。原站里每个段落是一个段落标签，渲染时必须保留段间距，不能挤成一大块。',
  '第二段：正文宽度决定一行能放多少字，阅读器给正文一个舒适的测量长度，过长的行会让眼睛来回扫。',
  '第三段：列表、引用、代码块都要按原站样式呈现，否则读者会以为是同一段文字。',
  '第四段：图片默认不放行，点「显示图片」之后才允许远程加载，这样打开文章不会把阅读位置暴露给站点。',
  '第五段：字号跟随阅读设置里的字体缩放，正文最小 13px，最大不会超过三档。',
  '第六段：这是最后一段，用来确认段落数量统计与滚动高度。'
]
const ARTICLE = '<h2>小标题：段落与结构</h2>' + P.map(function (t) { return '<p>' + t + '</p>' }).join('') + '<ul><li>列表项一</li><li>列表项二</li></ul><blockquote>引用块：用于确认样式</blockquote>'
const LONG = '这一篇只有纯文本，没有任何换行符。' + '它必须在前端按句号切分，否则整篇文章会变成一整块无法阅读的文字。'.repeat(9)
function item(id, title, contentHtml, content) {
  return { id: id, sourceId: 's1', guid: id, title: title, link: 'https://example.com/' + id, author: '测试作者', summary: '摘要占位：列表里的第二行文字。', content: content, contentHtml: contentHtml, publishedAt: now - 3600000, read: false, starred: false, readLater: false }
}
const ITEMS = [
  item('it-html', '长文：按原站格式渲染', ARTICLE, P.join(String.fromCharCode(10, 10))),
  item('it-text', '纯文本兜底：长段落自动分段', null, LONG)
]
const SETTINGS = { appearance: { theme: '\u6d45\u8272', accent: '#0f766e', font: '\u4e2d', sidebarExpand: true }, notify: { inApp: true, desktop: false, systemOnlyAway: true, weather: false, schedule: false, todo: false, pomodoro: false, parcel: false, mail: false, dndOn: false, dndStart: '22:00', dndEnd: '08:00', privacy: 'summary', sounds: {} }, shortcuts: { search: 'Ctrl+K', newTodo: 'N', focus: 'F' }, window: { closeToTray: true, minimizeToTray: false, launchAtLogin: false }, backup: { auto: false, path: '', freq: '\u6bcf\u5929', encrypted: false, passwordSet: false, lastAt: null, lastFile: null }, weather: { source: 'qweather', host: '', geoHost: '', cacheMin: 5, refreshMin: 5, authType: 'jwt', offlineCache: true, alertPush: false, unit: 'C', apiKeySet: false, jwtSet: false, authMode: 'none' }, feed: { defaultInterval: 360, keepContent: true }, mail: { autoSyncMin: 15 }, modules: { dashboard: true, weather: true, schedule: true, todo: true, pomodoro: true, feed: true, parcel: true, mail: true, notice: true }, home: { locked: false, layout: [] } }
const DATA = {
  'settings.all': function () { return SETTINGS },
  'settings.set': function () { return SETTINGS },
  'system.info': function () { return { version: 'headless', userData: '', defaultUserData: '', dataSource: 'default', db: '' } },
  'feed.groups': function () { return [{ id: 'g1', name: '\u9ed8\u8ba4\u5206\u7ec4' }] },
  'feed.sources': function () { return [{ id: 's1', groupId: 'g1', title: '\u6d4b\u8bd5\u6e90', url: 'https://example.com/rss', enabled: true, intervalMin: 360 }] },
  'feed.items': function () { return ITEMS },
  'feed.detail': function (dto) { return ITEMS.filter(function (x) { return x.id === dto.id })[0] || null },
  'feed.refresh': function () { return { added: 0, updated: 0, skipped: 0, failed: 0 } },
  'feed.markRead': function () { return true },
  'feed.toggleStar': function () { return true },
  'feed.toggleLater': function () { return true }
}
// 每个 domain 必须own 一组方法名：渲染层 bridge() 会用 Object.keys 递归 bind，
// 只靠 Proxy 兜底拿不到键，绑定后就变成空对象。
const METHODS = {
  settings: ['all', 'set', 'get'],
  system: ['info'],
  todo: ['list', 'lists', 'stats', 'create', 'update', 'remove', 'toggle'],
  notification: ['counts', 'list', 'readAll', 'remove'],
  feed: ['groups', 'sources', 'items', 'detail', 'refresh', 'markRead', 'toggleStar', 'toggleLater', 'importOPML', 'exportOPML'],
  schedule: ['list', 'create', 'update', 'remove'],
  pomodoro: ['list', 'create', 'update', 'stats'],
  parcel: ['list', 'create', 'update', 'remove'],
  mail: ['accounts', 'folders', 'list', 'read', 'sync'],
  weather: ['now', 'forecast'],
  backup: ['list', 'create']
}
function domain(name) {
  const target = {}
  const keys = (METHODS[name] || []).slice()
  Object.keys(DATA).forEach(function (k) {
    if (k.indexOf(name + '.') !== 0) return
    const key = k.slice(name.length + 1)
    if (keys.indexOf(key) < 0) keys.push(key)
  })
  keys.forEach(function (key) {
    const full = name + '.' + key
    target[key] = function (dto) {
      const hit = DATA[full]
      return Promise.resolve({ ok: true, data: hit ? hit(dto) : [] })
    }
  })
  return target
}
const api = {}
Object.keys(METHODS).forEach(function (d) { api[d] = domain(d) })
api.onDataChanged = function () { return function () {} }
api.onWindowMaximized = function () { return function () {} }
api.onWindowUnmaximized = function () { return function () {} }
api.isMaximized = function () { return Promise.resolve({ ok: true, data: false }) }
api.minimize = function () { return Promise.resolve({ ok: true, data: true }) }
api.maximize = function () { return Promise.resolve({ ok: true, data: true }) }
api.close = function () { return Promise.resolve({ ok: true, data: true }) }
window.api = api
`

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

async function until(win, expr, label, timeoutMs) {
  const limit = Date.now() + (timeoutMs || 15000)
  while (Date.now() < limit) {
    const v = await win.webContents.executeJavaScript('(function(){try{return (' + expr + ')}catch(e){return null}})()').catch(function () { return null })
    if (v) return v
    await sleep(200)
  }
  throw new Error('TIMEOUT ' + label)
}

// 隐藏窗口不会重绘，capturePage 会拿到旧帧：临时以 0 不透明度显示一次再截图。
async function shoot(win, name) {
  win.setOpacity(0)
  win.showInactive()
  await sleep(400)
  const img = await win.webContents.capturePage()
  const file = path.join(OUT, name)
  fs.writeFileSync(file, img.toPNG())
  win.hide()
  win.setOpacity(1)
  return file
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(PRELOAD, STUB, 'utf8')
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { preload: PRELOAD, contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false }
  })
  const errors = []
  win.webContents.on('console-message', function (e, level, msg) { if (level >= 2) errors.push(level + ':' + msg) })
  await win.loadURL(BASE + '/#/feed')
  await sleep(3000)
  const diag = await win.webContents.executeJavaScript("({href:location.href, len:document.body.innerHTML.length, text:(document.body.innerText||'').slice(0,400), lists:document.querySelectorAll('.fd-items').length, items:document.querySelectorAll('.n-list-item').length, rows:document.querySelectorAll('*[data-item-id]').length})").catch(function (e) { return { err: String(e) } })
  console.log('DIAG ' + JSON.stringify({ diag: diag, errors: errors.slice(0, 12) }))
  await until(win, "document.querySelectorAll('.fd-items .n-list-item').length", 'feed list', 20000)
  const rows = await win.webContents.executeJavaScript("document.querySelectorAll('.fd-items .n-list-item').length")
  const result = { rows: rows, errors: errors }

  result.clickErr = await win.webContents.executeJavaScript("(function(){try{document.querySelectorAll('.fd-items .n-list-item')[0].click();return ''}catch(e){return String((e&&e.message)||e)}})()")
  result.html = await until(win, "(function(){var f=document.querySelector('iframe.html-frame');if(!f||!f.contentDocument)return null;var d=f.contentDocument;var ps=d.querySelectorAll('p');if(!ps.length)return null;return {paragraphs:ps.length,listItems:d.querySelectorAll('ul li').length,h2:d.querySelectorAll('h2').length,fontSize:d.body?getComputedStyle(d.body).fontSize:'',height:Math.round(f.getBoundingClientRect().height),first:(ps[0].textContent||'').slice(0,30),last:(ps[ps.length-1].textContent||'').slice(0,30)}})()", 'html iframe', 20000)
  result.shotHtml = await shoot(win, 'feed-reader-html.png')

  result.clickErr2 = await win.webContents.executeJavaScript("(function(){try{var t=Array.prototype.slice.call(document.querySelectorAll('.fd-items .n-list-item'));var el=t.filter(function(x){return x.textContent.indexOf('\u7eaf\u6587\u672c')>=0})[0]||t[t.length-1];if(!el)throw new Error('no-row');el.click();return ''}catch(e){return String((e&&e.message)||e)}})()")
  try {
    result.text = await until(win, "(function(){var s=document.querySelector('.fd-article-inner');if(!s)return null;var ps=s.querySelectorAll('p');if(!ps.length)return null;return {paragraphs:ps.length,firstLen:(ps[0].textContent||'').length,scrollHeight:s.scrollHeight}})()", 'text mode', 12000)
  } catch (err) {
    result.textFail = await win.webContents.executeJavaScript("(function(){var s=document.querySelector('.fd-article-inner');return {html: s ? s.innerHTML.slice(0,300) : 'no-inner', activeRows: Array.prototype.slice.call(document.querySelectorAll('.fd-items .fd-row-active')).length}})()").catch(function (e) { return String(e) })
    result.textErr = String(err && err.message)
  }
  result.shotText = await shoot(win, 'feed-reader-text.png')
  console.log('RESULT ' + JSON.stringify(result, null, 2))
  win.destroy()
  app.exit(0)
}

main().catch(function (e) {
  console.error('HEADLESS_FAIL ' + (e && e.stack ? e.stack : e))
  app.exit(2)
})
