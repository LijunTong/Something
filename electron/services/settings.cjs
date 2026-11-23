// 设置领域服务：app_setting 键值表 + 本地存储统计 + 备份/恢复 + 导出 + 清理。
// 约束：所有 SQL 只在此文件；凭据（天气 API Key / JWT 私钥）明文单键保存，但键名在 INTERNAL_KEYS 里，不出现在 all()。
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { get, withTx, file } = require('../db/conn.cjs')
const { now } = require('../db/util.cjs')
const logger = require('../log/logger.cjs')
const scheduleSvc = require('./schedule.cjs')
const feedSvc = require('./feed.cjs')
const qweather = require('./qweather.cjs')
const secret = require('./secret.cjs')

const DEFAULTS = {
  appearance: { theme: '浅色', accent: '#0f766e', font: '中', sidebarExpand: true },
  // 事件通知：inApp 应用内（通知表 + 浮层）、desktop 系统通知（通知中心 toast）
  // systemOnlyAway：窗口在前台时只走应用内，避免同一条提醒弹两次
  notify: {
    inApp: true, desktop: true, systemOnlyAway: true,
    weather: true, schedule: true, todo: true,
    pomodoro: true, parcel: false, mail: true,
    dndOn: false, dndStart: '22:00', dndEnd: '08:00', privacy: 'summary',
    // 每个模块的提示音，默认蜂鸣；渲染层按名字播放 assets/sounds 里的音频
    sounds: {
      weather: '蜂鸣', schedule: '蜂鸣', todo: '蜂鸣',
      pomodoro: '蜂鸣', parcel: '蜂鸣', mail: '蜂鸣'
    }
  },
  shortcuts: { search: 'Ctrl+K', newTodo: 'N', focus: 'F' },
  // 窗口行为：关闭/最小化到托盘、开机启动（开机启动同时写入系统登录项）
  window: { closeToTray: true, minimizeToTray: false, launchAtLogin: false },
  // 自动备份：path 为空时落在数据库同级的 backups 目录
  backup: { auto: true, path: '', freq: '每天', encrypted: false, passwordSet: false, lastAt: null, lastFile: null },
  // 天气：unit 供天气页与首页共享；apiKeySet 只是状态位，真值不进 all()
  // host/geoHost 均为和风天气 API Host：老账号用 devapi/geoapi，新账号填控制台里自己的 Host
  // host/geoHost 为空表示还没配置：和风天气要求使用控制台分配的账号专属 API Host
  // authMode/jwtSet 由凭据推算，不落库
  // refreshMin：自动刷新频率（分钟，默认 5）；authType：设置面板里选中的认证方式
  weather: {
    source: 'qweather', host: '', geoHost: '', cacheMin: 5, refreshMin: 5, authType: 'jwt',
    offlineCache: true, alertPush: true, unit: 'C',
    apiKeySet: false, apiKeyHint: '', jwtSet: false, jwtMeta: null, authMode: 'none'
  },
  feed: { defaultInterval: 360, keepContent: true },
  // 邮件：autoSyncMin 是自动同步间隔（分钟，默认 15）；0 表示只在手动点「同步」时拉取
  mail: { autoSyncMin: 15 },
  // MCP：Agent 接入开关与端口。只监听 127.0.0.1，默认关闭；Token 在 INTERNAL_KEYS 里
  // port 为 null 表示没有手动指定，由主进程按环境取默认（开发 3927 / 安装版 3928，TK_MCP_PORT 优先）
  mcp: { enabled: false, port: null },
  // 快递：provider 为选中的数据源（manual=手动维护）；autoRefreshMin 是后台自动刷新间隔（分钟，0 关闭）
  // credentials 只是凭据状态位，由库里是否保存推算，真值不进 all()
  parcel: { provider: 'manual', autoRefreshMin: 0, detectCompany: true, credentials: {} },
  // 首页卡片显隐：只影响首页展示，模块页与数据不受影响
  modules: { dashboard: true, weather: true, schedule: true, todo: true, pomodoro: true, feed: true, parcel: true, mail: true, notice: true },
  // 首页卡片布局：x/y 为网格坐标、w/h 为网格单位（行高 40px、间距 16px、列数 3/2/1 自适应）
  // 这份坐标与渲染层 packLayout(默认顺序) 的结果一致；旧数据只有 w/h 时由渲染层补齐坐标
  // locked 为 true 时首页不允许拖动与缩放
  home: {
    locked: false,
    layout: [
      { key: 'weather', x: 0, y: 0, w: 1, h: 6 },
      { key: 'schedule', x: 1, y: 0, w: 2, h: 6 },
      { key: 'todo', x: 0, y: 6, w: 1, h: 6 },
      { key: 'pomodoro', x: 1, y: 6, w: 1, h: 7 },
      { key: 'parcel', x: 2, y: 6, w: 1, h: 6 },
      { key: 'feed', x: 0, y: 12, w: 1, h: 6 },
      { key: 'mail', x: 1, y: 13, w: 2, h: 6 },
      { key: 'notice', x: 0, y: 18, w: 1, h: 5 }
    ]
  }
}

