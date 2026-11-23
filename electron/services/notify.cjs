// 事件通知引擎：一次「事件」拆成两条通道，两条通道各自独立开关。
//   系统通知：Electron Notification，Windows 落到通知中心（appId 已在 main 里 setAppUserModelId）
//   应用内通知：notification 表（首页「今日通知」、天气页提醒）+ 渲染层浮层（notify:event）
// 判定顺序：模块开关 → 总开关 → 去重 → 免打扰（只压系统通知）→ 隐私摘要（只改系统通知文案）。
const { Notification } = require('electron')
const { get, withTx } = require('../db/conn.cjs')
const { now } = require('../db/util.cjs')
const logger = require('../log/logger.cjs')
const settingsSvc = require('./settings.cjs')
const notificationSvc = require('./notification.cjs')
const notifyText = require('./notifyText.cjs')
const weatherDigest = require('./weatherDigest.cjs')

const MODULE_LABEL = {
  weather: '天气', schedule: '日程', todo: '待办',
  pomodoro: '番茄钟', parcel: '快递', mail: '邮件', system: '系统'
}
/** 点击通知后落到哪个页面 */
const MODULE_ROUTE = {
  weather: '/weather', schedule: '/schedule', todo: '/todo',
  pomodoro: '/pomodoro', parcel: '/parcel', mail: '/mail', system: '/settings'
}
const EMIT_KEY = 'notifyEmitted'
const SCAN_MS = 60000
const GRACE_MS = 60000
const KEEP_MS = 7 * 86400000
const MAX_MARKS = 600
const DUE_WINDOW_MS = 24 * 3600000

const hooks = {
  getWindow: function () { return null },
  publish: function () {},
  navigate: function () {},
  icon: null
}
let timer = null
let running = false
// Electron 的 Notification 对象若被 GC，点击回调就失效，这里留引用
const alive = []

function cfg() {
  const saved = settingsSvc.get('notify') || {}
  return Object.assign({
    inApp: true, desktop: true, systemOnlyAway: true,
    privacy: 'summary', dndOn: false, dndStart: '22:00', dndEnd: '08:00',
    // 每个模块一条提示音；缺省全部蜂鸣
    sounds: {
      weather: '蜂鸣', schedule: '蜂鸣', todo: '蜂鸣',
      pomodoro: '蜂鸣', parcel: '蜂鸣', mail: '蜂鸣'
    }
  }, saved)
}

/** "HH:MM" → 当天分钟数；非法输入返回 null */
function minutesOf(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''))
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** 免打扰时段支持跨零点（22:00 → 08:00） */
function inDnd(c, at) {
  // 开关关掉时区间只是记忆值，不参与判定
  if (!c.dndOn) return false
  const s = minutesOf(c.dndStart)
  const e = minutesOf(c.dndEnd)
  if (s == null || e == null || s === e) return false
  const d = new Date(at)
  const cur = d.getHours() * 60 + d.getMinutes()
  return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e)
}

function away() {
  let w = null
  try { w = hooks.getWindow() } catch (e) { w = null }
  if (!w) return true
  try {
    if (w.isDestroyed && w.isDestroyed()) return true
    return !w.isVisible() || !w.isFocused()
  } catch (e) {
    return true
  }
}

/* ---------- 去重：同一事件只提醒一次 ---------- */

function marks() {
  try {
    const row = get().prepare('SELECT value FROM app_setting WHERE key = ?').get(EMIT_KEY)
    if (!row) return {}
    const o = JSON.parse(row.value)
    return o && typeof o === 'object' ? o : {}
  } catch (e) {
    return {}
  }
}

function seen(id) {
  return Object.prototype.hasOwnProperty.call(marks(), id)
}

function remember(id) {
  try {
    withTx(function () {
      const map = marks()
      map[id] = now()
      const floor = now() - KEEP_MS
      let keys = Object.keys(map).filter(function (k) { return Number(map[k]) >= floor })
      if (keys.length > MAX_MARKS) {
        keys.sort(function (a, b) { return Number(map[a]) - Number(map[b]) })
        keys = keys.slice(keys.length - MAX_MARKS)
      }
      const next = {}
      keys.forEach(function (k) { next[k] = map[k] })
      get().prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)').run(EMIT_KEY, JSON.stringify(next))
    })
  } catch (e) {
    logger.warn('notify', 'remember_failed', { message: e && e.message })
  }
}

/* ---------- 系统通知 ---------- */

