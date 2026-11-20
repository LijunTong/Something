// SQLite 连接与事务封装。主进程单例，所有写操作必须走 withTx。
const path = require('node:path')
const fs = require('node:fs')
const Database = require('better-sqlite3')
const { migrate, currentVersion } = require('./migrate.cjs')

let db = null
let dbFile = null

function open(userDataPath) {
  if (db) return { db: db, file: dbFile, applied: [], version: currentVersion(db) }
  fs.mkdirSync(userDataPath, { recursive: true })
  dbFile = path.join(userDataPath, 'toolkit.db')
  db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  const applied = migrate(db)
  return { db: db, file: dbFile, applied: applied, version: currentVersion(db) }
}

function get() {
  if (!db) throw new Error('DB_NOT_OPEN')
  return db
}

function withTx(fn) {
  const tx = get().transaction(fn)
  return tx()
}

function integrityCheck() {
  const d = get()
  let ok = false
  try {
    const row = d.prepare('PRAGMA integrity_check').get()
    ok = !!row && Object.values(row)[0] === 'ok'
  } catch (e) { ok = false }
  let backup = null
  if (!ok && dbFile && fs.existsSync(dbFile)) {
    backup = dbFile + '.corrupt.' + Date.now()
    try { fs.copyFileSync(dbFile, backup) } catch (e) { backup = null }
  }
  return { ok: ok, backup: backup }
}

function close() {
  if (db) { db.close(); db = null }
}

module.exports = { open: open, get: get, withTx: withTx, integrityCheck: integrityCheck, close: close, file: function () { return dbFile } }
