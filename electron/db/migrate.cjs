// 迁移执行器：按文件名顺序应用 migrations/*.sql，用 schema_version 记录进度
const fs = require('node:fs')
const path = require('node:path')

const MIGRATION_DIR = path.join(__dirname, '..', '..', 'migrations')

function ensureVersionTable(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);')
}

function appliedVersions(db) {
  const rows = db.prepare('SELECT version FROM schema_version').all()
  return new Set(rows.map(function (r) { return r.version }))
}

function listMigrations() {
  if (!fs.existsSync(MIGRATION_DIR)) return []
  return fs.readdirSync(MIGRATION_DIR)
    .filter(function (f) { return f.endsWith('.sql') })
    .sort()
    .map(function (file) {
      const m = /^(\d+)_(.+)\.sql$/.exec(file)
      return { version: m ? Number(m[1]) : 0, name: file, filePath: path.join(MIGRATION_DIR, file) }
    })
    .filter(function (m) { return m.version > 0 })
}

function migrate(db) {
  ensureVersionTable(db)
  const done = appliedVersions(db)
  const pending = listMigrations().filter(function (m) { return !done.has(m.version) })
  const record = db.prepare('INSERT OR REPLACE INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)')
  const applied = []
  for (const m of pending) {
    const sql = fs.readFileSync(m.filePath, 'utf8')
    const run = db.transaction(function () {
      db.exec(sql)
      record.run(m.version, m.name, Date.now())
    })
    run()
    applied.push(m.version)
  }
  return applied
}

function currentVersion(db) {
  ensureVersionTable(db)
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()
  return row && row.v ? row.v : 0
}

module.exports = { migrate: migrate, currentVersion: currentVersion, listMigrations: listMigrations }