// 内部键：不进 all()，避免凭据或内部游标泄漏到渲染层
const INTERNAL_KEYS = [
  'weatherKey', 'qweatherJwt',
  // 快递数据源凭据：按数据源分别存一条，键名含 key，日志里自动脱敏
  'parcelKey_kuaidi100', 'parcelKey_kdniao', 'parcelKey_juhe',
  'noticeReadAt', 'noticeDerivedRead', 'noticeDismissed', 'notifyEmitted',
  // MCP Bearer Token：等同计划写权限，绝不进 all()
  'mcpToken'
]

// 备份包含的业务表（按外键顺序插入，删除时反向）
const TABLES = [
  'todo_list', 'todo', 'todo_subtask', 'project_plan',
  'schedule_calendar', 'schedule', 'schedule_exception',
  'pomodoro_session', 'pomodoro_state',
  'weather_city', 'weather_cache',
  'feed_group', 'feed_source', 'feed_item',
  'parcel', 'parcel_track',
  'mail_account', 'mail_folder', 'mail', 'mail_rule', 'mail_attachment',
  'notification', 'app_setting'
]

const MAGIC = 'EFFICIENCY-BACKUP-1'
const MAGIC_ENC = 'EFFICIENCY-BACKUP-ENC-1'

const SEGMENTS = [
  { key: 'schedule', label: '日程', color: '#2563eb' },
  { key: 'todo', label: '待办', color: '#16a34a' },
  { key: 'mail', label: '邮件缓存', color: '#c2410c' },
  { key: 'feed', label: '文章缓存', color: '#a855f7' },
  { key: 'attachment', label: '附件', color: '#94a3b8' }
]

function fail(where, err, meta) {
  try { logger.error('settings', where, err, meta || {}) } catch (e) { /* 日志失败不影响主流程 */ }
  throw err
}

function readAll() {
  const rows = get().prepare('SELECT key, value FROM app_setting').all()
  const out = {}
  for (const k in DEFAULTS) out[k] = JSON.parse(JSON.stringify(DEFAULTS[k]))
  rows.forEach(function (r) {
    if (INTERNAL_KEYS.indexOf(r.key) >= 0) return
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, r.key)) return
    try { out[r.key] = Object.assign({}, out[r.key], JSON.parse(r.value)) } catch (e) { out[r.key] = r.value }
  })
  // 凭据状态位以库里是否存在加密记录为准，不信任前端提交值
  if (out.weather && typeof out.weather === 'object') {
    Object.assign(out.weather, weatherStatus())
  }
  // 快递数据源同理：只合并「是否已配置」，凭据本身留在 INTERNAL_KEYS 里
  if (out.parcel && typeof out.parcel === 'object') {
    Object.assign(out.parcel, parcelStatus())
  }
  // 历史配置清理：快捷添加已移除；视图切换区间收敛为 Ctrl+1-2
  if (out.shortcuts && typeof out.shortcuts === 'object') {
    delete out.shortcuts.quickAdd
    delete out.shortcuts.viewSwitch
  }
  return out
}

function getOne(key) {
  const row = get().prepare('SELECT value FROM app_setting WHERE key = ?').get(key)
  if (!row) return DEFAULTS[key] || null
  try { return JSON.parse(row.value) } catch (e) { return row.value }
}

function writeKey(key, value) {
  get().prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)').run(key, JSON.stringify(value))
}

/** 写设置：按 section 合并（避免面板只提交部分字段时把其它字段抹掉）。 */
function set(dto) {
  try {
    return withTx(function () {
      for (const k in dto) {
        if (INTERNAL_KEYS.indexOf(k) >= 0) continue
        const base = DEFAULTS[k] && typeof DEFAULTS[k] === 'object' ? DEFAULTS[k] : null
        const prev = getOne(k)
        const merged = base
          ? Object.assign({}, prev && typeof prev === 'object' ? prev : {}, dto[k] && typeof dto[k] === 'object' ? dto[k] : {})
          : dto[k]
        // credentials 是派生状态，渲染层回传时丢掉，避免把状态位写进库里
        if (k === 'parcel' && merged && typeof merged === 'object') delete merged.credentials
        writeKey(k, merged)
      }
      get().prepare('INSERT INTO operation_log (action, detail, created_at) VALUES (?,?,?)')
        .run('settings.set', Object.keys(dto).join(','), now())
      return readAll()
    })
  } catch (err) {
    return fail('set failed', err, { keys: Object.keys(dto || {}) })
  }
}

