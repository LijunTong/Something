// 番茄钟领域服务：状态机 + 会话记录 + 统计。计时的权威来源是绝对时间戳，避免 setInterval 漂移。
const { get, withTx } = require('../db/conn.cjs')
const { uid, now, camel, camelAll, bool } = require('../db/util.cjs')

const DAY = 86400000
const DEFAULTS = { focusMin: 25, shortMin: 5, longMin: 15, longEvery: 4, goal: 4 }

function cfg() {
  const row = get().prepare('SELECT value FROM app_setting WHERE key = ?').get('pomodoro')
  if (!row) return Object.assign({}, DEFAULTS)
  try { return Object.assign({}, DEFAULTS, JSON.parse(row.value)) } catch (e) { return Object.assign({}, DEFAULTS) }
}

function saveCfg(patch) {
  const next = Object.assign(cfg(), patch)
  get().prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)').run('pomodoro', JSON.stringify(next))
  return next
}

function readState() {
  const row = get().prepare('SELECT * FROM pomodoro_state WHERE id = 1').get()
  const c = cfg()
  if (!row) return { phase: 'idle', remainSec: c.focusMin * 60, round: 1, taskId: null, endsAt: null, plannedSec: c.focusMin * 60 }
  const s = camel(row)
  // 运行中：按 endsAt 反算剩余，进程重启也能接上
  let remain = s.remainSec
  if (s.phase === 'running' && s.endsAt) remain = Math.max(0, Math.round((s.endsAt - now()) / 1000))
  return { phase: s.phase, remainSec: remain, round: s.round, taskId: s.taskId, endsAt: s.endsAt || null, plannedSec: s.plannedSec || remain }
}

function writeState(patch) {
  const cur = readState()
  const next = Object.assign(cur, patch)
  get().prepare('INSERT OR REPLACE INTO pomodoro_state (id,phase,remain_sec,round,task_id,ends_at,planned_sec,updated_at) VALUES (1,?,?,?,?,?,?,?)')
    .run(next.phase, next.remainSec, next.round, next.taskId || null, next.endsAt || null, next.plannedSec || next.remainSec, now())
  return next
}

/** 事件上报：延迟到写事务提交后再推，通知写入不会嵌进计时事务里 */
function notifyEvent(dto) {
  setImmediate(function () {
    try { require('./notify.cjs').push(dto) } catch (e) { /* 通知失败不影响计时 */ }
  })
}

function start(dto) {
  return withTx(function () {
    const c = cfg()
    const cur = readState()
    const planned = (dto && dto.minutes ? dto.minutes : (cur.phase === 'paused' ? Math.ceil(cur.remainSec / 60) : c.focusMin)) * 60
    const remain = cur.phase === 'paused' ? cur.remainSec : planned
    const st = writeState({
      phase: 'running',
      remainSec: remain,
      plannedSec: planned,
      endsAt: now() + remain * 1000,
      taskId: dto && dto.taskId !== undefined ? dto.taskId : cur.taskId
    })
    return st
  })
}

function pause() {
  return withTx(function () {
    const cur = readState()
    if (cur.phase !== 'running') return cur
    const remain = Math.max(0, Math.round(((cur.endsAt || now()) - now()) / 1000))
    return writeState({ phase: 'paused', remainSec: remain, endsAt: null })
  })
}

function resume() {
  return withTx(function () {
    const cur = readState()
    if (cur.phase !== 'paused') return cur
    return writeState({ phase: 'running', endsAt: now() + cur.remainSec * 1000 })
  })
}

