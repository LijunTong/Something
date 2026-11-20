// 和风天气适配层：GeoAPI 定位 + v7 天气/空气/指数/预警。
// 约束：只做网络与字段映射，不写库；缓存与城市管理仍由 weather.cjs 负责。
const crypto = require('node:crypto')
const { get } = require('../db/conn.cjs')
const logger = require('../log/logger.cjs')

const TIMEOUT_MS = 8000
// 2024 起和风天气取消了 devapi/geoapi 公共域名，必须使用控制台分配的账号专属 API Host，
// 例如 abcxyz.re.qweatherapi.com；同一个 Host 同时提供 /geo/v2 与 /v7 接口。
const DOC_DEFAULTS = { host: '', geoHost: '' }
const LEGACY_HOSTS = ['api.qweather.com', 'devapi.qweather.com', 'geoapi.qweather.com']

class QWeatherError extends Error {
  constructor(code, message, payload) {
    super(message)
    this.name = 'QWeatherError'
    this.code = String(code)
    this.payload = payload || null
  }
}

const CODE_TEXT = {
  204: '该地区暂无数据',
  400: '请求参数错误',
  401: '认证失败：API Key 无效或已过期',
  402: '请求次数超限或余额不足',
  403: '没有访问该接口的权限（请在控制台开通）',
  404: '查询的地区不存在',
  429: '请求过于频繁，已被限流',
  500: '和风天气服务异常'
}

function codeMessage(code) {
  return CODE_TEXT[String(code)] || ('和风天气返回错误码 ' + code)
}

/** 解密天气 API Key：主进程用 safeStorage 存的是 base64 密文 */
function readApiKey() {
  const row = get().prepare("SELECT value FROM app_setting WHERE key = 'weatherKey'").get()
  if (!row) return ''
  let b64 = ''
  try { b64 = JSON.parse(row.value) } catch (e) { return '' }
  if (!b64) return ''
  try {
    const safeStorage = require('electron').safeStorage
    if (!safeStorage || typeof safeStorage.decryptString !== 'function') return ''
    return String(safeStorage.decryptString(Buffer.from(b64, 'base64'))).trim()
  } catch (e) {
    logger.warn('qweather', 'decrypt_key_failed', { message: e && e.message })
    return ''
  }
}

