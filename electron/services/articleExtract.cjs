// 信息流正文提取：自研轻量 Readability（不引入第三方依赖）。
// 输入整页 HTML，按「文本密度 + 段落数 + 容器语义」打分，选正文容器并清掉站点外框，
// 输出可直接给阅读器渲染的 HTML 与段落文本；提取不出可信正文时返回 null，由调用方回退 RSS 内容。
'use strict'

// 无闭合标签的元素：解析时不能压栈
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
])
// 内容按原始文本读取的元素：内部尖括号不当标签
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'noscript'])
// 整段丢弃：脚本、框架、表单控件、导航与页脚等外框
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe', 'object', 'embed', 'svg', 'canvas',
  'form', 'input', 'button', 'select', 'textarea', 'nav', 'header', 'footer',
  'aside', 'dialog', 'video', 'audio', 'map', 'template'
])
// 阅读器允许保留的标签：其余标签打散成文本
const KEEP_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'code', 'figure', 'figcaption', 'img', 'table', 'thead', 'tbody',
  'tr', 'td', 'th', 'a', 'strong', 'b', 'em', 'i', 'u', 'del', 'br', 'hr',
  'span', 'div', 'section', 'article'
])
// 块级标签：输出纯文本时用来断段
const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'figure', 'figcaption', 'table', 'tr', 'td', 'th', 'div', 'section',
  'article', 'br', 'hr'
])
// 容器语义权重：命中正负词分别加减分
const POSITIVE_RE = /article|content|post|entry|main|text|body|read|story|blog|markdown|prose|editor/i
const NEGATIVE_RE = /comment|share|social|related|recommend|advert|sponsor|sidebar|side-bar|nav|menu|footer|header|breadcrumb|copyright|subscribe|newsletter|pagination|toolbar|banner|popup|modal|login|widget|meta|caption|tag-list|tool|author-box/i

const MAX_SCAN_NODES = 20000

/** 实体解码：数字实体按码点处理，避免 emoji 被截成乱码 */
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function (all, body) {
    const key = body.toLowerCase()
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10)
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return all
      try { return String.fromCodePoint(code) } catch (e) { return all }
    }
    switch (key) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      case 'nbsp': return ' '
      case 'mdash': return '—'
      case 'ndash': return '–'
      case 'hellip': return '…'
      case 'ldquo': return '“'
      case 'rdquo': return '”'
      case 'lsquo': return '‘'
      case 'rsquo': return '’'
      case 'middot': return '·'
      default: return all
    }
  })
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 找开始标签的右尖括号：跳过引号内的 > */
function findTagEnd(src, from) {
  let quote = ''
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '>') return i
  }
  return -1
}

/** 解析属性串；值统一实体解码 */
function parseAttrs(raw) {
  const attrs = {}
  const re = /([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let m
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase()
    const value = m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] != null ? m[5] : ''))
    attrs[name] = decodeEntities(value)
  }
  return attrs
}

/** 把整页 HTML 解析成节点树：root -> element/text，属性名小写 */
function parseHtml(html) {
  const src = String(html || '')
  const root = { type: 'root', tag: '#root', attrs: {}, children: [], parent: null }
  let cur = root
  let i = 0
  let guard = 0

  function pushText(raw) {
    if (!raw) return
    const text = decodeEntities(raw)
    if (!text) return
    cur.children.push({ type: 'text', text: text, parent: cur })
  }

  while (i < src.length && guard++ < MAX_SCAN_NODES * 20) {
    const lt = src.indexOf('<', i)
    if (lt < 0) { pushText(src.slice(i)); break }
    if (lt > i) pushText(src.slice(i, lt))
    // 注释 / doctype / 处理指令：直接跳过
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end < 0 ? src.length : end + 3
      continue
    }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      const end = src.indexOf('>', lt)
      i = end < 0 ? src.length : end + 1
      continue
    }
    // 结束标签：弹栈到最近的同名节点
    if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt)
      if (end < 0) break
      const tag = src.slice(lt + 2, end).trim().toLowerCase().split(/\s+/)[0]
      let node = cur
      while (node && node !== root && node.tag !== tag) node = node.parent
      if (node && node !== root) cur = node.parent
      i = end + 1
      continue
    }
    const end = findTagEnd(src, lt + 1)
    if (end < 0) break
    const raw = src.slice(lt + 1, end)
    const m = /^([a-zA-Z][\w:-]*)/.exec(raw)
    if (!m) { i = end + 1; continue }
    const tag = m[1].toLowerCase()
    const node = { type: 'element', tag: tag, attrs: parseAttrs(raw.slice(m[1].length)), children: [], parent: cur }
    cur.children.push(node)
    i = end + 1
    if (VOID_TAGS.has(tag) || /\/\s*$/.test(raw)) continue
    // script/style 等按原始文本吞到对应结束标签
    if (RAW_TEXT_TAGS.has(tag)) {
      const closeRe = new RegExp('</\\s*' + tag + '\\s*>', 'ig')
      closeRe.lastIndex = i
      const cm = closeRe.exec(src)
      const stop = cm ? cm.index : src.length
      const text = src.slice(i, stop)
      if (text) node.children.push({ type: 'text', text: text, parent: node })
      i = cm ? cm.index + cm[0].length : src.length
      continue
    }
    cur = node
  }
  return root
}

