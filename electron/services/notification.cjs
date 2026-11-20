// 通知领域服务：数据库通知行 + 由各模块派生的今日提醒（规则汇总，无智能推断）。
const { get, withTx } = require('../db/conn.cjs')
const { now } = require('../db/util.cjs')

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

function readMark() {
  const row = get().prepare("SELECT value FROM app_setting WHERE key = 'noticeReadAt'").get()
  if (!row) return 0
  try { return Number(JSON.parse(row.value)) || 0 } catch (e) { return 0 }
}

/** 由日程/待办/快递/邮件派生今日提醒，纯规则匹配。 */
function derived(mark) {
  const t = now()
  const out = []
  let schedules = []
  let overdue = []
  let parcels = []
  let mails = []
  try { schedules = get().prepare('SELECT id, title, start_at, remind_min, place FROM schedule WHERE start_at >= ? AND start_at <= ? ORDER BY start_at ASC LIMIT 5').all(t - HOUR, t + 12 * HOUR) } catch (e) { schedules = [] }
  try { overdue = get().prepare("SELECT id, title, due_at FROM todo WHERE status IN ('未开始','进行中') AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at ASC LIMIT 3").all(t) } catch (e) { overdue = [] }
  // 派生提醒的时间基准必须稳定（用记录自身的时间戳），否则每次调用都等于当前时间，已读标记无法生效
  try { parcels = get().prepare("SELECT id, company, status, pickup_code, station, updated_at FROM parcel WHERE archived = 0 AND status = '待取件' LIMIT 3").all() } catch (e) { parcels = [] }
  try { mails = get().prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sent_at), 0) AS latest FROM mail WHERE read = 0 AND important = 1').get() } catch (e) { mails = { n: 0, latest: 0 } }

  schedules.forEach(function (s) {
    const soon = s.start_at - t <= HOUR
    out.push({
      id: 'sch:' + s.id, module: 'schedule', level: soon ? 'strong' : 'normal',
      title: (soon ? '即将开始：' : '今日日程：') + s.title,
      body: (s.place ? s.place + ' · ' : '') + '提前 ' + (s.remind_min || 0) + ' 分钟提醒',
      at: s.start_at - (s.remind_min || 0) * 60000, derived: true
    })
  })
  overdue.forEach(function (x) {
    out.push({
      id: 'todo:' + x.id, module: 'todo', level: 'strong',
      title: '待办已到期：' + x.title, body: '完成时间已过，建议重新安排', at: x.due_at, derived: true
    })
  })
  parcels.forEach(function (p) {
    out.push({
      id: 'parcel:' + p.id, module: 'parcel', level: 'normal',
      title: p.company + ' 已到驿站', body: (p.station || '驿站') + (p.pickup_code ? ' · 取件码 ' + p.pickup_code : ''),
      at: Number(p.updated_at) || t - 60000, derived: true
    })
  })
  if (mails && mails.n > 0) {
    out.push({
      id: 'mail:important', module: 'mail', level: 'normal',
      title: '有 ' + mails.n + ' 封重要未读邮件', body: '来自已配置邮箱账户',
      at: Number(mails.latest) || t - 60000, derived: true
    })
  }
  return out.map(function (i) { return Object.assign({}, i, { read: i.at <= mark }) })
}

function today() {
  const mark = readMark()
  const merged = rows(20).concat(derived(mark))
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
    get().prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)').run('noticeReadAt', JSON.stringify(t))
    get().prepare('INSERT INTO operation_log (action, detail, created_at) VALUES (?,?,?)').run('notification.readAll', '', t)
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

module.exports = { today: today, unreadCount: unreadCount, markAllRead: markAllRead, create: create, remove: remove }
