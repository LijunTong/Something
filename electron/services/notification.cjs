// 通知领域服务：数据库通知行 + 由各模块派生的今日提醒（规则汇总，无智能推断）。
const { get, withTx } = require('../db/conn.cjs')
const { now } = require('../db/util.cjs')
const notifyText = require('./notifyText.cjs')

const HOUR = 3600000

function rows(limit) {
  const list = get().prepare('SELECT * FROM notification ORDER BY created_at DESC LIMIT ?').all(limit || 50)
  return list.map(function (r) {
    return {
      id: r.id, module: r.module, level: r.level, title: r.title, body: r.body,
      at: r.created_at, read: !!r.read, derived: false
    }
  })
}

/**
 * 派生提醒的已读状态按条目 id 落库（noticeDerivedRead）。
 * 旧口径是「统一已读时间 >= 条目时间」，但日程提醒的时间点在将来，
 * 这类条目永远比标记时间新，于是「全部已读」对它们无效、「清除已读」也清不掉。
 */
function derivedReadMap() {
  const row = get().prepare("SELECT value FROM app_setting WHERE key = 'noticeDerivedRead'").get()
  if (!row) return {}
  try {
    const v = JSON.parse(row.value)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch (e) { return {} }
}

function writeDerivedReadMap(map) {
  get().prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)')
    .run('noticeDerivedRead', JSON.stringify(map))
}

/**
 * 「清除已读」清掉的派生条目（noticeDismissed）：派生条目删不掉，只能记下 id 不再展示。
 * 与已读标记分开存：已读是状态，清掉是「从列表移除」。
 */
function dismissedMap() {
  const row = get().prepare("SELECT value FROM app_setting WHERE key = 'noticeDismissed'").get()
  if (!row) return {}
  try {
    const v = JSON.parse(row.value)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch (e) { return {} }
}

function writeDismissedMap(map) {
  get().prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)')
    .run('noticeDismissed', JSON.stringify(map))
}

/** 由日程/待办/快递/邮件派生今日提醒，纯规则匹配。 */
function derived() {
  const t = now()
  const out = []
  let schedules = []
  let overdue = []
  let parcels = []
  let mails = []
  try { schedules = get().prepare('SELECT id, title, start_at, remind_min, place FROM schedule WHERE start_at >= ? AND start_at <= ? ORDER BY start_at ASC LIMIT 5').all(t - HOUR, t + 12 * HOUR) } catch (e) { schedules = [] }
  try { overdue = get().prepare("SELECT id, title, due_at FROM todo WHERE status IN ('未开始','进行中') AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at ASC LIMIT 3").all(t) } catch (e) { overdue = [] }
  // 派生提醒的时间基准必须稳定（用记录自身的时间戳），否则每次调用都等于当前时间，已读标记无法生效
  try { parcels = get().prepare("SELECT id, company, status, pickup_code, station, eta_at, updated_at FROM parcel WHERE archived = 0 AND status = '待取件' LIMIT 3").all() } catch (e) { parcels = [] }
  try { mails = get().prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sent_at), 0) AS latest FROM mail WHERE read = 0 AND important = 1').get() } catch (e) { mails = { n: 0, latest: 0 } }

  schedules.forEach(function (s) {
    const remindAt = s.start_at - (Number(s.remind_min) || 0) * 60000
    // 到了提醒点就报「还有多久」，没到点只是今天的清单项
    const copy = t >= remindAt ? notifyText.scheduleReminder(s, t) : notifyText.scheduleToday(s)
    out.push({
      id: 'sch:' + s.id, module: 'schedule', level: copy.level,
      title: copy.title, body: copy.body, at: remindAt, derived: true
    })
  })
  overdue.forEach(function (x) {
    const copy = notifyText.todoDue(x, t)
    out.push({
      id: 'todo:' + x.id, module: 'todo', level: copy.level,
      title: copy.title, body: copy.body, at: x.due_at, derived: true
    })
  })
  parcels.forEach(function (p) {
    const copy = notifyText.parcel(p)
    out.push({
      id: 'parcel:' + p.id, module: 'parcel', level: copy.level,
      title: copy.title, body: copy.body, at: Number(p.updated_at) || t - 60000, derived: true
    })
  })
  if (mails && mails.n > 0) {
    const copy = notifyText.mailDigest(mails, t)
    out.push({
      id: 'mail:important', module: 'mail', level: copy.level,
      title: copy.title, body: copy.body, at: Number(mails.latest) || t - 60000, derived: true
    })
  }
  const readMap = derivedReadMap()
  const dismissed = dismissedMap()
  return out.filter(function (i) { return !dismissed[i.id] })
    .map(function (i) { return Object.assign({}, i, { read: !!readMap[i.id] }) })
}

function today() {
  const real = rows(40)
  // 事件通知引擎写入的行与派生提醒说的是同一件事（同一日程/待办/快递/重要邮件），
  // 已有真实行时不再重复展示派生条目；两条通道共用同一套 id 前缀，这里按前缀判断。
  const realIds = real.map(function (r) { return String(r.id) })
  const merged = real.concat(derived().filter(function (d) {
    const base = String(d.id)
    return !realIds.some(function (rid) { return rid === base || rid.indexOf(base + ':') === 0 })
  }))
  merged.sort(function (a, b) { return b.at - a.at })
  return merged
}

