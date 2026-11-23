// 待办领域服务：所有 SQL 与业务规则集中在这里，IPC 层只做校验与转发。
const { get, withTx } = require('../db/conn.cjs')
const { uid, now, camel, camelAll, bool } = require('../db/util.cjs')

const SORTS = { '未开始': 0, '进行中': 1, '已完成': 2, '取消': 3, '归档': 4 }

/** 标签以 JSON 字符串入库；对外统一成数组。 */
function serializeLabels(v) {
  if (v == null) return null
  if (Array.isArray(v)) return v.length ? JSON.stringify(v) : null
  return String(v)
}
function parseLabels(v) {
  if (!v) return []
  try {
    const r = JSON.parse(v)
    return Array.isArray(r) ? r : []
  } catch (e) {
    return []
  }
}

function list(opts) {
  const o = opts || {}
  const where = ['1=1']
  const args = []
  if (o.status) { where.push('t.status = ?'); args.push(o.status) }
  if (o.listId) { where.push('t.list_id = ?'); args.push(o.listId) }
  if (o.priority) { where.push('t.priority = ?'); args.push(o.priority) }
  if (o.onlyPending) where.push("t.status IN ('未开始','进行中')")
  const sql = 'SELECT t.*, l.name AS list_name FROM todo t LEFT JOIN todo_list l ON l.id = t.list_id WHERE ' + where.join(' AND ') + ' ORDER BY t.sort ASC, t.created_at DESC'
  // better-sqlite3 的 all/run 支持直接传数组展开，
  // 不要用 .apply(另一个 statement) —— this 不匹配会抛 Illegal invocation。
  const rows = camelAll(get().prepare(sql).all(...args))
  if (!rows.length) return []
  const ids = rows.map(function (r) { return r.id })
  const marks = ids.map(function () { return '?' }).join(',')
  const subs = camelAll(get().prepare('SELECT * FROM todo_subtask WHERE todo_id IN (' + marks + ') ORDER BY sort ASC').all(...ids))
  const byTodo = {}
  subs.forEach(function (s) { (byTodo[s.todoId] = byTodo[s.todoId] || []).push(s) })
  return rows.map(function (r) { r.subtasks = byTodo[r.id] || []; r.labels = parseLabels(r.labels); return r })
}

function lists() {
  return camelAll(get().prepare('SELECT * FROM todo_list WHERE deleted_at IS NULL ORDER BY sort ASC').all())
}

/** 按名称找清单（忽略大小写与首尾空格）：新建待办时输入的是名字，避免重复建同名清单。 */
function findListByName(name) {
  const n = String(name || '').trim()
  if (!n) return null
  return get().prepare('SELECT * FROM todo_list WHERE deleted_at IS NULL AND lower(name) = lower(?)').get(n) || null
}

/** 内部实现：不开启事务，供已在外层事务中的调用方（如 Agent 计划写入）使用。 */
function createListRaw(dto) {
  const name = String((dto && dto.name) || '').trim()
  if (!name) throw new Error('LIST_NAME_REQUIRED')
  const existed = findListByName(name)
  if (existed) return camel(existed)
  const id = uid('list')
  const max = get().prepare('SELECT COALESCE(MAX(sort),-1) AS m FROM todo_list').get()
  get().prepare('INSERT INTO todo_list (id,name,color,sort) VALUES (?,?,?,?)')
    .run(id, name, (dto && dto.color) || null, (max ? max.m : -1) + 1)
  return camel(get().prepare('SELECT * FROM todo_list WHERE id = ?').get(id))
}

/** 新建清单；同名已存在则直接复用。返回清单行。 */
function createList(dto) {
  return withTx(function () { return createListRaw(dto) })
}

/**
 * 默认清单：删除其它清单时承接里面的待办；标记丢失时退回排序最前的一条。
 * 默认清单只能改名，不能删除（removeList 会拦下）。
 */
function defaultList() {
  const d = get()
  return d.prepare('SELECT * FROM todo_list WHERE deleted_at IS NULL AND is_default = 1 ORDER BY sort ASC LIMIT 1').get()
    || d.prepare('SELECT * FROM todo_list WHERE deleted_at IS NULL ORDER BY sort ASC LIMIT 1').get()
    || null
}

