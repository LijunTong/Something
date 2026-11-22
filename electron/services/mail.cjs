// 邮件领域服务：所有 SQL、fixture 数据与安全处理集中在这里，IPC 层只做校验与转发。
const { get, withTx } = require('../db/conn.cjs')
const { uid, now, camel, camelAll, bool } = require('../db/util.cjs')
const logger = require('../log/logger.cjs')
const mailNet = require('./mailNet.cjs')
const secret = require('./secret.cjs')

// 账户对外字段白名单：刻意排除 secret_enc，任何返回值都不带授权码密文。
const ACCOUNT_COLUMNS = 'id,alias,email,protocol,imap_host,imap_port,smtp_host,smtp_port,username,sync_days,enabled,last_sync_at'

// 新建账户时自动创建的四个系统文件夹。
const DEFAULT_FOLDERS = [
  { name: '收件箱', kind: 'inbox' },
  { name: '已发送', kind: 'sent' },
  { name: '草稿箱', kind: 'draft' },
  { name: '垃圾箱', kind: 'trash' }
]

// 日志元数据只保留非敏感字段，避免授权码或密文进入日志文件。
function safeMeta(meta) {
  const out = {}
  if (!meta || typeof meta !== 'object') return out
  Object.keys(meta).forEach(function (k) {
    if (/secret|password|passwd|token|credential|authorization|cookie|authcode|auth_code|apikey|api_key/i.test(k)) return
    out[k] = meta[k]
  })
  return out
}

// 统一异常记录入口：action 描述操作，meta 经 safeMeta 过滤后再写日志。
function withLog(action, meta, fn) {
  try {
    return fn()
  } catch (e) {
    logger.error('mail', action + '失败', e, safeMeta(meta))
    throw e
  }
}

