// 日程领域服务：CRUD、重复展开、冲突检测、ICS 导入导出。
const { get, withTx } = require('../db/conn.cjs')
const { uid, now, camel, camelAll, bool } = require('../db/util.cjs')

const DAY = 86400000

function calendars() {
  return camelAll(get().prepare('SELECT * FROM schedule_calendar ORDER BY sort ASC').all())
}

/** 默认分组：删除其它分组时承接其中的日程；标记丢失时退回排序最前的一条。 */
function defaultCalendar() {
  const d = get()
  return d.prepare('SELECT * FROM schedule_calendar WHERE is_default = 1 ORDER BY sort ASC LIMIT 1').get()
    || d.prepare('SELECT * FROM schedule_calendar ORDER BY sort ASC LIMIT 1').get()
    || null
}

/** 修改分组名称：只改名字；默认分组同样允许改名。 */
function updateCalendar(dto) {
  return withTx(function () {
    const name = String((dto && dto.name) || '').trim()
    if (!name) throw new Error('CALENDAR_NAME_REQUIRED')
    const row = get().prepare('SELECT * FROM schedule_calendar WHERE id = ?').get(dto.id)
    if (!row) throw new Error('CALENDAR_NOT_FOUND')
    const dup = get().prepare('SELECT id FROM schedule_calendar WHERE lower(name) = lower(?) AND id <> ?').get(name, dto.id)
    if (dup) throw new Error('CALENDAR_NAME_EXISTS')
    get().prepare('UPDATE schedule_calendar SET name = ? WHERE id = ?').run(name, dto.id)
    return calendars()
  })
}

function toggleCalendar(dto) {
  return withTx(function () {
    get().prepare('UPDATE schedule_calendar SET visible = ? WHERE id = ?').run(bool(dto.visible), dto.id)
    return calendars()
  })
}

function createCalendar(dto) {
  return withTx(function () {
    const id = uid('cal')
    const max = get().prepare('SELECT COALESCE(MAX(sort),-1) AS m FROM schedule_calendar').get()
    get().prepare('INSERT INTO schedule_calendar (id,name,color,visible,sort) VALUES (?,?,?,?,?)').run(id, dto.name, dto.color || '#2563eb', 1, (max ? max.m : -1) + 1)
    return calendars()
  })
}

/** 把一条重复日程展开成 range 内的若干实例。 */
function expand(row, from, to) {
  const out = []
  const rule = row.recurRule
  const dur = row.endAt - row.startAt
  if (!rule) {
    if (row.startAt <= to && row.endAt >= from) out.push(row)
    return out
  }
  const step = rule === 'daily' ? DAY : rule === 'weekly' ? DAY * 7 : 0
  if (!step) {
    // monthly：按自然月推进
    const start = new Date(row.startAt)
    let cursor = new Date(start.getTime())
    let guard = 0
    while (cursor.getTime() < from && guard < 240) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, start.getDate(), start.getHours(), start.getMinutes())
      guard++
    }
    while (cursor.getTime() <= to && guard < 480) {
      if (cursor.getTime() + dur >= from) out.push(Object.assign({}, row, { instance_at: cursor.getTime(), occurrence: true }))
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, start.getDate(), start.getHours(), start.getMinutes())
      guard++
    }
    return out
  }
  let t = row.startAt
  if (t < from) {
    const n = Math.ceil((from - t) / step)
    t = t + n * step
  }
  let guard = 0
  while (t <= to && guard < 800) {
    if (t + dur >= from) out.push(Object.assign({}, row, { instance_at: t, occurrence: true }))
    t += step
    guard++
  }
  return out
}

