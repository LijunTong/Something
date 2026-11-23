// 项目计划服务：把 Agent 提交的计划幂等写进「清单 + 待办 + 子任务」。
// 约定：项目 = todo_list；计划条目 = todo(source_type='plan', source_ref='<projectKey>:<itemKey>')；
// 子任务 source_ref='<itemKey>:<subtaskKey>'。所有写操作只在这里拼 SQL，且必须走 withTx。
const crypto = require('node:crypto')
const { get, withTx } = require('../db/conn.cjs')
const { uid, now, camel, bool } = require('../db/util.cjs')
const todoSvc = require('./todo.cjs')

const STATUS = ['未开始', '进行中', '已完成']
const PRIORITY = ['低', '中', '高']

function fail(code, message) {
  const e = new Error(message || code)
  e.code = code
  return e
}

function has(o, k) {
  return Object.prototype.hasOwnProperty.call(o || {}, k)
}

/** 缺 key 时按标题派生稳定标识；同一标题重复写入仍是同一条，改标题请显式带 key。 */
function stableKey(text) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return 'item'
  return 'k' + crypto.createHash('sha1').update(s).digest('hex').slice(0, 10)
}

function toTs(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v)
  const t = Date.parse(String(v))
  if (!Number.isFinite(t)) throw fail('DUE_AT_INVALID', 'dueAt 需要毫秒时间戳或 ISO 时间字符串：' + v)
  return t
}

function cleanName(v) {
  return String(v == null ? '' : v).trim()
}

/** 校验并归一化条目数组；key 必须单次唯一（调用方负责限制条数）。 */
function normalizeItems(input) {
  if (!Array.isArray(input)) throw fail('ITEMS_REQUIRED', 'plan.items 必须是数组')
  const seen = new Set()
  return input.map(function (raw, i) {
    const item = raw || {}
    const title = cleanName(item.title)
    if (!title) throw fail('ITEM_TITLE_REQUIRED', '第 ' + (i + 1) + ' 条计划缺少 title')
    const key = item.key ? cleanName(item.key) : stableKey(title)
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(key)) throw fail('ITEM_KEY_INVALID', 'item.key 只能包含字母、数字、. _ : -，且不超过 64 位：' + key)
    if (seen.has(key)) throw fail('ITEM_KEY_DUPLICATE', 'item.key 重复：' + key)
    seen.add(key)
    const status = has(item, 'status') ? String(item.status) : ''
    if (status && STATUS.indexOf(status) < 0) throw fail('STATUS_INVALID', 'status 只能是 未开始 / 进行中 / 已完成：' + status)
    const priority = has(item, 'priority') ? String(item.priority) : ''
    if (priority && PRIORITY.indexOf(priority) < 0) throw fail('PRIORITY_INVALID', 'priority 只能是 低 / 中 / 高：' + priority)
    const subs = []
    if (has(item, 'subtasks')) {
      if (!Array.isArray(item.subtasks)) throw fail('SUBTASKS_INVALID', 'subtasks 必须是数组')
      const subSeen = new Set()
      item.subtasks.forEach(function (rawSub, j) {
        const sub = rawSub || {}
        const subTitle = cleanName(sub.title)
        if (!subTitle) throw fail('SUBTASK_TITLE_REQUIRED', '第 ' + (i + 1) + ' 条计划的子任务 ' + (j + 1) + ' 缺少 title')
        const subKey = sub.key ? cleanName(sub.key) : stableKey(subTitle)
        if (subSeen.has(subKey)) throw fail('SUBTASK_KEY_DUPLICATE', '子任务 key 重复：' + subKey)
        subSeen.add(subKey)
        subs.push({ key: subKey, title: subTitle, done: has(sub, 'done') ? !!sub.done : null })
      })
    }
    return { key: key, title: title, note: has(item, 'note') ? item.note : undefined, status: status || '', done: has(item, 'done') ? !!item.done : null, priority: priority, dueAt: has(item, 'dueAt') ? toTs(item.dueAt) : undefined, labels: has(item, 'labels') ? item.labels : undefined, subtasks: subs, hasSubtasks: has(item, 'subtasks') }
  })
}

