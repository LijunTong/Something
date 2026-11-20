// 设置领域服务：app_setting 键值表 + 本地存储统计 + 备份/恢复 + 导出 + 清理。
// 约束：所有 SQL 只在此文件；凭据（天气 API Key）经 safeStorage 加密后单键保存，永不出现在 all()。
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { get, withTx, file } = require('../db/conn.cjs')
const { now } = require('../db/util.cjs')
const logger = require('../log/logger.cjs')
const scheduleSvc = require('./schedule.cjs')
const feedSvc = require('./feed.cjs')

const DEFAULTS = {
  appearance: { theme: '浅色', accent: '#0f766e', font: '小', sidebarExpand: true },
  notify: {
    desktop: true, weather: true, schedule: true, todo: true,
    pomodoro: true, parcel: false, mail: true,
    dndStart: '22:00', dndEnd: '08:00', privacy: 'summary'
  },
  shortcuts: { search: 'Ctrl+K', newTodo: 'N', focus: 'F', quickAdd: 'Space', viewSwitch: 'Ctrl+1-3' },
  // 自动备份：path 为空时落在数据库同级的 backups 目录
  backup: { auto: true, path: '', freq: '每天', encrypted: false, passwordSet: false, lastAt: null, lastFile: null },
  // 天气：unit 供天气页与首页共享；apiKeySet 只是状态位，真值不进 all()
  weather: { source: 'qweather', host: 'api.qweather.com', cacheMin: 30, offlineCache: true, alertPush: true, unit: 'C', apiKeySet: false },
  feed: { defaultInterval: 360, keepContent: true },
  modules: { dashboard: true, weather: true, schedule: true, todo: true, pomodoro: true, feed: true, parcel: true, mail: true }
}

// 内部键：不进 all()，避免凭据或内部游标泄漏到渲染层
const INTERNAL_KEYS = ['weatherKey', 'noticeReadAt']

// 备份包含的业务表（按外键顺序插入，删除时反向）
const TABLES = [
  'todo_list', 'todo', 'todo_subtask',
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
  if (out.weather && typeof out.weather === 'object') out.weather.apiKeySet = hasWeatherKey()
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
    const mailText = num("SELECT COALESCE(SUM(length(coalesce(body_html,''))+length(coalesce(body_text,''))+length(coalesce(snippet,''))+length(coalesce(subject,''))),0) AS v FROM mail")
    const feedText = num("SELECT COALESCE(SUM(length(coalesce(content,''))+length(coalesce(summary,''))+length(coalesce(title,''))),0) AS v FROM feed_item")
    const mailRows = num('SELECT COUNT(*) AS v FROM mail')
    const attachRows = num('SELECT COUNT(*) AS v FROM mail_attachment')
    const seg = {
      schedule: scheduleRows * 420,
      todo: todoRows * 360,
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

function hasWeatherKey() {
  try {
    return !!get().prepare("SELECT value FROM app_setting WHERE key = 'weatherKey'").get()
  } catch (e) {
    return false
  }
}

function encryptSecret(plain) {
  const safeStorage = require('electron').safeStorage
  if (!safeStorage || typeof safeStorage.encryptString !== 'function') throw new Error('ENCRYPTION_UNAVAILABLE')
  return safeStorage.encryptString(String(plain)).toString('base64')
}

/** 保存天气 API Key：加密后单键存放，返回值只带 apiKeySet 状态位。 */
function setWeatherKey(dto) {
  try {
    return withTx(function () {
      const key = dto && dto.key ? String(dto.key).trim() : ''
      if (!key) {
        get().prepare("DELETE FROM app_setting WHERE key = 'weatherKey'").run()
        const cleared = Object.assign({}, getOne('weather') || DEFAULTS.weather, { apiKeySet: false })
        writeKey('weather', cleared)
        return cleared
      }
      get().prepare('INSERT OR REPLACE INTO app_setting (key,value) VALUES (?,?)').run('weatherKey', JSON.stringify(encryptSecret(key)))
      const next = Object.assign({}, getOne('weather') || DEFAULTS.weather, { apiKeySet: true })
      writeKey('weather', next)
      return next
    })
  } catch (err) {
    return fail('setWeatherKey failed', err, {})
  }
}

/** 数据源自检：只做本地配置校验，不做网络请求，避免把「能连上」说成本地能力。 */
function testWeather() {
  try {
    const cfg = Object.assign({}, DEFAULTS.weather, getOne('weather') || {})
    const keySet = hasWeatherKey()
    return {
      ok: keySet,
      keySet: keySet,
      host: cfg.host,
      cacheMin: cfg.cacheMin,
      message: keySet
        ? '数据源与凭据已保存在本机，本地配置校验通过；天气数据仍取本地缓存'
        : '尚未填写 API Key，天气页展示本地缓存数据'
    }
  } catch (err) {
    return fail('testWeather failed', err, {})
  }
}

module.exports = {
  all: readAll, get: getOne, set: set, defaults: DEFAULTS,
  storage: storage, backup: backup, backups: backups, restore: restore,
  exportData: exportData, clearCache: clearCache, clearTrash: clearTrash, resetAll: resetAll,
  setWeatherKey: setWeatherKey, testWeather: testWeather
}
