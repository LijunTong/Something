// scripts/release-proc.cjs
// 长命令执行与进度显示：把子进程输出实时转发到终端，底部保留一行「已用时」心跳；
// 另提供带进度条的 HTTPS 上传（GitHub Release 附件）。
//
// 输出保持英文/ASCII：Windows 控制台默认代码页是 936，中文容易变乱码，
// 进度条只用 '#' '-' 与百分比，不依赖 ANSI 转义（cmd.exe 也安全）。
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const IS_TTY = Boolean(process.stdout.isTTY)
const PREFIX_OUT = '   | '
const PREFIX_ERR = '   ! '
const TAIL_LIMIT = 64 * 1024
const NON_TTY_HEARTBEAT_MS = 20000

function humanMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const total = ms / 1000
  if (total < 60) return total.toFixed(1) + 's'
  const m = Math.floor(total / 60)
  const s = Math.round(total - m * 60)
  if (m < 60) return m + 'm ' + s + 's'
  const h = Math.floor(m / 60)
  return h + 'h ' + (m - h * 60) + 'm'
}

function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) n = 0
  const mb = n / 1024 / 1024
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB'
  if (mb >= 1) return mb.toFixed(1) + ' MB'
  return (n / 1024).toFixed(0) + ' KB'
}

// 一行可覆盖的状态行：TTY 下用 \r 原地刷新，非 TTY 下按固定间隔打一行。
function statusLine() {
  let width = 0
  let lastEmit = 0
  return {
    update(text) {
      if (IS_TTY) {
        const line = '   ' + text
        const pad = width > line.length ? ' '.repeat(width - line.length) : ''
        process.stdout.write('\r' + line + pad)
        width = line.length
        return
      }
      const now = Date.now()
      if (now - lastEmit >= NON_TTY_HEARTBEAT_MS) {
        lastEmit = now
        console.log('   ' + text)
      }
    },
    clear() {
      if (IS_TTY && width > 0) {
        process.stdout.write('\r' + ' '.repeat(width) + '\r')
        width = 0
      }
    },
    stop() {
      this.clear()
    }
  }
}

function progressText(done, total, startedAt, width) {
  const w = width || 24
  const frac = total > 0 ? Math.min(1, done / total) : 0
  const filled = Math.round(frac * w)
  const bar = '#'.repeat(filled) + '-'.repeat(w - filled)
  const secs = Math.max(0.2, (Date.now() - startedAt) / 1000)
  const rate = done / secs
  const eta = rate > 0 ? (total - done) / rate : 0
  return (
    '[' + bar + '] ' + String(Math.round(frac * 100)).padStart(3) + '%  ' +
    humanBytes(done) + ' / ' + humanBytes(total) + '  ' +
    humanBytes(rate) + '/s  ETA ' + humanMs(eta * 1000)
  )
}

