// 天气领域服务：城市管理 + 天气缓存。SQL 集中在文件内，IPC 层只做校验与转发。
const { get, withTx } = require('../db/conn.cjs')
const { uid, now, camel, camelAll } = require('../db/util.cjs')
const logger = require('../log/logger.cjs')
const qweather = require('./qweather.cjs')

// 缓存按 kind 分行存：一张天气快照拆成多类 payload(JSON 字符串)。
// meta 额外记住数据来源与更新时间，供渲染层区分「和风天气 / 本地缓存 / 本地模拟」。
const KINDS = ['now', 'hourly', 'daily', 'aqi', 'indices', 'alerts', 'meta']


/** 统一异常出口：记录模块日志后继续向上抛，交由 IPC 层转成结构化错误。 */
function fail(where, err, meta) {
  logger.error('weather', where, err, meta || {})
  throw err
}

/** 取单行原始记录（is_home 等仍是 0/1）。 */
function cityRow(id) {
  return get().prepare('SELECT * FROM weather_city WHERE id = ?').get(id)
}

/**
 * 城市行 → 渲染层契约。
 * 表里是 is_home，camel() 会得到 isHome；而渲染层契约字段是 home，
 * 这里统一映射，避免前端 c.home 永远 undefined（表现为「定位城市」识别不到、主城不可删逻辑失效）。
 */
function cityView(row) {
  if (!row) return null
  const c = camel(row)
  return {
    id: c.id, name: c.name, home: !!c.isHome, sort: c.sort,
    // 和风天气定位信息：LocationID 供 v7 接口使用，经纬度供 v1 预警接口使用
    qweatherId: c.qweatherId || null,
    lat: c.lat == null ? null : Number(c.lat),
    lon: c.lon == null ? null : Number(c.lon),
    adm1: c.adm1 || null,
    adm2: c.adm2 || null
  }
}

/** 列出城市：主城、排序靠前。 */
function cities() {
  try {
    return camelAll(get().prepare('SELECT * FROM weather_city ORDER BY is_home DESC, sort ASC, name ASC').all()).map(cityView)
  } catch (err) {
    return fail('cities failed', err, {})
  }
}

/**
 * 新增城市：sort 追加到末尾；is_home 走表默认 0，不擅自设主城。
 * 配了 API Key 时先经 GeoAPI 定位（拿 LocationID 与经纬度），定位失败直接报错，避免存进一个取不到天气的城市。
 */
/** 城市搜索：透传 GeoAPI 候选列表，由前端渲染给用户选择 */
async function searchCities(dto) {
  const keyword = dto && dto.keyword ? String(dto.keyword).trim() : ''
  if (!keyword) return fail('searchCities failed', new Error('请输入城市名称'), {})
  if (qweather.authMode() === 'none') return fail('searchCities failed', new Error('尚未配置和风天气身份认证（JWT 或 API Key）'), {})
  try {
    return await qweather.searchCities(keyword, qweather.credentials())
  } catch (err) {
    return fail('searchCities failed', err, { keyword: keyword })
  }
}