/** 数据源配置：settings.weather 里的 host/geoHost，缺省用旧版公共域名 */
function normalizeHost(v) {
  return String(v || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

function config() {
  const row = get().prepare("SELECT value FROM app_setting WHERE key = 'weather'").get()
  let cfg = {}
  if (row) { try { cfg = JSON.parse(row.value) || {} } catch (e) { cfg = {} } }
  const host = normalizeHost(cfg.host)
  const geoHost = normalizeHost(cfg.geoHost) || host
  return {
    host: host,
    geoHost: geoHost,
    legacyHost: !!host && LEGACY_HOSTS.indexOf(host) >= 0,
    // refreshMin 是自动刷新频率；cacheMin 为历史字段，仅作兼容回退
    cacheMin: Number(cfg.refreshMin || cfg.cacheMin || 5)
  }
}

/* ---------- 身份认证：JWT（官方推荐）或 API KEY ---------- */

/** 读取 JWT 凭据：safeStorage 加密的 { developerId, projectId, keyId, privateKey } */
function readJwt() {
  const row = get().prepare("SELECT value FROM app_setting WHERE key = 'qweatherJwt'").get()
  if (!row) return null
  let b64 = ''
  try { b64 = JSON.parse(row.value) } catch (e) { return null }
  if (!b64) return null
  try {
    const safeStorage = require('electron').safeStorage
    if (!safeStorage || typeof safeStorage.decryptString !== 'function') return null
    const json = safeStorage.decryptString(Buffer.from(b64, 'base64'))
    const cred = JSON.parse(json)
    if (!cred || !cred.projectId || !cred.keyId || !cred.privateKey) return null
    return cred
  } catch (e) {
    logger.warn('qweather', 'decrypt_jwt_failed', { message: e && e.message })
    return null
  }
}

let tokenCache = { token: '', exp: 0 }

/**
 * 生成 JWT：Header { alg: 'EdDSA', kid }，Payload { iss: 开发者ID, sub: 项目ID, iat, exp }。
 * 签名用 Ed25519 私钥（PEM PKCS8），三段 Base64URL 拼接，有效期 15 分钟并做缓存。
 */
function makeToken(cred) {
  const nowSec = Math.floor(Date.now() / 1000)
  if (tokenCache.token && tokenCache.exp - 120 > nowSec) return tokenCache.token
  const header = { alg: 'EdDSA', kid: String(cred.keyId) }
  const payload = {
    iss: String(cred.developerId || ''),
    sub: String(cred.projectId),
    iat: nowSec - 30,
    exp: nowSec + 900
  }
  if (!payload.iss) throw new QWeatherError('JWT_INCOMPLETE', 'JWT 缺少开发者 ID（iss）')
  let keyObject = null
  try {
    keyObject = crypto.createPrivateKey({ key: String(cred.privateKey), format: 'pem' })
  } catch (e) {
    throw new QWeatherError('JWT_KEY_INVALID', 'Ed25519 私钥无法解析，请粘贴完整的 PEM（-----BEGIN PRIVATE KEY----- 开头）')
  }
  const enc = function (o) { return Buffer.from(JSON.stringify(o)).toString('base64url') }
  const signingInput = enc(header) + '.' + enc(payload)
  let signature = ''
  try {
    signature = crypto.sign(null, Buffer.from(signingInput), keyObject).toString('base64url')
  } catch (e) {
    throw new QWeatherError('JWT_SIGN_FAILED', 'JWT 签名失败：' + (e && e.message ? e.message : String(e)))
  }
  tokenCache = { token: signingInput + '.' + signature, exp: payload.exp }
  return tokenCache.token
}

/** 当前生效的认证方式：JWT 优先，其次 API Key */
function credentials() {
  const jwt = readJwt()
  if (jwt) {
    try {
      return { mode: 'jwt', token: makeToken(jwt), key: '' }
    } catch (e) {
      logger.warn('qweather', 'jwt_build_failed', { code: e && e.code, message: e && e.message })
      return { mode: 'jwt', token: '', key: '', error: e }
    }
  }
  const key = readApiKey()
  if (key) return { mode: 'key', token: '', key: key }
  return { mode: 'none', token: '', key: '' }
}

/** 统一 GET：JWT 走 Authorization: Bearer，API Key 走 query key；超时中断，错误码转中文 */
async function getJson(host, pathname, params, auth) {
  if (!host) throw new QWeatherError('HOST_REQUIRED', '请先在「设置 › 天气」填写控制台分配的 API Host（形如 abcxyz.re.qweatherapi.com）')
  if (LEGACY_HOSTS.indexOf(host) >= 0) {
    throw new QWeatherError('HOST_INVALID', '和风天气已停用公共域名 ' + host + '，请改用控制台分配给你的 API Host')
  }
  const cred = auth || credentials()
  if (cred.mode === 'none') throw new QWeatherError('NO_AUTH', '尚未配置和风天气身份认证（JWT 或 API Key）')
  if (cred.mode === 'jwt' && cred.error) throw cred.error
  if (cred.mode === 'jwt' && !cred.token) throw new QWeatherError('NO_AUTH', 'JWT 生成失败，请检查开发者 ID / 项目 ID / 凭据 ID 与私钥')
  const url = new URL('https://' + host + pathname)
  Object.keys(params || {}).forEach(function (k) {
    const v = params[k]
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  })
  const headers = { Accept: 'application/json' }
  if (cred.mode === 'jwt') headers.Authorization = 'Bearer ' + cred.token
  else url.searchParams.set('key', cred.key)
  const ctrl = new AbortController()
  const timer = setTimeout(function () { ctrl.abort() }, TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: headers })
    const text = await res.text()
    if (!text) {
      const hint = res.status === 403
        ? '：API Host 未授权或不存在，请核对控制台里的 Host 与凭据（JWT / API Key）是否属于同一项目'
        : res.status === 404
          ? '：路径或 location 不存在，请确认 API Host 正确'
          : ''
      throw new QWeatherError('HTTP_' + res.status, 'API 请求被拒绝（HTTP ' + res.status + '）' + hint)
    }
    let json = null
    try { json = JSON.parse(text) } catch (e) { throw new QWeatherError('BAD_JSON', '和风天气返回非 JSON 内容') }
    // 新版接口的错误体是 { error: { status, title, detail, type } }，旧版是 { code }
    if (json && json.error && json.error.status) {
      const err = json.error
      const hint = String(err.type || '').indexOf('invalid-host') >= 0
        ? '（API Host 无效或未被授权，请核对控制台里的 Host）'
        : ''
      throw new QWeatherError(String(err.status), String(err.title || '和风天气请求失败') + '：' + String(err.detail || '') + hint, json)
    }
    if (json && json.code && String(json.code) !== '200') throw new QWeatherError(json.code, codeMessage(json.code), json)
    if (!res.ok && (!json || !json.code)) throw new QWeatherError('HTTP_' + res.status, '和风天气请求失败（HTTP ' + res.status + '）')
    return json
  } catch (e) {
    if (e instanceof QWeatherError) throw e
    if (e && e.name === 'AbortError') throw new QWeatherError('TIMEOUT', '请求和风天气超时（' + TIMEOUT_MS + 'ms）')
    const cause = e && e.cause ? e.cause : null
    const detail = (cause && (cause.code || cause.message)) || (e && e.message) || String(e)
    const hint = /ENOTFOUND|EAI_AGAIN/.test(String(detail)) ? '（域名无法解析，请检查 API Host 拼写）' : ''
    throw new QWeatherError('NETWORK', '网络请求失败：' + detail + hint)
  } finally {
    clearTimeout(timer)
  }
}

