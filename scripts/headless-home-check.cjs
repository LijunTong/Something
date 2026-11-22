// 无头 UI 校验（Electron 隐藏窗口 + 桩 window.api）：仪表盘行级跳转 + 番茄钟系统全屏调用。
// 前提：先起 npx vite preview --port 4173（dist 已构建）；可用 HEADLESS_URL 覆盖。
// 运行：unset ELECTRON_RUN_AS_NODE; npx electron scripts/headless-home-check.cjs
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.data', 'headless')
const BASE = process.env.HEADLESS_URL || 'http://localhost:4173'
const PRELOAD = path.join(OUT, 'stub-preload-home.cjs')

const STUB = `
const now = Date.now()
const SETTINGS = { appearance: { theme: '浅色', accent: '#0f766e', font: '中', sidebarExpand: true }, notify: { inApp: true, desktop: false, systemOnlyAway: true, weather: false, schedule: false, todo: false, pomodoro: false, parcel: false, mail: false, dndOn: false, dndStart: '22:00', dndEnd: '08:00', privacy: 'summary', sounds: {} }, shortcuts: { search: 'Ctrl+K', newTodo: 'N', focus: 'F' }, window: { closeToTray: true, minimizeToTray: false, launchAtLogin: false }, backup: { auto: false, path: '', freq: '每天', encrypted: false, passwordSet: false, lastAt: null, lastFile: null }, weather: { source: 'qweather', host: '', geoHost: '', cacheMin: 5, refreshMin: 5, authType: 'jwt', offlineCache: true, alertPush: false, unit: 'C', apiKeySet: false, jwtSet: false, authMode: 'none' }, feed: { defaultInterval: 360, keepContent: true }, mail: { autoSyncMin: 15 }, modules: { dashboard: true, weather: true, schedule: true, todo: true, pomodoro: true, feed: true, parcel: true, mail: true, notice: true }, home: { locked: false, layout: [] } }
const TODOS = [
  { id: 't1', title: '写周报', note: '', listId: null, priority: '高', status: '未开始', dueAt: now + 3600000, remindAt: null, recurRule: null, labels: [], sort: 1 },
  { id: 't2', title: '回复邮件', note: '', listId: null, priority: '中', status: '未开始', dueAt: now + 7200000, remindAt: null, recurRule: null, labels: [], sort: 2 }
]
const DATA = {
  'settings.all': function () { return SETTINGS },
  'settings.set': function () { return SETTINGS },
  'system.info': function () { return { version: 'headless', userData: '', defaultUserData: '', dataSource: 'default', db: '' } },
  'todo.list': function () { return TODOS },
  'todo.lists': function () { return [] },
  'todo.stats': function () { return { today: 2, done: 0, overdue: 0, week: 0 } },
  'schedule.list': function () { return [{ id: 'e1', title: '周会', startAt: now + 1800000, endAt: now + 3600000, allDay: false, place: '', note: '', remindMin: 10, calendarName: '默认' }] },
  'parcel.list': function () { return [{ id: 'p1', company: '顺丰', trackingNo: 'SF1', status: '待取件', pickupCode: 'A12', station: '小区东门', etaAt: now, refreshedAt: now }] },
  'mail.accounts': function () { return [{ id: 'a1', alias: '工作', email: 'a@b.c', enabled: true }] },
  'mail.folders': function () { return [{ id: 'f1', accountId: 'a1', name: '收件箱', kind: 'inbox', unreadCount: 1 }] },
  'mail.list': function () { return [{ id: 'm1', accountId: 'a1', subject: '你好', fromName: '张三', fromAddr: 'z@b.c', sentAt: now, read: false, important: true, hasAttach: false }] },
  'feed.sources': function () { return [{ id: 's1', title: '测试源', url: 'https://example.com/rss', enabled: true }] },
  'feed.items': function () { return [{ id: 'i1', sourceId: 's1', guid: 'i1', title: '文章标题', link: 'https://example.com/1', author: '', summary: '', content: '', contentHtml: null, publishedAt: now, read: false, starred: false, readLater: false, sourceTitle: '测试源' }] },
  'notification.list': function () { return [{ id: 'n1', module: 'todo', title: '一件事', body: '正文', at: now, read: false }] },
  'weather.now': function () { return { city: '杭州', temp: 20, text: '晴', humidity: 50, wind: '2', feelsLike: 20, updatedAt: now } },
  'weather.forecast': function () { return [] },
  'pomodoro.state': function () { return { phase: 'idle', remainSec: 1500, round: 1, taskId: null, endsAt: null, plannedSec: 1500 } },
  'pomodoro.config': function () { return { focusMin: 25, shortMin: 5, longMin: 15, longEvery: 4, goal: 4 } },
  'pomodoro.stats': function () { return { sessions: [], count: 0, minutes: 0, interrupted: 0, rate: 0 } },
  'pomodoro.weekStats': function () { return [] }
}
const METHODS = {
  settings: ['all', 'set', 'get'], system: ['info'],
  todo: ['list', 'lists', 'stats', 'create', 'update', 'remove', 'toggle'],
  notification: ['counts', 'list', 'readAll', 'remove'],
  feed: ['groups', 'sources', 'items', 'detail', 'refresh', 'markRead', 'toggleStar', 'toggleLater'],
  schedule: ['list', 'create', 'update', 'remove'],
  pomodoro: ['state', 'config', 'stats', 'weekStats', 'start', 'pause', 'resume', 'finish', 'abandon', 'saveConfig', 'list'],
  parcel: ['list', 'create', 'update', 'remove'],
  mail: ['accounts', 'folders', 'list', 'read', 'sync'],
  weather: ['now', 'forecast'],
  backup: ['list', 'create'],
  log: ['write', 'error']
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
window.__FS_CALLS = []
const api = {}
Object.keys(METHODS).forEach(function (d) { api[d] = domain(d) })
api.window = {
  minimize: function () { return Promise.resolve({ ok: true, data: true }) },
  toggleMaximize: function () { return Promise.resolve({ ok: true, data: true }) },
  close: function () { return Promise.resolve({ ok: true, data: true }) },
  isMaximized: function () { return Promise.resolve({ ok: true, data: false }) },
  isMinimized: function () { return Promise.resolve({ ok: true, data: false }) },
  setFullScreen: function (dto) { window.__FS_CALLS.push(!!(dto && dto.on)); return Promise.resolve({ ok: true, data: !!(dto && dto.on) }) },
  isFullScreen: function () { return Promise.resolve({ ok: true, data: true }) }
}
api.onDataChanged = function () { return function () {} }
api.onWindowMaximized = function () { return function () {} }
api.onWindowUnmaximized = function () { return function () {} }
api.onNavigate = function () { return function () {} }
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

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(PRELOAD, STUB, 'utf8')
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({
    show: false, width: 1440, height: 900,
    webPreferences: { preload: PRELOAD, contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false }
  })
  const errors = []
  win.webContents.on('console-message', function (e, level, msg) { if (level >= 2) errors.push(level + ':' + msg) })
  const result = { errors: errors }

  await win.loadURL(BASE + '/#/')
  await sleep(2500)
  try {
    result.rows = await until(win, "(function(){var r=document.querySelectorAll('.hc-row-link');if(!r.length)return null;var out=[];for(var i=0;i<r.length;i++){out.push({cls:r[i].className.split(' ')[0],role:r[i].getAttribute('role'),tab:r[i].getAttribute('tabindex'),cursor:getComputedStyle(r[i]).cursor})}return out})()", 'home rows', 20000)
  } catch (err) {
    result.rowsFail = String(err && err.message)
    result.diag = await win.webContents.executeJavaScript("({hash:location.hash,text:(document.body.innerText||'').slice(0,200),cards:document.querySelectorAll('.hc-card').length})").catch(function (e) { return String(e) })
  }
  result.diagCards = await win.webContents.executeJavaScript("({cards:document.querySelectorAll('.hc-card').length,tlRow:document.querySelectorAll('.hc-tl-row').length,tlItem:document.querySelectorAll('.n-timeline-item').length,noticeRow:document.querySelectorAll('.hc-notice-row').length,todoRow:document.querySelectorAll('.hc-todo-item').length,titles:Array.prototype.slice.call(document.querySelectorAll('.hc-head span')).map(function(x){return x.innerText})})").catch(function (e) { return String(e) })
  result.mailClick = await win.webContents.executeJavaScript("(function(){var el=document.querySelector('.hc-mail-row');if(!el)return 'no-mail-row';el.click();return ''})()")
  await sleep(900)
  result.afterMailClick = await win.webContents.executeJavaScript("location.hash")

  await win.webContents.executeJavaScript("location.hash = '#/pomodoro'")
  await sleep(1200)
  result.btnClick = await win.webContents.executeJavaScript("(function(){var b=Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(x){return (x.innerText||'').indexOf('全屏专注')>=0})[0];if(!b)return 'no-btn';b.click();return ''})()")
  await sleep(900)
  result.focus = await win.webContents.executeJavaScript("({overlay: !!document.querySelector('.pm-focus'), fsCalls: window.__FS_CALLS.slice()})")
  result.esc = await win.webContents.executeJavaScript("(function(){window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return ''})()")
  await sleep(700)
  result.afterEsc = await win.webContents.executeJavaScript("({overlay: !!document.querySelector('.pm-focus'), fsCalls: window.__FS_CALLS.slice()})")
  console.log('RESULT ' + JSON.stringify(result, null, 2))
  win.destroy()
  app.exit(0)
}

main().catch(function (e) {
  console.error('HEADLESS_FAIL ' + (e && e.stack ? e.stack : e))
  app.exit(2)
})
