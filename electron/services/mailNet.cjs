// 邮件协议层：IMAP 收信、SMTP 发信与账户连通性测试。
// 只负责网络读写与报文解析；SQL 全部留在 services/mail.cjs。
const net = require('node:net')
const tls = require('node:tls')

const TIMEOUT_MS = 15000
const MAX_BODY_BYTES = 1024 * 1024

// 服务端错误原文可能很长（QQ/163 会附整段帮助链接），截断后再回给界面展示。
function errText(err, fallback) {
  const text = String((err && err.message) || err || fallback || 'UNKNOWN')
  return text.length > 200 ? text.slice(0, 200) + '…' : text
}

// 认证失败几乎都是配置问题，附上可执行提示，避免用户只看到服务器英文原文。
function authText(err, fallback) {
  const raw = errText(err, fallback)
  if (/AUTHENTICATIONFAILED|LOGIN fail|LOGIN failed|authentication failed|invalid credentials|\b(535|534|530)\b/i.test(raw)) {
    return raw + ' ｜ 提示：QQ/163 等邮箱必须用网页端生成的「授权码」当密码，并先开启 IMAP/SMTP 服务；用户名填完整邮箱；连续失败会被临时限流，等 10 分钟再试。'
  }
  return raw
}

// 网易系（163/126/yeah/188）登录后要求先上报客户端 ID，否则 SELECT 会报 Unsafe Login。
async function sendClientId(session, host) {
  if (!/(163|126|yeah|188)\./i.test(String(host || ''))) return
  try {
    await session.cmd('ID ("name" "Something" "version" "1.0" "vendor" "local")')
  } catch (e) {
    // 服务端不支持 ID 时忽略即可
  }
}

function connect(host, port, useTls) {
  return new Promise(function (resolve, reject) {
    const socket = useTls
      ? tls.connect({ host: host, port: port, servername: host })
      : net.connect({ host: host, port: port })
    const timer = setTimeout(function () {
      cleanup()
      socket.destroy()
      reject(new Error('CONNECT_TIMEOUT'))
    }, TIMEOUT_MS)
    function cleanup() {
      clearTimeout(timer)
      socket.removeListener('connect', onOpen)
      socket.removeListener('secureConnect', onOpen)
      socket.removeListener('error', onError)
    }
    function onOpen() {
      cleanup()
      socket.setTimeout(TIMEOUT_MS)
      resolve(socket)
    }
    function onError(e) {
      cleanup()
      socket.destroy()
      reject(e)
    }
    socket.once(useTls ? 'secureConnect' : 'connect', onOpen)
    socket.once('error', onError)
  })
}

// STARTTLS：把已建立的明文连接升级成 TLS，旧 socket 交给 tls 接管，旧 reader 必须先摘掉监听。
function upgrade(socket, host) {
  return new Promise(function (resolve, reject) {
    const secured = tls.connect({ socket: socket, servername: host })
    const timer = setTimeout(function () {
      secured.destroy()
      reject(new Error('TLS_TIMEOUT'))
    }, TIMEOUT_MS)
    secured.once('secureConnect', function () {
      clearTimeout(timer)
      secured.setTimeout(TIMEOUT_MS)
      resolve(secured)
    })
    secured.once('error', function (e) {
      clearTimeout(timer)
      reject(e)
    })
  })
}

// 行读取器：识别 IMAP 的 {N} 字面量，字面量按字节取满再接下一行。
function createReader(socket) {
  let buf = Buffer.alloc(0)
  let failure = null
  let notify = null
  const onData = function (chunk) {
    buf = Buffer.concat([buf, chunk])
    wake()
  }
  const onError = function (e) {
    failure = failure || e
    wake()
  }
  const onClose = function () {
    failure = failure || new Error('CONNECTION_CLOSED')
    wake()
  }
  const onTimeout = function () {
    failure = failure || new Error('SOCKET_TIMEOUT')
    wake()
  }
  function wake() {
    if (notify) {
      const n = notify
      notify = null
      n()
    }
  }
  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('close', onClose)
  socket.on('timeout', onTimeout)

  function detach() {
    socket.removeListener('data', onData)
    socket.removeListener('error', onError)
    socket.removeListener('close', onClose)
    socket.removeListener('timeout', onTimeout)
  }

  async function until(check) {
    while (!check()) {
      if (failure) throw failure
      await new Promise(function (resolve) { notify = resolve })
    }
    if (failure) throw failure
  }

  async function readLine() {
    await until(function () { return buf.indexOf('\r\n') >= 0 })
    const idx = buf.indexOf('\r\n')
    const line = buf.subarray(0, idx).toString('utf8')
    buf = buf.subarray(idx + 2)
    const m = /\{(\d+)\}$/.exec(line)
    if (!m) return { line: line, literal: null }
    const need = Number(m[1])
    await until(function () { return buf.length >= need })
    const literal = buf.subarray(0, need)
    buf = buf.subarray(need)
    return { line: line, literal: literal }
  }

  async function readUntil(check) {
    const out = []
    while (true) {
      const item = await readLine()
      out.push(item)
      if (check(item.line)) return out
    }
  }

  return { readLine: readLine, readUntil: readUntil, detach: detach }
}