/** 图标码 → 页面 sprite：只区分晴/多云/阴/雨/雷/雪/雾/夜 */
function spriteOf(code, isNight) {
  const c = String(code || '')
  if (!c) return 'partly'
  if (c === '100' || c === '150') return isNight ? 'moon' : 'sun'
  if (/^10[1-3]$/.test(c)) return 'partly'
  if (c === '104' || c === '154') return 'cloud'
  if (/^3\d\d$/.test(c)) return 'rain'
  if (/^302$|^303$/.test(c)) return 'thunder'
  if (/^4\d\d$/.test(c)) return 'snow'
  if (/^5\d\d$/.test(c)) return 'fog'
  return 'partly'
}

function pad2(n) { return String(n).padStart(2, '0') }

function clockOf(iso) {
  const m = /T(\d{2}):(\d{2})/.exec(String(iso || ''))
  return m ? m[1] + ':' + m[2] : ''
}

function dayLabel(iso, index) {
  if (index === 0) return '今天'
  if (index === 1) return '明天'
  const d = new Date(String(iso || '').replace(/-/g, '/'))
  if (Number.isNaN(d.getTime())) return '第 ' + (index + 1) + ' 天'
  return '周' + ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
}

/** 生活指数类型 → 页面图标与展示名（与设计稿四宫格对应） */
const INDEX_META = {
  1: { name: '运动', icon: 'sport', order: 3 },
  2: { name: '洗车', icon: 'car', order: 2 },
  3: { name: '穿衣', icon: 'clothes', order: 1 },
  5: { name: '紫外线', icon: 'uv', order: 5 },
  13: { name: '晾晒', icon: 'drop', order: 4 }
}

/* ---------- GeoAPI：城市搜索 ---------- */

/**
 * 城市搜索：文档路径为 /geo/v2/city/lookup（新版 API Host），
 * 旧版公共域名 geoapi.qweather.com 上是 /v2/city/lookup；两者参数一致，这里自动兼容。
 */
/** 城市搜索：返回最多 10 条候选，交给用户选择（GeoAPI 文档 /geo/v2/city/lookup） */
async function searchCities(keyword, auth) {
  const cfg = config()
  const params = { location: String(keyword || '').trim(), range: 'cn', number: 10, lang: 'zh' }
  if (!params.location) throw new QWeatherError('CITY_NAME_REQUIRED', '请输入城市名称')
  let json = null
  try {
    json = await getJson(cfg.geoHost, '/geo/v2/city/lookup', params, auth)
  } catch (e) {
    // 404 = 没有匹配城市，返回空列表而不是报错
    if (e instanceof QWeatherError && e.code === '404') return []
    throw e
  }
  const list = (json && json.location) || []
  return list.map(function (hit) {
    return {
      qweatherId: String(hit.id),
      name: String(hit.name || ''),
      lat: Number(hit.lat),
      lon: Number(hit.lon),
      adm1: hit.adm1 ? String(hit.adm1) : null,
      adm2: hit.adm2 ? String(hit.adm2) : null,
      country: hit.country ? String(hit.country) : null,
      type: hit.type ? String(hit.type) : null
    }
  })
}

