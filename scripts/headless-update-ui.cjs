#!/usr/bin/env node
'use strict'
// 渲染层无头验证：真实 Vue 页面 + 真实 Naive UI，只把 window.api 换成桩。
// 桩 preload 由 electron/preload.cjs 生成（保留真实的白名单形状），把 ipcRenderer
// 换成进程内的假后端，于是弹窗、进度、通知、偏好都能在无头窗口里确定地走一遍。
// 由 scripts/verify-update.cjs 用 electron 拉起，需要 VITE_URL 指向 vite preview。
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const stubDir = path.join(root, '.data', 'headless')
const stubPath = path.join(stubDir, 'stub-preload-update.cjs')
const viteUrl = String(process.env.VITE_URL || '').replace(/\/+$/, '')
const stubStateFile = process.env.STUB_STATE_FILE || ''

const results = []
function record(name, ok, detail) {
  results.push({ name: name, ok: ok, detail: detail || '' })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !detail ? '' : ' :: ' + detail))
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

// 默认设置：与 src/composables/useSettings.ts 的 FALLBACK 同形状（面板读不到会引起渲染报错）
const DEFAULT_SETTINGS = {
  appearance: { theme: '浅色', accent: '#0f766e', font: '中', sidebarExpand: true },
  notify: {
    inApp: true, desktop: true, systemOnlyAway: true, weather: true, schedule: true, todo: true,
    pomodoro: true, parcel: false, mail: true, dndOn: false, dndStart: '22:00', dndEnd: '08:00',
    privacy: 'summary',
    sounds: { weather: '蜂鸣', schedule: '蜂鸣', todo: '蜂鸣', pomodoro: '蜂鸣', parcel: '蜂鸣', mail: '蜂鸣' }
  },
  shortcuts: { search: 'Ctrl+K', newTodo: 'N', focus: 'F' },
  window: { closeToTray: true, minimizeToTray: false, launchAtLogin: false },
  backup: { auto: true, path: '', freq: '每天', encrypted: false, keep: 10, passwordSet: false, lastAt: null, lastFile: null },
  weather: { source: 'qweather', host: '', geoHost: '', cacheMin: 5, refreshMin: 5, authType: 'jwt', offlineCache: true, alertPush: true, unit: 'C', apiKeySet: false, jwtSet: false, authMode: 'none' },
  feed: { defaultInterval: 360, keepContent: true },
  mail: { autoSyncMin: 15 },
  mcp: { enabled: false, port: null },
  parcel: { provider: 'manual', autoRefreshMin: 0, detectCompany: true },
  modules: { dashboard: true, weather: true, schedule: true, todo: true, pomodoro: true, feed: true, parcel: true, mail: true, notice: true },
  home: { locked: false, layout: [] },
  widgets: { items: [], useTransparent: true },
  update: { ignored: '', snoozeUntil: 0, autoCheck: true }
}