function quote(value) {
  return '"' + String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// —— 通用解码 ——
function bufferToString(buf, charset) {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/["']/g, '').trim()
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii' || cs === '') return buf.toString('utf8')
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'windows-1252') return buf.toString('latin1')
  // Node 没有内置 GBK/GB18030 解码器，按 utf8 尽力解码，避免整封信丢失
  return buf.toString('utf8')
}

function decodeMimeWords(value) {
  if (!value) return ''
  return String(value).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, function (_all, charset, enc, text) {
    try {
      if (String(enc).toUpperCase() === 'B') return bufferToString(Buffer.from(text, 'base64'), charset)
      const bytes = []
      const q = String(text).replace(/_/g, ' ')
      for (let i = 0; i < q.length; i++) {
        const ch = q[i]
        if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(q.slice(i + 1, i + 3))) {
          bytes.push(parseInt(q.slice(i + 1, i + 3), 16))
          i += 2
        } else {
          bytes.push(q.charCodeAt(i) & 0xff)
        }
      }
      return bufferToString(Buffer.from(bytes), charset)
    } catch (e) {
      return text
    }
  })
}

function parseHeaders(text) {
  const map = {}
  const lines = String(text || '').split(/\r?\n/)
  let last = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (/^[ \t]/.test(line) && last) {
      map[last] += ' ' + line.trim()
      continue
    }
    const idx = line.indexOf(':')
    if (idx < 0) continue
    last = line.slice(0, idx).trim().toLowerCase()
    map[last] = line.slice(idx + 1).trim()
  }
  return map
}

function parseAddress(value) {
  const raw = decodeMimeWords(String(value || '').replace(/[\r\n]+/g, ' ').trim())
  const m = /^(.*)<([^>]+)>/.exec(raw)
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), addr: m[2].trim() }
  return { name: '', addr: raw.replace(/[<>]/g, '').trim() }
}

function parseAddressList(value) {
  const raw = String(value || '')
  if (!raw) return []
  return raw.split(',').map(function (part) { return parseAddress(part).addr }).filter(Boolean)
}

function decodeTransfer(body, cte, charset) {
  const enc = String(cte || '').toLowerCase().trim()
  if (enc === 'base64') return bufferToString(Buffer.from(String(body).replace(/\s+/g, ''), 'base64'), charset)
  if (enc === 'quoted-printable') {
    const bytes = []
    const s = String(body)
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (ch === '=') {
        if (s[i + 1] === '\r' && s[i + 2] === '\n') { i += 2; continue }
        if (s[i + 1] === '\n') { i += 1; continue }
        const hex = s.slice(i + 1, i + 3)
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16))
          i += 2
          continue
        }
      }
      bytes.push(s.charCodeAt(i) & 0xff)
    }
    return bufferToString(Buffer.from(bytes), charset)
  }
  return bufferToString(Buffer.from(String(body), 'latin1'), charset)
}

function stripTags(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, function (_a, d) { return String.fromCharCode(Number(d)) })
    .replace(/&amp;/gi, '&')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 正文解析：multipart 里优先 text/plain，其次是 text/html（转纯文本）。
function parsePart(raw, depth) {
  const sep = raw.indexOf('\r\n\r\n')
  const head = sep >= 0 ? raw.slice(0, sep) : raw
  const body = sep >= 0 ? raw.slice(sep + 4) : ''
  const headers = parseHeaders(head)
  const ctype = headers['content-type'] || 'text/plain; charset=utf-8'
  const cte = headers['content-transfer-encoding'] || ''
  if (/^multipart\//i.test(ctype) && depth < 3) {
    const m = /boundary\s*=\s*"?([^";]+)"?/i.exec(ctype)
    if (!m) return null
    const chunks = body.split('--' + m[1])
    let htmlPart = null
    for (let i = 0; i < chunks.length; i++) {
      let chunk = chunks[i]
      if (!chunk || chunk.trim() === '--' || chunk.trim() === '') continue
      chunk = chunk.replace(/^\r?\n/, '')
      const part = parsePart(chunk, depth + 1)
      if (part && part.kind === 'plain' && part.text) return part
      if (part && part.kind === 'html' && part.text) htmlPart = part
    }
    return htmlPart
  }
  const charset = (/charset\s*=\s*"?([^";]+)"?/i.exec(ctype) || [])[1] || 'utf-8'
  const text = decodeTransfer(body, cte, charset)
  if (/^text\/html/i.test(ctype)) return { kind: 'html', text: stripTags(text) }
  if (/^text\/plain/i.test(ctype)) return { kind: 'plain', text: text }
  return { kind: 'other', text: '' }
}