async function lookupCity(name, auth) {
  const cfg = config()
  const params = { location: String(name || '').trim(), range: 'cn', number: 5, lang: 'zh' }
  if (!params.location) throw new QWeatherError('CITY_NAME_REQUIRED', '请输入城市名称')
  // 新版文档路径：GET /geo/v2/city/lookup（与天气接口同一个 API Host）
  const json = await getJson(cfg.geoHost, '/geo/v2/city/lookup', params, auth)
  const list = (json && json.location) || []
  if (!list.length) throw new QWeatherError('CITY_NOT_FOUND', '未找到城市：' + params.location)
  const hit = list[0]
  return {
    id: String(hit.id),
    name: String(hit.name || params.location),
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    adm1: hit.adm1 ? String(hit.adm1) : null,
    adm2: hit.adm2 ? String(hit.adm2) : null,
    country: hit.country ? String(hit.country) : null
  }
}

/* ---------- 数据映射 ---------- */

function mapNow(nowJson, daily) {
  const n = (nowJson && nowJson.now) || {}
  const today = daily[0] || {}
  return {
    temp: Number(n.temp),
    cond: String(n.text || '—'),
    feel: Number(n.feelsLike == null ? n.temp : n.feelsLike),
    humidity: Number(n.humidity),
    wind: String(n.windDir || '') + (n.windScale ? ' ' + n.windScale + ' 级' : ''),
    pressure: Number(n.pressure),
    visibility: Number(n.vis),
    uv: today.uvIndex == null ? '' : Number(today.uvIndex),
    sunrise: today.sunrise || '',
    sunset: today.sunset || '',
    obsTime: String(n.obsTime || ''),
    precip: n.precip == null ? null : Number(n.precip),
    cloud: n.cloud == null ? null : Number(n.cloud),
    dew: n.dew == null ? null : Number(n.dew)
  }
}

function mapHourly(hourlyJson) {
  const list = (hourlyJson && hourlyJson.hourly) || []
  return list.slice(0, 24).map(function (h) {
    const hm = clockOf(h.fxTime)
    return {
      time: hm,
      icon: spriteOf(h.icon, false),
      iconCode: String(h.icon || ''),
      temp: Number(h.temp),
      pop: Number(h.pop || 0),
      text: String(h.text || ''),
      wind: String(h.windDir || ''),
      windScale: String(h.windScale || '')
    }
  })
}

function mapDaily(dailyJson) {
  const list = (dailyJson && dailyJson.daily) || []
  return list.slice(0, 7).map(function (d, i) {
    return {
      dow: dayLabel(d.fxDate, i),
      date: String(d.fxDate || ''),
      icon: spriteOf(d.iconDay, false),
      iconNight: spriteOf(d.iconNight, true),
      iconCode: String(d.iconDay || ''),
      hi: Number(d.tempMax),
      lo: Number(d.tempMin),
      pop: Number(d.precip == null ? 0 : d.pop == null ? 0 : d.pop),
      textDay: String(d.textDay || ''),
      textNight: String(d.textNight || ''),
      sunrise: String(d.sunrise || ''),
      sunset: String(d.sunset || ''),
      uvIndex: d.uvIndex == null ? null : Number(d.uvIndex),
      windDirDay: String(d.windDirDay || ''),
      windScaleDay: String(d.windScaleDay || ''),
      moonPhase: String(d.moonPhase || '')
    }
  })
}

function mapAqi(airJson) {
  const a = (airJson && airJson.now) || {}
  return {
    num: Number(a.aqi == null ? 0 : a.aqi),
    level: String(a.category || '—'),
    pm25: Number(a.pm2p5 == null ? 0 : a.pm2p5),
    pm10: Number(a.pm10 == null ? 0 : a.pm10),
    o3: Number(a.o3 == null ? 0 : a.o3),
    no2: a.no2 == null ? null : Number(a.no2),
    so2: a.so2 == null ? null : Number(a.so2),
    co: a.co == null ? null : Number(a.co),
    primary: a.primary && a.primary !== 'NA' ? String(a.primary) : ''
  }
}

