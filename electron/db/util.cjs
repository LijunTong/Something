// 通用工具：ID、时间、行转换
const crypto = require('node:crypto')

function uid(prefix) {
  return (prefix ? prefix + '_' : '') + crypto.randomUUID().replace(/-/g, '').slice(0, 20)
}

function now() { return Date.now() }

/** 下划线字段转驼峰；布尔字段按 table 约定还原 */
// 这些列在 SQLite 里存 INTEGER(0/1)，读取时统一转成布尔。
// 注意：判断要基于「转换后的驼峰名」，否则 SQL 别名（如 AS calendar_visible）
// 不会被识别，会漏成数字 0/1，进而让 visible !== false 这类判断失效。
const BOOL_FIELDS = new Set([
  'done', 'all_day', 'enabled', 'read', 'starred', 'important',
  'archived', 'privacy_masked', 'has_attach', 'is_home', 'is_default', 'read_later'
])
// 带前缀的别名也要覆盖，如 calendarVisible / folderVisible
// 裸列名（visible/done/...）与带前缀别名（calendarVisible/...）都要覆盖
const BOOL_SUFFIX = /(Visible|Done|Enabled|Read|Starred|Important|Archived|ReadLater|HasAttach|IsHome|IsDefault|AllDay)$/i

function camel(row) {
  if (!row) return null
  const out = {}
  for (const k in row) {
    const ck = k.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase() })
    // 用驼峰名判断，兼容 SQL 别名
    out[ck] = (BOOL_FIELDS.has(k) || BOOL_SUFFIX.test(ck)) ? !!row[k] : row[k]
  }
  return out
}

function camelAll(rows) { return rows.map(camel) }

function bool(v) { return v ? 1 : 0 }

module.exports = { uid: uid, now: now, camel: camel, camelAll: camelAll, bool: bool }