function finishSession(status, extra) {
  const cur = readState()
  const c = cfg()
  const actual = Math.max(1, Math.round((cur.plannedSec - Math.max(0, cur.remainSec)) / 60))
  const startedAt = now() - Math.max(0, cur.plannedSec - cur.remainSec) * 1000
  get().prepare('INSERT INTO pomodoro_session (id,task_type,task_id,tag,planned_min,actual_min,started_at,ended_at,status,interrupt_reason) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(uid('pomo'), extra && extra.taskType ? extra.taskType : 'todo', cur.taskId || null, extra && extra.tag ? extra.tag : null, Math.round(cur.plannedSec / 60), actual, startedAt, now(), status, extra && extra.reason ? extra.reason : null)
}

function complete() {
  const st = withTx(function () {
    const cur = readState()
    const c = cfg()
    finishSession('完成', {})
    const round = (cur.round % c.longEvery) + 1
    const isLong = round === 1
    const restSec = (isLong ? c.longMin : c.shortMin) * 60
    const next = writeState({ phase: 'break', remainSec: restSec, plannedSec: restSec, endsAt: now() + restSec * 1000, round: round })
    // 回写待办的专注时长
    if (cur.taskId) {
      get().prepare('UPDATE todo SET focus_seconds = focus_seconds + ?, updated_at = ? WHERE id = ?').run(cur.plannedSec, now(), cur.taskId)
    }
    return next
  })
  const done = require('./notifyText.cjs').pomodoroDone(st.plannedSec, st.remainSec)
  notifyEvent({
    id: 'ev:pomodoro:done:' + st.round + ':' + (st.endsAt || now()),
    module: 'pomodoro',
    level: done.level,
    title: done.title,
    body: done.body
  })
  return st
}

function skipBreak() {
  return withTx(function () {
    const c = cfg()
    const cur = readState()
    const focusSec = c.focusMin * 60
    return writeState({ phase: 'idle', remainSec: focusSec, plannedSec: focusSec, endsAt: null, round: cur.round })
  })
}

function abandon(dto) {
  return withTx(function () {
    const c = cfg()
    finishSession('中断', { reason: dto && dto.reason ? dto.reason : '其他' })
    const focusSec = c.focusMin * 60
    return writeState({ phase: 'idle', remainSec: focusSec, plannedSec: focusSec, endsAt: null })
  })
}

/** 状态变更回调：由主进程注入，用于把自动收尾广播给所有窗口 */
let stateListener = null
function onStateChange(fn) { stateListener = fn }

/**
 * 绑定的任务已完成（或被删除）后，番茄钟跟着收尾：
 * 专注中/暂停 → 记一条中断并回到待开始；休息中 → 只解除绑定，让休息照常走完。
 * 没绑定这个任务时返回 null，调用方据此决定要不要广播。
 */
function endForTask(taskId) {
  const next = withTx(function () {
    const cur = readState()
    if (!cur.taskId || cur.taskId !== taskId) return null
    if (cur.phase === 'running' || cur.phase === 'paused') {
      finishSession('中断', { reason: '任务已完成' })
      const focusSec = cfg().focusMin * 60
      return writeState({ phase: 'idle', remainSec: focusSec, plannedSec: focusSec, endsAt: null, taskId: null })
    }
    return writeState({ taskId: null })
  })
  if (next && stateListener) {
    setImmediate(function () {
      try { stateListener() } catch (e) { /* 广播失败不影响计时 */ }
    })
  }
  return next
}

function tick() {
  // 渲染进程轮询：把到期的 running 自动推进到 break，break 到期回到 idle
  return withTx(function () {
    const cur = readState()
    if (cur.phase === 'running' && cur.endsAt && cur.endsAt <= now()) return complete()
    if (cur.phase === 'break' && cur.endsAt && cur.endsAt <= now()) {
      const next = skipBreak()
      const rest = require('./notifyText.cjs').pomodoroBreakOver()
      notifyEvent({
        id: 'ev:pomodoro:break:' + cur.endsAt,
        module: 'pomodoro',
        level: rest.level,
        title: rest.title,
        body: rest.body
      })
      return next
    }
    return cur
  })
}

function setTask(dto) {
  return withTx(function () {
    return writeState({ taskId: dto.taskId || null })
  })
}

function stats(dto) {
  const since = dto && dto.since ? dto.since : (function () { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })()
  const rows = camelAll(get().prepare('SELECT * FROM pomodoro_session WHERE started_at >= ? ORDER BY started_at DESC').all(since))
  const done = rows.filter(function (r) { return r.status === '完成' })
  const interrupted = rows.filter(function (r) { return r.status === '中断' })
  const minutes = done.reduce(function (a, r) { return a + r.actualMin }, 0)
  const total = rows.length
  return {
    sessions: rows,
    count: done.length,
    minutes: minutes,
    interrupted: interrupted.length,
    rate: total ? Math.round((done.length / total) * 100) : 0
  }
}

function weekStats() {
  const out = []
  const base = new Date()
  base.setHours(0, 0, 0, 0)
  for (let i = 6; i >= 0; i--) {
    const dayStart = base.getTime() - i * DAY
    const dayEnd = dayStart + DAY
    const row = get().prepare("SELECT COALESCE(SUM(actual_min),0) AS m, COUNT(*) AS n FROM pomodoro_session WHERE status = '完成' AND started_at >= ? AND started_at < ?").get(dayStart, dayEnd)
    out.push({ date: dayStart, minutes: row ? row.m : 0, count: row ? row.n : 0 })
  }
  return out
}

function recent(limit) {
  return camelAll(get().prepare('SELECT * FROM pomodoro_session ORDER BY started_at DESC LIMIT ?').all(limit || 5))
}

module.exports = {
  state: readState, start: start, pause: pause, resume: resume, complete: complete,
  abandon: abandon, skipBreak: skipBreak, tick: tick, setTask: setTask,
  config: cfg, saveConfig: function (p) { return withTx(function () { return saveCfg(p) }) },
  stats: stats, weekStats: weekStats, recent: recent,
  endForTask: endForTask, onStateChange: onStateChange
}
