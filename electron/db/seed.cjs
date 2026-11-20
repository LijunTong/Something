// 首次建库只写入结构性的默认项（默认清单、默认日历、番茄状态），不写任何示例记录。
// 历史版本会插入示例待办/日程/快递/订阅源/城市，这些已全部移除。
const { uid, now } = require('./util.cjs')

function countOf(db, table) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()
  return r && r.n ? r.n : 0
}

function seed(db) {
  if (countOf(db, 'todo_list') > 0) return false
  db.prepare('INSERT INTO todo_list (id,name,color,sort) VALUES (?,?,?,?)').run(uid('list'), '收件箱', '#0f766e', 0)
  if (countOf(db, 'schedule_calendar') === 0) {
    db.prepare('INSERT INTO schedule_calendar (id,name,color,visible,sort) VALUES (?,?,?,?,?)').run(uid('cal'), '默认', '#2563eb', 1, 0)
  }
  if (countOf(db, 'pomodoro_state') === 0) {
    db.prepare('INSERT INTO pomodoro_state (id,phase,remain_sec,round,task_id,updated_at) VALUES (1,?,?,?,?,?)').run('idle', 1500, 1, null, now())
  }
  return true
}

module.exports = { seed: seed }