// JSON 字段统一以字符串入库；已是字符串时原样保留，避免二次编码。
function toJsonString(v) {
  if (v == null) return null
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

// 解析数组型 JSON 字段（收件人、标签、规则条件与动作）。
function parseArray(v) {
  if (!v) return []
  try {
    const r = JSON.parse(v)
    return Array.isArray(r) ? r : []
  } catch (e) {
    return []
  }
}

// 授权码明文落库（用户要求可切换明文查看）；旧 safeStorage 密文读取时自动解出。
function encryptSecret(plain) {
  return secret.pack(String(plain == null ? '' : plain))
}

function decryptSecret(stored) {
  if (!stored) throw new Error('SECRET_REQUIRED')
  return secret.unpack(stored)
}

// 一次性迁移：把旧版 safeStorage 密文授权码改写成明文，返回改写条数
function migratePlain() {
  try {
    return withTx(function () {
      const rows = get().prepare('SELECT id, secret_enc FROM mail_account').all()
      let changed = 0
      rows.forEach(function (row) {
        if (!row || !row.secret_enc) return
        const plain = secret.unpack(row.secret_enc)
        if (!plain) return
        if (row.secret_enc === secret.pack(plain)) return
        get().prepare('UPDATE mail_account SET secret_enc = ? WHERE id = ?').run(secret.pack(plain), row.id)
        changed += 1
      })
      return changed
    })
  } catch (e) {
    return 0
  }
}

// 按需回显授权码：设置页默认掩码，用户点「显示」时才取明文
function revealSecret(dto) {
  const id = dto && dto.id
  const row = get().prepare('SELECT secret_enc FROM mail_account WHERE id = ?').get(id)
  if (!row) throw new Error('ACCOUNT_NOT_FOUND')
  return { id: id, value: String(secret.unpack(row.secret_enc) || '').trim() }
}

// 单账户详情，走白名单列，确保 secret_enc 不进入返回值。
function accountView(id) {
  const row = get().prepare('SELECT ' + ACCOUNT_COLUMNS + ' FROM mail_account WHERE id = ?').get(id)
  return row ? camel(row) : null
}

// 账户列表：同样只查白名单列。
function accounts() {
  return withLog('查询账户', {}, function () {
    return camelAll(get().prepare('SELECT ' + ACCOUNT_COLUMNS + ' FROM mail_account ORDER BY alias ASC').all())
  })
}

// 新增账户：先加密授权码，再在事务内写入账户与四个默认文件夹。
function addAccount(dto) {
  const d = dto || {}
  // 授权码先 trim：从 QQ/163 网页复制出来常带空格或换行
  const secretEnc = withLog('加密授权码', { email: d.email, alias: d.alias }, function () {
    return encryptSecret(String(d.secret == null ? '' : d.secret).trim())
  })
  const newId = withLog('新增账户', { email: d.email, alias: d.alias }, function () {
    return withTx(function () {
      const id = uid('acct')
      get().prepare('INSERT INTO mail_account (id,alias,email,protocol,imap_host,imap_port,smtp_host,smtp_port,username,secret_enc,sync_days,enabled,last_sync_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id, d.alias || d.email || '未命名账户', d.email || null, d.protocol || 'imap',
        d.imapHost || null, d.imapPort || null, d.smtpHost || null, d.smtpPort || null,
        d.username || null, secretEnc, d.syncDays == null ? 30 : d.syncDays,
        d.enabled == null ? 1 : bool(d.enabled), null
      )
      const insFolder = get().prepare('INSERT INTO mail_folder (id,account_id,name,kind,unread_count) VALUES (?,?,?,?,0)')
      DEFAULT_FOLDERS.forEach(function (f) { insFolder.run(uid('fld'), id, f.name, f.kind) })
      return id
    })
  })
  // 契约是「返回账户列表」：渲染层直接把它当成数组渲染，单条对象会炸渲染函数。
  void newId
  return accounts()
}

// 修改账户：只更新提交的字段；授权码留空表示「不修改」，避免改别名被迫重填凭据。
function updateAccount(dto) {
  const d = dto || {}
  withLog('修改账户', { id: d.id, email: d.email }, function () {
    return withTx(function () {
      // 逐字段合并：只更新调用方传来的字段，其余沿用库里现值。
      // 之前按整行覆盖，开关启用状态这类只传 {id, enabled} 的调用会把 email 写成 NULL，触发 NOT NULL 约束。
      const cur = get().prepare('SELECT * FROM mail_account WHERE id = ?').get(d.id)
      if (!cur) throw new Error('ACCOUNT_NOT_FOUND')
      const val = function (next, prev) { return next === undefined ? prev : next }
      const nextSecret = String(d.secret == null ? '' : d.secret).trim()
      const secretEnc = nextSecret ? encryptSecret(nextSecret) : cur.secret_enc
      const email = val(d.email, cur.email)
      const alias = val(d.alias, cur.alias) || email || '未命名账户'
      get().prepare('UPDATE mail_account SET alias = ?, email = ?, protocol = ?, imap_host = ?, imap_port = ?, smtp_host = ?, smtp_port = ?, username = ?, secret_enc = ?, sync_days = ?, enabled = ? WHERE id = ?')
        .run(
          alias, email, val(d.protocol, cur.protocol) || 'imap',
          val(d.imapHost, cur.imap_host) || null, val(d.imapPort, cur.imap_port),
          val(d.smtpHost, cur.smtp_host) || null, val(d.smtpPort, cur.smtp_port),
          val(d.username, cur.username) || null, secretEnc,
          val(d.syncDays, cur.sync_days), d.enabled === undefined ? cur.enabled : bool(d.enabled), d.id
        )
      return d.id
    })
  })
  // 与 addAccount 保持一致：统一返回列表
  return accounts()
}

// 删除账户：mail / mail_folder 的外键都是 ON DELETE CASCADE，账户删除会一并清掉文件夹与邮件。
function removeAccount(dto) {
  const id = typeof dto === 'string' ? dto : (dto && dto.id)
  return withLog('删除账户', { id: id }, function () {
    return withTx(function () {
      get().prepare('DELETE FROM mail_account WHERE id = ?').run(id)
      return accounts()
    })
  })
}

// 连通性测试：真实登录 IMAP / SMTP。编辑态授权码留空时，用已保存的密文解密后测试。
async function testAccount(dto) {
  const d = dto || {}
  const account = d.id ? get().prepare('SELECT * FROM mail_account WHERE id = ?').get(d.id) : null
  let secret = d.secret ? String(d.secret) : ''
  if (!secret && account) {
    try {
      secret = decryptSecret(account.secret_enc)
    } catch (e) {
      secret = ''
    }
  }
  if (!secret) return { ok: false, code: 'SECRET_REQUIRED', message: '缺少授权码：新增账户请先填写，编辑账户可留空复用原授权码' }
  const imapHost = d.imapHost || (account && account.imap_host) || ''
  const imapPort = Number(d.imapPort || (account && account.imap_port) || 993)
  const smtpHost = d.smtpHost || (account && account.smtp_host) || ''
  const smtpPort = Number(d.smtpPort || (account && account.smtp_port) || 465)
  const user = String(d.username || (account && account.username) || d.email || (account && account.email) || '').trim()
  // 授权码从网页复制常带空格/换行，必须先 trim，否则服务器一律回 AUTHENTICATIONFAILED
  const pass = String(secret).trim()
  if (!imapHost && !smtpHost) return { ok: false, code: 'HOST_REQUIRED', message: '请先填写 IMAP 或 SMTP 服务器地址' }
  if (user && user.indexOf('@') < 0) {
    return { ok: false, code: 'USERNAME_NOT_EMAIL', message: '用户名必须是完整邮箱地址（如 name@qq.com）：QQ/163 不接受纯数字或纯名字的账号' }
  }

  const out = { ok: true, code: 'OK', message: '', imap: null, smtp: null }
  if (imapHost) {
    out.imap = await mailNet.testImap({ host: imapHost, port: imapPort, user: user, pass: pass })
    if (!out.imap.ok) out.ok = false
  }
  if (smtpHost) {
    out.smtp = await mailNet.testSmtp({ host: smtpHost, port: smtpPort, user: user, pass: pass })
    if (!out.smtp.ok) out.ok = false
  }
  const parts = []
  if (out.imap) parts.push('IMAP ' + (out.imap.ok ? '通过' : '失败：' + out.imap.message))
  if (out.smtp) parts.push('SMTP ' + (out.smtp.ok ? '通过' : '失败：' + out.smtp.message))
  out.message = parts.join(' · ')
  // 认证失败时把实际登录账号（脱敏）带出来，方便一眼看出是不是漏了 @域名
  if (!out.ok) out.message += '（登录账号：' + maskUser(user) + '）'
  return out
}

// 脱敏账号：保留前两位与域名
function maskUser(user) {
  const text = String(user || '')
  const at = text.indexOf('@')
  if (at <= 0) return text ? text.slice(0, 2) + '***' : '(空)'
  return text.slice(0, 2) + '***' + text.slice(at)
}

// 旧版本把纯文本包成 "<div>…<br>…</div>" 塞进 body_html，阅读器会当成 HTML 渲染，
// 结果既不是原邮件样式也拿不到排版。判定为假 HTML 时按无 HTML 处理，回落到纯文本正文。
function isWrappedPlainHtml(html) {
  const s = String(html || '').trim()
  if (!/^<div>[\s\S]*<\/div>$/i.test(s)) return false
  return !/<\/?[a-z]/i.test(s.replace(/<\/?div>/gi, '').replace(/<br\s*\/?>/gi, ''))
}

// 未读数存在 mail_folder.unread_count 里，只在 sync 时算一次；阅读/删除/标未读之后必须重算，
// 否则左栏计数会停在旧值（收件箱显示 3 但列表只有 2 条就是这个问题）。
function recountFolder(folderId) {
  if (!folderId) return
  get().prepare('UPDATE mail_folder SET unread_count = (SELECT COUNT(*) FROM mail WHERE folder_id = ? AND read = 0) WHERE id = ?').run(folderId, folderId)
}

// 邮件详情（含附件），供 read / send 等复用；只读，不开启事务。
function mailDetail(id) {
  const row = get().prepare('SELECT m.*, fo.name AS folder_name, fo.kind AS folder_kind FROM mail m LEFT JOIN mail_folder fo ON fo.id = m.folder_id WHERE m.id = ?').get(id)
  if (!row) return null
  const r = camel(row)
  r.labels = parseArray(r.labels)
  r.toAddrs = parseArray(r.toAddrs)
  r.ccAddrs = parseArray(r.ccAddrs)
  r.attachments = camelAll(get().prepare('SELECT * FROM mail_attachment WHERE mail_id = ? ORDER BY rowid ASC').all(id))
  if (isWrappedPlainHtml(r.bodyHtml)) r.bodyHtml = ''
  return r
}

// 取账户指定类型的文件夹；缺失时按需补建，保证同步与发送有落点。
function folderIdOf(accountId, kind, autoCreate) {
  const row = get().prepare('SELECT id FROM mail_folder WHERE account_id = ? AND kind = ? LIMIT 1').get(accountId, kind)
  if (row) return row.id
  if (!autoCreate) return null
  const id = uid('fld')
  const preset = DEFAULT_FOLDERS.filter(function (f) { return f.kind === kind })[0]
  get().prepare('INSERT INTO mail_folder (id,account_id,name,kind,unread_count) VALUES (?,?,?,?,0)').run(id, accountId, (preset && preset.name) || kind, kind)
  return id
}

// 同步：IMAP 拉取收件箱最近 N 封。网络阶段在事务外，落库阶段一次性提交。
async function sync(dto) {
  const d = dto || {}
  const accountId = d.accountId
  if (!accountId) throw new Error('ACCOUNT_ID_REQUIRED')
  const acct = get().prepare('SELECT * FROM mail_account WHERE id = ?').get(accountId)
  if (!acct) throw new Error('MAIL_ACCOUNT_NOT_FOUND')
  if (String(acct.protocol || 'imap').toLowerCase() !== 'imap') throw new Error('PROTOCOL_NOT_SUPPORTED')
  if (!acct.imap_host) throw new Error('IMAP_HOST_REQUIRED')

  const secret = String(decryptSecret(acct.secret_enc) || '').trim()
  const imapUser = String(acct.username || acct.email || '').trim()
  if (imapUser.indexOf('@') < 0) throw new Error('USERNAME_NOT_EMAIL：用户名需填完整邮箱地址（如 name@qq.com）')
  const messages = await mailNet.fetchInbox({
    host: acct.imap_host,
    port: acct.imap_port || 993,
    user: imapUser,
    pass: secret,
    limit: Math.min(Math.max(Number(d.limit) || 20, 1), 50),
    // 额外补齐服务器上的未读邮件，否则「只同步最近 N 封」会让更早的未读永远统计不到
    unseenLimit: Math.min(Math.max(Number(d.unseenLimit == null ? 100 : d.unseenLimit) || 0, 0), 300)
  })

  return withTx(function () {
    const inboxId = folderIdOf(accountId, 'inbox', true)
    // 历史版本写入的演示邮件（msg_id 带 fixture 标记）顺手清掉，真实邮件不受影响
    const olds = get().prepare("SELECT id FROM mail WHERE account_id = ? AND msg_id LIKE '<fixture-%@dashboard.local>'").all(accountId)
    const delMail = get().prepare('DELETE FROM mail WHERE id = ?')
    olds.forEach(function (o) { delMail.run(o.id) })

    const findOne = get().prepare('SELECT id FROM mail WHERE account_id = ? AND msg_id = ?')
    const ins = get().prepare('INSERT INTO mail (id,account_id,folder_id,uid,msg_id,from_name,from_addr,to_addrs,cc_addrs,subject,snippet,body_html,body_text,has_attach,sent_at,read,starred,important,labels) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    // 已读/未读一律以本地库为准：同步只刷新内容与星标，绝不动 read。
    // 否则本地读过的邮件会被服务器 FLAGS 覆盖回未读，左栏计数就永远对不上。
    const upd = get().prepare('UPDATE mail SET subject = ?, snippet = ?, body_text = ?, body_html = ?, starred = ? WHERE id = ?')
    let added = 0
    let updated = 0
    messages.forEach(function (m) {
      const snippet = String(m.bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 120)
      // 有 MIME 的 text/html 就存原文，没有则留空，由阅读器回落到纯文本（不再伪造 <div>+<br> 的假 HTML）
      const rawHtml = m.bodyHtml ? String(m.bodyHtml) : null
      // 服务器给的是假 HTML（旧版本写入格式）就当没有，避免阅读器把 <div>+<br> 当成原邮件排版
      const bodyHtml = rawHtml && !isWrappedPlainHtml(rawHtml) ? rawHtml : null
      const hit = findOne.get(accountId, m.msgId)
      if (hit) {
        upd.run(m.subject, snippet, m.bodyText || '', bodyHtml, m.starred ? 1 : 0, hit.id)
        updated += 1
        return
      }
      ins.run(
        uid('mail'), accountId, inboxId, m.uid, m.msgId,
        m.fromName, m.fromAddr, toJsonString(m.toAddrs), toJsonString(m.ccAddrs),
        m.subject, snippet, bodyHtml, m.bodyText || '', m.hasAttach ? 1 : 0, m.sentAt,
        m.read ? 1 : 0, m.starred ? 1 : 0, 0, toJsonString([])
      )
      added += 1
    })
    recountFolder(inboxId)
    get().prepare('UPDATE mail_account SET last_sync_at = ? WHERE id = ?').run(now(), accountId)
    return { ok: true, accountId: accountId, added: added, updated: updated, total: messages.length }
  })
}

// 邮件列表：kind 来自文件夹 JOIN，unread/starred 为布尔筛选。
function list(filter) {
  const f = filter || {}
  return withLog('查询邮件', { accountId: f.accountId, folderId: f.folderId }, function () {
    // 停用的账户不出现在任何邮件列表（含统一收件箱与首页卡片），与左栏隐藏保持一致
    const where = ['m.account_id IN (SELECT id FROM mail_account WHERE enabled = 1)']
    const args = []
    if (f.accountId) { where.push('m.account_id = ?'); args.push(f.accountId) }
    if (f.folderId) { where.push('m.folder_id = ?'); args.push(f.folderId) }
    if (f.kind) { where.push('fo.kind = ?'); args.push(f.kind) }
    if (f.search) {
      where.push('(m.subject LIKE ? OR m.from_name LIKE ? OR m.snippet LIKE ?)')
      const kw = '%' + f.search + '%'
      args.push(kw, kw, kw)
    }
    if (f.unread === true || f.unread === 1) where.push('m.read = 0')
    if (f.starred === true || f.starred === 1) where.push('m.starred = 1')
    const sql = 'SELECT m.*, fo.name AS folder_name, fo.kind AS folder_kind FROM mail m LEFT JOIN mail_folder fo ON fo.id = m.folder_id WHERE ' + where.join(' AND ') + ' ORDER BY m.sent_at DESC'
    // better-sqlite3 的 all/run 必须用 ...args 展开，禁止 .apply(另一个 prepare 结果)，否则会抛 Illegal invocation。
    const rows = camelAll(get().prepare(sql).all(...args))
    return rows.map(function (r) {
      r.labels = parseArray(r.labels)
      r.toAddrs = parseArray(r.toAddrs)
      r.ccAddrs = parseArray(r.ccAddrs)
      return r
    })
  })
}

// 读取邮件：先标记已读，再返回含附件的完整详情。
function read(id) {
  return withLog('读取邮件', { id: id }, function () {
    // 打开即已读：只改本地库，界面与计数立刻生效，不碰服务器的 \Seen
    return withTx(function () {
      const row = get().prepare('SELECT read, folder_id FROM mail WHERE id = ?').get(id)
      if (!row) return null
      if (!row.read) {
        get().prepare('UPDATE mail SET read = 1 WHERE id = ?').run(id)
        recountFolder(row.folder_id)
      }
      return mailDetail(id)
    })
  })
}

// 发信：配置了 SMTP 就真实投递；未配置时只落本地「已发送」，由 delivered 区分。
async function send(dto) {
  const d = dto || {}
  if (!d.accountId) throw new Error('ACCOUNT_ID_REQUIRED')
  const acct = get().prepare('SELECT * FROM mail_account WHERE id = ?').get(d.accountId)
  if (!acct) throw new Error('MAIL_ACCOUNT_NOT_FOUND')

  const toAddrs = (d.toAddrs || []).filter(Boolean)
  const ccAddrs = (d.ccAddrs || []).filter(Boolean)
  let delivered = false
  if (acct.smtp_host && toAddrs.length) {
    const secret = String(decryptSecret(acct.secret_enc) || '').trim()
    await mailNet.sendMail({
      host: acct.smtp_host,
      port: acct.smtp_port || 465,
      user: String(acct.username || acct.email || '').trim(),
      pass: secret,
      from: acct.email || '',
      fromName: acct.alias || '',
      to: toAddrs,
      cc: ccAddrs,
      subject: d.subject || '(无主题)',
      text: d.bodyText || ''
    })
    delivered = true
  }

  return withTx(function () {
    const sentId = folderIdOf(d.accountId, 'sent', true)
    const id = uid('mail')
    const text = d.bodyText || ''
    const html = d.bodyHtml || ('<div>' + String(text).split('\n').join('<br>') + '</div>')
    get().prepare('INSERT INTO mail (id,account_id,folder_id,uid,msg_id,from_name,from_addr,to_addrs,cc_addrs,subject,snippet,body_html,body_text,has_attach,sent_at,read,starred,important,labels) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id, d.accountId, sentId, 'local-' + uid('u'), '<' + uid('msg') + '@dashboard.local>',
      '我', acct.email || d.fromAddr || null, toJsonString(toAddrs), toJsonString(ccAddrs),
      d.subject || '(无主题)', d.snippet || text.slice(0, 120), html, text,
      d.hasAttach ? 1 : 0, now(), 1, 0, d.important ? 1 : 0, toJsonString(d.labels || [])
    )
    if (Array.isArray(d.attachments)) {
      const insAttach = get().prepare('INSERT INTO mail_attachment (id,mail_id,filename,size,local_path) VALUES (?,?,?,?,?)')
      d.attachments.forEach(function (a) { insAttach.run(uid('att'), id, a.filename || '附件', a.size || 0, a.localPath || null) })
    }
    return { ok: true, id: id, delivered: delivered }
  })
}

// 保存草稿：带 id 时更新已有草稿，否则新建；同样落在 draft 文件夹。
function saveDraft(dto) {
  const d = dto || {}
  return withLog('保存草稿', { accountId: d.accountId, id: d.id }, function () {
    return withTx(function () {
      if (!d.accountId) throw new Error('ACCOUNT_ID_REQUIRED')
      const draftId = folderIdOf(d.accountId, 'draft', true)
      const text = d.bodyText || ''
      const html = d.bodyHtml || ('<div>' + String(text).split('\n').join('<br>') + '</div>')
      if (d.id && get().prepare('SELECT id FROM mail WHERE id = ?').get(d.id)) {
        get().prepare('UPDATE mail SET subject = ?,snippet = ?,body_html = ?,body_text = ?,to_addrs = ?,cc_addrs = ?,labels = ? WHERE id = ?').run(
          d.subject || '(无主题)', d.snippet || text.slice(0, 120), html, text,
          toJsonString(d.toAddrs || []), toJsonString(d.ccAddrs || []), toJsonString(d.labels || []), d.id
        )
        return { ok: true, id: d.id }
      }
      const id = uid('mail')
      get().prepare('INSERT INTO mail (id,account_id,folder_id,uid,msg_id,from_name,from_addr,to_addrs,cc_addrs,subject,snippet,body_html,body_text,has_attach,sent_at,read,starred,important,labels) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id, d.accountId, draftId, 'draft-' + uid('u'), '<' + uid('msg') + '@dashboard.local>',
        '我', d.fromAddr || null, toJsonString(d.toAddrs || []), toJsonString(d.ccAddrs || []),
        d.subject || '(无主题)', d.snippet || text.slice(0, 120), html, text,
        0, now(), 1, 0, 0, toJsonString(d.labels || [])
      )
      return { ok: true, id: id }
    })
  })
}


// 标记已读：只改本地库，左栏与首页卡片的未读数立刻减少；不碰服务器的 \Seen。
function markRead(id) {
  return withLog('标记已读', { id: id }, function () {
    return withTx(function () {
      const row = get().prepare('SELECT read, folder_id FROM mail WHERE id = ?').get(id)
      if (!row) return false
      if (!row.read) get().prepare('UPDATE mail SET read = 1 WHERE id = ?').run(id)
      recountFolder(row.folder_id)
      return true
    })
  })
}

// 标记未读：与 markRead 对称，同样只落本地库。
function markUnread(id) {
  return withLog('标记未读', { id: id }, function () {
    return withTx(function () {
      const row = get().prepare('SELECT read, folder_id FROM mail WHERE id = ?').get(id)
      if (!row) return false
      if (row.read) get().prepare('UPDATE mail SET read = 0 WHERE id = ?').run(id)
      recountFolder(row.folder_id)
      return true
    })
  })
}

// 切换星标，返回切换后的状态。
function toggleStar(id) {
  return withLog('切换星标', { id: id }, function () {
    return withTx(function () {
      const row = get().prepare('SELECT starred FROM mail WHERE id = ?').get(id)
      if (!row) return null
      const next = row.starred ? 0 : 1
      get().prepare('UPDATE mail SET starred = ? WHERE id = ?').run(next, id)
      return next === 1
    })
  })
}

// 删除邮件；附件通过外键级联清理。
function remove(id) {
  return withLog('删除邮件', { id: id }, function () {
    return withTx(function () {
      const row = get().prepare('SELECT folder_id FROM mail WHERE id = ?').get(id)
      get().prepare('DELETE FROM mail WHERE id = ?').run(id)
      recountFolder(row && row.folder_id)
      return true
    })
  })
}

// 规则列表：conditions/actions 从 JSON 字符串还原为数组。
function rules() {
  return withLog('查询规则', {}, function () {
    const rows = camelAll(get().prepare('SELECT * FROM mail_rule ORDER BY priority DESC, rowid ASC').all())
    return rows.map(function (r) {
      r.conditions = parseArray(r.conditions)
      r.actions = parseArray(r.actions)
      return r
    })
  })
}

// 新增或更新规则；优先级高的排前面。
function saveRule(dto) {
  const d = dto || {}
  return withLog('保存规则', { id: d.id, name: d.name }, function () {
    return withTx(function () {
      const id = d.id || uid('rule')
      const priority = d.priority == null ? 0 : d.priority
      const enabled = d.enabled == null ? 1 : bool(d.enabled)
      const conditions = toJsonString(d.conditions || [])
      const actions = toJsonString(d.actions || [])
      const exists = get().prepare('SELECT id FROM mail_rule WHERE id = ?').get(id)
      if (exists) {
        get().prepare('UPDATE mail_rule SET name = ?,priority = ?,enabled = ?,conditions = ?,actions = ? WHERE id = ?').run(
          d.name || '未命名规则', priority, enabled, conditions, actions, id
        )
      } else {
        get().prepare('INSERT INTO mail_rule (id,name,priority,enabled,conditions,actions) VALUES (?,?,?,?,?,?)').run(
          id, d.name || '未命名规则', priority, enabled, conditions, actions
        )
      }
      const row = camel(get().prepare('SELECT * FROM mail_rule WHERE id = ?').get(id))
      row.conditions = parseArray(row.conditions)
      row.actions = parseArray(row.actions)
      return row
    })
  })
}

// 供前端把邮件转成待办：只返回标题、来源、主题与正文，不暴露任何账户凭据。
function toTodoInfo(id) {
  return withLog('提取待办信息', { id: id }, function () {
    const row = get().prepare('SELECT from_name,from_addr,subject,body_text FROM mail WHERE id = ?').get(id)
    if (!row) return null
    const from = row.from_name
      ? String(row.from_name) + ' <' + String(row.from_addr || '') + '>'
      : String(row.from_addr || '')
    return {
      title: row.subject || '(无主题)',
      from: from,
      subject: row.subject || '',
      body: row.body_text || ''
    }
  })
}

/** 列出文件夹；传 accountId 时只列该账户，未传则列全部。 */
function folders(accountId) {
  try {
    // unread_count 直接按邮件表现算，不读 mail_folder 的缓存列：任何遗漏的重算都不会让左栏计数与列表对不上
    const sql = 'SELECT f.id, f.account_id, f.name, f.kind,'
      + ' (SELECT COUNT(*) FROM mail m WHERE m.folder_id = f.id AND m.read = 0) AS unread_count FROM mail_folder f'
    if (accountId) {
      return camelAll(get().prepare(sql + ' WHERE f.account_id = ? ORDER BY f.kind, f.name').all(accountId))
    }
    return camelAll(get().prepare(sql + ' ORDER BY f.account_id, f.kind, f.name').all())
  } catch (e) {
    logger.error('mail', 'folders_failed', e)
    return []
  }
}

module.exports = {
  accounts: accounts,
  folders: folders,
  addAccount: addAccount,
  updateAccount: updateAccount,
  revealSecret: revealSecret,
  migratePlain: migratePlain,
  removeAccount: removeAccount,
  testAccount: testAccount,
  sync: sync,
  list: list,
  read: read,
  send: send,
  saveDraft: saveDraft,
  markRead: markRead,
  markUnread: markUnread,
  toggleStar: toggleStar,
  remove: remove,
  rules: rules,
  saveRule: saveRule,
  toTodoInfo: toTodoInfo
}