function num(sql) {
  try {
    const r = get().prepare(sql).get()
    if (!r) return 0
    const v = Object.values(r)[0]
    return Number(v || 0)
  } catch (e) {
    return 0
  }
}

function fileBytes(p) {
  try { return fs.existsSync(p) ? fs.statSync(p).size : 0 } catch (e) { return 0 }
}

function dbBytes() {
  const f = file()
  if (!f) return 0
  return fileBytes(f) + fileBytes(f + '-wal')
}

function attachmentBytes() {
  const rows = get().prepare('SELECT local_path, size FROM mail_attachment').all()
  let total = 0
  rows.forEach(function (r) {
    const onDisk = r.local_path ? fileBytes(String(r.local_path)) : 0
    total += onDisk > 0 ? onDisk : Number(r.size || 0)
  })
  return total
}

/** 本地存储用量：数据库文件 + 附件，按五个业务分段估算占用。 */
function storage() {
  try {
    const scheduleRows = num('SELECT COUNT(*) AS v FROM schedule') + num('SELECT COUNT(*) AS v FROM schedule_exception')
    const todoRows = num('SELECT COUNT(*) AS v FROM todo') + num('SELECT COUNT(*) AS v FROM todo_subtask')
    const planRows = num('SELECT COUNT(*) AS v FROM project_plan')
    const mailText = num("SELECT COALESCE(SUM(length(coalesce(body_html,''))+length(coalesce(body_text,''))+length(coalesce(snippet,''))+length(coalesce(subject,''))),0) AS v FROM mail")
    const feedText = num("SELECT COALESCE(SUM(length(coalesce(content,''))+length(coalesce(summary,''))+length(coalesce(title,''))),0) AS v FROM feed_item")
    const mailRows = num('SELECT COUNT(*) AS v FROM mail')
    const attachRows = num('SELECT COUNT(*) AS v FROM mail_attachment')
    const seg = {
      schedule: scheduleRows * 420,
      todo: todoRows * 360 + planRows * 320,
      mail: mailText + mailRows * 220,
      feed: feedText,
      attachment: attachmentBytes() + attachRows * 512
    }
    const segments = SEGMENTS.map(function (s) { return { key: s.key, label: s.label, color: s.color, bytes: Math.max(0, Math.round(seg[s.key])) } })
    const attachments = segments[4] ? segments[4].bytes : 0
    // 数据库文件里还有索引、页头与系统表，补一段「系统与索引」让分段之和等于总占用
    const knownBytes = segments.reduce(function (sum, s) { return sum + s.bytes }, 0) - attachments
    segments.push({ key: 'system', label: '系统与索引', color: '#cbd5e1', bytes: Math.max(0, Math.round(dbBytes() - knownBytes)) })
    return {
      dbFile: file(),
      dbBytes: dbBytes(),
      attachmentBytes: attachments,
      totalBytes: dbBytes() + attachments,
      segments: segments,
      counts: {
        todo: num('SELECT COUNT(*) AS v FROM todo'),
        schedule: num('SELECT COUNT(*) AS v FROM schedule'),
        mail: mailRows,
        feed: num('SELECT COUNT(*) AS v FROM feed_item'),
        parcel: num('SELECT COUNT(*) AS v FROM parcel'),
        city: num('SELECT COUNT(*) AS v FROM weather_city'),
        notification: num('SELECT COUNT(*) AS v FROM notification')
      },
      backupDir: backupDir(),
      lastBackupAt: (getOne('backup') || {}).lastAt || null
    }
  } catch (err) {
    return fail('storage failed', err, {})
  }
}

/* ---------- 备份目录与文件命名 ---------- */

function backupDir() {
  const cfg = getOne('backup') || DEFAULTS.backup
  const dir = cfg.path ? String(cfg.path) : path.join(path.dirname(file()), 'backups')
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { /* 不可写时由 backup() 抛错 */ }
  return dir
}

function exportDir() {
  const dir = path.join(path.dirname(file()), 'exports')
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { /* 同上 */ }
  return dir
}

