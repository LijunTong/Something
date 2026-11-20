// 信息流领域服务：分组、订阅源、文章读写与 OPML 导入导出。
// 所有 SQL 集中在本文件；写操作统一走 withTx，嵌套调用使用内部 Raw 避免重复开事务。
const crypto = require('node:crypto')
const { get, withTx } = require('../db/conn.cjs')
const { uid, now, camel, camelAll, bool } = require('../db/util.cjs')
const logger = require('../log/logger.cjs')


// 统一异常出口：按项目约定记录模块名、说明、错误对象与上下文。
function logError(action, meta, err) {
  logger.error('feed', action, err, meta)
}

// sha1 摘要：guid 用 url + 标题，content_hash 用正文，保证刷新幂等去重。
function hash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex')
}

// OPML 属性需要做实体解码，导出时则反向转义。
function decodeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)) })
    .replace(/&amp;/g, '&')
}
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// 内部读取：不开启事务，供写方法在事务内回查最新行。
function getItemRaw(id) {
  return camel(get().prepare('SELECT * FROM feed_item WHERE id = ?').get(id))
}
// —— 分组 ——
function groups() {
  return camelAll(get().prepare('SELECT * FROM feed_group ORDER BY name ASC').all())
}

function addGroup(dto) {
  return withTx(function () {
    const id = uid('grp')
    get().prepare('INSERT INTO feed_group (id,name) VALUES (?,?)').run(id, dto.name)
    return camel(get().prepare('SELECT * FROM feed_group WHERE id = ?').get(id))
  })
}

// —— 订阅源 ——
function sources() {
  // 带上分组名，别名 group_name 经 camel 转成 groupName 供渲染层直接使用。
  return camelAll(get().prepare('SELECT s.*, g.name AS group_name FROM feed_source s LEFT JOIN feed_group g ON g.id = s.group_id ORDER BY s.id ASC').all())
}