function range(dto) {
  const from = dto && dto.from ? dto.from : 0
  const to = dto && dto.to ? dto.to : Number.MAX_SAFE_INTEGER
  const rows = camelAll(get().prepare('SELECT s.*, c.name AS calendar_name, c.color AS calendar_color, c.visible AS calendar_visible FROM schedule s LEFT JOIN schedule_calendar c ON c.id = s.calendar_id WHERE s.status != ? ORDER BY s.start_at ASC').all('取消'))
  // 只按「所属日历是否隐藏」过滤；没有分类的日程（calendar_id 为 NULL）一律显示。
  // camel() 会把 NULL 的 calendar_visible 转成 false，直接参与过滤会把这类日程全部藏掉。
  const visible = rows.filter(function (r) {
    if (!r.calendarId) return true
    return r.calendarVisible !== 0 && r.calendarVisible !== false
  })
  const out = []
  visible.forEach(function (r) {
    expand(r, from, to).forEach(function (inst) { out.push(inst) })
  })
  out.sort(function (a, b) { return (a.instanceAt || a.startAt) - (b.instanceAt || b.startAt) })
  return out
}

function getOne(id) {
  const row = get().prepare('SELECT s.*, c.name AS calendar_name, c.color AS calendar_color FROM schedule s LEFT JOIN schedule_calendar c ON c.id = s.calendar_id WHERE s.id = ?').get(id)
  return row ? camel(row) : null
}