function pad2(n) { return String(n).padStart(2, '0') }

function stamp(d) {
  const t = d || new Date()
  return '' + t.getFullYear() + pad2(t.getMonth() + 1) + pad2(t.getDate()) + '-' + pad2(t.getHours()) + pad2(t.getMinutes()) + pad2(t.getSeconds())
}

/** 全量转储：业务表逐表 SELECT，附计数，便于恢复时核对。 */
function dump() {
  const d = get()
  const out = { magic: MAGIC, version: 1, at: now(), tables: {}, counts: {} }
  TABLES.forEach(function (t) {
    try {
      out.tables[t] = d.prepare('SELECT * FROM ' + t).all()
      out.counts[t] = out.tables[t].length
    } catch (e) {
      out.tables[t] = []
      out.counts[t] = 0
    }
  })
  return out
}

/* ---------- 加密：scrypt 派生密钥 + AES-256-GCM；口令只在内存态使用 ---------- */

function encryptText(plain, password) {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(String(password), salt, 32)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()])
  return {
    magic: MAGIC_ENC, version: 1,
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64')
  }
}

function decryptText(env, password) {
  const key = crypto.scryptSync(String(password), Buffer.from(env.salt, 'base64'), 32)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]).toString('utf8')
}

/* ---------- 备份 / 列表 / 恢复 ---------- */

function backup(dto) {
  try {
    const o = dto || {}
    const cfg = getOne('backup') || DEFAULTS.backup
    const dir = cfg.path ? String(cfg.path) : backupDir()
    fs.mkdirSync(dir, { recursive: true })
    const plain = JSON.stringify(dump())
    const useEnc = !!o.password || !!cfg.encrypted
    if (useEnc && !o.password) throw new Error('BACKUP_PASSWORD_REQUIRED')
    const body = useEnc ? JSON.stringify(encryptText(plain, o.password)) : plain
    // 同一秒内可能连续备份（例如恢复前自动快照），补毫秒与冲突序号避免互相覆盖
    let target = path.join(dir, 'efficiency-backup-' + stamp() + '-' + String(Date.now() % 1000).padStart(3, '0') + (useEnc ? '.enc.json' : '.json'))
    let seq = 1
    while (fs.existsSync(target)) {
      target = path.join(dir, 'efficiency-backup-' + stamp() + '-' + String(Date.now() % 1000).padStart(3, '0') + '-' + seq + (useEnc ? '.enc.json' : '.json'))
      seq += 1
    }
    const name = path.basename(target)
    fs.writeFileSync(target, body, 'utf8')
    const t = now()
    writeKey('backup', Object.assign({}, cfg, { lastAt: t, lastFile: target, passwordSet: useEnc }))
    get().prepare('INSERT INTO operation_log (action, detail, created_at) VALUES (?,?,?)').run('settings.backup', name, t)
    return { path: target, name: name, bytes: Buffer.byteLength(body), encrypted: useEnc, at: t }
  } catch (err) {
    return fail('backup failed', err, {})
  }
}

function backups() {
  const dir = backupDir()
  let names = []
  try { names = fs.readdirSync(dir).filter(function (n) { return /\.json$/.test(n) }) } catch (e) { names = [] }
  const files = names.map(function (n) {
    const p = path.join(dir, n)
    let bytes = 0
    let at = 0
    let encrypted = false
    try { const st = fs.statSync(p); bytes = st.size; at = st.mtimeMs } catch (e) { /* 文件已被外部删除 */ }
    try { encrypted = fs.readFileSync(p, 'utf8').slice(0, 80).indexOf(MAGIC_ENC) >= 0 } catch (e) { /* 读失败按未加密处理 */ }
    return { path: p, name: n, bytes: bytes, at: at, encrypted: encrypted }
  })
  files.sort(function (a, b) { return b.at - a.at })
  return { dir: dir, files: files.slice(0, 50) }
}

