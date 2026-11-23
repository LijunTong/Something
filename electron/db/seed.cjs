// 首次建库只写入结构性的默认项（默认清单、默认分组、默认分类、番茄状态），不写任何示例记录。
// 历史版本会插入示例待办/日程/快递/订阅源/城市，这些已全部移除。
const { uid, now } = require('./util.cjs')

function countOf(db, table) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()
  return r && r.n ? r.n : 0
}

// 默认项兜底：表里有数据但没有 is_default=1 的行时，把排序最前的一条标为默认。
// 旧版这里用 todo_list 是否为空做总开关，待办有数据时会把日程默认分组的种子一起跳过。
function ensureDefault(db, table, orderBy) {
  const has = db.prepare('SELECT id FROM ' + table + ' WHERE is_default = 1 LIMIT 1').get()
  if (has) return
  db.prepare('UPDATE ' + table + ' SET is_default = 1 WHERE id = (SELECT id FROM ' + table + ' ORDER BY ' + orderBy + ' LIMIT 1)').run()
}

function seed(db) {
  // 三个域的默认项各自独立保证，互不牵连
  if (countOf(db, 'feed_group') === 0) {
    db.prepare('INSERT INTO feed_group (id,name,color,is_default) VALUES (?,?,?,?)').run(uid('grp'), '默认分类', '#0f766e', 1)
  } else {
    ensureDefault(db, 'feed_group', 'name ASC, id ASC')
  }
  if (countOf(db, 'todo_list') === 0) {
    // is_default=1：种子清单是默认项，可改名但不可删除
    db.prepare('INSERT INTO todo_list (id,name,color,sort,is_default) VALUES (?,?,?,?,?)').run(uid('list'), '默认清单', '#0f766e', 0, 1)
  } else {
    ensureDefault(db, 'todo_list', 'sort ASC, id ASC')
  }
  if (countOf(db, 'schedule_calendar') === 0) {
    db.prepare('INSERT INTO schedule_calendar (id,name,color,visible,sort,is_default) VALUES (?,?,?,?,?,?)').run(uid('cal'), '默认分组', '#2563eb', 1, 0, 1)
  } else {
    ensureDefault(db, 'schedule_calendar', 'sort ASC, id ASC')
  }
  if (countOf(db, 'pomodoro_state') === 0) {
    db.prepare('INSERT INTO pomodoro_state (id,phase,remain_sec,round,task_id,updated_at) VALUES (1,?,?,?,?,?)').run('idle', 1500, 1, null, now())
  }
  return true
}

module.exports = { seed: seed }
