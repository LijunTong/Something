// 数据目录选择：默认用 Electron 的 userData，但如果该目录不可写
// （受限沙箱、只读配置文件系统、被安全软件拦截的非白名单进程等），
// 就回退到应用目录下的 .data，避免 SQLite 报 "attempt to write a readonly database"。
// 纯函数式设计，不依赖 electron，便于单独验证。
const fs = require('node:fs')
const path = require('node:path')

/** 目录是否真的可写：不能只看 existsSync，受限环境里目录可读但写会 EPERM。 */
function isWritableDir(dir) {
  if (!dir) return false
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.tk-write-probe-' + process.pid + '-' + Date.now())
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return true
  } catch (e) {
    return false
  }
}

function hasDb(dir) {
  if (!dir) return false
  try {
    return fs.existsSync(path.join(dir, 'toolkit.db'))
  } catch (e) {
    return false
  }
}

/**
 * @param {{ override?: string, defaultDir: string, stickyDir?: string, candidates?: string[] }} opts
 * @returns {{ dir: string, source: 'env'|'env-readonly'|'existing'|'default'|'default-readonly'|'fallback', fallbackFrom?: string }}
 */
function pickDataDir(opts) {
  const o = opts || {}
  // 显式指定优先，即使不可写也照用：让上层报出明确的路径，而不是悄悄换地方。
  if (o.override) {
    const dir = path.resolve(o.override)
    return { dir: dir, source: isWritableDir(dir) ? 'env' : 'env-readonly' }
  }
  // 曾经回退过的目录里已经有库，就继续用它。
  // 否则同一份数据会在 userData 与回退目录之间分叉（一次受限启动、一次正常启动）。
  if (o.stickyDir && hasDb(o.stickyDir)) {
    return { dir: path.resolve(o.stickyDir), source: 'existing' }
  }
  const def = o.defaultDir
  if (isWritableDir(def)) return { dir: def, source: 'default' }
  const candidates = o.candidates || []
  for (const c of candidates) {
    if (c && isWritableDir(c)) {
      return { dir: c, source: 'fallback', fallbackFrom: def }
    }
  }
  return { dir: def, source: 'default-readonly' }
}

/**
 * 首次回退时把旧库复制到新目录，避免用户以为数据丢了。
 * -wal 未合并时必须一起复制；-shm 是临时索引，SQLite 会按 WAL 重建，不需要。
 */
function copyLegacyDb(fromDir, toDir) {
  if (!fromDir || !toDir) return null
  const from = path.resolve(fromDir)
  const to = path.resolve(toDir)
  if (from === to) return null
  const src = path.join(from, 'toolkit.db')
  const dst = path.join(to, 'toolkit.db')
  if (!fs.existsSync(src) || fs.existsSync(dst)) return null
  try {
    fs.mkdirSync(to, { recursive: true })
    fs.copyFileSync(src, dst)
    const wal = src + '-wal'
    if (fs.existsSync(wal) && fs.statSync(wal).size > 0) fs.copyFileSync(wal, dst + '-wal')
    return { from: src, to: dst }
  } catch (e) {
    try { fs.unlinkSync(dst) } catch (e2) {}
    try { fs.unlinkSync(dst + '-wal') } catch (e2) {}
    return null
  }
}

module.exports = {
  isWritableDir: isWritableDir,
  hasDb: hasDb,
  pickDataDir: pickDataDir,
  copyLegacyDb: copyLegacyDb
}