function restore(dto) {
  try {
    const o = dto || {}
    let text = ''
    if (o.text) text = String(o.text)
    else if (o.path) text = fs.readFileSync(String(o.path), 'utf8')
    else throw new Error('BACKUP_SOURCE_REQUIRED')
    let data = null
    try { data = JSON.parse(text) } catch (e) { throw new Error('BACKUP_INVALID_JSON') }
    if (data && data.magic === MAGIC_ENC) {
      if (!o.password) throw new Error('BACKUP_PASSWORD_REQUIRED')
      try { data = JSON.parse(decryptText(data, o.password)) } catch (e) { throw new Error('BACKUP_PASSWORD_WRONG') }
    }
    if (!data || data.magic !== MAGIC || !data.tables) throw new Error('BACKUP_INVALID_FORMAT')
    // 覆盖前先拍当前数据快照：恢复异常时至少还有一份可回退的本机文件
    const snap = backup({})
    const restored = withTx(function () {
      const d = get()
      TABLES.slice().reverse().forEach(function (t) { try { d.prepare('DELETE FROM ' + t).run() } catch (e) { /* 表不存在则跳过 */ } })
      const counts = {}
      TABLES.forEach(function (t) {
        const list = Array.isArray(data.tables[t]) ? data.tables[t] : []
        if (!list.length) { counts[t] = 0; return }
        const cols = Object.keys(list[0])
        const sql = 'INSERT OR REPLACE INTO ' + t + ' (' + cols.join(',') + ') VALUES (' + cols.map(function () { return '?' }).join(',') + ')'
        const st = d.prepare(sql)
        list.forEach(function (row) {
          st.run(cols.map(function (c) { return row[c] === undefined ? null : row[c] }))
        })
        counts[t] = list.length
      })
      d.prepare('INSERT INTO operation_log (action, detail, created_at) VALUES (?,?,?)').run('settings.restore', 'restored=' + Object.keys(counts).length, now())
      return counts
    })
    return { restored: restored, snapshot: snap.path, at: now() }
  } catch (err) {
    return fail('restore failed', err, { path: dto && dto.path })
  }
}

/* ---------- 导出 ---------- */

function mbox() {
  const rows = get().prepare('SELECT * FROM mail ORDER BY sent_at ASC').all()
  const parts = rows.map(function (m) {
    const d = new Date(m.sent_at || now())
    const body = m.body_text || String(m.body_html || '').replace(/<[^>]+>/g, ' ')
    return 'From ' + (m.from_addr || 'unknown@local') + ' ' + d.toUTCString() + '\n' +
      'From: ' + (m.from_name || '') + ' <' + (m.from_addr || '') + '>\n' +
      'To: ' + (m.to_addrs || '') + '\n' +
      'Subject: ' + (m.subject || '') + '\n' +
      'Date: ' + d.toUTCString() + '\n' +
      'Content-Type: text/plain; charset=utf-8\n\n' + body + '\n'
  })
  return parts.join('\n')
}

function exportData(dto) {
  try {
    const kind = String((dto && dto.kind) || 'json')
    let name = ''
    let body = ''
    if (kind === 'json') {
      name = 'efficiency-data-' + stamp() + '.json'
      body = JSON.stringify(dump())
    } else if (kind === 'ics') {
      name = 'schedule-' + stamp() + '.ics'
      body = scheduleSvc.exportICS({})
    } else if (kind === 'opml') {
      name = 'feeds-' + stamp() + '.opml'
      body = feedSvc.exportOPML()
    } else if (kind === 'eml') {
      name = 'mail-' + stamp() + '.mbox'
      body = mbox()
    } else {
      throw new Error('EXPORT_KIND_UNKNOWN')
    }
    const target = path.join(exportDir(), name)
    fs.writeFileSync(target, String(body == null ? '' : body), 'utf8')
    get().prepare('INSERT INTO operation_log (action, detail, created_at) VALUES (?,?,?)').run('settings.export', kind + ' ' + name, now())
    return { path: target, name: name, bytes: Buffer.byteLength(String(body == null ? '' : body)), kind: kind }
  } catch (err) {
    return fail('export failed', err, { kind: dto && dto.kind })
  }
}

/* ---------- 清理 ---------- */

/** 清空缓存：天气缓存全清；已读且未收藏/未稍后读的正文缓存置空（保留索引行）。 */
function clearCache() {
  try {
    return withTx(function () {
      const d = get()
      const weather = d.prepare('DELETE FROM weather_cache').run().changes
      const feed = d.prepare('UPDATE feed_item SET content = NULL WHERE read = 1 AND starred = 0 AND read_later = 0 AND content IS NOT NULL').run().changes
      const mail = d.prepare('UPDATE mail SET body_html = NULL, body_text = NULL WHERE read = 1 AND starred = 0 AND (body_html IS NOT NULL OR body_text IS NOT NULL)').run().changes
      d.prepare('INSERT INTO operation_log (action, detail, created_at) VALUES (?,?,?)')
        .run('settings.clearCache', 'weather=' + weather + ' feed=' + feed + ' mail=' + mail, now())
      return { weather: weather, feed: feed, mail: mail }
    })
  } catch (err) {
    return fail('clearCache failed', err, {})
  }
}