// —— 文本与结构度量（结果缓存到节点上，避免重复递归）——
function textOf(node) {
  if (node.type === 'text') return node.text
  if (node._text != null) return node._text
  let out = ''
  for (let i = 0; i < node.children.length; i++) out += textOf(node.children[i])
  node._text = out
  return out
}

function textLen(node) {
  if (node._len != null) return node._len
  node._len = textOf(node).replace(/\s+/g, ' ').trim().length
  return node._len
}

function linkLen(node) {
  if (node.type === 'text') return 0
  if (node._link != null) return node._link
  let n = 0
  if (node.tag === 'a') n += textLen(node)
  else for (let i = 0; i < node.children.length; i++) n += linkLen(node.children[i])
  node._link = n
  return n
}

/** 统计某类标签出现次数（如段落数），用于判断是不是正文块 */
function countTag(node, tags) {
  if (node.type === 'text') return 0
  let n = tags.has(node.tag) ? 1 : 0
  for (let i = 0; i < node.children.length; i++) n += countTag(node.children[i], tags)
  return n
}

const PARA_TAGS = new Set(['p', 'pre', 'blockquote', 'li', 'td', 'h2', 'h3'])
const IMG_TAGS = new Set(['img'])

function classId(node) {
  return String((node.attrs && (node.attrs.class || '')) + ' ' + (node.attrs && (node.attrs.id || '')))
}

/** 节点是否隐藏：display:none / hidden / aria-hidden */
function isHidden(node) {
  const a = node.attrs || {}
  if ('hidden' in a) return true
  if (a['aria-hidden'] === 'true') return true
  const style = String(a.style || '').replace(/\s+/g, '').toLowerCase()
  return style.indexOf('display:none') >= 0 || style.indexOf('visibility:hidden') >= 0
}

/** 链接密度：链接文字占全文比例，导航/相关阅读通常 > 0.5 */
function linkDensity(node) {
  const len = textLen(node)
  return len ? linkLen(node) / len : 1
}

/** 去噪：删脚本/框架/表单/隐藏节点，以及「负语义 + 短文本或高链接密度」的站点外框 */
function stripNoise(node) {
  const kids = node.children || []
  for (let i = kids.length - 1; i >= 0; i--) {
    const child = kids[i]
    if (child.type !== 'element') continue
    if (DROP_TAGS.has(child.tag) || isHidden(child)) { kids.splice(i, 1); continue }
    const len = textLen(child)
    const negative = NEGATIVE_RE.test(classId(child))
    // 正文容器也可能叫 content-comments 之类，所以负语义只在「短文本或全是链接」时判死
    if (negative && (len < 400 || linkDensity(child) > 0.5)) { kids.splice(i, 1); continue }
    stripNoise(child)
  }
}

const CANDIDATE_TAGS = new Set([
  'div', 'section', 'article', 'main', 'p', 'td', 'pre', 'blockquote', 'li', 'body'
])

/**
 * 打分：文本越长、段落越多、图片越多分越高；class/id 命中正负语义加减分；
 * 分数向父级（1/2）与祖父级（1/4）传播，避免正文被切在更深一层时选中空壳容器。
 */