function create(dto) {
  return withTx(function () {
    const t = now()
    const id = uid('sch')
    get().prepare('INSERT INTO schedule (id,title,start_at,end_at,all_day,place,calendar_id,remind_min,recur_rule,note,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, dto.title, dto.startAt, dto.endAt, bool(dto.allDay), dto.place || null, dto.calendarId || null, dto.remindMin == null ? 10 : dto.remindMin, dto.recurRule || null, dto.note || null, dto.status || '确认', t, t)
    return getOne(id)
  })
}

function updateRaw(dto) {
  const cur = get().prepare('SELECT * FROM schedule WHERE id = ?').get(dto.id)
  if (!cur) throw new Error('SCHEDULE_NOT_FOUND')
  const map = { title: 'title', startAt: 'start_at', endAt: 'end_at', place: 'place', calendarId: 'calendar_id', remindMin: 'remind_min', recurRule: 'recur_rule', note: 'note', status: 'status' }
  const fields = []
  const args = []
  for (const k in map) {
    if (Object.prototype.hasOwnProperty.call(dto, k)) { fields.push(map[k] + ' = ?'); args.push(dto[k]) }
  }
  if (Object.prototype.hasOwnProperty.call(dto, 'allDay')) { fields.push('all_day = ?'); args.push(bool(dto.allDay)) }
  if (!fields.length) return getOne(dto.id)
  fields.push('updated_at = ?'); args.push(now()); args.push(dto.id)
  get().prepare('UPDATE schedule SET ' + fields.join(', ') + ' WHERE id = ?').run(...args)
  return getOne(dto.id)
}

function update(dto) {
  return withTx(function () { return updateRaw(dto) })
}

function remove(id) {
  return withTx(function () {
    get().prepare('DELETE FROM schedule WHERE id = ?').run(id)
    return true
  })
}

/** 冲突检测：返回与 dto 时间重叠的其它日程（忽略 excludeId）。 */
function checkConflict(dto) {
  const from = dto.startAt
  const to = dto.endAt
  const rows = range({ from: from, to: to })
  return rows.filter(function (r) {
    if (dto.excludeId && r.id === dto.excludeId) return false
    const st = r.instanceAt || r.startAt
    const en = st + (r.endAt - r.startAt)
    return st < to && en > from
  }).map(function (r) {
    return { id: r.id, title: r.title, startAt: r.instanceAt || r.startAt, endAt: r.instanceAt ? r.instanceAt + (r.endAt - r.startAt) : r.endAt }
  })
}

function pad(n) { return String(n).padStart(2, '0') }
function icsDate(ts) {
  const d = new Date(ts)
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z'
}

function exportICS(dto) {
  const from = dto && dto.from ? dto.from : 0
  const to = dto && dto.to ? dto.to : now() + DAY * 365
  const rows = range({ from: from, to: to }).filter(function (r) { return !r.occurrence })
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Efficiency Toolkit//ZH']
  rows.forEach(function (r) {
    lines.push('BEGIN:VEVENT')
    lines.push('UID:' + r.id)
    lines.push('SUMMARY:' + String(r.title).replace(/[\r\n]/g, ' '))
    lines.push('DTSTART:' + icsDate(r.startAt))
    lines.push('DTEND:' + icsDate(r.endAt))
    if (r.place) lines.push('LOCATION:' + String(r.place).replace(/[\r\n]/g, ' '))
    if (r.note) lines.push('DESCRIPTION:' + String(r.note).replace(/[\r\n]/g, ' '))
    if (r.recurRule === 'daily') lines.push('RRULE:FREQ=DAILY')
    if (r.recurRule === 'weekly') lines.push('RRULE:FREQ=WEEKLY')
    if (r.recurRule === 'monthly') lines.push('RRULE:FREQ=MONTHLY')
    lines.push('END:VEVENT')
  })
  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

/** 极简 ICS 解析：只取 VEVENT 的 SUMMARY/DTSTART/DTEND/LOCATION/DESCRIPTION。 */
function importICS(dto) {
  const text = String(dto.text || '')
  const blocks = text.split('BEGIN:VEVENT').slice(1)
  const created = []
  const parseDate = function (v) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(String(v).trim())
    if (!m) return null
    const utc = m[7] === 'Z'
    const ts = utc
      ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
      : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
    return ts
  }
  withTx(function () {
    blocks.forEach(function (b) {
      const body = b.split('END:VEVENT')[0]
      const pick = function (key) {
        const re = new RegExp('^' + key + '[:;](.*)$', 'm')
        const mm = re.exec(body)
        return mm ? mm[1].trim() : null
      }
      const title = pick('SUMMARY')
      const st = parseDate(pick('DTSTART'))
      const en = parseDate(pick('DTEND'))
      if (!title || !st || !en) return
      const t = now()
      const id = uid('sch')
      get().prepare('INSERT INTO schedule (id,title,start_at,end_at,all_day,place,calendar_id,remind_min,recur_rule,note,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, title, st, en, 0, pick('LOCATION'), dto.calendarId || null, 10, null, pick('DESCRIPTION'), '确认', t, t)
      created.push(id)
    })
  })
  return { imported: created.length }
}

/** 删除分组：分组内的日程迁移到默认分组，不清空；默认分组不允许删除。 */
/** 分组内日程条数：删除前提示用。月视图只持有当月事件，所以跨月分组也要算准。 */
function calendarUsage(id) {
  const row = get().prepare('SELECT COUNT(*) AS n FROM schedule WHERE calendar_id = ?').get(String(id || ''))
  return row ? row.n : 0
}

function removeCalendar(id) {
  return withTx(function () {
    const row = get().prepare('SELECT * FROM schedule_calendar WHERE id = ?').get(id)
    if (!row) throw new Error('CALENDAR_NOT_FOUND')
    if (row.is_default) throw new Error('CALENDAR_IS_DEFAULT')
    const fallback = defaultCalendar()
    if (!fallback) throw new Error('CALENDAR_DEFAULT_MISSING')
    get().prepare('UPDATE schedule SET calendar_id = ? WHERE calendar_id = ?').run(fallback.id, id)
    get().prepare('DELETE FROM schedule_calendar WHERE id = ?').run(id)
    return calendars()
  })
}

module.exports = {
  range: range, get: getOne, create: create, update: update, remove: remove,
  checkConflict: checkConflict, calendars: calendars, toggleCalendar: toggleCalendar,
  createCalendar: createCalendar, updateCalendar: updateCalendar, calendarUsage: calendarUsage,
  removeCalendar: removeCalendar,
  exportICS: exportICS, importICS: importICS
}