/** 修改清单名称：只改名字，颜色与排序保持不动；默认清单同样允许改名。 */
function updateList(dto) {
  return withTx(function () {
    const name = String((dto && dto.name) || '').trim()
    if (!name) throw new Error('LIST_NAME_REQUIRED')
    const row = get().prepare('SELECT * FROM todo_list WHERE id = ?').get(dto.id)
    if (!row) throw new Error('LIST_NOT_FOUND')
    const dup = get().prepare('SELECT id FROM todo_list WHERE deleted_at IS NULL AND lower(name) = lower(?) AND id <> ?').get(name, dto.id)
    if (dup) throw new Error('LIST_NAME_EXISTS')
    get().prepare('UPDATE todo_list SET name = ? WHERE id = ?').run(name, dto.id)
    return camel(get().prepare('SELECT * FROM todo_list WHERE id = ?').get(dto.id))
  })
}

/**
 * 删除清单：清单下的待办整体迁移到默认清单，不清空数据。
 * 默认清单不允许删除；返回迁移条数与承接方，供渲染层提示。
 */
function removeList(id) {
  return withTx(function () {
    const row = get().prepare('SELECT * FROM todo_list WHERE id = ?').get(id)
    if (!row) throw new Error('LIST_NOT_FOUND')
    if (row.is_default) throw new Error('LIST_IS_DEFAULT')
    const fallback = defaultList()
    if (!fallback) throw new Error('LIST_DEFAULT_MISSING')
    const moved = get().prepare('SELECT COUNT(*) AS n FROM todo WHERE list_id = ?').get(id).n
    get().prepare('UPDATE todo SET list_id = ? WHERE list_id = ?').run(fallback.id, id)
    get().prepare('DELETE FROM todo_list WHERE id = ?').run(id)
    return { list: camel(row), count: moved, defaultList: camel(fallback) }
  })
}

function getOne(id) {
  const row = get().prepare('SELECT * FROM todo WHERE id = ?').get(id)
  if (!row) return null
  const r = camel(row)
  r.subtasks = camelAll(get().prepare('SELECT * FROM todo_subtask WHERE todo_id = ? ORDER BY sort ASC').all(id))
  r.labels = parseLabels(r.labels)
  return r
}

