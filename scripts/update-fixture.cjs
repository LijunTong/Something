#!/usr/bin/env node
'use strict'
// 开发期假 GitHub release 服务：只给 npm run verify:update 用，跑在本机回环上。
// 返回和 GitHub API /releases/latest 同形状的 JSON，并提供可流式下载的假安装包，
// 用来验证「检查更新 → 下载 → 就绪」在真实网络栈上的行为（不联网、不装包）。
const http = require('node:http')
const fs = require('node:fs')

const MB = 1024 * 1024

function parseArgs(argv) {
  const opt = {
    port: 9911,
    version: '9.9.9',
    size: 20 * MB,
    bodyFile: '',
    chunkDelay: 150,
    fail: ''
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') opt.port = Number(argv[++i])
    else if (a === '--version') opt.version = String(argv[++i] || opt.version)
    else if (a === '--size') opt.size = Number(argv[++i])
    else if (a === '--body-file') opt.bodyFile = String(argv[++i] || '')
    else if (a === '--chunk-delay') opt.chunkDelay = Number(argv[++i])
    else if (a === '--fail') opt.fail = String(argv[++i] || '')
  }
  if (!Number.isFinite(opt.port) || opt.port <= 0) opt.port = 9911
  if (!Number.isFinite(opt.size) || opt.size < 0) opt.size = 20 * MB
  if (!Number.isFinite(opt.chunkDelay) || opt.chunkDelay < 0) opt.chunkDelay = 150
  return opt
}

const opt = parseArgs(process.argv.slice(2))
const stats = { latest: 0, setup: 0, stats: 0, lastUserAgent: '' }

function defaultNotes() {
  return [
    '### 新增',
    '',
    '- 更新弹窗分步展示版本信息与更新日志',
    '- 下载完成后由用户确认再安装',
    '',
    '### 修复',
    '',
    '- 修复下载中关闭弹窗后进度丢失的问题',
    '',
    '### 优化',
    '',
    '- 安装完成后自动重新打开应用'
  ].join('\n')
}

function notesBody() {
  if (!opt.bodyFile) return defaultNotes()
  try {
    return fs.readFileSync(opt.bodyFile, 'utf8')
  } catch (e) {
    console.error('[fixture] cannot read body file: ' + opt.bodyFile)
    return defaultNotes()
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length)
  })
  res.end(body)
}

function releasePayload(base) {
  return {
    tag_name: 'v' + opt.version,
    name: 'v' + opt.version,
    body: notesBody(),
    draft: false,
    prerelease: false,
    published_at: '2026-11-27T08:00:00Z',
    html_url: base + '/releases/tag/v' + opt.version,
    assets: [
      {
        name: 'Something-Setup-' + opt.version + '.exe',
        size: opt.size,
        browser_download_url: base + '/setup.exe'
      }
    ]
  }
}

function streamSetup(res) {
  const total = opt.size
  const headers = {
    'content-type': 'application/octet-stream',
    'content-length': String(total)
  }
  if (opt.fail === 'small') headers['content-length'] = '1000'
  if (opt.fail === 'truncate') headers['content-length'] = String(total)
  res.writeHead(200, headers)

  if (opt.fail === 'small') {
    res.end(Buffer.alloc(1000, 7))
    return
  }
  if (opt.fail === 'badmz') {
    // 长度按声明发满，只是内容不是安装包，交给 MZ 校验拦截
    res.end(Buffer.alloc(total, 0x41))
    return
  }

  const chunk = 512 * 1024
  const head = Buffer.from('MZ')
  const filler = Buffer.alloc(chunk, 0x4d)
  let sent = 0
  const limit = opt.fail === 'truncate' ? Math.floor(total / 3) : total

  function step() {
    if (sent >= limit) {
      if (opt.fail === 'truncate') res.destroy()
      else res.end()
      return
    }
    const n = Math.min(chunk, limit - sent)
    let buf
    if (sent === 0) {
      buf = Buffer.concat([head, filler.subarray(0, Math.max(0, n - 2))])
    } else {
      buf = filler.subarray(0, n)
    }
    sent += buf.length
    const ok = res.write(buf)
    const delay = opt.fail === 'slow' ? Math.max(opt.chunkDelay, 2000) : opt.chunkDelay
    if (ok) setTimeout(step, delay)
    else res.once('drain', function () { setTimeout(step, delay) })
  }
  step()
}

function handle(req, res) {
  const url = String(req.url || '/')
  const pathname = url.split('?')[0]
  stats.lastUserAgent = String(req.headers['user-agent'] || '')

  if (pathname === '/stats') {
    stats.stats++
    sendJson(res, 200, stats)
    return
  }
  if (pathname === '/latest') {
    stats.latest++
    const base = 'http://127.0.0.1:' + server.address().port
    if (opt.fail === 'hang') return
    if (opt.fail === '500') { sendJson(res, 500, { message: 'fixture failure' }); return }
    if (opt.fail === '404') { sendJson(res, 404, { message: 'Not Found' }); return }
    sendJson(res, 200, releasePayload(base))
    return
  }
  if (pathname === '/setup.exe') {
    stats.setup++
    streamSetup(res)
    return
  }
  sendJson(res, 404, { message: 'not found' })
}

const server = http.createServer(handle)

function listen(port, attempt) {
  server.once('error', function (e) {
    if (e && e.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1)
      return
    }
    console.error('[fixture] server error: ' + ((e && e.message) || e))
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', function () {
    const actual = server.address().port
    console.log('FIXTURE_READY http://127.0.0.1:' + actual)
    console.log('[fixture] version=' + opt.version + ' size=' + opt.size + ' fail=' + (opt.fail || 'none'))
  })
}

listen(opt.port, 0)

function shutdown() {
  try { server.close() } catch (e) { /* ignore */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