/** 已存在的项目定位：不创建任何东西，找不到返回 null。 */
function locate(input) {
  const p = input || {}
  const key = cleanName(p.key)
  const name = cleanName(p.name)
  if (!key && !name) throw fail('PROJECT_REQUIRED', '需要 project.key 或 project.name')
  let plan = null
  if (key) plan = get().prepare('SELECT * FROM project_plan WHERE project_key = ?').get(key) || null
  if (!plan && name) {
    const list = todoSvc.findListByName(name)
    if (list) plan = get().prepare('SELECT * FROM project_plan WHERE list_id = ?').get(list.id) || null
  }
  if (!plan) return null
  const list = get().prepare('SELECT * FROM todo_list WHERE id = ?').get(plan.list_id)
  if (!list || list.deleted_at) return null
  return { plan: plan, list: list }
}

/** 写计划时解析项目：必要时新建清单与绑定；默认清单不能当项目。 */
function ensureProject(input) {
  const p = input || {}
  const key = cleanName(p.key)
  const name = cleanName(p.name)
  if (!name) throw fail('PROJECT_NAME_REQUIRED', 'project.name 必填')
  if (name.length > 80) throw fail('PROJECT_NAME_TOO_LONG', 'project.name 不能超过 80 字')
  if (key && !/^[A-Za-z0-9._-]{1,64}$/.test(key)) throw fail('PROJECT_KEY_INVALID', 'project.key 只能包含字母、数字、. _ -，且不超过 64 位')

  let plan = key ? get().prepare('SELECT * FROM project_plan WHERE project_key = ?').get(key) : null
  let list = plan ? get().prepare('SELECT * FROM todo_list WHERE id = ?').get(plan.list_id) : null
  if (plan && (!list || list.deleted_at)) throw fail('PROJECT_NOT_FOUND', '项目绑定的清单已不存在：' + key)

  if (!plan) {
    list = todoSvc.findListByName(name)
    if (list) {
      if (list.is_default) throw fail('LIST_IS_DEFAULT', '默认清单不能作为 Agent 项目，请给项目起一个独立名称')
      const bound = get().prepare('SELECT * FROM project_plan WHERE list_id = ?').get(list.id)
      if (bound) {
        if (key && bound.project_key !== key) throw fail('PROJECT_KEY_MISMATCH', '清单「' + list.name + '」已绑定项目 ' + bound.project_key)
        plan = bound
      }
    }
  }

  if (!plan) {
    if (!list) {
      list = todoSvc.createListRaw({ name: name, color: p.color || null })
      if (list.isDefault) throw fail('LIST_IS_DEFAULT', '默认清单不能作为 Agent 项目')
    }
    const finalKey = key || 'auto-' + crypto.createHash('sha1').update(name).digest('hex').slice(0, 12)
    const t = now()
    const id = uid('plan')
    get().prepare('INSERT INTO project_plan (id,list_id,project_key,repo_path,title,summary,version,revision,source,last_writer,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, list.id, finalKey, cleanName(p.repoPath) || null, name, null, null, 1, 'mcp', null, t, t)
    plan = get().prepare('SELECT * FROM project_plan WHERE id = ?').get(id)
  } else if (has(p, 'repoPath')) {
    get().prepare('UPDATE project_plan SET repo_path = ? WHERE id = ?').run(cleanName(p.repoPath) || null, plan.id)
    plan = get().prepare('SELECT * FROM project_plan WHERE id = ?').get(plan.id)
  }
  return { plan: plan, list: list }
}

function itemRef(projectKey, itemKey) {
  return projectKey + ':' + itemKey
}

/** 子任务按 source_ref 同步；replace 模式额外清掉本次没提交的 Agent 子任务。 */
function syncSubtasks(todoId, item, mode) {
  const prefix = item.key + ':'
  const kept = new Set()
  item.subtasks.forEach(function (s, i) {
    const ref = prefix + s.key
    kept.add(ref)
    const cur = get().prepare('SELECT * FROM todo_subtask WHERE todo_id = ? AND source_ref = ?').get(todoId, ref)
    if (!cur) {
      get().prepare('INSERT INTO todo_subtask (id,todo_id,title,done,sort,source_ref) VALUES (?,?,?,?,?,?)')
        .run(uid('sub'), todoId, s.title, bool(s.done), i, ref)
    } else {
      const done = s.done == null ? cur.done : bool(s.done)
      get().prepare('UPDATE todo_subtask SET title = ?, done = ?, sort = ? WHERE id = ?').run(s.title, done, i, cur.id)
    }
  })
  if (mode === 'replace') {
    get().prepare('SELECT * FROM todo_subtask WHERE todo_id = ? AND source_ref LIKE ?').all(todoId, prefix + '%').forEach(function (row) {
      if (!kept.has(row.source_ref)) get().prepare('DELETE FROM todo_subtask WHERE id = ?').run(row.id)
    })
  }
}

function todoIdOf(ref) {
  const row = get().prepare('SELECT id FROM todo WHERE source_type = ? AND source_ref = ?').get('plan', ref)
  return row ? row.id : null
}

function writePlan(dto) {
  const input = dto || {}
  const planInput = input.plan || {}
  const items = normalizeItems(planInput.items)
  const mode = input.mode === 'replace' ? 'replace' : 'merge'
  const completed = []
  let deleted = []
  let out = null
  out = withTx(function () {
    const ctx = ensureProject(input.project)
    const plan = ctx.plan
    const prefix = plan.project_key + ':'
    const kept = new Set()
    let created = 0
    let updated = 0

    items.forEach(function (item, index) {
      const ref = prefix + item.key
      kept.add(ref)
      const exists = get().prepare("SELECT * FROM todo WHERE list_id = ? AND source_type = 'plan' AND source_ref = ?").get(ctx.list.id, ref)
      const fields = { title: item.title, sort: index }
      if (item.note !== undefined) fields.note = item.note == null ? null : String(item.note)
      if (item.priority) fields.priority = item.priority
      if (item.dueAt !== undefined) fields.dueAt = item.dueAt
      if (item.labels !== undefined) fields.labels = item.labels
      // status 显式优先；只给 done 时换算成状态，避免出现「done=true 但状态未完成」的脏行
      if (item.status) fields.status = item.status
      else if (item.done != null) fields.status = item.done ? '已完成' : '未开始'

      let todoId = null
      if (!exists) {
        fields.listId = ctx.list.id
        fields.sourceType = 'plan'
        fields.sourceRef = ref
        const row = todoSvc.createRaw(fields)
        todoId = row.id
        created += 1
        if (row.status === '已完成') completed.push(row.id)
      } else {
        fields.id = exists.id
        const row = todoSvc.updateRaw(fields)
        todoId = exists.id
        updated += 1
        if (row.status === '已完成' && exists.status !== '已完成') completed.push(exists.id)
      }
      if (item.hasSubtasks) syncSubtasks(todoId, item, mode)
    })

    if (mode === 'replace' && items.length) {
      get().prepare("SELECT * FROM todo WHERE list_id = ? AND source_type = 'plan' AND source_ref LIKE ? AND status <> '已完成' AND focus_seconds = 0 AND schedule_id IS NULL")
        .all(ctx.list.id, prefix + '%').forEach(function (row) {
          if (kept.has(row.source_ref)) return
          get().prepare('DELETE FROM todo WHERE id = ?').run(row.id)
          deleted.push(row.id)
        })
    }

    const next = {
      title: has(planInput, 'title') ? cleanName(planInput.title) || null : plan.title,
      summary: has(planInput, 'summary') ? cleanName(planInput.summary) || null : plan.summary,
      version: has(planInput, 'version') ? cleanName(planInput.version) || null : plan.version
    }
    const repoPath = has(input.project, 'repoPath') ? cleanName(input.project.repoPath) || null : plan.repo_path
    get().prepare('UPDATE project_plan SET title = ?, summary = ?, version = ?, repo_path = ?, revision = revision + 1, last_writer = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.summary, next.version, repoPath, 'mcp', now(), plan.id)
    const fresh = get().prepare('SELECT * FROM project_plan WHERE id = ?').get(plan.id)
    return { ctx: ctx, plan: fresh, created: created, updated: updated, deleted: deleted.slice(), total: items.length }
  })

  completed.forEach(function (id) { try { todoSvc.notifyTaskDone(id) } catch (e) { /* 番茄钟收尾失败不影响计划写入 */ } })
  deleted.forEach(function (id) { try { todoSvc.notifyTaskDone(id) } catch (e) { /* 同上 */ } })

  const list = get().prepare('SELECT * FROM todo_list WHERE id = ?').get(out.ctx.list.id)
  return {
    project: { key: out.plan.project_key, name: list ? list.name : '', listId: out.ctx.list.id, repoPath: out.plan.repo_path || null },
    plan: { title: out.plan.title || (list ? list.name : ''), summary: out.plan.summary || null, version: out.plan.version || null, revision: out.plan.revision, updatedAt: out.plan.updated_at },
    mode: mode,
    counts: { items: out.total, created: out.created, updated: out.updated, removed: out.deleted.length }
  }
}

function subtaskView(row, itemKey) {
  const ref = String(row.source_ref || '')
  const key = ref.indexOf(itemKey + ':') === 0 ? ref.slice(itemKey.length + 1) : (ref || row.id)
  return { key: key, title: row.title, done: !!row.done, id: row.id }
}

function itemView(row, projectKey) {
  const ref = String(row.source_ref || '')
  const key = ref.indexOf(projectKey + ':') === 0 ? ref.slice(projectKey.length + 1) : (ref || row.id)
  return {
    key: key,
    todoId: row.id,
    title: row.title,
    note: row.note || null,
    status: row.status,
    done: row.status === '已完成',
    priority: row.priority,
    dueAt: row.due_at == null ? null : row.due_at,
    labels: row.labels || [],
    subtasks: []
  }
}

function readPlan(dto) {
  const ctx = locate(dto && dto.project)
  if (!ctx) throw fail('PROJECT_NOT_FOUND', '找不到对应的 Agent 项目')
  const list = camel(ctx.list)
  const rows = todoSvc.list({ listId: ctx.list.id }).filter(function (r) { return r.sourceType === 'plan' })
  const items = rows.map(function (r) { return itemView({ id: r.id, title: r.title, note: r.note, status: r.status, priority: r.priority, due_at: r.dueAt, labels: r.labels, source_ref: r.sourceRef }, ctx.plan.project_key) })
  const subsBy = {}
  if (rows.length) {
    const marks = rows.map(function () { return '?' }).join(',')
    const subs = get().prepare('SELECT * FROM todo_subtask WHERE todo_id IN (' + marks + ') AND source_ref IS NOT NULL ORDER BY sort ASC').all(...rows.map(function (r) { return r.id }))
    subs.forEach(function (s) { (subsBy[s.todo_id] = subsBy[s.todo_id] || []).push(s) })
  }
  items.forEach(function (item) { item.subtasks = (subsBy[item.todoId] || []).map(function (s) { return subtaskView(s, item.key) }) })
  const total = items.length
  const done = items.filter(function (i) { return i.status === '已完成' }).length
  return {
    project: { key: ctx.plan.project_key, name: list.name, listId: list.id, repoPath: ctx.plan.repo_path || null },
    plan: { title: ctx.plan.title || list.name, summary: ctx.plan.summary || null, version: ctx.plan.version || null, revision: ctx.plan.revision, updatedAt: ctx.plan.updated_at, lastWriter: ctx.plan.last_writer || null },
    stats: { total: total, done: done, inProgress: items.filter(function (i) { return i.status === '进行中' }).length, pending: total - done },
    items: items
  }
}

function updatePlanItem(dto) {
  const input = dto || {}
  const ctx = locate(input.project)
  if (!ctx) throw fail('PROJECT_NOT_FOUND', '找不到对应的 Agent 项目')
  const key = cleanName(input.key)
  if (!key) throw fail('ITEM_KEY_REQUIRED', '需要 item.key')
  const ref = itemRef(ctx.plan.project_key, key)
  const row = get().prepare("SELECT * FROM todo WHERE list_id = ? AND source_type = 'plan' AND source_ref = ?").get(ctx.list.id, ref)
  if (!row) throw fail('ITEM_NOT_FOUND', '找不到计划条目：' + key)
  if (has(input, 'status') && STATUS.indexOf(String(input.status)) < 0) throw fail('STATUS_INVALID', 'status 只能是 未开始 / 进行中 / 已完成')
  if (has(input, 'priority') && PRIORITY.indexOf(String(input.priority)) < 0) throw fail('PRIORITY_INVALID', 'priority 只能是 低 / 中 / 高')

  let completedId = null
  let out = null
  out = withTx(function () {
    const fields = { id: row.id }
    if (has(input, 'status')) fields.status = String(input.status)
    else if (has(input, 'done')) fields.status = input.done ? '已完成' : '未开始'
    if (has(input, 'note')) fields.note = input.note == null ? null : String(input.note)
    if (has(input, 'priority')) fields.priority = String(input.priority)
    if (has(input, 'dueAt')) fields.dueAt = toTs(input.dueAt)
    const updated = todoSvc.updateRaw(fields)
    if (updated.status === '已完成' && row.status !== '已完成') completedId = row.id

    const sub = input.subtask
    if (sub) {
      const subKey = cleanName(sub.key) || stableKey(sub.title)
      const subRef = key + ':' + subKey
      const cur = get().prepare('SELECT * FROM todo_subtask WHERE todo_id = ? AND source_ref = ?').get(row.id, subRef)
      if (!cur) {
        if (!cleanName(sub.title)) throw fail('SUBTASK_NOT_FOUND', '子任务不存在且没有 title，无法新建：' + subKey)
        get().prepare('INSERT INTO todo_subtask (id,todo_id,title,done,sort,source_ref) VALUES (?,?,?,?,?,?)')
          .run(uid('sub'), row.id, cleanName(sub.title), bool(sub.done), 999, subRef)
      } else {
        const title = has(sub, 'title') && cleanName(sub.title) ? cleanName(sub.title) : cur.title
        const done = has(sub, 'done') ? bool(sub.done) : cur.done
        get().prepare('UPDATE todo_subtask SET title = ?, done = ? WHERE id = ?').run(title, done, cur.id)
      }
    }
    get().prepare('UPDATE project_plan SET updated_at = ? WHERE id = ?').run(now(), ctx.plan.id)
    return updated
  })
  if (completedId) { try { todoSvc.notifyTaskDone(completedId) } catch (e) { /* 同上 */ } }
  const list = get().prepare('SELECT * FROM todo_list WHERE id = ?').get(ctx.list.id)
  return {
    project: { key: ctx.plan.project_key, name: list ? list.name : '', listId: ctx.list.id },
    item: { key: key, todoId: out.id, title: out.title, status: out.status, done: out.status === '已完成', priority: out.priority, dueAt: out.dueAt, note: out.note }
  }
}

function planMeta(listId) {
  const plan = get().prepare('SELECT * FROM project_plan WHERE list_id = ?').get(String(listId || ''))
  if (!plan) return null
  const list = get().prepare('SELECT * FROM todo_list WHERE id = ?').get(plan.list_id)
  const rows = get().prepare("SELECT status FROM todo WHERE list_id = ? AND source_type = 'plan'").all(plan.list_id)
  const total = rows.length
  const done = rows.filter(function (r) { return r.status === '已完成' }).length
  return {
    listId: plan.list_id,
    projectKey: plan.project_key,
    title: plan.title || (list ? list.name : ''),
    summary: plan.summary || null,
    version: plan.version || null,
    revision: plan.revision,
    updatedAt: plan.updated_at,
    source: plan.source,
    lastWriter: plan.last_writer || null,
    repoPath: plan.repo_path || null,
    total: total,
    done: done
  }
}

function listPlans() {
  const rows = get().prepare('SELECT p.*, l.name AS list_name FROM project_plan p LEFT JOIN todo_list l ON l.id = p.list_id WHERE l.deleted_at IS NULL ORDER BY p.updated_at DESC').all()
  return rows.map(function (p) {
    const counts = get().prepare("SELECT status, COUNT(*) AS n FROM todo WHERE list_id = ? AND source_type = 'plan' GROUP BY status").all(p.list_id)
    let total = 0
    let done = 0
    counts.forEach(function (c) { total += c.n; if (c.status === '已完成') done += c.n })
    return {
      projectKey: p.project_key,
      listId: p.list_id,
      name: p.list_name,
      title: p.title || p.list_name,
      summary: p.summary || null,
      version: p.version || null,
      revision: p.revision,
      updatedAt: p.updated_at,
      repoPath: p.repo_path || null,
      total: total,
      done: done
    }
  })
}

module.exports = {
  writePlan: writePlan,
  readPlan: readPlan,
  updatePlanItem: updatePlanItem,
  planMeta: planMeta,
  listPlans: listPlans
}
