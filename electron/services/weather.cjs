// 天气领域服务：城市管理 + 天气缓存。SQL 集中在文件内，IPC 层只做校验与转发。
const { get, withTx } = require('../db/conn.cjs')
const { uid, now, camel, camelAll } = require('../db/util.cjs')
const logger = require('../log/logger.cjs')

// 缓存按 kind 分行存：一张天气快照拆成五类 payload(JSON 字符串)。
const KINDS = ['now', 'hourly', 'daily', 'aqi', 'indices']

// 内置 fixture 基准温度：按城市名区分，未命中用默认 24。
const CITY_TEMP = { '佛山': 24, '广州': 25, '深圳': 26, '北京': 21 }
const DEFAULT_TEMP = 24
const ICONS = ['sunny', 'cloudy', 'overcast', 'rain']
const DOWS = ['今天', '明天', '周三', '周四', '周五', '周六', '周日']

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
  return { id: c.id, name: c.name, home: !!c.isHome, sort: c.sort }
}

/** 列出城市：主城、排序靠前。 */
function cities() {
  try {
    return camelAll(get().prepare('SELECT * FROM weather_city ORDER BY is_home DESC, sort ASC, name ASC').all()).map(cityView)
  } catch (err) {
    return fail('cities failed', err, {})
  }
}

/** 新增城市：sort 追加到末尾；is_home 走表默认 0，不擅自设主城。 */
function addCity(dto) {
  try {
    return withTx(function () {
      const name = dto && dto.name ? String(dto.name).trim() : ''
      if (!name) throw new Error('CITY_NAME_REQUIRED')
      const max = get().prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM weather_city').get()
      const sort = (max ? max.m : -1) + 1
      const id = uid('city')
      get().prepare('INSERT INTO weather_city (id, name, is_home, sort) VALUES (?, ?, ?, ?)').run(id, name, 0, sort)
      return cityView(cityRow(id))
    })
  } catch (err) {
    return fail('addCity failed', err, { name: dto && dto.name })
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

/** 写天气缓存：五类各一行，INSERT OR REPLACE 覆盖旧值（主键 city_id+kind）。 */
function writeCache(cityId, fixture) {
  const t = now()
  const st = get().prepare('INSERT OR REPLACE INTO weather_cache (city_id, kind, payload, fetched_at) VALUES (?, ?, ?, ?)')
  KINDS.forEach(function (k) { st.run(cityId, k, JSON.stringify(fixture[k]), t) })
}

/** 生成内置 fixture：按城市基准温度派生 now/hourly/daily/aqi/indices 五类真实结构。 */
function buildFixture(name) {
  const base = Object.prototype.hasOwnProperty.call(CITY_TEMP, name) ? CITY_TEMP[name] : DEFAULT_TEMP

  // 实时天气
  const now = {
    temp: base,
    cond: '晴',
    feel: base + 1,
    humidity: 58 + (base % 7),
    wind: '东南风 2级',
    pressure: 1010 + (base % 5),
    visibility: 12,
    uv: 5,
    sunrise: '06:12',
    sunset: '18:46'
  }

  // 24 小时：整点温度按正弦围绕基准波动，降水概率错开。
  const hourly = []
  for (let i = 0; i < 24; i++) {
    hourly.push({
      time: String(i).padStart(2, '0') + ':00',
      icon: (i < 6 || i > 19) ? 'night' : ICONS[i % ICONS.length],
      temp: base + Math.round(3 * Math.sin((i - 8) / 24 * Math.PI * 2)),
      pop: (i * 7) % 40
    })
  }

  // 7 天：今天/明天 + 周几，最高/最低温与降水概率。
  const daily = []
  for (let i = 0; i < 7; i++) {
    daily.push({
      dow: DOWS[i],
      icon: ICONS[i % ICONS.length],
      hi: base + 3 - (i % 2),
      lo: base - 5 + (i % 2),
      pop: (i * 13) % 60
    })
  }

  // 空气质量
  const aqi = {
    num: 38 + (base % 20),
    level: '优',
    pm25: 18 + (base % 10),
    pm10: 32 + (base % 15),
    o3: 52 + (base % 20)
  }

  // 生活指数：四条固定维度。
  const indices = [
    { name: '穿衣', icon: 'clothes', text: '薄外套或长袖，早晚偏凉' },
    { name: '紫外线', icon: 'uv', text: '中等强度，外出注意防晒' },
    { name: '运动', icon: 'sport', text: '天气适宜，适合户外运动' },
    { name: '洗车', icon: 'car', text: '未来两天无雨，适合洗车' }
  ]

  return { now: now, hourly: hourly, daily: daily, aqi: aqi, indices: indices }
}

/**
 * 取天气：命中缓存则直接返回；未缓存或 force=true 时生成 fixture 写缓存后返回。
 * 涉及写库，整体包在 withTx 内。
 */
function fetch(dto) {
  try {
    const o = dto || {}
    const cityId = o.cityId
    return withTx(function () {
      const city = get().prepare('SELECT name FROM weather_city WHERE id = ?').get(cityId)
      if (!city) throw new Error('CITY_NOT_FOUND')
      // 非强制时优先读缓存；缓存完整才复用。
      const cached = o.force ? null : readCache(cityId)
      if (cached) {
        const d = cached.data
        return {
          cityId: cityId, name: city.name, fromCache: true, fetchedAt: cached.fetchedAt,
          now: d.now, hourly: d.hourly, daily: d.daily, aqi: d.aqi, indices: d.indices
        }
      }
      const fixture = buildFixture(city.name)
      writeCache(cityId, fixture)
      return {
        cityId: cityId, name: city.name, fromCache: false, fetchedAt: now(),
        now: fixture.now, hourly: fixture.hourly, daily: fixture.daily,
        aqi: fixture.aqi, indices: fixture.indices
      }
    })
  } catch (err) {
    return fail('fetch failed', err, { cityId: dto && dto.cityId, force: dto && dto.force })
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
  fetch: fetch,
  cache: cache
}
