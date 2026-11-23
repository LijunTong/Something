// 快递领域服务：单号登记、公司识别、轨迹读取、真实物流接口刷新与取件待办素材。
// 轨迹只来自真实物流接口；未选择数据源（manual）时绝不编造轨迹或推进状态。
// 所有 SQL 只写在 service 里；写操作统一包 withTx，嵌套用内部 Raw 避免重复开事务。
const { get, withTx } = require('../db/conn.cjs')
const { uid, now, camel, camelAll, bool } = require('../db/util.cjs')
const logger = require('../log/logger.cjs')
const settings = require('./settings.cjs')
const parcelApi = require('./parcelApi.cjs')

// 快递公司目录：各数据源的编码不一样，刷新时按当前数据源现算；prefixes 供单号自动识别
const COMPANY_CATALOG = [
  { name: '顺丰速运', short: 'SF', prefixes: ['SF'], kuaidi100: 'shunfeng', kdniao: 'SF', juhe: 'sf' },
  { name: '中通快递', short: 'ZT', prefixes: ['ZT', 'ZTO'], kuaidi100: 'zhongtong', kdniao: 'ZTO', juhe: 'zto' },
  { name: '圆通速递', short: 'YT', prefixes: ['YT', 'YTO'], kuaidi100: 'yuantong', kdniao: 'YTO', juhe: 'yto' },
  { name: '申通快递', short: 'ST', prefixes: ['STO', 'ST'], kuaidi100: 'shentong', kdniao: 'STO', juhe: 'sto' },
  { name: '韵达速递', short: 'YD', prefixes: ['YD'], kuaidi100: 'yunda', kdniao: 'YD', juhe: 'yd' },
  { name: '京东物流', short: 'JD', prefixes: ['JD', 'JDV'], kuaidi100: 'jd', kdniao: 'JD', juhe: 'jd' },
  { name: '邮政EMS', short: 'EMS', prefixes: ['EMS', 'YZ'], kuaidi100: 'ems', kdniao: 'EMS', juhe: 'ems' },
  { name: '极兔速递', short: 'JT', prefixes: ['JT'], kuaidi100: 'jtexpress', kdniao: 'JTSD', juhe: 'jt' },
  { name: '百世快递', short: 'HT', prefixes: ['HT'], kuaidi100: 'huitongkuaidi', kdniao: 'HTKY', juhe: 'huitong' },
  { name: '德邦快递', short: 'DB', prefixes: ['DB'], kuaidi100: 'debangwuliu', kdniao: 'DBL', juhe: 'debang' }
]

const UNKNOWN_COMPANY = '其他快递'

function findCompany(name) {
  const key = String(name || '').trim()
  for (const c of COMPANY_CATALOG) if (c.name === key) return c
  return null
}

/** 按单号前缀识别快递公司，未知前缀归为其他快递。匹配前统一转大写。 */
function detectCompany(no) {
  const s = String(no || '').trim().toUpperCase()
  if (!s) return UNKNOWN_COMPANY
  for (const c of COMPANY_CATALOG) {
    for (const prefix of c.prefixes) if (s.startsWith(prefix)) return c.name
  }
  return UNKNOWN_COMPANY
}