async function addCity(dto) {
  const name = dto && dto.name ? String(dto.name).trim() : ''
  if (!name) return fail('addCity failed', new Error('CITY_NAME_REQUIRED'), {})
  try {
    // 用户在搜索结果里选定某一条时，直接用它携带的 LocationID 与经纬度，避免再次按名字猜
    const geo = dto && dto.qweatherId
      ? {
          id: String(dto.qweatherId),
          name: name,
          lat: dto.lat == null ? null : Number(dto.lat),
          lon: dto.lon == null ? null : Number(dto.lon),
          adm1: dto.adm1 || null,
          adm2: dto.adm2 || null
        }
      : (qweather.authMode() !== 'none' ? await qweather.lookupCity(name, qweather.credentials()) : null)
    return withTx(function () {
      const max = get().prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM weather_city').get()
      const sort = (max ? max.m : -1) + 1
      const id = uid('city')
      get().prepare(
        'INSERT INTO weather_city (id, name, is_home, sort, qweather_id, lat, lon, adm1, adm2, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).run(id, geo ? geo.name : name, 0, sort, geo ? geo.id : null, geo ? geo.lat : null, geo ? geo.lon : null, geo ? geo.adm1 : null, geo ? geo.adm2 : null, now())
      return cityView(cityRow(id))
    })
  } catch (err) {
    return fail('addCity failed', err, { name: name })
  }
}

/** 重新定位：把已有城市名再查一次 GeoAPI，补齐/更新 LocationID 与经纬度。 */
async function relocate(dto) {
  const o = dto || {}
  if (qweather.authMode() === 'none') return fail('relocate failed', new Error('尚未配置和风天气身份认证（JWT 或 API Key），无法定位'), {})
  const auth = qweather.credentials()
  try {
    const targets = o.id ? [cityRow(String(o.id))].filter(Boolean) : get().prepare('SELECT * FROM weather_city').all()
    const failures = []
    for (const row of targets) {
      try {
        const geo = await qweather.lookupCity(row.name, auth)
        get().prepare('UPDATE weather_city SET qweather_id = ?, lat = ?, lon = ?, adm1 = ?, adm2 = ?, updated_at = ?, name = ? WHERE id = ?')
          .run(geo.id, geo.lat, geo.lon, geo.adm1, geo.adm2, now(), geo.name, row.id)
      } catch (e) {
        failures.push(row.name + '：' + ((e && e.message) || '定位失败'))
        logger.warn('weather', 'relocate_failed', { name: row.name, code: e && e.code, message: e && e.message })
      }
    }
    // 全部失败时把原因抛给页面，避免「看起来成功但其实一个都没定位到」
    if (targets.length && failures.length === targets.length) throw new Error(failures[0])
    return { cities: cities(), failed: failures }
  } catch (err) {
    return fail('relocate failed', err, { id: o.id })
  }
}

/** 删除城市：主城受保护；weather_cache 外键 ON DELETE CASCADE 自动清理缓存。 */
function removeCity(id) {
  try {
    return withTx(function () {
      const row = get().prepare('SELECT is_home FROM weather_city WHERE id = ?').get(id)
      if (!row) throw new Error('CITY_NOT_FOUND')
      if (row.is_home === 1) throw new Error('HOME_CITY_NO_DELETE')
      get().prepare('DELETE FROM weather_city WHERE id = ?').run(id)
      return true
    })
  } catch (err) {
    return fail('removeCity failed', err, { id: id })
  }
}

/** 设为主城：先全部置 0 再置 1，保证全局唯一主城；整体在一个事务内。 */
function setHome(id) {
  try {
    return withTx(function () {
      if (!cityRow(id)) throw new Error('CITY_NOT_FOUND')
      get().prepare('UPDATE weather_city SET is_home = 0').run()
      get().prepare('UPDATE weather_city SET is_home = 1 WHERE id = ?').run(id)
      return cityView(cityRow(id))
    })
  } catch (err) {
    return fail('setHome failed', err, { id: id })
  }
}

/** 读整份天气缓存：五类齐全才算命中，任一缺失或解析失败都视为未命中。 */
function readCache(cityId) {
  const rows = get().prepare('SELECT kind, payload, fetched_at FROM weather_cache WHERE city_id = ?').all(cityId)
  if (!rows || rows.length < KINDS.length) return null
  const byKind = {}
  rows.forEach(function (r) { byKind[r.kind] = r })
  const data = {}
  let fetchedAt = 0
  for (let i = 0; i < KINDS.length; i++) {
    const k = KINDS[i]
    if (!byKind[k]) return null
    try { data[k] = JSON.parse(byKind[k].payload) } catch (e) { return null }
    if (byKind[k].fetched_at > fetchedAt) fetchedAt = byKind[k].fetched_at
  }
  return { data: data, fetchedAt: fetchedAt }
}

/** 写天气缓存：每类一行，INSERT OR REPLACE 覆盖旧值（主键 city_id+kind）。缺失的 kind 写 null 占位。 */
function writeCache(cityId, snapshot) {
  const t = now()
  const st = get().prepare('INSERT OR REPLACE INTO weather_cache (city_id, kind, payload, fetched_at) VALUES (?, ?, ?, ?)')
  const data = snapshot || {}
  KINDS.forEach(function (k) {
    const value = data[k] === undefined ? null : data[k]
    st.run(cityId, k, JSON.stringify(value), t)
  })
}


/** 统一出参：把缓存快照摊平成渲染层契约（source 区分数据来源） */
function snapshotView(city, cached, extra) {
  const d = (cached && cached.data) || {}
  const e = extra || {}
  return {
    cityId: city.id, name: city.name,
    fromCache: !!e.fromCache, fetchedAt: (cached && cached.fetchedAt) || now(),
    now: d.now || null, hourly: d.hourly || [], daily: d.daily || [],
    aqi: d.aqi || { num: 0, level: '—', pm25: 0, pm10: 0, o3: 0 },
    indices: d.indices || [], alerts: d.alerts || [],
    source: e.source || (d.meta && d.meta.source) || 'qweather',
    updateTime: (d.meta && d.meta.updateTime) || '',
    error: e.error || null
  }
}

/**
 * 取天气：只使用和风天气与它自己的本地缓存，没有任何本地模拟数据。
 * - 未配置 API Host / Key：返回结构化错误，页面引导去设置。
 * - 城市未定位：先经 GeoAPI 定位并写回；失败即报错。
 * - 请求失败：有真实缓存则用缓存并在 error 里说明原因，没有就把错误抛给页面。
 */
async function fetch(dto) {
  const o = dto || {}
  const cityId = String(o.cityId || '')
  try {
    const city = cityRow(cityId)
    if (!city) throw new Error('CITY_NOT_FOUND')
    const cfg = qweather.config()
    if (!cfg.host) throw new Error('尚未配置和风天气 API Host（设置 › 天气）')
    if (cfg.legacyHost) throw new Error('和风天气已停用公共域名 ' + cfg.host + '，请改用账号专属 API Host')
    const authMode = qweather.authMode()
    if (!authMode || authMode === 'none') throw new Error('尚未配置和风天气身份认证（JWT 或 API Key，设置 › 天气）')
    const ttl = Math.max(1, cfg.cacheMin) * 60000
    const cached = readCache(cityId)
    if (cached && !o.force && (now() - cached.fetchedAt) < ttl) {
      return snapshotView(city, cached, { fromCache: true, source: 'qweather' })
    }
    let qid = city.qweather_id
    let lat = city.lat
    let lon = city.lon
    if (!qid) {
      const geo = await qweather.lookupCity(city.name, qweather.credentials())
      qid = geo.id
      lat = geo.lat
      lon = geo.lon
      withTx(function () {
        get().prepare('UPDATE weather_city SET qweather_id = ?, lat = ?, lon = ?, adm1 = ?, adm2 = ?, updated_at = ?, name = ? WHERE id = ?')
          .run(geo.id, geo.lat, geo.lon, geo.adm1, geo.adm2, now(), geo.name, city.id)
      })
    }
    try {
      const data = await qweather.fetchWeather({ name: city.name, qweatherId: qid, lat: lat, lon: lon })
      const payload = Object.assign({}, data, { meta: { source: 'qweather', updateTime: data.updateTime || '', fetchedAt: now() } })
      withTx(function () { writeCache(cityId, payload) })
      return snapshotView(city, { data: payload, fetchedAt: now() }, { fromCache: false, source: 'qweather' })
    } catch (err) {
      logger.warn('weather', 'provider_failed', { city: city.name, code: err && err.code, message: err && err.message })
      if (cached) {
        return snapshotView(city, cached, { fromCache: true, source: 'qweather', error: (err && err.message) || '取数失败，展示上一次成功的数据' })
      }
      throw err
    }
  } catch (err) {
    return fail('fetch failed', err, { cityId: cityId, force: o.force })
  }
}

/** 缓存状态：是否五类齐全、已缓存的 kind、最新抓取时间。 */
function cache(dto) {
  try {
    const cityId = dto && dto.cityId
    const rows = get().prepare('SELECT kind, fetched_at FROM weather_cache WHERE city_id = ?').all(cityId)
    const byKind = {}
    rows.forEach(function (r) { byKind[r.kind] = r.fetched_at })
    const kinds = KINDS.filter(function (k) { return byKind[k] != null })
    const fetchedAt = kinds.length ? Math.max(...kinds.map(function (k) { return byKind[k] })) : null
    return { cityId: cityId, cached: kinds.length === KINDS.length, kinds: kinds, fetchedAt: fetchedAt }
  } catch (err) {
    return fail('cache failed', err, { cityId: dto && dto.cityId })
  }
}

module.exports = {
  cities: cities,
  addCity: addCity,
  removeCity: removeCity,
  setHome: setHome,
  searchCities: searchCities,
  relocate: relocate,
  fetch: fetch,
  cache: cache
}