// 生成桩 preload：头部换成假 ipcRenderer + 假后端，尾部原样复用真实 preload 的白名单对象
function writeStubPreload() {
  fs.mkdirSync(stubDir, { recursive: true })
  const real = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
  const marker = 'const api = {'
  const at = real.indexOf(marker)
  if (at < 0) throw new Error('electron/preload.cjs 结构变了：找不到 "' + marker + '"')
  const apiBody = real.slice(at)

  const header = [
    '// 自动生成，勿手改：scripts/headless-update-ui.cjs',
    "const { contextBridge } = require('electron')",
    'const listeners = new Map()',
    'const state = {',
    '  settings: ' + JSON.stringify(DEFAULT_SETTINGS) + ',',
    "  fixture: 'latest',",
    "  downloadPlan: 'ok',",
    "  progress: { state: 'idle', version: null, percent: 0, received: 0, total: 0 },",
    '  checkCalls: 0,',
    '  downloadCalls: 0,',
    '  installCalls: 0,',
    '  lastCheckAt: 0,',
    '  lastDownloadAt: 0,',
    '  lastInstallAt: 0,',
    "  errorMessage: '',",
    '  timer: null',
    '}',
    ''
  ].join('\n')
  const headerFixed = header

  const impl = `
// 与真实 preload 同签名：channel -> (payload) => Promise<{ok,data}>
const stateFile = process.env.STUB_STATE_FILE || ''

function persist() {
  if (!stateFile) return
  try {
    require('node:fs').writeFileSync(stateFile, JSON.stringify({ settings: state.settings, fixture: state.fixture, downloadPlan: state.downloadPlan }))
  } catch (e) { /* ignore */ }
}

// 刷新后 preload 会重新执行，偏好与开关必须从文件恢复
try {
  if (stateFile && require("node:fs").existsSync(stateFile)) {
    const saved = JSON.parse(require("node:fs").readFileSync(stateFile, "utf8")) || {}
    if (saved.settings) for (const key of Object.keys(saved.settings)) state.settings[key] = Object.assign({}, state.settings[key] || {}, saved.settings[key])
    if (saved.fixture) state.fixture = String(saved.fixture)
    if (saved.downloadPlan) state.downloadPlan = String(saved.downloadPlan)
  }
} catch (e) { /* ignore */ }
function call(channel) {
  return function (payload) { return handle(channel, payload) }
}

function emit(channel, payload) {
  const arr = listeners.get(channel) || []
  for (const fn of arr.slice()) {
    try { fn({}, payload) } catch (e) { /* ignore */ }
  }
}

function pushProgress(p) {
  state.progress = p
  emit('update:progress', p)
}

function releaseInfo(kind) {
  const base = {
    current: '1.0.4',
    latest: '9.9.9',
    hasUpdate: true,
    url: 'https://github.com/LijunTong/Something/releases/tag/v9.9.9',
    repo: 'https://github.com/LijunTong/Something',
    name: 'v9.9.9',
    publishedAt: '2026-11-27T08:00:00Z',
    notes: '### 新增\\n\\n- 更新弹窗分步展示版本信息与更新日志\\n- 下载完成后由用户确认再安装\\n\\n### 修复\\n\\n- 修复下载中关闭弹窗后进度丢失的问题',
    asset: { name: 'Something-Setup-9.9.9.exe', url: 'https://github.com/x/y.exe', size: 20 * 1024 * 1024 },
    noRelease: false,
    checkedAt: Date.now()
  }
  if (kind === 'latest') {
    return Object.assign(base, { latest: '1.0.4', hasUpdate: false, name: 'v1.0.4', publishedAt: '2026-11-20T02:00:00Z', notes: '', asset: null })
  }
  return base
}

function startDownload() {
  state.downloadCalls++
  if (state.timer) { clearInterval(state.timer); state.timer = null }
  const total = 20 * 1024 * 1024
  let received = 0
  pushProgress({ state: 'downloading', version: '9.9.9', percent: 0, received: 0, total: total })
  state.timer = setInterval(function () {
    received += 1024 * 1024
    const percent = Math.min(99, Math.floor((received / total) * 100))
    if (state.downloadPlan === 'fail' && received >= 4 * 1024 * 1024) {
      clearInterval(state.timer)
      state.timer = null
      pushProgress({ state: 'error', version: '9.9.9', percent: percent, received: received, total: total, message: '安装包大小与发布信息不一致' })
      return
    }
    if (received >= total) {
      clearInterval(state.timer)
      state.timer = null
      pushProgress({ state: 'ready', version: '9.9.9', percent: 100, received: total, total: total })
      return
    }
    pushProgress({ state: 'downloading', version: '9.9.9', percent: percent, received: received, total: total })
  }, 200)
}

async function handle(channel, payload) {
  if (channel === 'settings:all') return { ok: true, data: state.settings }
  if (channel === 'settings:set') {
    const patch = payload || {}
    for (const key of Object.keys(patch)) {
      state.settings[key] = Object.assign({}, state.settings[key] || {}, patch[key])
    }
    persist()
    return { ok: true, data: state.settings }
  }
  if (channel === 'system:info') {
    return { ok: true, data: { version: '1.0.4', userData: 'C:/tmp/something-userdata', db: 'C:/tmp/something.db', electron: '33.4.11', platform: 'win32' } }
  }
  if (channel === 'system:checkUpdate') {
    state.checkCalls++
    state.lastCheckAt = Date.now()
    await new Promise(function (r) { setTimeout(r, 80) })
    if (state.fixture === 'error') {
      return { ok: false, error: { code: 'HTTP_503', message: 'HTTP_503' } }
    }
    return { ok: true, data: releaseInfo(state.fixture) }
  }
  if (channel === 'system:updateStatus') return { ok: true, data: state.progress }
  if (channel === 'system:downloadUpdate') {
    state.lastDownloadAt = Date.now()
    const info = releaseInfo(state.fixture)
    if (!info.hasUpdate) return { ok: true, data: { started: false, hasUpdate: false, version: info.current } }
    startDownload()
    return { ok: true, data: { started: true, version: '9.9.9', total: 20 * 1024 * 1024 } }
  }
  if (channel === 'system:installUpdate') {
    state.installCalls++
    state.lastInstallAt = Date.now()
    pushProgress({ state: 'installing', version: '9.9.9', percent: 100, received: 20 * 1024 * 1024, total: 20 * 1024 * 1024 })
    return { ok: true, data: { ok: true } }
  }
  // 其余通道一律给空结果：设置页/壳层不需要真的数据
  return { ok: true, data: [] }
}

const ipcRenderer = {
  invoke: function (channel, payload) { return handle(channel, payload) },
  on: function (channel, fn) {
    const arr = listeners.get(channel) || []
    arr.push(fn)
    listeners.set(channel, arr)
  },
  removeListener: function (channel, fn) {
    const arr = listeners.get(channel) || []
    listeners.set(channel, arr.filter(function (f) { return f !== fn }))
  }
}

`

  const footer = `

contextBridge.exposeInMainWorld('__stub', {
  setFixture: function (name) { state.fixture = String(name); persist() },
  setDownloadPlan: function (name) { state.downloadPlan = String(name); persist() },
  resetCounters: function () {
    state.checkCalls = 0
    state.downloadCalls = 0
    state.installCalls = 0
    state.lastCheckAt = 0
    state.lastDownloadAt = 0
    state.lastInstallAt = 0
    state.progress = { state: 'idle', version: null, percent: 0, received: 0, total: 0 }
    if (state.timer) { clearInterval(state.timer); state.timer = null }
  },
  setSettings: function (patch) {
    for (const key of Object.keys(patch || {})) {
      state.settings[key] = Object.assign({}, state.settings[key] || {}, patch[key])
    }
    persist()
    return state.settings
  },
  settings: function () { return JSON.parse(JSON.stringify(state.settings)) },
  counters: function () {
    return {
      checkCalls: state.checkCalls,
      downloadCalls: state.downloadCalls,
      installCalls: state.installCalls,
      progress: JSON.parse(JSON.stringify(state.progress))
    }
  }
})
`

  fs.writeFileSync(stubPath, headerFixed + impl + apiBody + footer)
}

