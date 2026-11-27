// 版本与更新检查。
// 版本号唯一来源：package.json 的 version。electron-builder 用它命名安装包，
// app.getVersion() 运行时读的也是它；GitHub tag 用 v + version（v1.0.0）保持一致。
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const logger = require('../log/logger.cjs')

// 发布仓库：检查更新只读这里的 latest release，不引入额外配置。
const OWNER_REPO = 'LijunTong/Something'
const REPO_URL = 'https://github.com/' + OWNER_REPO
const RELEASES_URL = REPO_URL + '/releases'
const LATEST_API = 'https://api.github.com/repos/' + OWNER_REPO + '/releases/latest'
const TIMEOUT_MS = 8000

// 版本号归一：'v1.0.0' / '1.0.0-beta.1' -> { nums, pre }；无法解析返回 null
function parseVersion(v) {
  const m = String(v == null ? '' : v).trim().replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' }
}

// latest 是否比 current 新：先比主次修订号，再按预发布标记（无标记的正式版更新）
function isNewer(latest, current) {
  const a = parseVersion(latest)
  if (!a) return false
  const b = parseVersion(current)
  if (!b) return true
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i]
  }
  if (a.pre === b.pre) return false
  if (!a.pre) return true
  if (!b.pre) return false
  return a.pre > b.pre
}

// 从发布资产里挑 Windows 安装包：优先与版本同名的 Something-Setup-*.exe
function pickAsset(rel, version) {
  const assets = Array.isArray(rel.assets) ? rel.assets : []
  const exe = assets.filter(function (a) {
    return a && a.name && /\.exe$/i.test(a.name) && a.browser_download_url
  })
  if (!exe.length) return null
  const want = 'Something-Setup-' + version + '.exe'
  function score(name) {
    let s = 0
    if (name === want) s += 100
    if (/Something-Setup/i.test(name)) s += 20
    if (/x64|amd64/i.test(name)) s += 5
    if (/arm64/i.test(name)) s -= 5
    return s
  }
  exe.sort(function (a, b) { return score(b.name) - score(a.name) })
  const picked = exe[0]
  return { name: picked.name, url: picked.browser_download_url, size: Number(picked.size) || 0 }
}