// —— IMAP ——
async function openImap(cfg) {
  const port = cfg.port || 993
  const implicit = port !== 143
  let socket = await connect(cfg.host, port, implicit)
  let reader = createReader(socket)
  const greet = await reader.readLine()
  if (!/^\*\s+(OK|PREAUTH)/i.test(greet.line)) throw new Error('IMAP 服务未就绪：' + greet.line)
  let seq = 0
  async function cmd(text) {
    seq += 1
    const tag = 'A' + seq
    socket.write(tag + ' ' + text + '\r\n')
    const lines = await reader.readUntil(function (line) { return line.toUpperCase().indexOf(tag + ' ') === 0 })
    const status = lines[lines.length - 1].line
    if (!/\sOK\b/i.test(status)) {
      const reason = lines.map(function (l) { return l.line }).filter(function (l) { return /\s(NO|BAD)\b/i.test(l) }).join(' | ')
      throw new Error('IMAP 命令失败：' + (reason || status))
    }
    return lines
  }
  if (!implicit) {
    await cmd('STARTTLS')
    reader.detach()
    socket = await upgrade(socket, cfg.host)
    reader = createReader(socket)
  }
  return {
    socket: socket,
    cmd: cmd,
    close: function () {
      try { socket.end() } catch (e) {}
      try { socket.destroy() } catch (e) {}
    }
  }
}

function parseFetch(lines) {
  const out = { uid: null, flags: '', header: null, body: null }
  for (let i = 0; i < lines.length; i++) {
    const item = lines[i]
    const text = item.line
    if (out.uid == null) {
      const m = /\bUID (\d+)/i.exec(text)
      if (m) out.uid = Number(m[1])
    }
    if (!out.flags) {
      const f = /FLAGS \(([^)]*)\)/i.exec(text)
      if (f) out.flags = f[1]
    }
    if (item.literal) {
      if (/BODY\[(HEADER|HEADER\.FIELDS[^\]]*)\]/i.test(text)) out.header = item.literal
      else if (/BODY\[(TEXT|1)\]/i.test(text)) out.body = item.literal
    }
  }
  return out
}

function toMessage(fetched) {
  const headerText = fetched.header ? fetched.header.toString('utf8') : ''
  const headers = parseHeaders(headerText)
  const from = parseAddress(headers.from || '')
  const subject = decodeMimeWords(headers.subject || '') || '(无主题)'
  const ctype = headers['content-type'] || 'text/plain; charset=utf-8'
  const rawBody = fetched.body && fetched.body.length <= MAX_BODY_BYTES ? fetched.body.toString('latin1') : ''
  const part = rawBody ? parsePart('Content-Type: ' + ctype + '\r\n\r\n' + rawBody, 0) : null
  const text = part && part.text ? part.text : ''
  const date = Date.parse(headers.date || '')
  return {
    uid: fetched.uid == null ? '' : String(fetched.uid),
    msgId: (headers['message-id'] || '').trim() || ('imap-' + fetched.uid + '@' + from.addr),
    fromName: from.name || from.addr || '(未知发件人)',
    fromAddr: from.addr || '',
    toAddrs: parseAddressList(headers.to || ''),
    ccAddrs: parseAddressList(headers.cc || ''),
    subject: subject,
    bodyText: text,
    hasAttach: /multipart\/mixed/i.test(ctype),
    read: /\bSeen\b/i.test(fetched.flags),
    starred: /\bFlagged\b/i.test(fetched.flags),
    sentAt: Number.isFinite(date) ? date : Date.now()
  }
}

async function testImap(cfg) {
  let session = null
  try {
    session = await openImap(cfg)
    await session.cmd('LOGIN ' + quote(cfg.user) + ' ' + quote(cfg.pass))
    await sendClientId(session, cfg.host)
    try { await session.cmd('LOGOUT') } catch (e) {}
    return { ok: true, message: 'IMAP 登录成功' }
  } catch (e) {
    return { ok: false, message: authText(e) }
  } finally {
    if (session) session.close()
  }
}

async function fetchInbox(cfg) {
  const session = await openImap(cfg)
  try {
    await session.cmd('LOGIN ' + quote(cfg.user) + ' ' + quote(cfg.pass))
    await sendClientId(session, cfg.host)
    const list = await session.cmd('SELECT INBOX')
    let exists = 0
    for (let i = 0; i < list.length; i++) {
      const m = /^\*\s+(\d+)\s+EXISTS/i.exec(list[i].line)
      if (m) exists = Number(m[1])
    }
    if (!exists) return []
    const limit = Math.min(Math.max(Number(cfg.limit) || 20, 1), 50)
    const start = Math.max(1, exists - limit + 1)
    const out = []
    for (let seq = start; seq <= exists; seq++) {
      const lines = await session.cmd('FETCH ' + seq + ' (UID FLAGS BODY.PEEK[HEADER] BODY.PEEK[TEXT])')
      const fetched = parseFetch(lines)
      if (!fetched.header) continue
      out.push(toMessage(fetched))
    }
    try { await session.cmd('LOGOUT') } catch (e) {}
    return out
  } catch (e) {
    throw new Error(authText(e))
  } finally {
    session.close()
  }
}