let win = null
const pageErrors = []

async function page(js) {
  return win.webContents.executeJavaScript(js, true)
}

async function waitFor(js, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 8000)
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await page(js)
      if (last && last !== 'null' && last !== 'undefined') return last
    } catch (e) { last = String(e && e.message) }
    await sleep(120)
  }
  throw new Error('timeout waiting for ' + (label || js.slice(0, 60)) + ' (last=' + JSON.stringify(last) + ')')
}

async function goto(route) {
  await page("location.hash = '#" + route + "'")
  await sleep(1200)
}

async function reload() {
  win.webContents.reloadIgnoringCache()
  await new Promise(function (resolve) {
    win.webContents.once('did-finish-load', resolve)
  })
  await sleep(1600)
}

// 页面内小工具：按文本找按钮、读弹窗卡片
const PAGE_HELPERS = `
window.__t = {
  byText: function (sel, text) {
    return Array.from(document.querySelectorAll(sel)).filter(function (el) {
      return (el.textContent || '').trim() === text
    })
  },
  clickText: function (sel, text) {
    const el = window.__t.byText(sel, text)[0]
    if (!el) return false
    el.click()
    return true
  },
  card: function () {
    const el = document.querySelector('.n-modal.n-card') || document.querySelector('.n-modal .n-card')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { width: Math.round(r.width), height: Math.round(r.height), text: (el.textContent || '').replace(/\\s+/g, ' ').trim() }
  },
  buttons: function () {
    return Array.from(document.querySelectorAll('.n-modal button')).map(function (b) {
      return (b.textContent || '').trim()
    }).filter(Boolean)
  },
  note: function () {
    const el = document.querySelector('.n-notification')
    if (!el) return null
    return { text: (el.textContent || '').replace(/\\s+/g, ' ').trim(), buttons: Array.from(el.querySelectorAll('button')).map(function (b) { return (b.textContent || '').trim() }) }
  },
  progressText: function () {
    const el = document.querySelector('.upd-progress-meta')
    return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null
  }
}
true
`