// Windows 上 npx/npm 是 .cmd 垫片，spawn 不能直接执行，需要交给 cmd.exe。
function quoteWin(arg) {
  const s = String(arg)
  if (!/[\s"]/.test(s)) return s
  return '"' + s.replace(/"/g, '\\"') + '"'
}

function invocation(cmd, args) {
  if (process.platform === 'win32' && /\.cmd$/i.test(String(cmd))) {
    const line = [cmd].concat(args).map(quoteWin).join(' ')
    return { file: process.env.ComSpec || 'cmd.exe', argv: ['/d', '/s', '/c', line] }
  }
  return { file: cmd, argv: args }
}

// 跑一个命令并把输出实时转发。
//   mode 'lines'（默认）：逐行加前缀，底部有已用时心跳
//   mode 'raw'          ：原样转发（保留 \r 进度条，给 git push --progress 用）
// 返回 { status, out, ms }：out 只保留输出尾部，用于失败时说明原因。
function runStream(cmd, args, opts) {
  const o = opts || {}
  const mode = o.mode === 'raw' ? 'raw' : 'lines'
  const label = o.label || [cmd].concat(args).join(' ')
  return new Promise(function (resolve) {
    const started = Date.now()
    const inv = invocation(cmd, args)
    let child = null
    try {
      child = spawn(inv.file, inv.argv, {
        cwd: o.cwd || process.cwd(),
        env: Object.assign({}, process.env, o.env || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (e) {
      resolve({ status: -1, out: e && e.message ? e.message : String(e), ms: Date.now() - started })
      return
    }

    let tail = ''
    const keep = function (chunk) {
      tail += chunk
      if (tail.length > TAIL_LIMIT) tail = tail.slice(-TAIL_LIMIT)
    }

    const line = statusLine()
    let ticker = null
    if (mode === 'lines') {
      ticker = setInterval(function () {
        line.update(label + ' ... ' + humanMs(Date.now() - started))
      }, 1000)
    }

    const pending = { out: '', err: '' }
    const flush = function (key, chunk) {
      if (mode === 'raw') {
        process.stdout.write(chunk)
        keep(chunk)
        return
      }
      keep(chunk)
      pending[key] += chunk
      let idx = pending[key].indexOf('\n')
      while (idx >= 0) {
        let text = pending[key].slice(0, idx)
        if (text.endsWith('\r')) text = text.slice(0, -1)
        pending[key] = pending[key].slice(idx + 1)
        line.clear()
        process.stdout.write((key === 'out' ? PREFIX_OUT : PREFIX_ERR) + text + '\n')
        idx = pending[key].indexOf('\n')
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', function (chunk) { flush('out', chunk) })
    child.stderr.on('data', function (chunk) { flush('err', chunk) })

    let spawnError = ''
    child.on('error', function (e) {
      spawnError = e && e.message ? e.message : String(e)
    })
    child.on('close', function (code) {
      if (ticker) clearInterval(ticker)
      line.clear()
      for (const key of ['out', 'err']) {
        if (pending[key]) {
          process.stdout.write((key === 'out' ? PREFIX_OUT : PREFIX_ERR) + pending[key].replace(/\r$/, '') + '\n')
          pending[key] = ''
        }
      }
      resolve({
        status: code == null ? -1 : code,
        out: tail,
        ms: Date.now() - started,
        error: spawnError
      })
    })
  })
}

// 带进度上报的文件上传（GitHub 附件接口）。读完即发，避免把 100MB 安装包整个读进内存。
function uploadFile(url, file, headers, opts) {
  const o = opts || {}
  const total = fs.statSync(file).size
  const started = Date.now()
  return new Promise(function (resolve, reject) {
    const attempt = function (target, redirectsLeft) {
      let parsed = null
      try {
        parsed = new URL(target)
      } catch (e) {
        reject(e)
        return
      }
      const lib = parsed.protocol === 'http:' ? require('node:http') : require('node:https')
      const req = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: Object.assign({}, headers, { 'content-length': String(total) })
        },
        function (res) {
          const location = res.headers.location
          if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && location && redirectsLeft > 0) {
            res.resume()
            attempt(new URL(location, target).toString(), redirectsLeft - 1)
            return
          }
          const chunks = []
          res.setEncoding('utf8')
          res.on('data', function (chunk) { chunks.push(chunk) })
          res.on('end', function () { resolve({ status: res.statusCode, text: chunks.join('') }) })
        }
      )
      // 网络卡住时不要无限等：120s 没有任何进展就断开，让上层把状态落盘再退出。
      req.setTimeout(120000, function () {
        req.destroy(new Error('upload stalled for 120s'))
      })

      let sent = 0
      let lastTick = 0
      const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
      stream.on('data', function (chunk) {
        sent += chunk.length
        const now = Date.now()
        if (o.onProgress && now - lastTick >= 200) {
          lastTick = now
          o.onProgress(sent, total, started)
        }
      })
      stream.on('error', function (e) { req.destroy(e) })
      req.on('error', function (e) {
        stream.destroy()
        reject(e)
      })
      stream.pipe(req)
    }
    attempt(url, 3)
  })
}

module.exports = {
  IS_TTY,
  humanMs,
  humanBytes,
  statusLine,
  progressText,
  invocation,
  runStream,
  uploadFile
}
