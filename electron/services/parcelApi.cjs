// 快递查询适配层：只负责网络请求、签名与字段归一化。
// 约束：不读设置、不读写数据库，凭据由调用方传入；不做自动重试，失败以 code 抛给上层。
const crypto = require('node:crypto')

const TIMEOUT_MS = 8000

/** 状态优先级：刷新时只允许向前推进，不允许从「已签收」退回「在途」 */
const STATUS_RANK = { 在途: 0, 派送中: 1, 待取件: 2, 已签收: 3 }

// 数据源清单：fields 决定设置面板渲染哪些输入框，secret 字段用密码框
const PROVIDERS = [
  {
    id: 'manual',
    name: '手动维护',
    site: '',
    desc: '不调用任何物流接口，单号、状态与轨迹都由你自己维护',
    fields: []
  },
  {
    id: 'kuaidi100',
    name: '快递100',
    site: 'https://www.kuaidi100.com/',
    desc: '实时查询接口，需要 Customer 编码与授权 Key；查询时要能识别出快递公司',
    fields: [
      { key: 'customer', label: 'Customer 编码', placeholder: '快递100 后台的顾客编码', secret: false },
      { key: 'key', label: '授权 Key', placeholder: '快递100 后台的授权 Key', secret: true }
    ]
  },
  {
    id: 'kdniao',
    name: '快递鸟',
    site: 'https://www.kdniao.com/',
    desc: '即时查询接口，需要 EBusinessID 与 AppKey；顺丰等快递要填收件人手机号后四位',
    fields: [
      { key: 'ebusinessId', label: 'EBusinessID', placeholder: '快递鸟的用户 ID', secret: false },
      { key: 'appKey', label: 'AppKey', placeholder: '快递鸟的 AppKey', secret: true }
    ]
  },
  {
    id: 'juhe',
    name: '聚合数据',
    site: 'https://www.juhe.cn/docs/api/id/43',
    desc: '快递查询接口，只需要一个 API Key，按查询次数计费',
    fields: [
      { key: 'key', label: 'API Key', placeholder: '聚合数据后台的 API Key', secret: true }
    ]
  }
]

function providerById(id) {
  const key = String(id || '')
  for (const item of PROVIDERS) if (item.id === key) return item
  return null
}

function buildError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** 按接口返回的中文原因归类，前端据此给不同提示 */
function classifyMessage(message) {
  const text = String(message || '')
  if (/签名|授权|appkey|customer|用户不存在|未开通|权限|认证|key/i.test(text)) return 'AUTH'
  if (/余额|次数|额度|超过|限制|quota/i.test(text)) return 'QUOTA'
  if (/无结果|无轨迹|不存在|找不到|暂无|没有查到|单号错误|查无/i.test(text)) return 'TRACKING_NOT_FOUND'
  return 'PROVIDER_ERROR'
}

async function httpJson(url, init) {
  const ctrl = new AbortController()
  const timer = setTimeout(function () { ctrl.abort() }, TIMEOUT_MS)
  const options = Object.assign({ signal: ctrl.signal }, init || {})
  options.headers = Object.assign({ 'user-agent': 'Something-Parcel/1.0' }, (init && init.headers) || {})
  try {
    const res = await fetch(url, options)
    const text = await res.text()
    if (!res.ok) throw buildError('PROVIDER_ERROR', '接口返回 HTTP ' + res.status)
    try {
      return JSON.parse(text)
    } catch (e) {
      throw buildError('PROVIDER_ERROR', '接口返回的不是 JSON')
    }
  } catch (e) {
    if (e && e.code) throw e
    const name = e && e.name
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw buildError('TIMEOUT', '接口请求超时（' + Math.round(TIMEOUT_MS / 1000) + ' 秒）')
    }
    throw buildError('NETWORK', '网络请求失败：' + String((e && e.message) || e))
  } finally {
    clearTimeout(timer)
  }
}

function md5Hex(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex')
}

function md5Upper(text) {
  return md5Hex(text).toUpperCase()
}

/** 接口时间串统一按本地时间解析：2024-05-01 10:20:30 / 2024-05-01T10:20:30 */
function parseTime(value) {
  const text = String(value || '').trim()
  if (!text) return Date.now()
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0)).getTime()
  const stamp = Date.parse(text.replace(/-/g, '/'))
  return Number.isFinite(stamp) ? stamp : Date.now()
}

