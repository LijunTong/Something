// 首次建库的示例数据。只在数据库为空时写入。
const { uid, now, bool } = require('./util.cjs')

function isEmpty(db) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM todo').get()
  return !r || r.n === 0
}

function seed(db) {
  if (!isEmpty(db)) return false
  const t = now()
  const lists = [['工作','#2563eb'],['个人','#16a34a'],['学习','#ea580c'],['购物','#a855f7'],['生活','#64748b']]
  const insList = db.prepare('INSERT INTO todo_list (id,name,color,sort) VALUES (?,?,?,?)')
  const listIds = {}
  lists.forEach(function (l, i) { const id = uid('list'); listIds[l[0]] = id; insList.run(id, l[0], l[1], i) })
  db.prepare('INSERT OR IGNORE INTO todo_list (id,name,color,sort) VALUES (?,?,?,?)').run(uid('list'), '今天', '#0f766e', 99)

  const insTodo = db.prepare('INSERT INTO todo (id,title,note,list_id,priority,due_at,remind_at,status,done_at,focus_seconds,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const todos = [
    ['回复客户邮件','工作','高',t + 3600000 * 3, null, '未开始', null, 0],
    ['整理项目周报','工作','中',t + 3600000 * 4, null, '进行中', null, 4500],
    ['取顺丰快递','生活','中',t + 3600000 * 6, null, '未开始', null, 0],
    ['阅读稍后读文章','学习','中',t + 3600000 * 7, null, '未开始', null, 0],
    ['确认会议室预订','工作','低',t - 86400000, null, '已完成', t - 3600000, 0]
  ]
  todos.forEach(function (x, i) {
    insTodo.run(uid('todo'), x[0], null, listIds[x[1]] || null, x[2], x[3], x[4], x[5], x[6], x[7], i, t, t)
  })
  const firstTodo = db.prepare('SELECT id FROM todo WHERE title = ?').get('整理项目周报')
  if (firstTodo) {
    const insSub = db.prepare('INSERT INTO todo_subtask (id,todo_id,title,done,sort) VALUES (?,?,?,?,?)')
    insSub.run(uid('sub'), firstTodo.id, '收集本周进展', 1, 0)
    insSub.run(uid('sub'), firstTodo.id, '整理成周报文档', 0, 1)
    insSub.run(uid('sub'), firstTodo.id, '发送给团队', 0, 2)
  }

  const cals = [['工作','#2563eb'],['个人','#16a34a'],['学习','#ea580c'],['节假日','#94a3b8']]
  const insCal = db.prepare('INSERT INTO schedule_calendar (id,name,color,visible,sort) VALUES (?,?,?,?,?)')
  const calIds = {}
  cals.forEach(function (c, i) { const id = uid('cal'); calIds[c[0]] = id; insCal.run(id, c[0], c[1], 1, i) })

  const day0 = new Date(); day0.setHours(0,0,0,0); const base = day0.getTime()
  const H = 3600000
  const insSch = db.prepare('INSERT INTO schedule (id,title,start_at,end_at,all_day,place,calendar_id,remind_min,recur_rule,note,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const schs = [
    ['项目周会', base + 9.5*H, base + 10.5*H, '会议室 A', '工作', 10, 'weekly', '同步上周进展，确认本周排期。'],
    ['需求评审', base + 14*H, base + 15*H, '线上会议', '工作', 10, null, ''],
    ['一对一沟通', base + 2*86400000 + 10*H, base + 2*86400000 + 11*H, '', '工作', 10, null, ''],
    ['健身', base + 2*86400000 + 19.5*H, base + 2*86400000 + 20.5*H, '附近健身房', '个人', 30, 'weekly', ''],
    ['周报整理', base + 4*86400000 + 15*H, base + 4*86400000 + 16*H, '', '工作', 10, 'weekly', ''],
    ['阅读时间', base + 5*86400000 + 10*H, base + 5*86400000 + 12*H, '', '学习', 0, null, '']
  ]
  schs.forEach(function (s) { insSch.run(uid('sch'), s[0], s[1], s[2], 0, s[3], calIds[s[4]] || null, s[5], s[6], s[7], '确认', t, t) })

  db.prepare('INSERT OR REPLACE INTO pomodoro_state (id,phase,remain_sec,round,task_id,updated_at) VALUES (1,?,?,?,?,?)').run('idle', 1500, 1, null, t)

  const insCity = db.prepare('INSERT INTO weather_city (id,name,is_home,sort) VALUES (?,?,?,?)')
  insCity.run(uid('city'), '佛山', 1, 0)
  insCity.run(uid('city'), '广州', 0, 1)
  insCity.run(uid('city'), '深圳', 0, 2)

  const g = uid('grp')
  db.prepare('INSERT INTO feed_group (id,name) VALUES (?,?)').run(g, '科技')
  const insSrc = db.prepare('INSERT INTO feed_source (id,url,title,group_id,interval_min,enabled) VALUES (?,?,?,?,?,?)')
  insSrc.run(uid('src'), 'https://sspai.com/feed', '少数派', g, 60, 1)
  insSrc.run(uid('src'), 'https://www.ruanyifeng.com/blog/atom.xml', '阮一峰的网络日志', g, 360, 1)

  const insParcel = db.prepare('INSERT INTO parcel (id,company,tracking_no,alias,note,status,pickup_code,station,eta_at,archived,privacy_masked,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const p1 = uid('pc')
  insParcel.run(p1, '顺丰速运', 'SF1234567890123', '双十一 · 耳机', '取件码 8-2-104', '待取件', '8-2-104', '菜鸟驿站（XX 路店）', null, 0, 1, t, t)
  insParcel.run(uid('pc'), '中通快递', 'ZT9876543210987', '生活用品', '', '在途', null, null, t + 86400000, 0, 1, t, t)
  const insTrack = db.prepare('INSERT INTO parcel_track (id,parcel_id,node_time,description,location) VALUES (?,?,?,?,?)')
  insTrack.run(uid('trk'), p1, t - 3600000, '待取件，取件码 8-2-104', '菜鸟驿站')
  insTrack.run(uid('trk'), p1, t - 72000000, '派送中，快递员 138****1234', '佛山市禅城区')
  insTrack.run(uid('trk'), p1, t - 108000000, '到达佛山转运中心', '佛山市')

  const setting = db.prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)')
  setting.run('appearance', JSON.stringify({ theme: '浅色', accent: '#0f766e', font: '小', sidebarExpand: true }))
  setting.run('notify', JSON.stringify({ desktop: true, weather: true, schedule: true, todo: true, pomodoro: true, parcel: false, mail: true, dndStart: '22:00', dndEnd: '08:00', privacy: 'summary' }))
  setting.run('shortcuts', JSON.stringify({ search: 'Ctrl+K', newTodo: 'N', focus: 'F', quickAdd: 'Space', viewSwitch: 'Ctrl+1-3' }))
  return true
}

module.exports = { seed: seed }
