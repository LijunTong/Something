// SQLite 数据访问层：主进程持有数据库，按模块持久化到 app_state 表
const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const { defaults } = require('./seed.cjs')

let db

function init(userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true })
  const file = path.join(userDataPath, 'toolkit.db')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
  `)
  const count = db.prepare('SELECT COUNT(*) AS n FROM app_state').get().n
  if (count === 0) seed()
  return file
}

function seed() {
  const data = defaults()
  const insert = db.prepare('INSERT OR REPLACE INTO app_state (key, data, updated_at) VALUES (?, ?, ?)')
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(data)) insert.run(key, JSON.stringify(value), now)
  })
  tx()
}

function getAll() {
  const rows = db.prepare('SELECT key, data FROM app_state').all()
  const state = defaults()
  for (const row of rows) {
    try { state[row.key] = JSON.parse(row.data) } catch (e) {}
  }
  return state
}

function saveAll(state) {
  const insert = db.prepare('INSERT OR REPLACE INTO app_state (key, data, updated_at) VALUES (?, ?, ?)')
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(state)) insert.run(key, JSON.stringify(value), now)
  })
  tx()
  return true
}

function saveModule(key, value) {
  db.prepare('INSERT OR REPLACE INTO app_state (key, data, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), Date.now())
  return true
}

function reset() {
  db.prepare('DELETE FROM app_state').run()
  seed()
  return getAll()
}

function log(action, detail) {
  db.prepare('INSERT INTO operation_log (action, detail, created_at) VALUES (?, ?, ?)').run(action, detail || '', Date.now())
}

module.exports = { init, getAll, saveAll, saveModule, reset, log, defaults }