/** 空气质量 v1 接口（/airquality/v1/current）→ 页面字段；v7 的 /v7/air/now 停用它时兜底 */
function mapAqiV1(json) {
  const idx = ((json && json.indexes) || []).find(function (x) { return x && x.code === 'us-epa' }) || ((json && json.indexes) || [])[0] || {}
  const pollutants = (json && json.pollutants) || []
  const valueOf = function (code) {
    const p = pollutants.find(function (x) { return x && x.code === code })
    return p && p.concentration && p.concentration.value != null ? Number(p.concentration.value) : null
  }
  return {
    num: Number(idx.aqi == null ? 0 : idx.aqi),
    level: String(idx.category || '—'),
    pm25: valueOf('pm2p5') || 0,
    pm10: valueOf('pm10') || 0,
    o3: valueOf('o3') || 0,
    no2: valueOf('no2'),
    so2: valueOf('so2'),
    co: valueOf('co'),
    primary: idx.primaryPollutant && idx.primaryPollutant.name ? String(idx.primaryPollutant.name) : ''
  }
}

function mapIndices(indicesJson) {
  const list = (indicesJson && indicesJson.daily) || []
  const picked = []
  list.forEach(function (it) {
    const meta = INDEX_META[String(it.type)]
    if (!meta) return
    picked.push({
      name: meta.name, icon: meta.icon, order: meta.order,
      text: String(it.text || it.category || ''),
      level: String(it.level || ''),
      category: String(it.category || '')
    })
  })
  if (!picked.length) {
    list.slice(0, 4).forEach(function (it) {
      picked.push({ name: String(it.name || '指数'), icon: 'uv', order: 9, text: String(it.text || ''), level: String(it.level || ''), category: String(it.category || '') })
    })
  }
  return picked.sort(function (a, b) { return a.order - b.order }).slice(0, 4).map(function (x) {
    return { name: x.name, icon: x.icon, text: x.text }
  })
}

function mapAlerts(warnJson, fallbackJson) {
  const out = []
  const list = (warnJson && warnJson.warning) || []
  list.forEach(function (w) {
    out.push({
      id: String(w.id || ''),
      title: String(w.title || w.type || '天气预警'),
      type: String(w.typeName || w.type || ''),
      level: String(w.level || ''),
      text: String(w.text || ''),
      time: String(w.pubTime || '')
    })
  })
  const v1 = (fallbackJson && fallbackJson.alerts) || []
  v1.forEach(function (a) {
    const ev = (a.eventType && a.eventType.name) || '天气预警'
    const desc = a.description ? String(a.description) : ''
    out.push({
      id: String(a.id || ''),
      title: ev + (a.severity ? '（' + a.severity + '）' : ''),
      type: ev,
      level: String(a.severity || ''),
      text: desc,
      time: String(a.issuedTime || '')
    })
  })
  return out
}

/* ---------- 取数 ---------- */

/**
 * 一次取齐一份天气快照。
 * 实时数据是必需的；其余接口失败时降级为空数组/占位，避免一个接口拖垮整页。
 */
