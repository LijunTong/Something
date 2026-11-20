// 文件日志：按天切分、限制单文件大小、敏感字段脱敏。
// 日志目录：<userData>/logs，与数据库同处。
const fs = require('node:fs')
const path = require('node:path')

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_BYTES = 5 * 1024 * 1024
const KEEP_DAYS = 14

let logDir = null
let currentFile = null
let minLevel = LEVELS.info

const SECRET_KEYS = ['password', 'passwd', 'secret', 'token', 'authcode', 'auth_code', 'credential', 'apikey', 'api_key', 'cookie', 'authorization']

function isSecretKey(k) {
  const low = String(k).toLowerCase()
  return SECRET_KEYS.some(function (s) { return low.includes(s) })
}

function redact(value, depth) {
  const d = depth || 0
  if (d > 6 || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.slice(0, 50).map(function (v) { return redact(v, d + 1) })
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) {
      out[k] = isSecretKey(k) ? '***' : redact(value[k], d + 1)
    }
    return out
  }
  if (typeof value === 'string' && value.length > 2000) return value.slice(0, 2000) + '...[truncated]'
  return value
}

function pad(n) { return String(n).padStart(2, '0') }
function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
function timestamp(ts) {
  const d = new Date(ts)
  return dayKey(ts) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

// 同步写入：日志量小、必须保证异常时能落盘，异步流在进程崩溃时会丢日志。
function openFile(file) {
  currentFile = file
}

function append(line) {
  if (!currentFile) return false
  try {
    fs.appendFileSync(currentFile, line + '\n')
    return true
  } catch (e) {
    return false
  }
}

function rotateIfNeeded() {
  const file = path.join(logDir, 'app-' + dayKey(Date.now()) + '.log')
  if (file !== currentFile) { openFile(file); return }
  try {
    const st = fs.statSync(currentFile)
    if (st.size > MAX_BYTES) {
      const bak = currentFile.replace(/\.log$/, '') + '-' + Date.now() + '.log'
      fs.renameSync(currentFile, bak)
      openFile(file)
    }
  } catch (e) {}
}

function cleanup() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400000
    for (const f of fs.readdirSync(logDir)) {
      if (!f.endsWith('.log')) continue
      const full = path.join(logDir, f)
      try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full) } catch (e) {}
    }
  } catch (e) {}
}

function init(userDataPath, opts) {
  const o = opts || {}
  logDir = path.join(userDataPath, 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  if (o.level && LEVELS[o.level]) minLevel = LEVELS[o.level]
  rotateIfNeeded()
  cleanup()
  write('info', 'app', 'logger_started', { dir: logDir, level: o.level || 'info' })
  return logDir
}

function write(level, scope, message, meta) {
  const lv = LEVELS[level] || LEVELS.info
  if (lv < minLevel) return
  let line = timestamp(Date.now()) + ' [' + level.toUpperCase().padEnd(5) + '] [' + scope + '] ' + message
  if (meta !== undefined && meta !== null) {
    try { line += ' ' + JSON.stringify(redact(meta)) } catch (e) { line += ' [meta unserializable]' }
  }
  if (!logDir) { console.log(line); return }
  try {
    rotateIfNeeded()
    if (!append(line)) console.log(line)
  } catch (e) { console.log(line) }
}

function error(scope, message, err, meta) {
  const payload = Object.assign({}, meta)
  if (err) {
    payload.errorName = err.name || 'Error'
    payload.errorMessage = err.message || String(err)
    if (err.stack) payload.stack = String(err.stack).split('\n').slice(0, 12).join('\n')
    if (err.code) payload.errorCode = err.code
  }
  write('error', scope, message, payload)
}

// 同步写入无需 flush，保留空实现以兼容调用方
function flush() {}
function currentPath() { return currentFile }
function directory() { return logDir }
function listFiles() {
  if (!logDir) return []
  try {
    return fs.readdirSync(logDir)
      .filter(function (f) { return f.endsWith('.log') })
      .map(function (f) { return path.join(logDir, f) })
      .sort().reverse()
  } catch (e) { return [] }
}

module.exports = {
  init: init, write: write, error: error,
  debug: function (s, m, x) { write('debug', s, m, x) },
  info: function (s, m, x) { write('info', s, m, x) },
  warn: function (s, m, x) { write('warn', s, m, x) },
  flush: flush, currentPath: currentPath, directory: directory, listFiles: listFiles
}