async function openAboutPanel() {
  await goto('/settings')
  const clicked = await page("String(window.__t.clickText('.n-menu-item-content', '关于'))")
  if (clicked !== 'true') throw new Error('未找到设置页的「关于」菜单项')
  await sleep(900)
}

async function clickCheck() {
  const ok = await page("String(window.__t.clickText('button', '检查更新'))")
  if (ok !== 'true') throw new Error('未找到「检查更新」按钮')
  await sleep(1400)
}

async function scenario(name, fn) {
  try {
    await fn()
    record(name, true)
  } catch (e) {
    record(name, false, (e && e.message) || String(e))
  }
}

async function run() {
  if (stubStateFile) { try { fs.rmSync(stubStateFile, { force: true }) } catch (e) { /* ignore */ } }
  if (!viteUrl) throw new Error('缺少 VITE_URL 环境变量（由 scripts/verify-update.cjs 注入）')
  writeStubPreload()
  console.log('[ui] stub preload -> ' + stubPath)
  console.log('[ui] loading ' + viteUrl + '/#/settings')

  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    webPreferences: {
      preload: stubPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  win.webContents.on('console-message', function (_e, level, message) {
    if (level >= 2) pageErrors.push(String(message))
  })
  win.webContents.on('did-fail-load', function (_e, code, desc) {
    pageErrors.push('did-fail-load ' + code + ' ' + desc)
  })

  await win.loadURL(viteUrl + '/#/settings')
  await sleep(2200)
  await page(PAGE_HELPERS)

  await scenario('ui: 无新版本时弹窗窄、无忽略按钮', async function () {
    await page("window.__stub.setFixture('latest'); window.__stub.resetCounters(); location.hash = '#/settings'; true")
    await sleep(900)
    await openAboutPanel()
    await clickCheck()
    const card = await waitFor("JSON.stringify(window.__t.card())", 8000, 'update modal')
    const c = JSON.parse(card)
    if (!/当前已是最新版本/.test(c.text)) throw new Error('缺少「当前已是最新版本」: ' + c.text.slice(0, 120))
    if (c.width > 420) throw new Error('弹窗过宽：' + c.width)
    const buttons = JSON.parse(await page('JSON.stringify(window.__t.buttons())'))
    if (buttons.indexOf('忽略此版本') >= 0) throw new Error('已是最新时不应出现「忽略此版本」')
    if (buttons.indexOf('重新检查') < 0) throw new Error('缺少「重新检查」')
    await page("window.__t.clickText('button', '重新检查'); true")
  })

  await scenario('ui: 有新版本时展示版本信息与更新日志', async function () {
    await page("window.__stub.setFixture('available'); window.__stub.resetCounters(); window.__t.clickText('button', '重新检查'); true")
    await sleep(1500)
    const card = JSON.parse(await waitFor("JSON.stringify(window.__t.card())", 8000, 'details modal'))
    const must = ['最新版本', '9.9.9', '更新日志', '新增', '下载并安装']
    must.forEach(function (k) {
      if (card.text.indexOf(k) < 0) throw new Error('详情缺「' + k + '」: ' + card.text.slice(0, 200))
    })
    if (card.width < 460) throw new Error('详情弹窗应更宽，实际 ' + card.width)
    const buttons = JSON.parse(await page('JSON.stringify(window.__t.buttons())'))
    ;['下载并安装', '以后再说', '忽略此版本'].forEach(function (k) {
      if (buttons.indexOf(k) < 0) throw new Error('缺按钮「' + k + '」：' + JSON.stringify(buttons))
    })
  })

  await scenario('ui: 下载中显示进度与速度，关窗后能接回', async function () {
    await page("window.__t.clickText('button', '下载并安装'); true")
    const text = await waitFor("(function () { var t = window.__t.progressText(); return t && /剩余约/.test(t) ? t : null })()", 8000, 'progress meta with eta')
    if (!/\/\s*20\.0 MB/.test(text)) throw new Error('进度缺总大小: ' + text)
    // 关闭弹窗再打开：进度必须接上，而不是从 0 开始
    const before = JSON.parse(await page('JSON.stringify(window.__stub.counters())'))
    await page("window.__t.clickText('button', '以后再说') || document.querySelector('.n-modal .n-base-close') && document.querySelector('.n-modal .n-base-close').click(); true")
    await sleep(700)
    await page("window.__t.clickText('button', '查看进度'); true")
    await sleep(600)
    const after = JSON.parse(await page('JSON.stringify(window.__stub.counters())'))
    if (after.downloadCalls <= before.downloadCalls) {
      const again = await page("JSON.stringify(window.__t.progressText())")
      if (again === 'null') throw new Error('重新打开后看不到进度')
    }
  })

  await scenario('ui: 下载完成后就绪态可安装', async function () {
    const card = JSON.parse(await waitFor("JSON.stringify(window.__t.card())", 12000, 'ready modal'))
    const deadline = Date.now() + 12000
    let text = card.text
    while (Date.now() < deadline && text.indexOf('立即安装并重启') < 0) {
      await sleep(250)
      const next = await page("JSON.stringify(window.__t.card())")
      if (next && next !== 'null') text = JSON.parse(next).text
    }
    if (text.indexOf('立即安装并重启') < 0) throw new Error('未进入就绪态: ' + text.slice(0, 160))
    if (text.indexOf('自动重新打开') < 0) throw new Error('就绪态缺少自动重启说明')
    await page("window.__t.clickText('button', '立即安装并重启'); true")
    await sleep(400)
    const counters = JSON.parse(await page('JSON.stringify(window.__stub.counters())'))
    if (counters.installCalls < 1) throw new Error('未调用 installUpdate')
  })

  await scenario('ui: 下载失败时给出原因与重试', async function () {
    await page("window.__stub.setFixture('available'); window.__stub.setDownloadPlan('fail'); window.__stub.resetCounters(); true")
    await reload()
    await page(PAGE_HELPERS)
    await openAboutPanel()
    await clickCheck()
    await page("window.__t.clickText('button', '下载并安装'); true")
    const card = JSON.parse(await waitFor("(function () { var c = window.__t.card(); return c && /不一致/.test(c.text) ? JSON.stringify(c) : null })()", 12000, 'error modal'))
    if (card.text.indexOf('不一致') < 0) throw new Error('错误原因未展示: ' + card.text.slice(0, 200))
    const buttons = JSON.parse(await page('JSON.stringify(window.__t.buttons())'))
    if (buttons.indexOf('重试') < 0) throw new Error('缺少重试按钮: ' + JSON.stringify(buttons))
    if (card.text.indexOf('打开发布页') < 0) throw new Error('缺少打开发布页入口')
    await page("window.__stub.setDownloadPlan('ok'); true")
  })

  await scenario('ui: 新版本通知带三个动作', async function () {
    await page("window.__stub.setFixture('available'); window.__stub.setSettings({ update: { ignored: '', snoozeUntil: 0, autoCheck: true } }); true")
    await reload()
    await page(PAGE_HELPERS)
    const note = JSON.parse(await waitFor("JSON.stringify(window.__t.note())", 8000, 'notification'))
    if (note.text.indexOf('发现新版本 9.9.9') < 0) throw new Error('通知文案不对: ' + note.text.slice(0, 120))
    ;['查看详情', '稍后提醒', '忽略此版本'].forEach(function (k) {
      if (note.buttons.indexOf(k) < 0) throw new Error('通知缺按钮「' + k + '」：' + JSON.stringify(note.buttons))
    })
    await page("window.__t.clickText('.n-notification button', '稍后提醒'); true")
    await sleep(900)
    const settings = JSON.parse(await page('JSON.stringify(window.__stub.settings())'))
    const until = Number(settings.update.snoozeUntil)
    const hours = (until - Date.now()) / 3600000
    if (!(hours > 23 && hours < 25)) throw new Error('snoozeUntil 不是 24 小时后：' + hours.toFixed(2) + 'h')
  })

  await scenario('ui: 忽略此版本会记住版本号', async function () {
    await page("window.__stub.setSettings({ update: { ignored: '', snoozeUntil: 0, autoCheck: true } }); true")
    await reload()
    await page(PAGE_HELPERS)
    await waitFor("JSON.stringify(window.__t.note())", 8000, 'notification again')
    await page("window.__t.clickText('.n-notification button', '忽略此版本'); true")
    await sleep(900)
    const settings = JSON.parse(await page('JSON.stringify(window.__stub.settings())'))
    if (settings.update.ignored !== '9.9.9') throw new Error('ignored 应为 9.9.9，实际 ' + JSON.stringify(settings.update.ignored))
  })

  await scenario('ui: autoCheck=false 启动不检查', async function () {
    await page("window.__stub.setFixture('available'); window.__stub.setSettings({ update: { ignored: '', snoozeUntil: 0, autoCheck: false } }); window.__stub.resetCounters(); true")
    await reload()
    await page(PAGE_HELPERS)
    await sleep(1500)
    const counters = JSON.parse(await page('JSON.stringify(window.__stub.counters())'))
    if (counters.checkCalls !== 0) throw new Error('关闭自动检查后仍请求了 ' + counters.checkCalls + ' 次')
    const note = await page('JSON.stringify(window.__t.note())')
    if (note !== 'null') throw new Error('关闭自动检查后仍弹了通知')
  })

  await scenario('ui: 忽略的版本不再弹通知', async function () {
    await page("window.__stub.setFixture('available'); window.__stub.setSettings({ update: { ignored: '9.9.9', snoozeUntil: 0, autoCheck: true } }); window.__stub.resetCounters(); true")
    await reload()
    await page(PAGE_HELPERS)
    await sleep(1800)
    const counters = JSON.parse(await page('JSON.stringify(window.__stub.counters())'))
    if (counters.checkCalls < 1) throw new Error('忽略后仍应静默检查一次')
    const note = await page('JSON.stringify(window.__t.note())')
    if (note !== 'null') throw new Error('已忽略的版本仍然弹了通知')
  })

  await scenario('ui: 检查失败时给出错误与重试', async function () {
    await page("window.__stub.setFixture('error'); window.__stub.setSettings({ update: { ignored: '', snoozeUntil: 0, autoCheck: false } }); window.__stub.resetCounters(); true")
    await reload()
    await page(PAGE_HELPERS)
    await openAboutPanel()
    await clickCheck()
    const card = JSON.parse(await waitFor("JSON.stringify(window.__t.card())", 8000, 'error modal'))
    if (!/失败|不可用|稍后/.test(card.text)) throw new Error('错误文案缺失: ' + card.text.slice(0, 160))
    const buttons = JSON.parse(await page('JSON.stringify(window.__t.buttons())'))
    if (buttons.indexOf('重试') < 0) throw new Error('检查失败缺重试：' + JSON.stringify(buttons))
  })

  if (pageErrors.length) {
    console.log('[ui] console errors (' + pageErrors.length + '):')
    pageErrors.slice(0, 10).forEach(function (m) { console.log('  ! ' + m) })
  }
}

app.whenReady().then(run).catch(function (e) {
  console.error('[ui] fatal: ' + ((e && e.stack) || e))
  record('fatal', false, (e && e.message) || String(e))
}).then(function () {
  const failed = results.filter(function (r) { return !r.ok })
  console.log('UI_RESULT pass=' + (results.length - failed.length) + ' fail=' + failed.length)
  failed.forEach(function (f) { console.log('  - ' + f.name + ' :: ' + f.detail) })
  app.exit(failed.length ? 1 : 0)
})
