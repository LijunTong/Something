// 快递领域服务：单号登记、公司识别、轨迹读取与取件待办素材。
// 不生成任何本地模拟轨迹：轨迹只来自真实物流接口（当前未接入，刷新不会改变状态）。
// 所有 SQL 只写在 service 里；写操作统一包 withTx，嵌套用内部 Raw 避免重复开事务。
const { get, withTx } = require('../db/conn.cjs')
const { uid, now, camel, camelAll, bool } = require('../db/util.cjs')
const logger = require('../log/logger.cjs')

// 单号前缀 → 快递公司。匹配前统一转大写，兼容用户输入小写前缀。
const COMPANIES = [
  { prefix: 'SF', name: '顺丰速运' },
  { prefix: 'ZT', name: '中通快递' },
  { prefix: 'JD', name: '京东物流' },
  { prefix: 'YT', name: '圆通速递' }
]


/** 按单号前缀识别快递公司，未知前缀归为其他快递。 */
function detectCompany(no) {
  const s = String(no || '').trim().toUpperCase()
  for (const c of COMPANIES) if (s.startsWith(c.prefix)) return c.name
  return '其他快递'
}

/** 列表：可选按状态、归档标记过滤。archived 入参是布尔，入库前用 bool 转 0/1。 */
function list(filter) {
  try {
    const f = filter || {}
    const where = []
    const args = []
    if (f.status) { where.push('status = ?'); args.push(f.status) }
    if (typeof f.archived === 'boolean') { where.push('archived = ?'); args.push(bool(f.archived)) }
    const sql = 'SELECT * FROM parcel' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY archived ASC, created_at DESC'
    // better-sqlite3 的 all/run 一律用 ...args 展开；禁止 .apply(另一个 prepare 结果)，会抛 Illegal invocation。
    return camelAll(get().prepare(sql).all(...args))
  } catch (err) {
    logger.error('parcel', '查询快递列表失败', err, { filter: filter })
    throw err
  }
}

/** 轨迹数组：新的在前，与原型「最新」标签一致。camelAll 自动转 parcelId/nodeTime。 */
function tracks(id) {
  try {
    return camelAll(get().prepare('SELECT * FROM parcel_track WHERE parcel_id = ? ORDER BY node_time DESC').all(id))
  } catch (err) {
    logger.error('parcel', '查询快递轨迹失败', err, { id: id })
    throw err
  }
}

/** 内部实现：单号去重、识别公司、写包裹；不生成轨迹，也不编造取件码。 */
function addRaw(dto) {
  const d = dto || {}
  const numbers = Array.isArray(d.numbers) ? d.numbers : []
  const t = now()
  const created = []
  const insParcel = get().prepare('INSERT INTO parcel (id,company,tracking_no,alias,note,status,pickup_code,station,eta_at,archived,privacy_masked,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const existsSt = get().prepare('SELECT 1 FROM parcel WHERE tracking_no = ?')
  const oneSt = get().prepare('SELECT * FROM parcel WHERE id = ?')

  numbers.forEach(function (raw) {
    const no = String(raw == null ? '' : raw).trim()
    if (!no) return
    if (existsSt.get(no)) return // tracking_no 已存在则跳过，避免 UNIQUE 冲突
    const id = uid('parcel')
    // 只登记单号与公司：状态、取件码、到达时间都等真实物流接口返回后再写
    insParcel.run(id, detectCompany(no), no, d.alias || null, d.note || null,
      '在途', null, null, null, 0, 1, t, t)
    created.push(oneSt.get(id))
  })
  return camelAll(created)
}

/** 新增：整批包裹在单个事务内完成，已存在的单号自动跳过。 */
function add(dto) {
  const count = dto && Array.isArray(dto.numbers) ? dto.numbers.length : 0
  try {
    return withTx(function () { return addRaw(dto) })
  } catch (err) {
    logger.error('parcel', '新增快递失败', err, { count: count })
    throw err
  }
}

/**
 * 刷新：当前没有接入物流查询接口，不能编造轨迹或推进状态。
 * 这里只回读一次包裹行，保证 UI 的刷新动作不报错，并在日志里留痕。
 */
function refreshRaw(id) {
  const p = get().prepare('SELECT * FROM parcel WHERE id = ?').get(id)
  if (!p) throw new Error('PARCEL_NOT_FOUND')
  logger.warn('parcel', 'refresh_without_provider', { id: id })
  return camel(p)
}

/** 刷新：无外部数据源时不改状态，仅回读。 */
function refresh(id) {
  try {
    return withTx(function () { return refreshRaw(id) })
  } catch (err) {
    logger.error('parcel', '刷新快递失败', err, { id: id })
    throw err
  }
}

/** 归档：置 archived=1。 */
function archive(id) {
  try {
    return withTx(function () {
      const r = get().prepare('UPDATE parcel SET archived = 1, updated_at = ? WHERE id = ?').run(now(), id)
      if (!r.changes) throw new Error('PARCEL_NOT_FOUND')
      return true
    })
  } catch (err) {
    logger.error('parcel', '归档快递失败', err, { id: id })
    throw err
  }
}

/** 隐私开关：masked 为布尔，入库用 bool 转 0/1，返回新状态。 */
function togglePrivacy(dto) {
  try {
    const d = dto || {}
    return withTx(function () {
      const v = bool(d.masked)
      const r = get().prepare('UPDATE parcel SET privacy_masked = ?, updated_at = ? WHERE id = ?').run(v, now(), d.id)
      if (!r.changes) throw new Error('PARCEL_NOT_FOUND')
      return !!v
    })
  } catch (err) {
    logger.error('parcel', '切换隐私状态失败', err, { id: dto && dto.id })
    throw err
  }
}

/** 取件待办素材：只返回标题/到期/备注，不写 todo 表，由渲染层决定如何创建待办。 */
function toTodoInfo(id) {
  try {
    const p = get().prepare('SELECT * FROM parcel WHERE id = ?').get(id)
    if (!p) throw new Error('PARCEL_NOT_FOUND')
    const parts = ['快递单号 ' + p.tracking_no]
    if (p.pickup_code) parts.push('取件码 ' + p.pickup_code)
    if (p.station) parts.push(p.station)
    return { title: '取' + p.company + '快递', dueAt: p.eta_at || null, note: parts.join('；') }
  } catch (err) {
    logger.error('parcel', '生成取件待办素材失败', err, { id: id })
    throw err
  }
}

/** 单条：仪表盘深链定位用（/parcel?focus=<id>）。查不到返回 null，由渲染层提示「已不存在」。 */
function detail(id) {
  try {
    const row = get().prepare('SELECT * FROM parcel WHERE id = ?').get(id)
    return row ? camel(row) : null
  } catch (err) {
    logger.error('parcel', '查询快递详情失败', err, { id: id })
    throw err
  }
}

module.exports = {
  list: list,
  get: detail,
  add: add,
  refresh: refresh,
  tracks: tracks,
  archive: archive,
  togglePrivacy: togglePrivacy,
  toTodoInfo: toTodoInfo
}