function unreadCount() {
  return today().filter(function (i) { return !i.read }).length
}

function markAllRead() {
  return withTx(function () {
    const t = now()
    get().prepare('UPDATE notification SET read = 1 WHERE read = 0').run()
    // 派生提醒按 id 记已读：整批覆盖为当前列表，不再残留已消失的条目
    const map = {}
    derived().forEach(function (i) { map[i.id] = t })
    writeDerivedReadMap(map)
    get().prepare('INSERT INTO operation_log (action, detail, created_at) VALUES (?,?,?)').run('notification.readAll', String(Object.keys(map).length), t)
    return unreadCount()
  })
}

function create(dto) {
  return withTx(function () {
    const id = dto && dto.id ? String(dto.id) : 'ntf_' + Math.random().toString(36).slice(2, 12)
    const t = now()
    get().prepare('INSERT OR REPLACE INTO notification (id,module,level,title,body,created_at,read) VALUES (?,?,?,?,?,?,?)')
      .run(id, String(dto.module || 'system'), String(dto.level || 'normal'), String(dto.title || ''), dto.body == null ? null : String(dto.body), t, 0)
    return id
  })
}

function remove(id) {
  return withTx(function () {
    get().prepare('DELETE FROM notification WHERE id = ?').run(id)
    return true
  })
}

/**
 * 统一列表：真实通知行 + 当天派生提醒（同日同一件事只出现一次）。
 * 首页卡片与管理页共用这一份口径，避免两处数量对不上。
 */
function unified() {
  const real = rows(200)
  const realIds = real.map(function (r) { return String(r.id) })
  return real.concat(derived().filter(function (d) {
    const base = String(d.id)
    return !realIds.some(function (rid) { return rid === base || rid.indexOf(base + ':') === 0 })
  })).sort(function (a, b) { return b.at - a.at })
}

/** 管理页：按模块/未读筛选 + 分页 */
function list(dto) {
  const o = dto || {}
  const moduleName = o.module ? String(o.module) : ''
  const limit = Math.min(200, Math.max(1, Number(o.limit) || 60))
  const offset = Math.max(0, Number(o.offset) || 0)
  let all = unified()
  if (moduleName) all = all.filter(function (i) { return i.module === moduleName })
  if (o.onlyUnread) all = all.filter(function (i) { return !i.read })
  return { items: all.slice(offset, offset + limit), total: all.length, offset: offset, limit: limit, hasMore: offset + limit < all.length }
}

/** 计数：总数、未读、按模块分布（侧栏角标与页头都用它） */
function counts() {
  const all = unified()
  const byModule = {}
  let unread = 0
  all.forEach(function (i) {
    byModule[i.module] = (byModule[i.module] || 0) + 1
    if (!i.read) unread += 1
  })
  return { total: all.length, unread: unread, byModule: byModule }
}

/** 单条已读：落库的通知改 read 列，派生提醒写进 noticeDerivedRead */
function markRead(id) {
  if (!id) return false
  const key = String(id)
  return withTx(function () {
    // 先按落库行匹配：事件通知引擎的 id 也带冒号（sch:/todo:/ev:/parcel:），
    // 不能用「有没有冒号」判断它是派生条目，否则单条已读永远走不到 UPDATE。
    const row = get().prepare('SELECT id FROM notification WHERE id = ?').get(key)
    if (row) return get().prepare('UPDATE notification SET read = 1 WHERE id = ?').run(key).changes > 0
    const exists = derived().some(function (i) { return i.id === key })
    if (!exists) return false
    const map = derivedReadMap()
    map[key] = now()
    writeDerivedReadMap(map)
    return true
  })
}

/**
 * 清除已读：真实行直接删，派生提醒清空已读记录后重新按未读出现。
 * 返回「从列表消失的条数」，管理页提示用。
 */
function clearRead() {
  return withTx(function () {
    const t = now()
    const current = derived()
    const readDerived = current.filter(function (i) { return i.read })
    const changes = get().prepare('DELETE FROM notification WHERE read = 1').run().changes
    const dismissed = dismissedMap()
    readDerived.forEach(function (i) { dismissed[i.id] = t })
    // 只保留仍在派生的 id，条目消失后不再占位
    const alive = {}
    current.forEach(function (i) { if (dismissed[i.id]) alive[i.id] = dismissed[i.id] })
    writeDismissedMap(alive)
    get().prepare("DELETE FROM app_setting WHERE key = 'noticeDerivedRead'").run()
    get().prepare('INSERT INTO operation_log (action, detail, created_at) VALUES (?,?,?)')
      .run('notification.clearRead', String(changes) + '+' + String(readDerived.length), t)
    return changes + readDerived.length
  })
}

/** 单条：仪表盘深链定位用（/notice?focus=<id>）。落库行与派生提醒都在 unified() 里，查不到返回 null。 */
function detail(id) {
  const key = String(id || '')
  if (!key) return null
  return unified().find(function (i) { return i.id === key }) || null
}

module.exports = {
  get: detail,
  today: today, unreadCount: unreadCount, markAllRead: markAllRead, create: create, remove: remove,
  list: list, counts: counts, markRead: markRead, clearRead: clearRead
}