/** 内部实现：不开启事务，供已在外层事务中的调用方使用。 */
function createRaw(dto) {
  const t = now()
  const id = uid('todo')
  // 没指定清单就落到默认清单：快速添加、信息流/日程/快递「转为待办」都不传 listId，
  // 兜底后不会留下「无清单」的待办（侧栏任何清单下都看不到它）。
  const fallbackList = dto.listId ? null : defaultList()
  const listId = dto.listId || (fallbackList ? fallbackList.id : null)
  get().prepare('INSERT INTO todo (id,title,note,list_id,priority,due_at,remind_at,status,recur_rule,source_type,source_ref,labels,schedule_id,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, dto.title, dto.note || null, listId, dto.priority || '中', dto.dueAt || null, dto.remindAt || null, dto.status || '未开始', dto.recurRule || null, dto.sourceType || null, dto.sourceRef || null, serializeLabels(dto.labels), dto.scheduleId || null, dto.sort || 0, t, t)
  if (dto.subtasks && dto.subtasks.length) {
    const ins = get().prepare('INSERT INTO todo_subtask (id,todo_id,title,done,sort) VALUES (?,?,?,?,?)')
    dto.subtasks.forEach(function (s, i) { ins.run(uid('sub'), id, s.title, bool(s.done), i) })
  }
  return getOne(id)
}

function create(dto) {
  return withTx(function () { return createRaw(dto) })
}

/** 内部实现：不开启事务，供已在外层事务中的调用方使用。 */
function updateRaw(dto) {
  const cur = get().prepare('SELECT * FROM todo WHERE id = ?').get(dto.id)
    if (!cur) throw new Error('TODO_NOT_FOUND')
    const fields = []
    const args = []
    const map = { title: 'title', note: 'note', listId: 'list_id', priority: 'priority', dueAt: 'due_at', remindAt: 'remind_at', status: 'status', recurRule: 'recur_rule', sort: 'sort', focusSeconds: 'focus_seconds', scheduleId: 'schedule_id' }
    for (const k in map) {
      if (Object.prototype.hasOwnProperty.call(dto, k)) { fields.push(map[k] + ' = ?'); args.push(dto[k]) }
    }
    // labels 要序列化成 JSON 字符串入库，不能走上面的通用赋值
    if (Object.prototype.hasOwnProperty.call(dto, 'labels')) {
      fields.push('labels = ?')
      args.push(serializeLabels(dto.labels))
    }
    if (dto.status === '已完成' && !cur.done_at) { fields.push('done_at = ?'); args.push(now()) }
    if (dto.status && dto.status !== '已完成') { fields.push('done_at = NULL') }
    if (!fields.length) return getOne(dto.id)
    fields.push('updated_at = ?'); args.push(now()); args.push(dto.id)
    get().prepare('UPDATE todo SET ' + fields.join(', ') + ' WHERE id = ?').run(...args)
  return getOne(dto.id)
}

/**
 * 绑定的待办完成后，番茄钟要跟着收尾。
 * 延后到事务之外再调，避免在写事务里嵌套另一个服务的事务。
 */
function notifyTaskDone(id) {
  setImmediate(function () {
    try { require('./pomodoro.cjs').endForTask(id) } catch (e) { /* 番茄钟收尾失败不影响待办 */ }
  })
}

/** 对外入口：自带事务。 */
function update(dto) {
  // 只在「未完成 → 已完成」这一刻触发，改标题等普通编辑不打扰番茄钟
  const prev = dto && dto.status ? get().prepare('SELECT status FROM todo WHERE id = ?').get(dto.id) : null
  const row = withTx(function () { return updateRaw(dto) })
  if (row && row.status === '已完成' && (!prev || prev.status !== '已完成')) notifyTaskDone(dto.id)
  return row
}

function toggle(id) {
  const row = withTx(function () {
    const cur = get().prepare('SELECT status FROM todo WHERE id = ?').get(id)
    if (!cur) throw new Error('TODO_NOT_FOUND')
    const next = cur.status === '已完成' ? '未开始' : '已完成'
    return updateRaw({ id: id, status: next })
  })
  if (row && row.status === '已完成') notifyTaskDone(id)
  return row
}

function remove(id) {
  withTx(function () {
    get().prepare('DELETE FROM todo WHERE id = ?').run(id)
  })
  // 任务被删掉也算结束，否则计时器会挂在一个不存在的任务上
  notifyTaskDone(id)
  return true
}

function reorder(ids) {
  return withTx(function () {
    const st = get().prepare('UPDATE todo SET sort = ? WHERE id = ?')
    ids.forEach(function (id, i) { st.run(i, id) })
    return true
  })
}

function addSubtask(dto) {
  return withTx(function () {
    const id = uid('sub')
    const max = get().prepare('SELECT COALESCE(MAX(sort),-1) AS m FROM todo_subtask WHERE todo_id = ?').get(dto.todoId)
    get().prepare('INSERT INTO todo_subtask (id,todo_id,title,done,sort) VALUES (?,?,?,?,?)').run(id, dto.todoId, dto.title, 0, (max ? max.m : -1) + 1)
    return getOne(dto.todoId)
  })
}

function toggleSubtask(id) {
  return withTx(function () {
    const row = get().prepare('SELECT * FROM todo_subtask WHERE id = ?').get(id)
    if (!row) throw new Error('SUBTASK_NOT_FOUND')
    get().prepare('UPDATE todo_subtask SET done = ? WHERE id = ?').run(row.done ? 0 : 1, id)
    return getOne(row.todo_id)
  })
}

function stats() {
  const d = get()
  const pending = d.prepare("SELECT COUNT(*) AS n FROM todo WHERE status IN ('未开始','进行中')").get().n
  const done = d.prepare("SELECT COUNT(*) AS n FROM todo WHERE status = '已完成'").get().n
  const overdue = d.prepare("SELECT COUNT(*) AS n FROM todo WHERE status IN ('未开始','进行中') AND due_at IS NOT NULL AND due_at < ?").get(now()).n
  const focus = d.prepare('SELECT COALESCE(SUM(focus_seconds),0) AS s FROM todo').get().s
  return { pending: pending, done: done, overdue: overdue, focusSeconds: focus }
}

module.exports = {
  list: list, lists: lists,
  // Raw 版本不开关事务，供 project.cjs 在自己的事务里复用；其余调用方仍用带事务的入口
  createList: createList, createListRaw: createListRaw, create: create, createRaw: createRaw,
  findListByName: findListByName, defaultList: defaultList, serializeLabels: serializeLabels,
  updateList: updateList, removeList: removeList, get: getOne, update: update, updateRaw: updateRaw,
  toggle: toggle, remove: remove, reorder: reorder, addSubtask: addSubtask, toggleSubtask: toggleSubtask,
  notifyTaskDone: notifyTaskDone, stats: stats
}