/** 清空回收站：已删除待办 + 已归档包裹。 */
function clearTrash() {
  try {
    return withTx(function () {
      const d = get()
      // 待办采用硬删除，没有回收站表；这里清理已取消任务、已归档包裹与已删除清单
      const todos = d.prepare("DELETE FROM todo WHERE status = '取消'").run().changes
      const parcels = d.prepare('DELETE FROM parcel WHERE archived = 1').run().changes
      const lists = d.prepare('DELETE FROM todo_list WHERE deleted_at IS NOT NULL').run().changes
      d.prepare('INSERT INTO operation_log (action, detail, created_at) VALUES (?,?,?)')
        .run('settings.clearTrash', 'todos=' + todos + ' parcels=' + parcels + ' lists=' + lists, now())
      return { todos: todos, parcels: parcels, lists: lists }
    })
  } catch (err) {
    return fail('clearTrash failed', err, {})
  }
}

/** 重置全部数据：清空所有业务表（设置也随之回到默认值）。 */
function resetAll() {
  try {
    const ok = withTx(function () {
      const d = get()
      TABLES.slice().reverse().forEach(function (t) { try { d.prepare('DELETE FROM ' + t).run() } catch (e) { /* 跳过不存在的表 */ } })
      d.prepare('INSERT INTO operation_log (action, detail, created_at) VALUES (?,?,?)').run('settings.resetAll', '', now())
      return true
    })
    // 事务提交后才能回收空间；顺手把 WAL 截断，否则文件大小看起来没变
    try { get().exec('VACUUM') } catch (e) { /* 空间回收失败不影响重置结果 */ }
    try { get().pragma('wal_checkpoint(TRUNCATE)') } catch (e) { /* 同上 */ }
    return ok
  } catch (err) {
    return fail('resetAll failed', err, {})
  }
}

/* ---------- 天气数据源凭据 ---------- */

/** 读天气 API Key 明文（旧密文自动解出）；没有则返回空串 */
function readWeatherKey() {
  try {
    const row = get().prepare("SELECT value FROM app_setting WHERE key = 'weatherKey'").get()
    if (!row) return ''
    return String(secret.unpack(row.value) || '').trim()
  } catch (e) {
    return ''
  }
}

/** JWT 凭据明文对象：{ developerId, projectId, keyId, privateKey } */
function readJwtCred() {
  try {
    const row = get().prepare("SELECT value FROM app_setting WHERE key = 'qweatherJwt'").get()
    if (!row) return null
    const plain = secret.unpack(row.value)
    if (!plain) return null
    const cred = JSON.parse(plain)
    return cred && typeof cred === 'object' ? cred : null
  } catch (e) {
    return null
  }
}

function hasWeatherKey() {
  return !!readWeatherKey()
}

function hasWeatherJwt() {
  try {
    return !!get().prepare("SELECT value FROM app_setting WHERE key = 'qweatherJwt'").get()
  } catch (e) {
    return false
  }
}

/** 当前认证方式：JWT 优先（官方推荐），其次 API Key */
function weatherAuthMode() {
  if (hasWeatherJwt()) return 'jwt'
  if (hasWeatherKey()) return 'key'
  return 'none'
}

/** 回显用：JWT 的开发者/项目/凭据 ID 可以回显；私钥只在 revealSecret 里按需返回 */
function readJwtMeta() {
  const cred = readJwtCred()
  if (!cred) return null
  return {
    developerId: String(cred.developerId || ''),
    projectId: String(cred.projectId || ''),
    keyId: String(cred.keyId || ''),
    privateKeySet: !!cred.privateKey
  }
}

/** 回显用：列表里只给尾号，完整 Key 由 revealSecret 按需返回 */
function readApiKeyHint() {
  const key = readWeatherKey()
  return key ? key.slice(-4) : ''
}

/**
 * 一次性迁移：把旧版 safeStorage 密文改写成明文（{plain} 包装）。
 * 只在启动时跑一次，已是明文的记录不动，返回改写的条数。
 */
function migratePlain() {
  try {
    return withTx(function () {
      let changed = 0
      ;['weatherKey', 'qweatherJwt'].forEach(function (key) {
        const row = get().prepare('SELECT value FROM app_setting WHERE key = ?').get(key)
        if (!row || !row.value) return
        const plain = secret.unpack(row.value)
        if (!plain) return
        if (row.value === secret.pack(plain)) return
        get().prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)').run(key, secret.pack(plain))
        changed += 1
      })
      return changed
    })
  } catch (e) {
    return 0
  }
}