function scoreTree(root) {
  const scores = new Map()
  function add(node, delta) {
    if (!node || node.type === 'root') return
    scores.set(node, (scores.get(node) || 0) + delta)
  }
  function walk(node) {
    if (node.type !== 'text' && node.children) {
      for (let i = 0; i < node.children.length; i++) walk(node.children[i])
    }
    if (node.type !== 'element') return
    if (!CANDIDATE_TAGS.has(node.tag)) return
    const len = textLen(node)
    if (len < 40) return
    const density = linkDensity(node)
    if (density > 0.5) return
    const pCount = countTag(node, PARA_TAGS)
    const imgCount = countTag(node, IMG_TAGS)
    let score = Math.min(3, Math.floor(len / 120)) + pCount * 3 + Math.min(6, imgCount)
    const cls = classId(node)
    if (POSITIVE_RE.test(cls)) score += 25
    if (NEGATIVE_RE.test(cls)) score -= 25
    add(node, score)
    add(node.parent, score / 2)
    if (node.parent) add(node.parent.parent, score / 4)
  }
  walk(root)
  return scores
}

/** 选正文容器：最高分节点；并列时取文本更长的 */
function pickBest(scores) {
  let best = null
  let bestScore = 0
  scores.forEach(function (score, node) {
    if (score > bestScore || (score === bestScore && best && textLen(node) > textLen(best))) {
      best = node
      bestScore = score
    }
  })
  return best
}

/** 正文常被切成「导语 + 小标题 + 段落」多个并列块：向上合并到能覆盖大部分文本的祖先 */
function liftContainer(best) {
  let node = best
  for (let depth = 0; depth < 3 && node && node.parent && node.parent.type === 'element'; depth++) {
    const parent = node.parent
    const parentLen = textLen(parent)
    const nodeLen = textLen(node)
    if (parentLen <= nodeLen * 1.35 && parentLen - nodeLen < 1200) node = parent
    else break
  }
  return node
}

/** 兄弟补全：同一父级下与正文同级的段落/列表也属于正文 */
function withSiblings(node) {
  const parent = node.parent
  if (!parent || parent.type !== 'element') return node
  const wrapper = { type: 'element', tag: 'div', attrs: {}, children: [], parent: parent, _synthetic: true }
  parent.children.forEach(function (child) {
    if (child === node) { wrapper.children.push(child); return }
    if (child.type !== 'element') return
    if (child.tag === 'p' || child.tag === 'div' || child.tag === 'section') {
      const len = textLen(child)
      if (len >= 80 && linkDensity(child) < 0.35) wrapper.children.push(child)
    }
  })
  return wrapper.children.length > 1 ? wrapper : node
}

function absUrl(base, href) {
  const raw = String(href || '').trim()
  if (!raw || /^(javascript|vbscript|file|data):/i.test(raw)) return ''
  try {
    return new URL(raw, base || 'https://example.invalid/').href
  } catch (e) {
    return /^https?:/i.test(raw) ? raw : ''
  }
}

/** 懒加载图片：优先 data-src 系列，src 是占位图时也要换掉 */
function pickImgSrc(attrs) {
  const keys = ['data-src', 'data-original', 'data-actualsrc', 'data-lazy-src', 'data-url', 'src']
  for (let i = 0; i < keys.length; i++) {
    const v = String(attrs[keys[i]] || '').trim()
    if (!v) continue
    if (/^data:image\/(gif|svg)/i.test(v) && v.length < 2000) continue
    return v
  }
  const srcset = String(attrs.srcset || '').split(',')[0].trim().split(/\s+/)[0]
  return srcset || ''
}

/** 只含行内内容的 div/span 转成段落，避免阅读器里出现大量空块 */
function hasBlockChild(node) {
  return node.children.some(function (c) {
    return c.type === 'element' && (BLOCK_TAGS.has(c.tag) || c.tag === 'img' || c.tag === 'figure')
  })
}

function cleanAttrs(node, base) {
  const out = {}
  if (node.tag === 'a') {
    const href = absUrl(base, node.attrs.href)
    if (!href) return null
    out.href = href
  } else if (node.tag === 'img') {
    const src = absUrl(base, pickImgSrc(node.attrs))
    if (!src) return null
    out.src = src
    if (node.attrs.alt) out.alt = node.attrs.alt
  } else if (node.tag === 'td' || node.tag === 'th') {
    if (node.attrs.colspan && /^\d+$/.test(node.attrs.colspan)) out.colspan = node.attrs.colspan
    if (node.attrs.rowspan && /^\d+$/.test(node.attrs.rowspan)) out.rowspan = node.attrs.rowspan
  }
  return out
}