function showSystem(c, event) {
  if (!Notification) return false
  try { if (Notification.isSupported && !Notification.isSupported()) return false } catch (e) { return false }
  // 窗口在前台时只走应用内浮层，避免「同一条提醒弹两次」
  if (c.systemOnlyAway && !away()) return false
  if (inDnd(c, now())) return false
  const summary = c.privacy === 'summary'
  const title = summary ? (MODULE_LABEL[event.module] || '几件事') + '有新消息' : event.title
  const body = summary ? '打开几件事查看详情' : (event.body || '')
  const n = new Notification({
    title: title.slice(0, 120),
    body: String(body).slice(0, 240),
    // 提示音统一由渲染层播放（用户可为每个模块选音），这里不再叠系统音
    silent: true,
    timeoutType: 'default',
    icon: hooks.icon || undefined
  })
  n.on('click', function () {
    try { hooks.navigate(MODULE_ROUTE[event.module] || '/') } catch (e) { /* 导航失败不影响主流程 */ }
  })
  n.on('failed', function (_e, error) {
    logger.warn('notify', 'system_failed', { message: String(error || '') })
  })
  alive.push(n)
  if (alive.length > 20) alive.splice(0, alive.length - 20)
  n.show()
  return true
}

/* ---------- 应用内通知 ---------- */

function pushInApp(event) {
  notificationSvc.create({
    id: event.id,
    module: event.module,
    level: event.level,
    title: event.title,
    body: event.body
  })
  try { hooks.publish(event) } catch (e) { /* 渲染层不在时忽略 */ }
}

/**
 * 上报一个事件。返回两条通道各自是否真的推送成功，便于设置页自检展示。
 * dto: { id?, module, title, body?, level?: 'normal'|'strong', force? }
 */
function push(dto) {
  const d = dto || {}
  const title = String(d.title || '').trim().slice(0, 120)
  if (!title) return { ok: false, id: null, inApp: false, system: false, reason: 'TITLE_REQUIRED' }
  const moduleName = String(d.module || 'system')
  const id = String(d.id || 'ev:' + moduleName + ':' + now() + ':' + Math.random().toString(36).slice(2, 8))
  const c = cfg()
  const out = { ok: true, id: id, inApp: false, system: false, reason: null }
  if (c[moduleName] === false) { out.reason = 'MODULE_OFF'; return out }
  if (!c.inApp && !c.desktop) { out.reason = 'ALL_OFF'; return out }
  if (!d.force && seen(id)) { out.reason = 'DUPLICATE'; return out }
  const event = {
    id: id,
    module: moduleName,
    level: d.level === 'strong' ? 'strong' : 'normal',
    title: title,
    body: d.body == null ? null : String(d.body).slice(0, 300),
    at: now(),
    // 提示音由渲染层播放：Windows 的 toast 只认系统音，自定义音频走 HTMLAudio
    sound: String((c.sounds && c.sounds[moduleName]) || '蜂鸣')
  }
  if (c.inApp) {
    try {
      // persist=false 用于自检：只走「应用内浮层」这条通道，不往通知表里留记录
      if (d.persist === false) hooks.publish(event)
      else pushInApp(event)
      out.inApp = true
    } catch (e) { logger.error('notify', 'inapp_failed', e, { id: id }) }
  }
  if (c.desktop) {
    try { out.system = showSystem(c, event) } catch (e) { logger.error('notify', 'system_threw', e, { id: id }) }
  }
  if (!d.force) remember(id)
  if (out.inApp || out.system) logger.info('notify', 'pushed', { module: moduleName, id: id, inApp: out.inApp, system: out.system })
  return out
}
/* ---------- 定时巡检：从业务表派生「该提醒了」的事件 ---------- */

function scanSchedules() {
  const t = now()
  const rows = get().prepare(
    "SELECT id, title, start_at, remind_min, place FROM schedule WHERE start_at >= ? AND start_at <= ? AND status != '取消' ORDER BY start_at ASC LIMIT 10"
  ).all(t - GRACE_MS, t + 2 * 3600000)
  rows.forEach(function (s) {
    const remindAt = s.start_at - (Number(s.remind_min) || 0) * 60000
    if (t < remindAt || t > s.start_at + GRACE_MS) return
    const copy = notifyText.scheduleReminder(s, t)
    push({ id: 'sch:' + s.id + ':' + s.start_at, module: 'schedule', level: copy.level, title: copy.title, body: copy.body })
  })
}

function scanTodos() {
  const t = now()
  // 一条待办只发一条「截止前」提醒：
  //   设了提醒时间 -> 在提醒时间说「还有 N 分钟」，到点不再单独再发一次
  //   没设提醒时间 -> 截止前 5 分钟说「还有 5 分钟截止」
  // 逾期状态由列表与派生条目表达，不额外推送，避免同一件事连响两三次。
  const remind = get().prepare(
    "SELECT id, title, remind_at, due_at FROM todo WHERE remind_at IS NOT NULL AND remind_at >= ? AND remind_at <= ? AND status IN ('未开始','进行中') LIMIT 10"
  ).all(t - GRACE_MS, t + GRACE_MS)
  remind.forEach(function (x) {
    const copy = notifyText.todoRemind(x, t)
    push({ id: 'todo-remind:' + x.id + ':' + x.remind_at, module: 'todo', level: copy.level, title: copy.title, body: copy.body })
  })
  const soon = get().prepare(
    "SELECT id, title, due_at FROM todo WHERE remind_at IS NULL AND due_at IS NOT NULL AND due_at > ? AND due_at <= ? AND status IN ('未开始','进行中') LIMIT 10"
  ).all(t, t + 5 * 60000)
  soon.forEach(function (x) {
    const copy = notifyText.todoDue(x, t)
    push({ id: 'todo:' + x.id + ':' + x.due_at, module: 'todo', level: copy.level, title: copy.title, body: copy.body })
  })
}