// 读 GitHub 最新正式发布；超时或非 2xx 直接抛错，由 IPC 层转成结构化错误
async function fetchLatestRelease(current) {
  const controller = new AbortController()
  const timer = setTimeout(function () { controller.abort() }, TIMEOUT_MS)
  try {
    const res = await fetch(LATEST_API, {
      headers: {
        'user-agent': 'Something/' + current,
        accept: 'application/vnd.github+json'
      },
      signal: controller.signal,
      redirect: 'follow'
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error('HTTP_' + res.status)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// 检查更新：返回当前版本、最新版本、是否有更新、发布页地址
async function check() {
  const current = app.getVersion()
  const out = {
    current: current,
    latest: null,
    hasUpdate: false,
    url: RELEASES_URL,
    repo: REPO_URL,
    name: null,
    publishedAt: null,
    notes: '',
    asset: null,
    noRelease: false,
    checkedAt: Date.now()
  }
  try {
    const rel = await fetchLatestRelease(current)
    if (!rel) {
      out.noRelease = true
      return out
    }
    const tag = String(rel.tag_name || '')
    out.latest = tag.replace(/^v/i, '')
    out.name = rel.name || tag
    out.publishedAt = rel.published_at || null
    out.url = rel.html_url || RELEASES_URL
    out.notes = String(rel.body || '').slice(0, 4000)
    out.hasUpdate = isNewer(out.latest, current)
    out.asset = out.hasUpdate ? pickAsset(rel, out.latest) : null
    logger.info('update', 'check_ok', { current: current, latest: out.latest, hasUpdate: out.hasUpdate, asset: out.asset && out.asset.name })
    return out
  } catch (e) {
    logger.warn('update', 'check_failed', { current: current, message: e && e.message })
    throw e
  }
}

/* ---------- 自动更新：下载安装包并启动安装 ---------- */

// 安装包只从 GitHub 域下载；302 后的 objects.githubusercontent.com /
// release-assets.githubusercontent.com 也要放行，但其他域一律拒绝。
const ALLOWED_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']
const MIN_ASSET_BYTES = 1024 * 1024

// 同一时刻只允许一个下载任务；状态推给所有窗口，渲染层据此显示进度
let job = null

function safeVersion(v) {
  const s = String(v == null ? '' : v).replace(/[^0-9A-Za-z.-]/g, '')
  return s || 'latest'
}

function status() {
  if (!job) return { state: 'idle', version: null, percent: 0, received: 0, total: 0 }
  const out = {
    state: job.state,
    version: job.version || null,
    percent: job.percent,
    received: job.received,
    total: job.total
  }
  if (job.message) out.message = job.message
  return out
}

function emitStatus(emit) {
  if (typeof emit === 'function') emit(status())
}

function updateTarget(version) {
  const dir = path.join(app.getPath('temp'), 'something-update')
  fs.mkdirSync(dir, { recursive: true })
  return { dir: dir, file: path.join(dir, 'Something-Setup-' + safeVersion(version) + '.exe') }
}

function hostAllowed(raw) {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    return ALLOWED_HOSTS.some(function (h) { return u.hostname === h || u.hostname.endsWith('.' + h) })
  } catch (e) {
    return false
  }
}

// 流式下载到临时目录：进度按 150ms 节流推送，完成后校验大小与 MZ 头再改名
async function downloadAsset(asset, version, onProgress) {
  if (!hostAllowed(asset.url)) throw new Error('下载地址不在 GitHub 域内')
  const res = await fetch(asset.url, {
    headers: { 'user-agent': 'Something/' + app.getVersion(), accept: 'application/octet-stream' },
    redirect: 'follow'
  })
  if (!res.ok) throw new Error('下载失败：HTTP ' + res.status)
  if (!hostAllowed(res.url)) throw new Error('下载被重定向到非 GitHub 域')
  if (!res.body) throw new Error('下载失败：响应没有内容')
  const total = Number(asset.size) || Number(res.headers.get('content-length')) || 0
  if (total && total < MIN_ASSET_BYTES) throw new Error('安装包大小异常')
  const target = updateTarget(version)
  const tmp = target.file + '.part'
  let received = 0
  let lastAt = 0
  const meter = new Transform({
    transform: function (chunk, _enc, cb) {
      received += chunk.length
      const now = Date.now()
      if (now - lastAt >= 150) {
        lastAt = now
        onProgress(total ? Math.min(99, Math.floor((received / total) * 100)) : 0, received, total)
      }
      cb(null, chunk)
    }
  })
  try {
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmp))
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw new Error('下载中断：' + ((e && e.message) || '网络错误'))
  }
  if (total && received !== total) {
    fs.rmSync(tmp, { force: true })
    throw new Error('安装包大小与发布信息不一致')
  }
  if (received < MIN_ASSET_BYTES) {
    fs.rmSync(tmp, { force: true })
    throw new Error('安装包过小，可能下载到了错误页面')
  }
  const fd = fs.openSync(tmp, 'r')
  const head = Buffer.alloc(2)
  try { fs.readSync(fd, head, 0, 2, 0) } finally { fs.closeSync(fd) }
  if (head.toString('latin1') !== 'MZ') {
    fs.rmSync(tmp, { force: true })
    throw new Error('下载内容不是 Windows 安装程序')
  }
  fs.renameSync(tmp, target.file)
  return target.file
}

// 开始下载：同步置为 downloading 并立即推一次状态，后续进度由下载器推送
function start(info, emit) {
  if (job && (job.state === 'downloading' || job.state === 'ready' || job.state === 'installing')) return status()
  const asset = info && info.asset
  if (!asset) throw new Error('该版本没有可下载的安装包')
  job = {
    state: 'downloading',
    version: info.latest || '',
    percent: 0,
    received: 0,
    total: Number(asset.size) || 0,
    file: null,
    message: ''
  }
  emitStatus(emit)
  downloadAsset(asset, job.version, function (percent, received, total) {
    if (!job || job.state !== 'downloading') return
    job.percent = percent
    job.received = received
    job.total = total
    emitStatus(emit)
  }).then(function (file) {
    job.state = 'ready'
    job.percent = 100
    job.received = job.total || job.received
    job.file = file
    logger.info('update', 'download_ok', { version: job.version, file: file })
    emitStatus(emit)
  }).catch(function (e) {
    job.state = 'error'
    job.message = (e && e.message) || '下载失败'
    logger.warn('update', 'download_failed', { version: job.version, message: job.message })
    emitStatus(emit)
  })
  return status()
}

// 静默安装并退出：安装程序分离启动，等它接管后再 close，避免占用安装目录
function install(emit) {
  if (!app.isPackaged) {
    const e = new Error('开发模式不执行自动安装')
    e.code = 'NOT_PACKAGED'
    throw e
  }
  if (!job || job.state !== 'ready' || !job.file) throw new Error('没有已下载的安装包')
  job.state = 'installing'
  emitStatus(emit)
  // --updated 让安装器按升级路径处理，--force-run 让它在静默安装结束后重新启动应用
  const child = spawn(job.file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  logger.info('update', 'install_start', { version: job.version })
  setTimeout(function () { app.quit() }, 700)
  return true
}

module.exports = {
  check: check,
  current: function () { return app.getVersion() },
  status: status,
  start: start,
  install: install
}
