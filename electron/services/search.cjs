// 全局搜索：跨模块 LIKE 查询，返回按模块分组的结果（只读，不写库）。
const { get } = require('../db/conn.cjs')
const logger = require('../log/logger.cjs')

const LIMIT = 6

function likeOf(keyword) {
  // 转义 LIKE 通配符，避免用户输入 % 或 _ 造成全表命中
  return '%' + String(keyword).replace(/[\\%_]/g, '\\$&') + '%'
}

function pick(sql, args) {
  try { return get().prepare(sql).all(...args) } catch (e) {
    logger.error('search', 'query_failed', e, { sql: sql.slice(0, 80) })
    return []
  }
}

function clock(ts) {
  if (!ts) return ''
  const d = new Date(Number(ts))
  const pad = (n) => String(n).padStart(2, '0')
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 搜索入口：keyword 必填；空结果返回空 groups，由前端展示空态 */
function query(dto) {
  const keyword = String((dto && dto.keyword) || '').trim()
  if (!keyword) return { keyword: '', total: 0, groups: [] }
  const like = likeOf(keyword)
  const groups = []

  const todos = pick(
    "SELECT id, title, status, due_at FROM todo WHERE title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?",
    [like, LIMIT]
  ).map((r) => ({
    id: r.id, title: r.title,
    meta: [r.status, r.due_at ? '截止 ' + clock(r.due_at) : ''].filter(Boolean).join(' · '),
    target: '/todo'
  }))
  groups.push({ module: 'todo', label: '待办', items: todos })

  const schedules = pick(
    "SELECT id, title, start_at, place FROM schedule WHERE title LIKE ? ESCAPE '\\' OR COALESCE(place,'') LIKE ? ESCAPE '\\' ORDER BY start_at DESC LIMIT ?",
    [like, like, LIMIT]
  ).map((r) => ({
    id: r.id, title: r.title,
    meta: [clock(r.start_at), r.place || ''].filter(Boolean).join(' · '),
    target: '/schedule'
  }))
  groups.push({ module: 'schedule', label: '日程', items: schedules })

  const mails = pick(
    "SELECT id, subject, from_name, from_addr, sent_at FROM mail WHERE subject LIKE ? ESCAPE '\\' OR COALESCE(from_addr,'') LIKE ? ESCAPE '\\' OR COALESCE(from_name,'') LIKE ? ESCAPE '\\' ORDER BY sent_at DESC LIMIT ?",
    [like, like, like, LIMIT]
  ).map((r) => ({
    id: r.id, title: r.subject || '（无主题）',
    meta: [r.from_name || r.from_addr || '', clock(r.sent_at)].filter(Boolean).join(' · '),
    target: '/mail'
  }))
  groups.push({ module: 'mail', label: '邮件', items: mails })

  // feed_item 没有 source_title 列，来源名在 feed_source.title：这里 LEFT JOIN 取回
  const items = pick(
    "SELECT i.id, i.title, i.published_at, s.title AS source_title FROM feed_item i LEFT JOIN feed_source s ON s.id = i.source_id WHERE i.title LIKE ? ESCAPE '\\' OR COALESCE(i.summary,'') LIKE ? ESCAPE '\\' OR COALESCE(i.content,'') LIKE ? ESCAPE '\\' ORDER BY i.published_at DESC LIMIT ?",
    [like, like, like, LIMIT]
  ).map((r) => ({
    id: r.id, title: r.title,
    meta: [r.source_title || '', clock(r.published_at)].filter(Boolean).join(' · '),
    // 带上文章 id：信息流页据此直接打开阅读器并定位到该条
    target: '/feed?item=' + encodeURIComponent(r.id)
  }))
  groups.push({ module: 'feed', label: '信息流', items })

  const parcels = pick(
    "SELECT id, company, tracking_no, alias, status FROM parcel WHERE tracking_no LIKE ? ESCAPE '\\' OR COALESCE(alias,'') LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?",
    [like, like, LIMIT]
  ).map((r) => ({
    id: r.id, title: r.alias || r.tracking_no,
    meta: [r.company || '', r.tracking_no, r.status].filter(Boolean).join(' · '),
    target: '/parcel'
  }))
  groups.push({ module: 'parcel', label: '快递', items: parcels })

  const cities = pick(
    "SELECT id, name, adm1, adm2 FROM weather_city WHERE name LIKE ? ESCAPE '\\' ORDER BY is_home DESC, sort ASC LIMIT ?",
    [like, LIMIT]
  ).map((r) => ({
    id: r.id, title: r.name,
    meta: [r.adm1 || '', r.adm2 || ''].filter(Boolean).join(' · ') || '城市',
    target: '/weather'
  }))
  groups.push({ module: 'weather', label: '城市', items: cities })

  const filtered = groups.filter((g) => g.items.length)
  const total = filtered.reduce((sum, g) => sum + g.items.length, 0)
  return { keyword: keyword, total: total, groups: filtered }
}

module.exports = { query: query }