function scanMails() {
  const row = get().prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sent_at), 0) AS latest FROM mail WHERE read = 0 AND important = 1').get()
  if (!row || !row.n) return
  const copy = notifyText.mailDigest(row, now())
  push({ id: 'mail:important:' + row.latest + ':' + row.n, module: 'mail', level: copy.level, title: copy.title, body: copy.body })
}

function scanWeatherAlerts() {
  const row = get().prepare(
    "SELECT payload FROM weather_cache WHERE kind = 'alerts' AND city_id IN (SELECT id FROM weather_city WHERE is_home = 1) LIMIT 1"
  ).get()
  if (!row) return
  let list = []
  try { list = JSON.parse(row.payload) } catch (e) { return }
  if (!Array.isArray(list)) return
  list.slice(0, 3).forEach(function (a) {
    const key = String((a && (a.id || a.title)) || '')
    if (!key) return
    const copy = notifyText.weatherAlert(a, now())
    push({ id: 'weather:' + key, module: 'weather', level: copy.level, title: copy.title, body: copy.body })
  })
}

/** 主城的最近一次天气缓存：now/daily/hourly/aqi/indices，缺 now 视为没有可用数据 */
function homeWeather() {
  const city = get().prepare('SELECT id, name FROM weather_city WHERE is_home = 1 LIMIT 1').get()
  if (!city) return null
  const rows = get().prepare(
    "SELECT kind, payload FROM weather_cache WHERE city_id = ? AND kind IN ('now','daily','hourly','aqi','indices')"
  ).all(city.id)
  const map = {}
  rows.forEach(function (r) {
    try { map[r.kind] = JSON.parse(r.payload) } catch (e) { /* 单块坏数据不影响其它块 */ }
  })
  if (!map.now) return null
  return {
    city: city,
    now: map.now,
    daily: Array.isArray(map.daily) ? map.daily : [],
    hourly: Array.isArray(map.hourly) ? map.hourly : [],
    aqi: map.aqi || null,
    indices: Array.isArray(map.indices) ? map.indices : []
  }
}

/** 每天 09 / 12 / 17 / 20 点的天气播报：强提醒，但模块开关、总开关与免打扰照常生效 */
function scanWeatherDigest() {
  const t = now()
  const hour = weatherDigest.dueHour(t)
  if (hour == null) return
  const snap = homeWeather()
  if (!snap) return
  const copy = notifyText.weatherDigest(snap, hour, t)
  push({ id: weatherDigest.eventId(t, hour), module: 'weather', level: copy.level, title: copy.title, body: copy.body })
}

function safeScan() {
  // 快递入口已隐藏（src/lib/features.ts 的 PARCEL_ENABLED=false），不再扫描快递状态；
  // 历史通知仍按 MODULE_LABEL / MODULE_ROUTE 保留「快递」标签与跳转。
  const steps = [scanSchedules, scanTodos, scanMails, scanWeatherAlerts, scanWeatherDigest]
  steps.forEach(function (fn) {
    try { fn() } catch (e) { logger.warn('notify', 'scan_failed', { step: fn.name, message: e && e.message }) }
  })
}

/* ---------- 生命周期 ---------- */

function start(options) {
  if (running) return false
  const o = options || {}
  if (typeof o.getWindow === 'function') hooks.getWindow = o.getWindow
  if (typeof o.publish === 'function') hooks.publish = o.publish
  if (typeof o.navigate === 'function') hooks.navigate = o.navigate
  if (o.icon) hooks.icon = o.icon
  running = true
  // 启动后先扫一次，补齐进程不在时错过的提醒；去重保证不会重复打扰
  setTimeout(function () { if (running) safeScan() }, 4000)
  timer = setInterval(function () { if (running) safeScan() }, SCAN_MS)
  if (timer && timer.unref) timer.unref()
  logger.info('notify', 'engine_started', { scanMs: SCAN_MS })
  return true
}

function stop() {
  if (timer) { clearInterval(timer); timer = null }
  running = false
}

/** 设置页「发送测试通知」：两条通道各自返回结果，被免打扰压掉时给出原因 */
function test() {
  const c = cfg()
  const out = push({
    id: 'ev:test:' + now(),
    module: 'system',
    level: 'strong',
    title: '测试通知',
    body: '能看到这条，说明两条通道都通了',
    force: true,
    // 自检不留痕：否则每点一次「发送测试通知」就在通知中心多一条
    persist: false
  })
  if (!out.system) {
    out.reason = out.reason || (c.desktop ? (inDnd(c, now()) ? 'DND' : (c.systemOnlyAway && !away() ? 'WINDOW_ACTIVE' : 'SYSTEM_OFF')) : 'SYSTEM_OFF')
  }
  return out
}

module.exports = { push: push, scan: safeScan, start: start, stop: stop, test: test }

