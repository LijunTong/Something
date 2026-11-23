// MCP 工具定义：zod schema 同时用于入参校验与 tools/list 的 inputSchema，避免两套定义漂移。
const { z } = require('zod')
const projectSvc = require('../services/project.cjs')

const itemSchema = z.object({
  key: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(200),
  note: z.string().max(4000).nullable().optional(),
  status: z.enum(['未开始', '进行中', '已完成']).optional(),
  done: z.boolean().optional(),
  priority: z.enum(['低', '中', '高']).optional(),
  dueAt: z.union([z.number().int(), z.string().min(1).max(40)]).nullable().optional(),
  labels: z.array(z.string().min(1).max(40)).max(20).optional(),
  subtasks: z.array(z.object({
    key: z.string().min(1).max(64).optional(),
    title: z.string().min(1).max(200),
    done: z.boolean().optional()
  })).max(30).optional()
})

const projectRef = z.object({
  key: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(80).optional()
})

const writeSchema = z.object({
  project: z.object({
    key: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(80),
    description: z.string().max(2000).optional(),
    color: z.string().max(32).optional(),
    repoPath: z.string().max(500).optional()
  }),
  plan: z.object({
    title: z.string().max(200).optional(),
    summary: z.string().max(2000).optional(),
    version: z.string().max(60).optional(),
    items: z.array(itemSchema).max(300)
  }),
  mode: z.enum(['merge', 'replace']).optional()
})

const readSchema = z.object({ project: projectRef })

const updateSchema = z.object({
  project: projectRef,
  key: z.string().min(1).max(64),
  status: z.enum(['未开始', '进行中', '已完成']).optional(),
  done: z.boolean().optional(),
  note: z.string().max(4000).nullable().optional(),
  priority: z.enum(['低', '中', '高']).optional(),
  dueAt: z.union([z.number().int(), z.string().min(1).max(40)]).nullable().optional(),
  subtask: z.object({
    key: z.string().min(1).max(64).optional(),
    title: z.string().min(1).max(200).optional(),
    done: z.boolean().optional()
  }).optional()
})

/** 生成 inputSchema：去掉 draft 元字段，其余原样交给客户端。 */
function inputSchema(schema) {
  try {
    const out = z.toJSONSchema(schema, { io: 'input' })
    delete out.$schema
    return out
  } catch (e) {
    return { type: 'object', additionalProperties: true }
  }
}

const TOOLS = [
  {
    name: 'project_plan_write',
    title: '写入项目计划',
    description: '把一份项目计划（阶段/任务/子任务）写入应用：项目对应一个清单，计划条目对应待办，subtasks 对应子任务。重复写入同一份计划请保持 item.key 不变，服务端按 key 幂等更新，不会产生重复待办；未显式传入的 status/done/note 不会覆盖用户手动改过的值。mode=replace 时会移除本次未提交、且未被用户完成/投入专注/关联日程的旧条目。',
    schema: writeSchema,
    handler: function (args) { return projectSvc.writePlan(args) }
  },
  {
    name: 'project_plan_read',
    title: '读取项目计划',
    description: '按 project.key 或 project.name 读取项目计划：项目信息、revision、进度统计，以及全部计划条目和子任务（子任务带 done 状态与 key）。写入前可先读一次，确认已有 key 与用户改动。',
    schema: readSchema,
    handler: function (args) { return projectSvc.readPlan(args) }
  },
  {
    name: 'project_plan_item_update',
    title: '更新计划条目',
    description: '更新单个计划条目的状态/完成/优先级/截止时间/备注，或更新/新增其中一个子任务（不存在且带 title 时会创建）。只需传要改的字段；done=true 等价于 status=已完成。',
    schema: updateSchema,
    handler: function (args) { return projectSvc.updatePlanItem(args) }
  },
  {
    name: 'project_plan_list',
    title: '列出项目计划',
    description: '列出本机所有已接入的项目计划：projectKey、清单名、标题、revision、最近写入时间与完成进度。用于确认项目是否已存在，避免重复建清单。',
    schema: z.object({}),
    handler: function () { return { items: projectSvc.listPlans() } }
  }
]

const BY_NAME = {}
TOOLS.forEach(function (t) { BY_NAME[t.name] = t })

/** tools/list 的返回项：只给协议字段。 */
function list() {
  return TOOLS.map(function (t) {
    return { name: t.name, title: t.title, description: t.description, inputSchema: inputSchema(t.schema) }
  })
}

function briefCounts(data) {
  if (!data || typeof data !== 'object') return undefined
  if (data.counts && typeof data.counts === 'object') return data.counts
  if (data.stats && typeof data.stats === 'object') return data.stats
  if (Array.isArray(data.items)) return { items: data.items.length }
  return undefined
}

/** 执行工具：协议错误由 server 处理；这里把业务失败转成 isError 文本。 */
function call(name, args) {
  const tool = BY_NAME[String(name || '')]
  if (!tool) return { text: 'METHOD_NOT_FOUND: 未知工具 ' + name, isError: true }
  const parsed = tool.schema.safeParse(args == null ? {} : args)
  if (!parsed.success) {
    const detail = parsed.error.issues.map(function (i) { return (i.path.join('.') || '(root)') + ': ' + i.message }).join('; ')
    return { text: 'INVALID_ARGS: ' + detail, isError: true }
  }
  try {
    const data = tool.handler(parsed.data)
    return { text: JSON.stringify(data, null, 2), isError: false, data: data, counts: briefCounts(data) }
  } catch (e) {
    const code = (e && e.code) || 'TOOL_FAILED'
    const msg = (e && e.message) || String(e)
    return { text: code + ': ' + msg, isError: true }
  }
}

module.exports = { list: list, call: call, names: TOOLS.map(function (t) { return t.name }) }