/** 按需取明文：设置页默认掩码，用户点「显示」时才调这里 */
function revealSecret(dto) {
  const kind = dto && dto.kind
  if (kind === 'weatherKey') return { kind: kind, value: readWeatherKey() }
  if (kind === 'weatherJwt') {
    const cred = readJwtCred()
    return { kind: kind, value: cred ? String(cred.privateKey || '') : '' }
  }
  throw new Error('UNKNOWN_SECRET_KIND')
}

function weatherStatus() {
  const cfg = Object.assign({}, DEFAULTS.weather, getOne('weather') || {})
  cfg.apiKeySet = hasWeatherKey()
  cfg.apiKeyHint = readApiKeyHint()
  cfg.jwtSet = hasWeatherJwt()
  cfg.jwtMeta = readJwtMeta()
  cfg.authMode = weatherAuthMode()
  return cfg
}

/** 保存 JWT 凭据：整个对象明文单键存放（设置页默认掩码），返回值只带状态位 */
function setWeatherJwt(dto) {
  try {
    return withTx(function () {
      const d = dto || {}
      const developerId = String(d.developerId || '').trim()
      const projectId = String(d.projectId || '').trim()
      const keyId = String(d.keyId || '').trim()
      const metaBefore = readJwtMeta()
      const privateKeyInput = String(d.privateKey || '').trim()
      // 编辑已有凭据时私钥可以留空，表示沿用原私钥（私钥不回显）
      const privateKey = privateKeyInput || (metaBefore && metaBefore.privateKeySet ? '<keep>' : '')
      if (!developerId || !projectId || !keyId || !privateKey) throw new Error('JWT 四项都必填：开发者 ID、项目 ID、凭据 ID、Ed25519 私钥')
      let finalKey = privateKey
      if (privateKey === '<keep>') {
        const prev = readJwtCred() || {}
        finalKey = String(prev.privateKey || '')
      }
      if (!finalKey) throw new Error('未找到原私钥，请重新粘贴 Ed25519 私钥')
      const payload = JSON.stringify({ developerId: developerId, projectId: projectId, keyId: keyId, privateKey: finalKey })
      get().prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)').run('qweatherJwt', secret.pack(payload))
      return weatherStatus()
    })
  } catch (err) {
    return fail('setWeatherJwt failed', err, {})
  }
}

function clearWeatherJwt() {
  try {
    return withTx(function () {
      get().prepare("DELETE FROM app_setting WHERE key = 'qweatherJwt'").run()
      return weatherStatus()
    })
  } catch (err) {
    return fail('clearWeatherJwt failed', err, {})
  }
}

/** 保存天气 API Key：明文单键存放，返回值只带 apiKeySet 状态位。 */
function setWeatherKey(dto) {
  try {
    return withTx(function () {
      const key = dto && dto.key ? String(dto.key).trim() : ''
      if (!key) {
        get().prepare("DELETE FROM app_setting WHERE key = 'weatherKey'").run()
        return weatherStatus()
      }
      get().prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)').run('weatherKey', secret.pack(key))
      return weatherStatus()
    })
  } catch (err) {
    return fail('setWeatherKey failed', err, {})
  }
}

/** 数据源自检：真实调用 GeoAPI 城市搜索 + 实时天气，验证 Key、Host 与网络 */
async function testWeather() {
  try {
    return await qweather.test()
  } catch (err) {
    return fail('testWeather failed', err, {})
  }
}

/* ---------- MCP 接入 ---------- */

/** 当前 MCP Token 明文；没有返回空串。每次请求都现取，轮换立即生效。 */
function mcpToken() {
  try {
    const row = get().prepare("SELECT value FROM app_setting WHERE key = 'mcpToken'").get()
    return row ? String(secret.unpack(row.value) || '').trim() : ''
  } catch (e) {
    return ''
  }
}

/** 首次使用时生成 32 字节随机 Token（64 位 hex）。 */
function ensureMcpToken() {
  const existed = mcpToken()
  if (existed) return existed
  const token = crypto.randomBytes(32).toString('hex')
  get().prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)').run('mcpToken', secret.pack(token))
  return token
}

/** 轮换 Token：旧值立即失效，等价于让旧配置作废。 */
function rotateMcpToken() {
  try {
    return withTx(function () {
      const token = crypto.randomBytes(32).toString('hex')
      get().prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)').run('mcpToken', secret.pack(token))
      return { token: token }
    })
  } catch (err) {
    return fail('rotateMcpToken failed', err, {})
  }
}