/** 当前数据源下的快递公司编码；识别不出公司时返回空串，由接口层给出中文提示。 */
function codeFor(provider, company) {
  const entry = findCompany(company)
  if (!entry || !provider) return ''
  return String(entry[provider] || '')
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

/** 当前快递配置：数据源与自动刷新间隔（分钟，0 表示不自动刷新）。 */
function providerConfig() {
  const raw = settings.get('parcel') || {}
  return {
    provider: String(raw.provider || 'manual'),
    autoRefreshMin: Number(raw.autoRefreshMin || 0),
    detectCompany: raw.detectCompany !== false
  }
}

/** 把接口归一化结果写回包裹与轨迹；同一条轨迹按 (node_time, description) 判重。 */
function applyResult(row, provider, courierCode, phoneTail, result) {
  const t = now()
  const seen = new Set()
  get().prepare('SELECT node_time, description FROM parcel_track WHERE parcel_id = ?').all(row.id).forEach(function (item) {
    seen.add(item.node_time + '|' + item.description)
  })
  const insTrack = get().prepare('INSERT INTO parcel_track (id,parcel_id,node_time,description,location) VALUES (?,?,?,?,?)')
  let added = 0
  ;(result.traces || []).forEach(function (trace) {
    const key = trace.nodeTime + '|' + String(trace.description || '')
    if (seen.has(key)) return
    seen.add(key)
    insTrack.run(uid('track'), row.id, trace.nodeTime, trace.description, trace.location || null)
    added += 1
  })
  // 状态只前进不后退：接口偶发把已签收的包裹报成在途时，保留更高的状态
  const rank = parcelApi.STATUS_RANK
  const prevStatus = String(row.status || '在途')
  const nextStatus = String(result.status || prevStatus)
  const status = (rank[nextStatus] || 0) >= (rank[prevStatus] || 0) ? nextStatus : prevStatus
  const statusChanged = status !== prevStatus
  const pickupCode = result.pickupCode || row.pickup_code || null
  const station = result.station || row.station || null
  // 没有新轨迹也没有状态变化的重复刷新不动 updated_at，页面「超 48 小时无更新」才准
  const updatedAt = added || statusChanged ? t : row.updated_at
  get().prepare('UPDATE parcel SET status = ?, pickup_code = ?, station = ?, provider = ?, courier_code = ?, phone_tail = ?, provider_state = ?, last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ?')
    .run(status, pickupCode, station, provider, courierCode || null, phoneTail || null, result.state || null, t, updatedAt, row.id)
  return { added: added, statusChanged: statusChanged }
}

/** 失败留痕：只写数据源/时间/原因，不动状态与轨迹。 */
function saveFailure(id, provider, code, message) {
  const detail = String(code || 'PROVIDER_ERROR') + '|' + String(message || '查询失败')
  get().prepare('UPDATE parcel SET provider = ?, last_sync_at = ?, last_error = ? WHERE id = ?').run(provider, now(), detail, id)
}

/** 内部实现：单号去重、识别公司、写包裹；不生成轨迹，也不编造取件码。 */
function addRaw(dto) {
  const d = dto || {}
  const numbers = Array.isArray(d.numbers) ? d.numbers : []
  const cfg = providerConfig()
  const t = now()
  const created = []
  const insParcel = get().prepare('INSERT INTO parcel (id,company,tracking_no,alias,note,status,pickup_code,station,eta_at,archived,privacy_masked,created_at,updated_at,courier_code,phone_tail,provider) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const existsSt = get().prepare('SELECT 1 FROM parcel WHERE tracking_no = ?')
  const oneSt = get().prepare('SELECT * FROM parcel WHERE id = ?')
  // 用户在添加抽屉里手选了快递公司就按它来，否则按单号前缀识别
  const picked = findCompany(d.company) ? String(d.company) : ''
  const phoneTail = String(d.phoneTail || '').trim() || null

  numbers.forEach(function (raw) {
    const no = String(raw == null ? '' : raw).trim()
    if (!no) return
    if (existsSt.get(no)) return // tracking_no 已存在则跳过，避免 UNIQUE 冲突
    const id = uid('parcel')
    const company = picked || detectCompany(no)
    const courierCode = codeFor(cfg.provider, company) || null
    // 只登记单号与公司：状态、取件码、到达时间都等真实物流接口返回后再写
    insParcel.run(id, company, no, d.alias || null, d.note || null,
      '在途', null, null, null, 0, 1, t, t, courierCode, phoneTail, cfg.provider)
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

/** 刷新入参兼容旧版：后端老调用只传 id 字符串，新版可带手选公司与手机号后四位。 */
function normalizeRefresh(dto) {
  if (typeof dto === 'string') return { id: dto, company: undefined, phoneTail: undefined }
  const d = dto || {}
  return {
    id: String(d.id || ''),
    company: d.company === undefined || d.company === null ? undefined : String(d.company),
    phoneTail: d.phoneTail === undefined || d.phoneTail === null ? undefined : String(d.phoneTail)
  }
}

/**
 * 刷新单个包裹：调当前数据源查真实轨迹，写回轨迹与状态。
 * 失败不抛异常，返回 { error: { code, message } }，由页面就地提示；
 * 失败同时写进 last_error，重启后仍能看到上次失败原因。
 */
async function refresh(dto) {
  const input = normalizeRefresh(dto)
  const cfg = providerConfig()
  const provider = cfg.provider
  let row = null
  try {
    row = get().prepare('SELECT * FROM parcel WHERE id = ?').get(input.id)
    if (!row) return { parcel: null, provider: provider, added: 0, statusChanged: false, error: { code: 'PARCEL_NOT_FOUND', message: '包裹不存在，可能已被删除' } }

    // 手选的快递公司与手机号后四位先落库：下次刷新、以及「首次填错再改」都不用重复输入
    const company = input.company === undefined ? String(row.company || '') : input.company
    const phoneTail = input.phoneTail === undefined ? String(row.phone_tail || '') : input.phoneTail
    const courierCode = codeFor(provider, company)
    if (company !== row.company || phoneTail !== String(row.phone_tail || '') || courierCode !== String(row.courier_code || '')) {
      withTx(function () {
        get().prepare('UPDATE parcel SET company = ?, phone_tail = ?, courier_code = ?, provider = ? WHERE id = ?')
          .run(company, phoneTail || null, courierCode || null, provider, row.id)
      })
      row = get().prepare('SELECT * FROM parcel WHERE id = ?').get(row.id)
    }

    if (provider === 'manual') {
      // 手动维护模式：明确告诉用户去选数据源，不假装刷新成功
      const message = '当前是手动维护模式：到「数据源」里选择快递接口后即可自动查询轨迹'
      saveFailure(row.id, provider, 'NO_PROVIDER', message)
      return { parcel: detail(row.id), provider: provider, added: 0, statusChanged: false, error: { code: 'NO_PROVIDER', message: message } }
    }

    const credential = settings.readParcelCredential(provider)
    const result = await parcelApi.query({
      provider: provider,
      credential: credential,
      no: row.tracking_no,
      code: courierCode,
      phone: phoneTail
    })
    const write = withTx(function () { return applyResult(row, provider, courierCode, phoneTail, result) })
    return { parcel: detail(row.id), provider: provider, added: write.added, statusChanged: write.statusChanged, error: null }
  } catch (err) {
    const code = String((err && err.code) || 'PROVIDER_ERROR')
    const message = String((err && err.message) || '查询失败')
    logger.warn('parcel', '刷新快递失败', { id: input.id, provider: provider, code: code })
    if (row) {
      try { saveFailure(row.id, provider, code, message) } catch (e) { /* 留痕失败不影响把错误返回给页面 */ }
    }
    return { parcel: row ? detail(row.id) : null, provider: provider, added: 0, statusChanged: false, error: { code: code, message: message } }
  }
}

/** 并发闸门：同时最多 limit 个在飞，避免一次性把接口配额打满。 */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length)
  let cursor = 0
  const runners = []
  const size = Math.max(1, Math.min(limit, items.length || 1))
  for (let i = 0; i < size; i += 1) {
    runners.push((async function () {
      while (cursor < items.length) {
        const index = cursor
        cursor += 1
        out[index] = await worker(items[index], index)
      }
    })())
  }
  await Promise.all(runners)
  return out
}

/** 批量刷新：默认只刷未签收的（已签收不会再变），force 为真时全部刷。 */
async function refreshAll(dto) {
  const opts = dto || {}
  const rows = get().prepare('SELECT id, status FROM parcel WHERE archived = 0').all()
  const targets = opts.force ? rows : rows.filter(function (r) { return r.status !== '已签收' })
  if (!targets.length) return { total: 0, added: 0, changed: 0, failed: 0, provider: providerConfig().provider }
  const results = await mapLimit(targets, 3, function (r) { return refresh(r.id) })
  let added = 0
  let changed = 0
  let failed = 0
  const errors = []
  results.forEach(function (r) {
    added += r.added || 0
    if (r.statusChanged) changed += 1
    if (r.error) {
      failed += 1
      if (errors.length < 3 && errors.indexOf(r.error.message) < 0) errors.push(r.error.message)
    }
  })
  return { total: results.length, added: added, changed: changed, failed: failed, provider: providerConfig().provider, errors: errors }
}

/** 数据源清单 + 各自凭据填写状态，供设置面板动态渲染表单，不返回任何明文凭据。 */
function providers() {
  const cfg = providerConfig()
  const status = settings.parcelStatus() || {}
  const creds = status.credentials || {}
  return parcelApi.PROVIDERS.map(function (item) {
    const cred = creds[item.id] || { set: false, filled: [], hints: {} }
    return {
      id: item.id,
      name: item.name,
      site: item.site,
      desc: item.desc,
      fields: item.fields,
      active: cfg.provider === item.id,
      // 手动模式无需配置；其余数据源填齐必填字段才算可用
      configured: item.id === 'manual' ? true : Boolean(cred.set),
      filled: cred.filled || [],
      hints: cred.hints || {}
    }
  })
}

/** 快递公司选项：新增包裹时可手选，默认让用户用「自动识别」。 */
function companies() {
  return COMPANY_CATALOG.map(function (c) { return { name: c.name, short: c.short } })
}

/** 测试数据源：可选传一个真实单号实际查一次，不写库。 */
async function testProvider(dto) {
  const d = dto || {}
  const provider = String(d.provider || providerConfig().provider)
  if (!parcelApi.providerById(provider)) return { ok: false, code: 'PROVIDER_ERROR', message: '未知的数据源：' + provider }
  if (provider === 'manual') return { ok: false, code: 'NO_PROVIDER', message: '手动维护模式不调用任何接口' }
  const no = String(d.no || '').trim()
  if (!no) return { ok: false, code: 'TRACKING_NOT_FOUND', message: '填一个真实的快递单号再测试，否则无法验证签名与返回格式' }
  const saved = settings.readParcelCredential(provider) || {}
  const typeValues = d.values && typeof d.values === 'object' ? d.values : {}
  const credential = Object.assign({}, saved, typeValues)
  const company = findCompany(d.company) ? String(d.company) : detectCompany(no)
  try {
    const result = await parcelApi.query({
      provider: provider,
      credential: credential,
      no: no,
      code: codeFor(provider, company),
      phone: String(d.phoneTail || '')
    })
    return {
      ok: true,
      code: 'OK',
      message: '接口已连通，返回 ' + result.traces.length + ' 条轨迹（识别状态：' + result.status + '）',
      company: company,
      status: result.status,
      traces: result.traces.length
    }
  } catch (err) {
    return { ok: false, code: String((err && err.code) || 'PROVIDER_ERROR'), message: String((err && err.message) || '测试失败') }
  }
}

/** 归档：不删轨迹，只从默认列表里收起来。 */
function archive(id) {
  const key = typeof id === 'string' ? id : String((id && id.id) || '')
  try {
    withTx(function () {
      get().prepare('UPDATE parcel SET archived = 1, updated_at = ? WHERE id = ?').run(now(), key)
    })
    return detail(key)
  } catch (err) {
    logger.error('parcel', '归档快递失败', err, { id: key })
    throw err
  }
}

/** 隐私模式：单条开关，masked 为真时列表隐藏单号中间段。 */
function togglePrivacy(dto) {
  const d = dto || {}
  const id = String(d.id || '')
  const masked = d.masked ? 1 : 0
  try {
    withTx(function () {
      get().prepare('UPDATE parcel SET privacy_masked = ?, updated_at = ? WHERE id = ?').run(masked, now(), id)
    })
    return detail(id)
  } catch (err) {
    logger.error('parcel', '切换隐私模式失败', err, { id: id })
    throw err
  }
}

/** 生成取件待办的素材：标题、建议截止时间、备注都在这里定，页面不再拼文案。 */
function toTodoInfo(id) {
  const p = get().prepare('SELECT * FROM parcel WHERE id = ?').get(id)
  if (!p) throw new Error('包裹不存在')
  const bits = []
  if (p.pickup_code) bits.push('取件码 ' + p.pickup_code)
  if (p.station) bits.push(p.station)
  if (p.note) bits.push(p.note)
  return {
    title: '取' + p.company + '快递',
    dueAt: p.eta_at || null,
    note: bits.join(' · ') || null
  }
}

/** 单条详情：页面抽屉与刷新返回共用同一形状。 */
function detail(id) {
  try {
    return camel(get().prepare('SELECT * FROM parcel WHERE id = ?').get(id))
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
  refreshAll: refreshAll,
  tracks: tracks,
  archive: archive,
  togglePrivacy: togglePrivacy,
  toTodoInfo: toTodoInfo,
  companies: companies,
  providers: providers,
  testProvider: testProvider,
  detectCompany: detectCompany
}