// —— SMTP ——
function encodeMimeWord(text) {
  const value = String(text || '')
  if (!/[^\x20-\x7e]/.test(value)) return value
  return '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?='
}

function buildMime(cfg) {
  const to = (cfg.to || []).map(function (a) { return String(a) }).join(', ')
  const cc = (cfg.cc || []).map(function (a) { return String(a) }).join(', ')
  const body = Buffer.from(String(cfg.text || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
  const lines = [
    'From: ' + (cfg.fromName ? encodeMimeWord(cfg.fromName) + ' ' : '') + '<' + cfg.from + '>',
    'To: ' + to,
    cc ? 'Cc: ' + cc : null,
    'Subject: ' + encodeMimeWord(cfg.subject || '(无主题)'),
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body
  ].filter(function (l) { return l !== null })
  return lines.join('\r\n')
}

async function openSmtp(cfg) {
  const port = cfg.port || 465
  const implicit = port === 465
  let socket = await connect(cfg.host, port, implicit)
  let reader = createReader(socket)
  await reader.readUntil(function (line) { return /^220[ ]/.test(line) })
  async function exchange(text, check) {
    socket.write(text + '\r\n')
    const lines = await reader.readUntil(check)
    return lines
  }
  async function expectCode(text, re, label) {
    const lines = await exchange(text, function (line) { return re.test(line) })
    const last = lines[lines.length - 1].line
    if (!re.test(last)) throw new Error('SMTP ' + label + ' 失败：' + last)
    return lines
  }
  await expectCode('EHLO dashboard.local', /^250[ ]/, 'EHLO')
  if (!implicit) {
    await expectCode('STARTTLS', /^220[ ]/, 'STARTTLS')
    reader.detach()
    socket = await upgrade(socket, cfg.host)
    reader = createReader(socket)
    await expectCode('EHLO dashboard.local', /^250[ ]/, 'EHLO')
  }
  const auth = Buffer.from('\0' + String(cfg.user || '') + '\0' + String(cfg.pass || ''), 'utf8').toString('base64')
  const authReply = await exchange('AUTH PLAIN ' + auth, function (line) { return /^(235|503|504|535|534|530)[ ]/.test(line) })
  const authStatus = authReply[authReply.length - 1].line
  if (!/^235[ ]|^503[ ]/.test(authStatus)) throw new Error('SMTP 认证失败：' + authStatus)
  return {
    send: async function (mime, from, recipients) {
      await expectCode('MAIL FROM:<' + from + '>', /^2[0-9][0-9][ ]/, 'MAIL FROM')
      for (let i = 0; i < recipients.length; i++) {
        await expectCode('RCPT TO:<' + recipients[i] + '>', /^2[0-9][0-9][ ]/, 'RCPT TO')
      }
      await expectCode('DATA', /^354[ ]/, 'DATA')
      const stuffed = mime.split('\r\n').map(function (line) { return line.charAt(0) === '.' ? '.' + line : line }).join('\r\n')
      await expectCode(stuffed + '\r\n.', /^250[ ]/, 'DATA 结束')
      try { await expectCode('QUIT', /^221[ ]/, 'QUIT') } catch (e) {}
    },
    close: function () {
      try { socket.end('QUIT\r\n') } catch (e) {}
      try { socket.destroy() } catch (e) {}
    }
  }
}

async function testSmtp(cfg) {
  let session = null
  try {
    session = await openSmtp(cfg)
    try { session.close() } catch (e) {}
    return { ok: true, message: 'SMTP 登录成功' }
  } catch (e) {
    return { ok: false, message: authText(e) }
  } finally {
    if (session) { try { session.close() } catch (e) {} }
  }
}

async function sendMail(cfg) {
  const session = await openSmtp(cfg)
  try {
    const mime = buildMime(cfg)
    const recipients = (cfg.to || []).concat(cfg.cc || []).filter(Boolean)
    if (!recipients.length) throw new Error('RCPT_REQUIRED')
    await session.send(mime, cfg.from, recipients)
    return { ok: true }
  } finally {
    try { session.close() } catch (e) {}
  }
}

module.exports = {
  testImap: testImap,
  testSmtp: testSmtp,
  fetchInbox: fetchInbox,
  sendMail: sendMail
}