// 内部新增：不开启事务，供 importOPML 复用；url 重复抛 SOURCE_EXISTS。
function addSourceRaw(dto) {
  const url = String(dto.url || '').trim()
  if (!url) throw new Error('SOURCE_URL_REQUIRED')
  const exists = get().prepare('SELECT id FROM feed_source WHERE url = ?').get(url)
  if (exists) throw new Error('SOURCE_EXISTS')
  const id = uid('src')
  get().prepare('INSERT INTO feed_source (id,url,title,group_id,interval_min,enabled,last_fetch_at,etag) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, url, dto.title || url, dto.groupId || null, dto.intervalMin || 60, 1, null, null)
  return camel(get().prepare('SELECT * FROM feed_source WHERE id = ?').get(id))
}

function addSource(dto) {
  return withTx(function () { return addSourceRaw(dto) })
}

function removeSource(id) {
  return withTx(function () {
    // feed_item 的外键声明为 ON DELETE CASCADE，文章随源一并清理，无需手动删除。
    get().prepare('DELETE FROM feed_source WHERE id = ?').run(id)
    return true
  })
}

function toggleSource(dto) {
  return withTx(function () {
    // bool() 把前端布尔值还原成 SQLite 的 0/1；读取时 camel 再转回 boolean。
    get().prepare('UPDATE feed_source SET enabled = ? WHERE id = ?').run(bool(dto.enabled), dto.id)
    return camel(get().prepare('SELECT * FROM feed_source WHERE id = ?').get(dto.id))
  })
}

// 修改订阅源：链接 / 标题 / 分组 / 频率；改链接时校验不与其他源重复，sourceId 不变，已抓文章不丢。
function updateSource(dto) {
  return withTx(function () {
    const cur = get().prepare('SELECT * FROM feed_source WHERE id = ?').get(dto.id)
    if (!cur) throw new Error('SOURCE_NOT_FOUND')
    const url = String(dto.url || cur.url).trim()
    if (!url) throw new Error('SOURCE_URL_REQUIRED')
    if (url !== cur.url) {
      const dup = get().prepare('SELECT id FROM feed_source WHERE url = ? AND id <> ?').get(url, dto.id)
      if (dup) throw new Error('SOURCE_EXISTS')
    }
    const title = String(dto.title || url).trim() || url
    const groupId = dto.groupId === undefined ? cur.group_id : (dto.groupId || null)
    const intervalMin = Number(dto.intervalMin) > 0 ? Math.round(Number(dto.intervalMin)) : cur.interval_min
    // 链接变了就清掉 etag / 抓取时间，下一次刷新才会真正重新拉全文，而不是命中旧条件请求。
    const sql = url !== cur.url
      ? 'UPDATE feed_source SET url = ?, title = ?, group_id = ?, interval_min = ?, etag = NULL, last_fetch_at = NULL WHERE id = ?'
      : 'UPDATE feed_source SET url = ?, title = ?, group_id = ?, interval_min = ? WHERE id = ?'
    get().prepare(sql).run(url, title, groupId, intervalMin, dto.id)
    return camel(get().prepare('SELECT * FROM feed_source WHERE id = ?').get(dto.id))
  })
}

// —— 文章 ——
function items(filter) {
  const f = filter || {}
  const where = ['1=1']
  const args = []
  if (f.sourceId) { where.push('i.source_id = ?'); args.push(f.sourceId) }
  if (f.group) { where.push('s.group_id = ?'); args.push(f.group) }
  // kind 决定状态过滤：三种视图各自命中一个布尔列，all 不做过滤。
  const kind = f.kind || 'all'
  if (kind === 'unread') where.push('i.read = 0')
  else if (kind === 'starred') where.push('i.starred = 1')
  else if (kind === 'later') where.push('i.read_later = 1')
  const sql = 'SELECT i.* FROM feed_item i LEFT JOIN feed_source s ON s.id = i.source_id WHERE ' + where.join(' AND ') + ' ORDER BY i.published_at DESC'
  return camelAll(get().prepare(sql).all(...args))
}

function markRead(id) {
  return withTx(function () {
    get().prepare('UPDATE feed_item SET read = 1 WHERE id = ?').run(id)
    return getItemRaw(id)
  })
}

function toggleStar(id) {
  return withTx(function () {
    const cur = get().prepare('SELECT starred FROM feed_item WHERE id = ?').get(id)
    if (!cur) throw new Error('FEED_ITEM_NOT_FOUND')
    get().prepare('UPDATE feed_item SET starred = ? WHERE id = ?').run(cur.starred ? 0 : 1, id)
    return getItemRaw(id)
  })
}

function toggleLater(id) {
  return withTx(function () {
    const cur = get().prepare('SELECT read_later FROM feed_item WHERE id = ?').get(id)
    if (!cur) throw new Error('FEED_ITEM_NOT_FOUND')
    get().prepare('UPDATE feed_item SET read_later = ? WHERE id = ?').run(cur.read_later ? 0 : 1, id)
    return getItemRaw(id)
  })
}

// —— 刷新：真实抓取 RSS / Atom ——
// 说明：网络请求必须放在 better-sqlite3 的同步事务之外，这里先并发抓取，再一次性写库。
const FETCH_TIMEOUT_MS = 12000
const MAX_ITEMS_PER_FETCH = 50
const FETCH_USER_AGENT = 'EfficiencyToolkit/1.0 (local RSS reader)'

// 去掉标签、还原实体，得到可直接排版的纯文本；段落用空行分隔，阅读器按空行分段。
function stripHtml(input) {
  if (input == null) return ''
  const withoutMarkup = String(input)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
  // 部分源把整段 HTML 做了实体转义（&lt;p&gt;），解码后还要再扒一遍标签
  const text = decodeXml(withoutMarkup)
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

// 取片段里第一个命名字段的文本，兼容带属性的开放标签与 CDATA。
function pickField(block, names) {
  for (let i = 0; i < names.length; i++) {
    const re = new RegExp('<' + names[i] + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + names[i] + '>', 'i')
    const m = re.exec(block)
    if (m) {
      const raw = m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim()
      if (raw) return raw
    }
  }
  return ''
}

// Atom 的 <link href="..."/> 是自闭合标签，要单独取属性。
function pickLink(block) {
  const plain = pickField(block, ['link'])
  if (plain) return decodeXml(plain)
  const m = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(block)
  return m ? decodeXml(m[1]) : ''
}

// RSS 用 RFC822、Atom 用 ISO8601，Date 都能解析；失败时回退到抓取时间。
function pickTime(block, fallback) {
  const raw = pickField(block, ['pubDate', 'published', 'updated', 'dc:date'])
  const ts = raw ? Date.parse(raw) : NaN
  return Number.isFinite(ts) ? ts : fallback
}

// 解析 feed 文本：RSS 2.0 / RSS 1.0 用 <item>，Atom 用 <entry>。
function parseFeedItems(xml) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || []
  const out = []
  const fetchedAt = now()
  for (let i = 0; i < blocks.length && out.length < MAX_ITEMS_PER_FETCH; i++) {
    const block = blocks[i]
    const title = stripHtml(pickField(block, ['title']))
    const link = pickLink(block)
    if (!title && !link) continue
    // guid 只认「源内稳定标识」：feed 自带 guid/id → 链接 → 标题+发布时间。
    // 绝不再掺抓取时间，否则每次刷新都会重复入库。
    const rawGuid = pickField(block, ['guid', 'id', 'dc:identifier'])
    const key = rawGuid || link || (title + '|' + pickField(block, ['pubDate', 'published', 'updated']))
    // 正文优先 content:encoded → content，摘要描述其次；RSS 的 description 往往是全文而不是摘要
    const encoded = pickField(block, ['content:encoded'])
    const full = encoded || pickField(block, ['content'])
    const description = pickField(block, ['description', 'summary'])
    const body = stripHtml(full || description)
    // Atom 的作者在 <author><name> 里，RSS 在 <author> / <dc:creator>；只取第一行，避免带出主页地址
    const author = stripHtml(pickField(block, ['dc:creator', 'name', 'author'])).split('\n')[0].trim()
    out.push({
      key: key,
      title: title || link,
      link: link || null,
      author: author || null,
      summary: (stripHtml(description) || body).slice(0, 240) || null,
      content: body || null,
      publishedAt: pickTime(block, fetchedAt)
    })
  }
  return out
}

// 带条件请求的抓取：命中 304 就只更新时间戳，不再解析。
async function fetchFeedXml(source) {
  const headers = {
    'user-agent': FETCH_USER_AGENT,
    accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8'
  }
  if (source.etag) headers['if-none-match'] = source.etag
  if (source.last_fetch_at) headers['if-modified-since'] = new Date(source.last_fetch_at).toUTCString()
  const controller = new AbortController()
  const timer = setTimeout(function () { controller.abort() }, FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(source.url, { headers: headers, signal: controller.signal, redirect: 'follow' })
    const etag = res.headers.get('etag') || source.etag || null
    if (res.status === 304) return { notModified: true, etag: etag, xml: '' }
    if (!res.ok) throw new Error('HTTP_' + res.status)
    return { notModified: false, etag: etag, xml: await res.text() }
  } finally {
    clearTimeout(timer)
  }
}

async function refresh(dto) {
  // 不传 sourceId 表示刷新全部启用的订阅源（对应「刷新全部」）
  const o = dto || {}
  const sources = o.sourceId
    ? get().prepare('SELECT * FROM feed_source WHERE id = ?').all(o.sourceId)
    : get().prepare('SELECT * FROM feed_source WHERE enabled = 1').all()
  if (!sources.length) throw new Error('SOURCE_NOT_FOUND')

  // 网络阶段：单个源失败只记账，不影响其他源
  const fetched = await Promise.all(sources.map(async function (source) {
    try {
      const r = await fetchFeedXml(source)
      return { source: source, ok: true, notModified: r.notModified, etag: r.etag, xml: r.xml }
    } catch (e) {
      logError('refresh.fetch', { sourceId: source.id, url: source.url }, e)
      return { source: source, ok: false, notModified: false, etag: source.etag, xml: '', error: String((e && e.message) || e) }
    }
  }))

  // 落库阶段：同步事务内完成，guid 幂等 + content_hash 判断是否需要更新
  return withTx(function () {
    const find = get().prepare('SELECT id, content_hash FROM feed_item WHERE source_id = ? AND guid = ?')
    const ins = get().prepare('INSERT INTO feed_item (id,source_id,guid,title,link,author,summary,content,published_at,read,starred,read_later,content_hash) VALUES (?,?,?,?,?,?,?,?,?,0,0,0,?)')
    const upd = get().prepare('UPDATE feed_item SET title = ?, link = ?, author = ?, summary = ?, content = ?, published_at = ?, content_hash = ? WHERE id = ?')
    const touch = get().prepare('UPDATE feed_source SET last_fetch_at = ?, etag = ? WHERE id = ?')
    const at = now()
    let added = 0, updated = 0, skipped = 0, failed = 0
    fetched.forEach(function (r) {
      if (!r.ok) { failed += 1; return }
      if (r.notModified) { skipped += 1; touch.run(at, r.etag, r.source.id); return }
      if (/^\s*<(!doctype\s+html|html)/i.test(r.xml)) {
        failed += 1
        logError('refresh.notFeed', { sourceId: r.source.id, url: r.source.url }, new Error('RETURNED_HTML'))
        return
      }
      const seen = {}
      parseFeedItems(r.xml).forEach(function (a) {
        const guid = hash(a.key)
        if (seen[guid]) return
        seen[guid] = true
        const contentHash = hash(a.content || a.title || '')
        const hit = find.get(r.source.id, guid)
        if (!hit) {
          ins.run(uid('item'), r.source.id, guid, a.title, a.link, a.author, a.summary, a.content, a.publishedAt, contentHash)
          added += 1
        } else if (hit.content_hash !== contentHash) {
          upd.run(a.title, a.link, a.author, a.summary, a.content, a.publishedAt, contentHash, hit.id)
          updated += 1
        }
      })
      touch.run(at, r.etag, r.source.id)
    })
    return { added: added, updated: updated, skipped: skipped, failed: failed }
  })
}

// —— OPML 导入导出 ——
// 从 outline 属性串里取属性值，兼容单双引号与大小写，并做实体解码。
function attr(attrs, name) {
  var m = new RegExp(name + "\\s*=\\s*\"([^\"]*)\"", 'i').exec(attrs)
  if (!m) m = new RegExp(name + "\\s*=\\s*'([^']*)'", 'i').exec(attrs)
  return m ? decodeXml(m[1]) : ''
}

function importOPML(dto) {
  return withTx(function () {
    const text = String(dto.text || '')
    const outlines = text.match(/<outline\b[\s\S]*?\/?>/gi) || []
    let count = 0
    outlines.forEach(function (tag) {
      const attrs = tag.replace(/^<outline\b/i, '').replace(/\/?>$/, '')
      const xmlUrl = attr(attrs, 'xmlUrl')
      if (!xmlUrl) return // 纯分组 outline 没有 xmlUrl，直接跳过。
      const title = attr(attrs, 'text') || attr(attrs, 'title') || xmlUrl
      try {
        addSourceRaw({ url: xmlUrl, title: title, groupId: null, intervalMin: 60 })
        count += 1
      } catch (e) {
        // url 重复属于预期情况静默跳过；其余异常记录日志后继续导入。
        if (e.message !== 'SOURCE_EXISTS' && e.message !== 'SOURCE_URL_REQUIRED') logError('importOPML', { url: xmlUrl }, e)
      }
    })
    return count
  })
}

function exportOPML() {
  const gs = groups()
  const ss = sources()
  const lines = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<opml version="2.0">')
  lines.push('  <head><title>信息流订阅</title></head>')
  lines.push('  <body>')
  // 先按分组输出订阅源，未分组的源单独放在 body 下。
  gs.forEach(function (g) {
    const list = ss.filter(function (s) { return s.groupId === g.id })
    if (!list.length) return
    lines.push('    <outline text="' + escapeXml(g.name) + '" title="' + escapeXml(g.name) + '">')
    list.forEach(function (s) {
      lines.push('      <outline type="rss" text="' + escapeXml(s.title || s.url) + '" title="' + escapeXml(s.title || s.url) + '" xmlUrl="' + escapeXml(s.url) + '" />')
    })
    lines.push('    </outline>')
  })
  ss.filter(function (s) { return !s.groupId }).forEach(function (s) {
    lines.push('    <outline type="rss" text="' + escapeXml(s.title || s.url) + '" title="' + escapeXml(s.title || s.url) + '" xmlUrl="' + escapeXml(s.url) + '" />')
  })
  lines.push('  </body>')
  lines.push('</opml>')
  return lines.join('\n')
}

module.exports = {
  groups: groups, addGroup: addGroup, sources: sources, addSource: addSource,
  removeSource: removeSource, toggleSource: toggleSource, updateSource: updateSource, items: items,
  markRead: markRead, toggleStar: toggleStar, toggleLater: toggleLater,
  refresh: refresh, importOPML: importOPML, exportOPML: exportOPML
}