/* ---------- 快递100：POST poll.kuaidi100.com/poll/query.do，sign = MD5(param+key+customer) 大写 ---------- */

async function queryKuaidi100(input) {
  const cred = input.credential || {}
  const customer = String(cred.customer || '').trim()
  const key = String(cred.key || '').trim()
  if (!customer || !key) throw buildError('AUTH', '还没填写快递100 的 Customer 编码与授权 Key')
  if (!input.code) throw buildError('COURIER_UNKNOWN', '快递100 需要快递公司编码，请在包裹上选择快递公司')
  const param = JSON.stringify({
    com: String(input.code),
    num: String(input.no),
    phone: String(input.phone || ''),
    resultv2: '4'
  })
  const body = new URLSearchParams({
    customer: customer,
    sign: md5Upper(param + key + customer),
    param: param
  })
  const raw = await httpJson('https://poll.kuaidi100.com/poll/query.do', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: body.toString()
  })
  return mapKuaidi100(raw)
}

function mapKuaidi100(raw) {
  const data = raw || {}
  const state = String(data.status == null ? '' : data.status)
  if (data.result === false || (state && state !== '200')) {
    const reason = String(data.message || data.reason || '快递100 返回查询失败')
    throw buildError(classifyMessage(reason), reason)
  }
  const list = Array.isArray(data.data) ? data.data : []
  const traces = list.map(function (item) {
    return {
      nodeTime: parseTime(item.ftime || item.time),
      description: String(item.context || '').trim(),
      location: String(item.location || '').trim() || null
    }
  }).filter(function (item) { return !!item.description })
  const signed = String(data.ischeck || '') === '1' || state === '3'
  return finish('kuaidi100', state, traces, signed)
}

/* ---------- 快递鸟：POST api.kdniao.com，DataSign = base64(MD5(RequestData+AppKey)) ---------- */

async function queryKdniao(input) {
  const cred = input.credential || {}
  const ebusinessId = String(cred.ebusinessId || '').trim()
  const appKey = String(cred.appKey || '').trim()
  if (!ebusinessId || !appKey) throw buildError('AUTH', '还没填写快递鸟的 EBusinessID 与 AppKey')
  if (!input.code) throw buildError('COURIER_UNKNOWN', '快递鸟需要快递公司编码，请在包裹上选择快递公司')
  const requestData = JSON.stringify({
    OrderCode: '',
    ShipperCode: String(input.code),
    LogisticCode: String(input.no),
    CustomerName: String(input.phone || '')
  })
  const dataSign = Buffer.from(md5Hex(requestData + appKey), 'utf8').toString('base64')
  const body = new URLSearchParams({
    RequestData: requestData,
    EBusinessID: ebusinessId,
    RequestType: '1002',
    DataSign: dataSign,
    DataType: '2'
  })
  const raw = await httpJson('https://api.kdniao.com/Ebusiness/EbusinessOrderHandle.aspx', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: body.toString()
  })
  return mapKdniao(raw)
}

function mapKdniao(raw) {
  const data = raw || {}
  if (data.Success !== true) {
    const reason = String(data.Reason || '快递鸟返回查询失败')
    throw buildError(classifyMessage(reason), reason)
  }
  const state = String(data.State == null ? '' : data.State)
  const list = Array.isArray(data.Traces) ? data.Traces : []
  const traces = list.map(function (item) {
    return {
      nodeTime: parseTime(item.AcceptTime),
      description: String(item.AcceptStation || '').trim(),
      location: String(item.Location || '').trim() || null
    }
  }).filter(function (item) { return !!item.description })
  return finish('kdniao', state, traces, state === '3')
}

/* ---------- 聚合数据：GET v.juhe.cn/exp/index ---------- */

async function queryJuhe(input) {
  const cred = input.credential || {}
  const key = String(cred.key || '').trim()
  if (!key) throw buildError('AUTH', '还没填写聚合数据的 API Key')
  if (!input.code) throw buildError('COURIER_UNKNOWN', '聚合数据需要快递公司编码，请在包裹上选择快递公司')
  const qs = new URLSearchParams({ key: key, com: String(input.code), no: String(input.no) })
  const raw = await httpJson('https://v.juhe.cn/exp/index?' + qs.toString(), { method: 'GET' })
  return mapJuhe(raw)
}