/** 序列化正文：只留白名单标签与属性；打散的容器标签递归输出子节点 */
function serialize(node, base, out) {
  if (node.type === 'text') {
    const text = String(node.text || '')
    if (text.trim()) out.push(escapeHtml(text.replace(/\s+/g, ' ')))
    return
  }
  if (node.type !== 'element') return
  const tag = node.tag === 'div' && !hasBlockChild(node) ? 'p' : node.tag
  if (!KEEP_TAGS.has(tag)) {
    for (let i = 0; i < node.children.length; i++) serialize(node.children[i], base, out)
    return
  }
  const attrs = cleanAttrs(node, base)
  if (attrs === null) return
  if (tag === 'img' || tag === 'br' || tag === 'hr') {
    const attrText = Object.keys(attrs).map(function (k) { return ' ' + k + '="' + escapeHtml(attrs[k]) + '"' }).join('')
    out.push('<' + tag + attrText + '>')
    return
  }
  const inner = []
  for (let i = 0; i < node.children.length; i++) serialize(node.children[i], base, inner)
  const body = inner.join('').trim()
  // 空段落、只有空白与换行的容器不输出
  if (!body && tag !== 'td' && tag !== 'th') return
  const attrText = Object.keys(attrs).map(function (k) { return ' ' + k + '="' + escapeHtml(attrs[k]) + '"' }).join('')
  out.push('<' + tag + attrText + '>' + body + '</' + tag + '>')
}

/** 纯文本：块级标签处断段，去掉重复空行 */
function toParagraphs(node, out, buf) {
  if (node.type === 'text') {
    const text = String(node.text || '').replace(/\s+/g, ' ')
    if (text.trim()) buf.push(text.trim())
    return
  }
  if (node.type !== 'element') return
  if (node.tag === 'br') { buf.push('\n'); return }
  if (BLOCK_TAGS.has(node.tag)) {
    if (buf.length) { out.push(buf.join(' ').replace(/\s+/g, ' ').trim()); buf.length = 0 }
    for (let i = 0; i < node.children.length; i++) toParagraphs(node.children[i], out, buf)
    if (buf.length) { out.push(buf.join(' ').replace(/\s+/g, ' ').trim()); buf.length = 0 }
    return
  }
  for (let i = 0; i < node.children.length; i++) toParagraphs(node.children[i], out, buf)
}

function findTitle(root) {
  let og = ''
  let h1 = ''
  let title = ''
  function walk(node) {
    if (node.type !== 'element') {
      for (let i = 0; i < (node.children || []).length; i++) walk(node.children[i])
      return
    }
    if (node.tag === 'meta' && /^og:title$/i.test(node.attrs.property || '')) og = node.attrs.content || ''
    if (node.tag === 'title' && !title) title = textOf(node).trim()
    if (node.tag === 'h1' && !h1) h1 = textOf(node).trim()
    for (let i = 0; i < node.children.length; i++) walk(node.children[i])
  }
  walk(root)
  return (og || h1 || title || '').replace(/\s+/g, ' ').trim()
}

/**
 * 主入口：整页 HTML → 正文
 * @param {string} html 原始页面
 * @param {string} url 页面地址（解析相对链接 / 图片）
 * @returns {{ title: string, html: string, text: string, chars: number } | null}
 */
function extractArticle(html, url) {
  const raw = String(html || '')
  if (!raw || raw.length < 200) return null
  const root = parseHtml(raw)
  stripNoise(root)
  const scores = scoreTree(root)
  let best = pickBest(scores)
  if (!best) return null
  best = liftContainer(best)
  best = withSiblings(best)
  const parts = []
  for (let i = 0; i < best.children.length; i++) serialize(best.children[i], url, parts)
  const bodyHtml = parts.join('\n').trim()
  if (!bodyHtml) return null
  const paragraphs = []
  const buf = []
  for (let i = 0; i < best.children.length; i++) toParagraphs(best.children[i], paragraphs, buf)
  if (buf.length) paragraphs.push(buf.join(' ').replace(/\s+/g, ' ').trim())
  const text = paragraphs.filter(Boolean).join('\n\n')
  return { title: findTitle(root), html: bodyHtml, text: text, chars: text.replace(/\s+/g, '').length }
}

module.exports = { extractArticle: extractArticle, parseHtml: parseHtml, _debug: { stripNoise: stripNoise, scoreTree: scoreTree, textLen: textLen, classId: classId, serialize: serialize } }
