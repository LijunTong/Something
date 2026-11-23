// 最小 MCP Streamable HTTP 服务：仅监听 127.0.0.1，单端点 /mcp，JSON-RPC 2.0。
// 只实现 tools 能力，不维护 session、不提供 SSE：响应一律 application/json + no-store。
const http = require('node:http')
const crypto = require('node:crypto')

const PROTOCOL = '2025-06-18'
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BODY = 1024 * 1024

let deps = null
let server = null
const state = { port: null, startedAt: null, calls: 0, lastCallAt: null, lastTool: null, lastError: null }

function init(d) { deps = d }

function status() {
  return {
    running: !!(server && server.listening),
    port: state.port,
    endpoint: state.port ? 'http://127.0.0.1:' + state.port + '/mcp' : null,
    calls: state.calls,
    startedAt: state.startedAt,
    lastCallAt: state.lastCallAt,
    lastTool: state.lastTool,
    lastError: state.lastError
  }
}

function stop() {
  const s = server
  server = null
  if (s) { try { s.close() } catch (e) { /* 已关闭 */ } }
  state.port = null
  state.startedAt = null
}

function log(level, msg, meta) {
  try { if (deps && deps.log) deps.log(level, msg, meta) } catch (e) { /* 日志失败不影响请求 */ }
}

function sendJson(res, code, body, headers) {
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, headers || {}))
  res.end(JSON.stringify(body))
}

function sendEmpty(res, code, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}))
  res.end()
}

function hostnameOf(host) {
  const text = String(host || '').trim().toLowerCase()
  if (!text) return ''
  if (text.charAt(0) === '[') {
    const end = text.indexOf(']')
    return end > 0 ? text.slice(0, end + 1) : text
  }
  return text.split(':')[0]
}

function isLocalHost(host) {
  const name = hostnameOf(host)
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

function isLocalOrigin(origin) {
  try {
    const u = new URL(String(origin))
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLocalHost(u.hostname)
  } catch (e) {
    return false
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8')
  const y = Buffer.from(String(b || ''), 'utf8')
  if (!x.length || x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

function withTimeout(promise, ms) {
  let timer = null
  const timeout = new Promise(function (resolve, reject) {
    timer = setTimeout(function () { reject(new Error('TOOL_TIMEOUT')) }, ms)
  })
  return Promise.race([promise, timeout]).finally(function () { if (timer) clearTimeout(timer) })
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: code, message: message } }
}

function pickProtocol(asked) {
  return SUPPORTED.indexOf(String(asked || '')) >= 0 ? String(asked) : PROTOCOL
}

async function handleRpc(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request')
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg.id, -32600, 'Invalid Request')
  const method = msg.method
  const isNotification = !Object.prototype.hasOwnProperty.call(msg, 'id')
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {}
  let result = null
  let error = null

  if (method === 'initialize') {
    result = {
      protocolVersion: pickProtocol(params.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'something-plan', title: '几件事 · 项目计划', version: (deps && deps.version) || '1.0.0' },
      instructions: '这是本机待办应用的项目计划接口。一个项目对应一个清单，计划条目是待办。写入前建议先调用 project_plan_read 或 project_plan_list 确认已有 key；重复提交时保持 item.key 稳定，未显式提交的状态不会被覆盖。'
    }
  } else if (method.indexOf('notifications/') === 0) {
    return null
  } else if (method === 'ping') {
    result = {}
  } else if (method === 'tools/list') {
    result = { tools: deps.listTools() }
  } else if (method === 'tools/call') {
    const name = String(params.name || '')
    if (!name) error = { code: -32602, message: 'Missing tool name' }
    else {
      const started = Date.now()
      try {
        const out = await withTimeout(Promise.resolve().then(function () {
          return deps.callTool(name, params.arguments || {})
        }), 20000)
        state.calls += 1
        state.lastCallAt = Date.now()
        state.lastTool = name
        log('info', 'tool_call', { name: name, ok: !out.isError, ms: Date.now() - started, counts: out.counts })
        result = { content: [{ type: 'text', text: out.text }], isError: !!out.isError }
      } catch (e) {
        error = { code: -32603, message: '工具执行失败：' + ((e && e.message) || String(e)) }
      }
    }
  } else {
    error = { code: -32601, message: 'Method not found: ' + method }
  }

  if (isNotification) return null
  if (error) return rpcError(msg.id, error.code, error.message)
  return { jsonrpc: '2.0', id: msg.id, result: result }
}

function readBody(req, res, cb) {
  let size = 0
  let aborted = false
  const chunks = []
  req.on('data', function (chunk) {
    if (aborted) return
    size += chunk.length
    if (size > MAX_BODY) {
      aborted = true
      sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32000, message: '请求体超过 1 MiB' } })
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', function () {
    if (!aborted) cb(Buffer.concat(chunks).toString('utf8'))
  })
  req.on('error', function () { /* 连接中断：无需再响应 */ })
}

function onRequest(req, res) {
  if (!isLocalHost(req.headers.host)) return sendJson(res, 403, { error: 'forbidden host' })
  if (req.headers.origin && !isLocalOrigin(req.headers.origin)) return sendJson(res, 403, { error: 'forbidden origin' })
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'POST' })
  let pathname = ''
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname } catch (e) { pathname = '' }
  if (pathname !== '/mcp') return sendJson(res, 404, { error: 'not found' })

  const expected = deps && deps.getToken ? String(deps.getToken() || '') : ''
  const matched = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))
  if (!expected || !matched || !safeEqual(matched[1].trim(), expected)) {
    return sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
  }

  const ctype = String(req.headers['content-type'] || '')
  if (!/^application\/json\b/i.test(ctype)) return sendJson(res, 415, { error: 'content-type must be application/json' })

  readBody(req, res, function (text) {
    let payload = null
    try { payload = JSON.parse(text) } catch (e) {
      return sendJson(res, 400, rpcError(null, -32700, 'Parse error'))
    }
    const batch = Array.isArray(payload)
    const list = batch ? payload : [payload]
    Promise.all(list.map(handleRpc)).then(function (outs) {
      const replies = outs.filter(function (x) { return x != null })
      if (!replies.length) return sendEmpty(res, 202)
      return sendJson(res, 200, batch ? replies : replies[0])
    }).catch(function (e) {
      sendJson(res, 500, rpcError(null, -32603, 'Internal error: ' + ((e && e.message) || String(e))))
    })
  })
}

function start(port) {
  const p = Number(port)
  if (!Number.isInteger(p) || p < 1024 || p > 65535) return Promise.resolve({ ok: false, error: 'PORT_INVALID: 端口需在 1024-65535 之间' })
  stop()
  return new Promise(function (resolve) {
    const s = http.createServer(onRequest)
    let settled = false
    function done(r) { if (!settled) { settled = true; resolve(r) } }
    s.once('error', function (e) {
      state.lastError = 'START_FAILED: ' + ((e && e.message) || String(e))
      try { s.close() } catch (err) { /* ignore */ }
      if (server === s) server = null
      done({ ok: false, error: state.lastError })
    })
    s.listen(p, '127.0.0.1', function () {
      server = s
      state.port = p
      state.startedAt = Date.now()
      state.lastError = null
      log('info', 'started', { port: p })
      done({ ok: true, port: p })
    })
  })
}

module.exports = { init: init, start: start, stop: stop, status: status }