function mapJuhe(raw) {
  const data = raw || {}
  const code = String(data.resultcode == null ? '' : data.resultcode)
  if (code !== '200') {
    const reason = String(data.reason || '聚合数据返回查询失败')
    throw buildError(classifyMessage(reason), reason)
  }
  const result = data.result || {}
  const list = Array.isArray(result.list) ? result.list : []
  const traces = list.map(function (item) {
    return {
      nodeTime: parseTime(item.datetime),
      description: String(item.remark || '').trim(),
      location: String(item.zone || '').trim() || null
    }
  }).filter(function (item) { return !!item.description })
  const state = String(result.status == null ? '' : result.status)
  return finish('juhe', state, traces, state === '3' || state === '4')
}

/* ---------- 归一化 ---------- */

const SIGNED_HINTS = /签收|已妥投|投递成功|已代收|已签收/
const DELIVERING_HINTS = /派件|派送|正在投递|快递员.*(取件|派送)/
const PICKUP_HINTS = /取件码|提货码|待取件|请取件|已到驿站|快递柜|智能柜|丰巢|菜鸟驿站|便利店|自提/
const PICKUP_CODE_RE = /[取提][件货]码[：:\s]*([A-Za-z0-9-]{3,12})/
const STATION_RE = /([\u4e00-\u9fa5A-Za-z0-9（）()·\-]{2,20}(?:驿站|快递柜|智能柜|自提点|服务点|代收点|便利店))/

/** 以「最新一条轨迹 + 接口状态码」判定，历史节点只用来找取件码/取件点 */
function normalizeStatus(input) {
  const traces = Array.isArray(input.traces) ? input.traces : []
  const latest = traces.length ? String(traces[0].description || '') : ''
  const state = String(input.state == null ? '' : input.state)
  if (input.signed || state === '3') return '已签收'
  if (SIGNED_HINTS.test(latest)) return '已签收'
  if (state === '5' || DELIVERING_HINTS.test(latest)) return '派送中'
  if (PICKUP_HINTS.test(latest)) return '待取件'
  for (const item of traces) {
    if (PICKUP_HINTS.test(String(item.description || ''))) return '待取件'
  }
  return '在途'
}

function extractPickup(traces) {
  const list = Array.isArray(traces) ? traces : []
  for (const item of list) {
    const m = PICKUP_CODE_RE.exec(String(item.description || ''))
    if (m) return m[1]
  }
  return null
}

function pickStation(traces) {
  const list = Array.isArray(traces) ? traces : []
  for (const item of list) {
    const text = String(item.description || '') + ' ' + String(item.location || '')
    const m = STATION_RE.exec(text)
    if (m) return m[1].replace(/^.*?(到达|存放于|已放至|放在|已到)/, '')
  }
  return null
}

function finish(provider, state, traces, signed) {
  const sorted = traces.slice().sort(function (a, b) { return b.nodeTime - a.nodeTime })
  return {
    provider: provider,
    state: String(state == null ? '' : state),
    status: normalizeStatus({ state: state, traces: sorted, signed: signed }),
    pickupCode: extractPickup(sorted),
    station: pickStation(sorted),
    traces: sorted
  }
}

const RUNNERS = { kuaidi100: queryKuaidi100, kdniao: queryKdniao, juhe: queryJuhe }

/** 统一入口：input = { provider, no, code, phone, credential } */
async function query(input) {
  const it = input || {}
  const provider = String(it.provider || '')
  const no = String(it.no || '').trim()
  if (!no) throw buildError('TRACKING_NOT_FOUND', '缺少快递单号')
  if (provider === 'manual') throw buildError('NO_PROVIDER', '当前是手动维护模式，没有可调用的物流接口')
  const runner = RUNNERS[provider]
  if (!runner) throw buildError('PROVIDER_ERROR', '未知的物流数据源：' + (provider || '空'))
  return runner(Object.assign({}, it, { no: no }))
}

module.exports = {
  PROVIDERS: PROVIDERS,
  STATUS_RANK: STATUS_RANK,
  TIMEOUT_MS: TIMEOUT_MS,
  providerById: providerById,
  query: query,
  mapKuaidi100: mapKuaidi100,
  mapKdniao: mapKdniao,
  mapJuhe: mapJuhe,
  normalizeStatus: normalizeStatus,
  extractPickup: extractPickup,
  pickStation: pickStation,
  parseTime: parseTime,
  md5Upper: md5Upper
}