/** 保存 MCP 开关与端口；返回归一化后的 mcp 配置。 */
function setMcp(dto) {
  const o = dto || {}
  const patch = { enabled: !!o.enabled }
  if (o.port != null) patch.port = o.port
  const all = set({ mcp: patch })
  return all.mcp
}

/* ---------- 快递数据源凭据 ---------- */

// 每个数据源一条凭据，JSON 明文存放（键名在 INTERNAL_KEYS 里，不会出现在 all()）
const PARCEL_CRED_KEYS = {
  kuaidi100: 'parcelKey_kuaidi100',
  kdniao: 'parcelKey_kdniao',
  juhe: 'parcelKey_juhe'
}

function parcelCredKey(provider) {
  const key = String(provider || '')
  const name = PARCEL_CRED_KEYS[key]
  if (!name) throw new Error('未知的快递数据源：' + (key || '空'))
  return name
}

/** 读某个数据源的凭据明文对象；没有则 null */
function readParcelCredential(provider) {
  try {
    const name = PARCEL_CRED_KEYS[String(provider || '')]
    if (!name) return null
    const row = get().prepare('SELECT value FROM app_setting WHERE key = ?').get(name)
    if (!row) return null
    const plain = secret.unpack(row.value)
    if (!plain) return null
    const cred = JSON.parse(plain)
    return cred && typeof cred === 'object' ? cred : null
  } catch (e) {
    return null
  }
}

function maskTail(value) {
  const text = String(value || '')
  return text ? '••••' + text.slice(-4) : ''
}

/** 单个数据源的配置状态：哪些字段已填、尾号提示（不回传完整凭据） */
function parcelCredentialStatus(provider) {
  const cred = readParcelCredential(provider) || {}
  const filled = []
  const hints = {}
  Object.keys(cred).forEach(function (k) {
    const text = String(cred[k] || '')
    if (!text) return
    filled.push(k)
    hints[k] = maskTail(text)
  })
  return { set: filled.length > 0, filled: filled, hints: hints }
}

function parcelStatus() {
  const credentials = {}
  Object.keys(PARCEL_CRED_KEYS).forEach(function (p) { credentials[p] = parcelCredentialStatus(p) })
  return { credentials: credentials }
}

/** 保存凭据：values 里的空串表示清掉该字段；全部为空时删除整条记录 */
function setParcelCredential(dto) {
  try {
    return withTx(function () {
      const provider = String((dto && dto.provider) || '')
      const name = parcelCredKey(provider)
      const values = (dto && dto.values) || {}
      const next = Object.assign({}, readParcelCredential(provider) || {})
      Object.keys(values).forEach(function (k) {
        const text = String(values[k] == null ? '' : values[k]).trim()
        if (text) next[k] = text
        else delete next[k]
      })
      if (!Object.keys(next).length) {
        get().prepare('DELETE FROM app_setting WHERE key = ?').run(name)
      } else {
        get().prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)').run(name, secret.pack(JSON.stringify(next)))
      }
      return parcelStatus()
    })
  } catch (err) {
    return fail('setParcelCredential failed', err, {})
  }
}

function clearParcelCredential(dto) {
  try {
    return withTx(function () {
      const name = parcelCredKey(String((dto && dto.provider) || ''))
      get().prepare('DELETE FROM app_setting WHERE key = ?').run(name)
      return parcelStatus()
    })
  } catch (err) {
    return fail('clearParcelCredential failed', err, {})
  }
}

/** 明文回显：设置面板点「显示已保存」时才调 */
function revealParcelCredential(dto) {
  const provider = String((dto && dto.provider) || '')
  parcelCredKey(provider)
  return { provider: provider, values: readParcelCredential(provider) || {} }
}

module.exports = {
  all: readAll, get: getOne, set: set, defaults: DEFAULTS,
  storage: storage, backup: backup, backups: backups, restore: restore,
  exportData: exportData, clearCache: clearCache, clearTrash: clearTrash, resetAll: resetAll,
  setWeatherKey: setWeatherKey, setWeatherJwt: setWeatherJwt, clearWeatherJwt: clearWeatherJwt,
  revealSecret: revealSecret, migratePlain: migratePlain, testWeather: testWeather,
  readParcelCredential: readParcelCredential, setParcelCredential: setParcelCredential,
  clearParcelCredential: clearParcelCredential, revealParcelCredential: revealParcelCredential,
  parcelStatus: parcelStatus,
  mcpToken: mcpToken, ensureMcpToken: ensureMcpToken, rotateMcpToken: rotateMcpToken, setMcp: setMcp
}