async function fetchWeather(city) {
  const cfg = config()
  const auth = credentials()
  if (auth.mode === 'none') throw new QWeatherError('NO_AUTH', '尚未配置和风天气身份认证（JWT 或 API Key）')
  if (auth.error) throw auth.error
  const location = city && city.qweatherId ? String(city.qweatherId) : ''
  if (!location) throw new QWeatherError('CITY_UNRESOLVED', '该城市尚未通过 GeoAPI 定位，请在城市管理里重新定位')
  const safe = async function (fn, fallback) {
    try { return await fn() } catch (e) {
      logger.warn('qweather', 'partial_failed', { message: e && e.message, code: e && e.code, city: city.name })
      return fallback
    }
  }
  const [nowJson, hourlyJson, dailyJson, airJson, indicesJson, warnJson] = await Promise.all([
    getJson(cfg.host, '/v7/weather/now', { location: location, lang: 'zh' }, auth),
    safe(function () { return getJson(cfg.host, '/v7/weather/24h', { location: location, lang: 'zh' }, auth) }, null),
    safe(function () { return getJson(cfg.host, '/v7/weather/7d', { location: location, lang: 'zh' }, auth) }, null),
    safe(function () { return getJson(cfg.host, '/v7/air/now', { location: location, lang: 'zh' }, auth) }, null),
    safe(function () { return getJson(cfg.host, '/v7/indices/1d', { location: location, type: '0', lang: 'zh' }, auth) }, null),
    safe(function () { return getJson(cfg.host, '/v7/warning/now', { location: location, lang: 'zh' }, auth) }, null)
  ])
  const daily = mapDaily(dailyJson)
  // 空气质量：v7 停用时用 v1 经纬度接口兜底
  let aqi = mapAqi(airJson)
  if (!airJson && city.lat && city.lon) {
    const v1Air = await safe(function () {
      return getJson(cfg.host, '/airquality/v1/current/' + Number(city.lat).toFixed(2) + '/' + Number(city.lon).toFixed(2), { lang: 'zh' }, auth)
    }, null)
    if (v1Air) aqi = mapAqiV1(v1Air)
  }
  let alerts = mapAlerts(warnJson, null)
  if (!alerts.length && city.lat && city.lon) {
    const v1 = await safe(function () {
      return getJson(cfg.host, '/weatheralert/v1/current/' + Number(city.lat).toFixed(2) + '/' + Number(city.lon).toFixed(2), { lang: 'zh' }, auth)
    }, null)
    alerts = mapAlerts(null, v1)
  }
  return {
    now: mapNow(nowJson, daily),
    hourly: mapHourly(hourlyJson),
    daily: daily,
    aqi: aqi,
    indices: mapIndices(indicesJson),
    alerts: alerts,
    updateTime: String((nowJson && nowJson.updateTime) || ''),
    source: 'qweather'
  }
}

/** 设置页自检：用 GeoAPI 搜索 + 实时天气，验证 Key、Host 与网络是否可用 */
async function test(cityName) {
  const cfg = config()
  const auth = credentials()
  const base = { keySet: auth.mode === 'key', authMode: auth.mode, host: cfg.host, geoHost: cfg.geoHost, cacheMin: cfg.cacheMin }
  if (!cfg.host) {
    return Object.assign({ ok: false }, base, { code: 'HOST_REQUIRED', message: '请填写控制台分配的 API Host（形如 abcxyz.re.qweatherapi.com）' })
  }
  if (cfg.legacyHost) {
    return Object.assign({ ok: false }, base, { code: 'HOST_INVALID', message: '和风天气已停用公共域名 ' + cfg.host + '，请改用账号专属 API Host' })
  }
  if (auth.mode === 'none') {
    return Object.assign({ ok: false }, base, { code: 'NO_AUTH', message: '尚未配置身份认证：推荐填 JWT（开发者 ID / 项目 ID / 凭据 ID / 私钥），或退而使用 API Key' })
  }
  if (auth.error) {
    return Object.assign({ ok: false }, base, { code: auth.error.code || 'JWT_INVALID', message: auth.error.message })
  }
  try {
    const city = await lookupCity(cityName || '北京', auth)
    const nowJson = await getJson(cfg.host, '/v7/weather/now', { location: city.id, lang: 'zh' }, auth)
    const n = (nowJson && nowJson.now) || {}
    return {
      ok: true, keySet: true, host: cfg.host, geoHost: cfg.geoHost, cacheMin: cfg.cacheMin,
      city: city.name + (city.adm2 ? ' · ' + city.adm2 : ''),
      message: '连接正常：' + city.name + ' 当前 ' + n.text + ' ' + n.temp + '°C（' + (nowJson.updateTime || '') + '）'
    }
  } catch (e) {
    return {
      ok: false, keySet: true, host: cfg.host, geoHost: cfg.geoHost, cacheMin: cfg.cacheMin,
      code: e && e.code ? String(e.code) : 'FAILED',
      message: (e && e.message) || '连接失败'
    }
  }
}

module.exports = {
  QWeatherError: QWeatherError,
  defaults: DOC_DEFAULTS,
  config: config,
  readApiKey: readApiKey,
  readJwt: readJwt,
  searchCities: searchCities,
  credentials: credentials,
  /** 是否已配置任一认证方式（不触发建 token 的副作用判断以 mode 为准） */
  authMode: function () { return credentials().mode },
  lookupCity: lookupCity,
  fetchWeather: fetchWeather,
  test: test,
  spriteOf: spriteOf
}
